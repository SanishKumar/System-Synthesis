import { getInstallationToken, isGitHubAppConfigured, type HttpTransport } from "./githubApp.js";
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
  | "identity_required"
  | "self_approval"
  | "insufficient_permission"
  | "verification_unavailable";

export type EntitlementVerdict =
  | { status: "allowed"; basis: EntitlementBasis; login?: string }
  | { status: "refused"; code: EntitlementRefusal; message: string };

export interface DecidingReviewer {
  githubUserId: string | null;
  githubLogin: string | null;
}

function defaultTransport(): HttpTransport {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, json: () => response.json() };
  };
}

export async function reviewDecisionEntitlement(
  review: Pick<ArchitectureReviewRecord, "externalSource">,
  reviewer: DecidingReviewer,
  options: { env?: NodeJS.ProcessEnv; transport?: HttpTransport } = {}
): Promise<EntitlementVerdict> {
  const env = options.env ?? process.env;
  const source = review.externalSource;

  // Nothing to have standing on. A manual import belongs to whoever created it.
  if (!source) return { status: "allowed", basis: "manual" };

  // A deployment that cannot check must not pretend it did, and must not lock
  // every reviewer out of a product that worked yesterday. It records that the
  // decision was unverified instead, which is the truth.
  if (!isGitHubAppConfigured(env) || !isGitHubIdentityConfigured(env)) {
    return { status: "allowed", basis: "unenforced" };
  }

  if (!reviewer.githubUserId) {
    return {
      status: "refused",
      code: "identity_required",
      message:
        "Link a GitHub account before deciding a pull-request review. This deployment " +
        "checks that whoever decides has standing on the repository.",
    };
  }

  const credential = await getInstallationToken(source.repository, {
    env,
    transport: options.transport,
  });
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
    const level = (await permission.json().catch(() => null)) as { permission?: unknown } | null;
    if (typeof level?.permission !== "string") {
      return unavailable("permission response was incomplete");
    }
    if (!DECIDING_PERMISSIONS.has(level.permission)) {
      return insufficient(source.repository);
    }

    return { status: "allowed", basis: "verified", login: reviewer.githubLogin ?? undefined };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "verification failed");
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
