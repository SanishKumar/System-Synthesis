import {
  getInstallationToken,
  isGitHubAppConfigured,
  readSafeHeaders,
  type HttpTransport,
  type InstallationPermissions,
  type SafeResponseHeaders,
} from "./githubApp.js";
import { isGitHubIdentityConfigured } from "./githubIdentity.js";
import type { SelfApprovalPolicy } from "@system-synthesis/architecture-core";
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
  | "verified"
  /**
   * The author decided their own change because GitHub confirmed no other
   * account holds deciding permission on the repository. Separate from
   * `verified` because nobody reviewed this but its author, and a reader six
   * months later must be able to see that without reconstructing the team.
   */
  | "self_sole_reviewer"
  /**
   * The author decided their own change as an administrator while other
   * eligible reviewers existed. The weakest basis this service will record,
   * and deliberately the most conspicuous.
   */
  | "self_admin_override";

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
  /**
   * True when the account that decided is the account that opened the change.
   * Present on every verified outcome, not only the exceptions, so that the
   * absence of a self-approval is recorded as positively as its presence.
   */
  selfApproved?: boolean;
  /**
   * How many accounts GitHub reported as holding deciding permission when a
   * self-approval was allowed. `1` is what makes `self_sole_reviewer` true;
   * a larger number beside `self_admin_override` states exactly how many
   * reviewers were available and not used.
   */
  eligibleReviewers?: number;
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
  review: Pick<ArchitectureReviewRecord, "externalSource" | "policy">,
  reviewer: DecidingReviewer,
  options: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date } = {}
): Promise<EntitlementVerdict> {
  const env = options.env ?? process.env;
  const source = review.externalSource;
  // Read from the review, which took it from the base commit. A pull request
  // that could widen this in its own head commit would be certifying itself by
  // editing a file.
  const selfApprovalPolicy: SelfApprovalPolicy =
    review.policy?.decision?.selfApproval ?? "forbidden";

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
  // Only a cached token can be describing a grant that has since changed. One
  // minted during this call already carries the current answer, and asking
  // again would spend a request to be told the same thing.
  if (
    credential.status === "ok" &&
    credential.fromCache &&
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
      return forbiddenIsNotAnAnswer("pull request", pull.headers);
    }
    if (pull.status !== 200) {
      return unavailable(`pull request lookup returned ${pull.status}`);
    }
    const author = (await pull.json().catch(() => null)) as { user?: { id?: unknown } } | null;
    const authorId = author?.user?.id;
    if (typeof authorId !== "number") {
      return unavailable("pull request response omitted its author");
    }
    // Proposing a change and certifying it are different acts. Unless the base
    // commit's policy names an exception, that holds however much permission
    // the person has. Where an exception is named it is not applied here: the
    // permission checks below still have to pass first, so a self-approval can
    // never reach a conclusion an ordinary reviewer could not.
    const selfApproved = String(authorId) === reviewer.githubUserId;
    if (selfApproved && selfApprovalPolicy === "forbidden") {
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
    // A 404 is GitHub declining to name this person a collaborator, which is an
    // answer about standing. A 403 is not: rate limits, IP allow lists and
    // organisation policy all answer 403, and reporting one of those as "you do
    // not have access to this repository" tells an authorised reviewer
    // something false about their own permissions.
    if (permission.status === 404) return insufficient(source.repository);
    if (permission.status === 403) {
      return forbiddenIsNotAnAnswer("collaborator", permission.headers);
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

    const evidence: EntitlementEvidence = {
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
      selfApproved,
    };

    if (!selfApproved) return { status: "allowed", evidence };

    // Everything below decides only whether an author may certify their own
    // change. Reaching here already means they hold deciding permission and are
    // the account they claim to be.
    if (selfApprovalPolicy === "admin_override") {
      if (level.permission !== "admin") {
        return {
          status: "refused",
          code: "self_approval",
          message:
            "You opened this pull request. This repository allows an administrator to " +
            "decide their own change, and your access is " + level.permission + ".",
        };
      }
      const eligible = await countDecidingReviewers(source.repository, transport, headers);
      return {
        status: "allowed",
        evidence: {
          ...evidence,
          basis: "self_admin_override",
          // Best effort: the override is granted on administrator standing, so
          // a count that could not be established does not withhold it. It is
          // recorded when known because "how many reviewers were skipped" is
          // the question this basis exists to answer.
          ...(eligible === undefined ? {} : { eligibleReviewers: eligible }),
        },
      };
    }

    // sole_reviewer: the exception only holds while it is true, so it is
    // established against GitHub on every decision rather than assumed from
    // how the repository looked when it was connected.
    const eligible = await countDecidingReviewers(source.repository, transport, headers);
    if (eligible === undefined) {
      return unavailable("could not establish whether another reviewer exists");
    }
    // GitHub just established that this account can decide, so a listing that
    // contains no deciding account is internally inconsistent and cannot prove
    // that this account is the only one.
    if (eligible === 0) {
      return unavailable("collaborator listing did not include the deciding account");
    }
    if (eligible > 1) {
      return {
        status: "refused",
        code: "self_approval",
        message:
          "You opened this pull request. This repository allows its author to decide " +
          `only while nobody else can, and ${eligible} accounts now have write access ` +
          "to it. Someone other than the author has to decide this change.",
      };
    }
    return {
      status: "allowed",
      evidence: { ...evidence, basis: "self_sole_reviewer", eligibleReviewers: eligible },
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
 * A 403 is never an answer about permission here.
 *
 * `x-accepted-github-permissions` states what the endpoint requires, not what
 * the caller was found to be missing — GitHub sends it to describe the endpoint,
 * so a rate-limited response carries it just as readily as a rejected one.
 * Reading its presence as proof of a missing grant was wrong, and reading it
 * before the rate-limit headers made it wrong in the worst direction: the
 * response that carries both is exactly the one where the header means least.
 *
 * The installation's own grant is the only thing that establishes a missing
 * permission, and it is consulted before any request is made. Everything a 403
 * can say afterwards is retryable, so the header is kept for the detail line
 * and decides nothing.
 */
function forbiddenIsNotAnAnswer(
  what: string,
  headers: SafeResponseHeaders | undefined
): EntitlementVerdict {
  // Rate-limit evidence first: it is the one condition here that clears on its
  // own, and it must not be described as anything an operator should act on.
  if (headers?.["retry-after"] || headers?.["x-ratelimit-remaining"] === "0") {
    return unavailable(`${what} lookup was rate limited`);
  }
  const accepted = headers?.["x-accepted-github-permissions"];
  return unavailable(
    accepted
      ? `${what} lookup returned 403; the endpoint requires ${accepted}`
      : `${what} lookup returned 403`
  );
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

/**
 * How many accounts hold permission to decide a change on this repository.
 *
 * `undefined` means the question could not be answered, which callers that
 * depend on it must treat as a refusal. Returning 1 on an error would turn
 * every outage into a licence for an author to certify their own change, which
 * is the one direction this must never fail in.
 *
 * `affiliation=all` includes outside collaborators alongside direct members.
 * Access granted only through an organisation team may still not be listed;
 * that is recorded in the known limitations rather than papered over here.
 */
async function countDecidingReviewers(
  repository: string,
  transport: HttpTransport,
  headers: Record<string, string>
): Promise<number | undefined> {
  try {
    let deciding = 0;
    // A large repository can span more than one page. Reading only the first
    // 100 can manufacture solitude when a second writer sorts onto a later
    // page, which is the one direction this check must never get wrong.
    for (let page = 1; page <= 100; page += 1) {
      const response = await transport(
        `${GITHUB_API}/repos/${repository}/collaborators?affiliation=all&per_page=100&page=${page}`,
        { method: "GET", headers }
      );
      if (response.status !== 200) return undefined;
      const collaborators = (await response.json().catch(() => null)) as
        | Array<{ permissions?: Record<string, unknown>; role_name?: unknown }>
        | null;
      if (!Array.isArray(collaborators)) return undefined;
      deciding += collaborators.filter((entry) => {
        // `permissions` is the shape GitHub returns for this endpoint; the
        // boolean flags are cumulative, so push covers maintain and admin.
        const permissions = entry.permissions;
        if (permissions && typeof permissions === "object") {
          return Boolean(permissions.push || permissions.maintain || permissions.admin);
        }
        return typeof entry.role_name === "string" && DECIDING_PERMISSIONS.has(entry.role_name);
      }).length;
      if (collaborators.length < 100) return deciding;
    }
    // Refuse rather than trust an incomplete count in an exceptionally large
    // or unstable listing.
    return undefined;
  } catch {
    return undefined;
  }
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
