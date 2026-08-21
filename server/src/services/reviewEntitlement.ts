import {
  getInstallationToken,
  isGitHubAppConfigured,
  readSafeHeaders,
  type HttpTransport,
  type InstallationPermissions,
  type SafeResponseHeaders,
} from "./githubApp.js";
import { isGitHubIdentityConfigured } from "./githubIdentity.js";
import type { ArchitectureReviewRecord } from "./reviewRepository.js";

/**
 * Whether this person may decide this review.
 *
 * Linking a GitHub account proves who a reviewer is. It says nothing about
 * whether they have any standing on the repository the change belongs to, and
 * an identity nobody checks is a name next to a decision rather than authority
 * behind it.
 *
 * Everything here is asked at the moment it matters, through the App's own
 * installation token. Nothing is taken from the delivery that created the
 * review: an Action reporting its own pull request's author would be reporting
 * on the very thing being gated, and a permission recorded weeks ago is not
 * evidence of permission now.
 */
const GITHUB_API = "https://api.github.com";

/** Permission levels GitHub reports that amount to "can change this repository". */
const DECIDING_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export type EntitlementBasis =
  /** A manual import: no pull request exists to have standing on. */
  | "manual"
  /** The server cannot check, and says so rather than implying it did. */
  | "unenforced"
  /** Checked against GitHub and allowed. */
  | "verified";

export type EntitlementRefusal =
  /** The App exists but was never granted what verification needs. */
  | "app_permission_missing"
  | "identity_required"
  /** The login on file resolved to a different account than the one linked. */
  | "identity_mismatch"
  | "self_approval"
  | "insufficient_permission"
  | "verification_unavailable";

/**
 * What was established about the person deciding, at the moment they decided.
 *
 * Stored with the decision. A decision without this is a name in a column: it
 * cannot answer which GitHub account made it, whether permission was checked at
 * all, or what GitHub said when it was. `basis` is the part that matters most,
 * because `unenforced` and `verified` look identical afterwards otherwise.
 */
export interface EntitlementEvidence {
  basis: EntitlementBasis;
  repository?: string;
  /** Immutable GitHub account id. The only durable name for who decided. */
  githubUserId?: string;
  /** Display login as GitHub resolved it during the check, not as stored. */
  githubLogin?: string;
  /** The level GitHub reported, kept verbatim. */
  permission?: string;
  checkedAt?: string;
}

export type EntitlementVerdict =
  | { status: "allowed"; evidence: EntitlementEvidence }
  | { status: "refused"; code: EntitlementRefusal; message: string };

export interface DecidingReviewer {
  githubUserId: string | null;
  githubLogin: string | null;
}

function defaultTransport(): HttpTransport {
  return async (url, init) => {
    const response = await fetch(url, init);
    return {
      status: response.status,
      json: () => response.json(),
      headers: readSafeHeaders(response.headers),
    };
  };
}

export async function reviewDecisionEntitlement(
  review: Pick<ArchitectureReviewRecord, "externalSource">,
  reviewer: DecidingReviewer,
  options: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date } = {}
): Promise<EntitlementVerdict> {
  const env = options.env ?? process.env;
  const source = review.externalSource;

  // Nothing to have standing on. A manual import belongs to whoever created it.
  if (!source) return { status: "allowed", evidence: { basis: "manual" } };

  // A deployment that cannot check must not pretend it did, and must not lock
  // every reviewer out of a product that worked yesterday. It records that the
  // decision was unverified instead, which is the truth.
  if (!isGitHubAppConfigured(env) || !isGitHubIdentityConfigured(env)) {
    return {
      status: "allowed",
      evidence: { basis: "unenforced", repository: source.repository },
    };
  }

  // Both halves, because the permission question is asked by login and the
  // answer is checked against the id. A row carrying only one of them would put
  // the string "null" in the request path and come back as a refusal that names
  // the wrong reason — the reviewer would be told they lack access when what
  // they actually have is an incomplete link.
  if (!reviewer.githubUserId || !reviewer.githubLogin) {
    return {
      status: "refused",
      code: "identity_required",
      message:
        "Link a GitHub account before deciding a pull-request review. This deployment " +
        "checks that whoever decides has standing on the repository.",
    };
  }

  let credential = await getInstallationToken(source.repository, {
    env,
    transport: options.transport,
    now: options.now,
  });
  // A cached token carries the grant it was minted with. When that grant is
  // short, the permission may have been accepted since, so one bounded refresh
  // is spent finding out rather than leaving the reviewer locked out for the
  // remaining life of the token.
  if (
    credential.status === "ok" &&
    credential.permissions &&
    !hasPullRequestRead(credential.permissions)
  ) {
    const refreshed = await getInstallationToken(source.repository, {
      env,
      transport: options.transport,
      now: options.now,
      refresh: true,
    });
    if (refreshed.status === "ok") credential = refreshed;
  }
  if (credential.status !== "ok") {
    // Failing open here would let anyone decide whenever GitHub is unreachable,
    // which is precisely when a false gate is least likely to be noticed.
    return {
      status: "refused",
      code: "verification_unavailable",
      message:
        "This decision cannot be verified against GitHub right now, so it has not been " +
        "recorded. The analysis and findings are unaffected; try again shortly.",
    };
  }

  // Asked before anything is requested. Reading the author of a pull request
  // needs `Pull requests: read`, and an installation without it answers exactly
  // as a private repository with a missing resource does, so the failure would
  // otherwise be reported as a transient outage and retried forever. GitHub
  // states the granted permissions when it mints the token, so this is settled
  // from the grant rather than guessed from a status code.
  if (credential.permissions && !hasPullRequestRead(credential.permissions)) {
    return missingAppPermission();
  }

  const transport = options.transport ?? defaultTransport();
  const headers = {
    Authorization: `Bearer ${credential.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "system-synthesis",
  };

  try {
    const pull = await transport(
      `${GITHUB_API}/repos/${source.repository}/pulls/${source.changeNumber}`,
      { method: "GET", headers }
    );
    // GitHub answers 403 for a primary or secondary rate limit, an IP allow
    // list, and organisation policy as well as for a permission it will not
    // exercise. The grant said this was allowed, so a refusal is only called a
    // permission problem when the response itself establishes one; everything
    // else is the conservative answer, which asks for a retry that can work.
    if (pull.status === 403) {
      return classifyForbidden(pull.headers);
    }
    if (pull.status !== 200) {
      return unavailable(`pull request lookup returned ${pull.status}`);
    }
    const author = (await pull.json().catch(() => null)) as { user?: { id?: unknown } } | null;
    const authorId = author?.user?.id;
    if (typeof authorId !== "number") {
      return unavailable("pull request response omitted its author");
    }
    // Proposing a change and certifying it are different acts. This is the one
    // rule that holds however much permission the person has.
    if (String(authorId) === reviewer.githubUserId) {
      return {
        status: "refused",
        code: "self_approval",
        message:
          "You opened this pull request. Someone other than its author has to decide " +
          "whether the architecture change is acceptable.",
      };
    }

    const permission = await transport(
      `${GITHUB_API}/repos/${source.repository}/collaborators/${reviewer.githubLogin}/permission`,
      { method: "GET", headers }
    );
    // 403 and 404 both mean "GitHub will not say this person has standing".
    if (permission.status === 403 || permission.status === 404) {
      return insufficient(source.repository);
    }
    if (permission.status !== 200) {
      return unavailable(`permission lookup returned ${permission.status}`);
    }
    const level = (await permission.json().catch(() => null)) as
      | { permission?: unknown; user?: { id?: unknown; login?: unknown } }
      | null;
    if (typeof level?.permission !== "string") {
      return unavailable("permission response was incomplete");
    }
    // Asked before identity, so a reviewer without access is told that rather
    // than being sent away with a retry message because the response for a
    // non-collaborator carries no account to compare.
    if (!DECIDING_PERMISSIONS.has(level.permission)) {
      return insufficient(source.repository);
    }
    // The question was asked using a login, and a login can be given away. The
    // response names the account it actually resolved to, so this answer is
    // about this reviewer only if that account is the one they linked. Without
    // the comparison, standing is established for whoever holds the name today
    // while self-approval is refused against the account that held it before.
    const resolvedId = level.user?.id;
    if (typeof resolvedId !== "number") {
      return unavailable("permission response did not name the account it resolved");
    }
    if (String(resolvedId) !== reviewer.githubUserId) {
      return {
        status: "refused",
        code: "identity_mismatch",
        message:
          "The GitHub account linked here no longer matches the account that login " +
          "belongs to. Re-link your GitHub account before deciding this review.",
      };
    }

    return {
      status: "allowed",
      evidence: {
        basis: "verified",
        repository: source.repository,
        githubUserId: reviewer.githubUserId,
        // Whatever GitHub calls this account now, which is what a later reader
        // needs in order to find it. The stored login may already be stale.
        githubLogin:
          typeof level.user?.login === "string"
            ? level.user.login
            : reviewer.githubLogin ?? undefined,
        permission: level.permission,
        checkedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "verification failed");
  }
}

/** Levels of `Pull requests` that permit reading one. */
const PULL_REQUEST_READ_LEVELS = new Set(["read", "write", "admin"]);

function hasPullRequestRead(permissions: InstallationPermissions): boolean {
  return PULL_REQUEST_READ_LEVELS.has(permissions.pull_requests);
}

/**
 * What a 403 on the pull-request lookup actually means.
 *
 * Only `x-accepted-github-permissions` naming the permission is treated as
 * evidence of one, because GitHub sends that header precisely to say which
 * grant the request needed. A rate limit is recognised so it is never mistaken
 * for configuration, and anything unexplained resolves to the conservative
 * answer: telling somebody to change their App when the real problem is a rate
 * limit sends them to do work that will not help.
 */
function classifyForbidden(headers: SafeResponseHeaders | undefined): EntitlementVerdict {
  const accepted = headers?.["x-accepted-github-permissions"];
  if (accepted && /\bpull_requests\b/.test(accepted)) {
    return missingAppPermission();
  }
  if (headers?.["retry-after"] || headers?.["x-ratelimit-remaining"] === "0") {
    return unavailable("pull request lookup was rate limited");
  }
  return unavailable("pull request lookup returned 403");
}

/**
 * A configuration answer, deliberately not an outage answer.
 *
 * Telling somebody to try again shortly when an operator has to change the App
 * and an organisation owner has to approve the change is advice that can never
 * come true.
 */
function missingAppPermission(): EntitlementVerdict {
  return {
    status: "refused",
    code: "app_permission_missing",
    message:
      "This deployment's GitHub App cannot read pull requests, so it cannot establish " +
      "who opened this one. An administrator has to add the Pull requests: Read " +
      "permission to the App and approve the updated permissions for the installation. " +
      "Retrying will not help until that is done.",
  };
}

function unavailable(detail: string): EntitlementVerdict {
  return {
    status: "refused",
    code: "verification_unavailable",
    message:
      "This decision cannot be verified against GitHub right now, so it has not been " +
      `recorded. The analysis and findings are unaffected; try again shortly. (${detail})`,
  };
}

function insufficient(repository: string): EntitlementVerdict {
  return {
    status: "refused",
    code: "insufficient_permission",
    message:
      `Your GitHub account does not have write access to ${repository}. Deciding a ` +
      "merge gate requires standing on the repository it gates.",
  };
}
