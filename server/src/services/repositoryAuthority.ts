import {
  getInstallationToken,
  isGitHubAppConfigured,
  readSafeHeaders,
  type HttpTransport,
  type SafeResponseHeaders,
} from "./githubApp.js";

/**
 * Whether this person may connect this repository to System Synthesis.
 *
 * An ingestion credential makes the App speak on a repository's behalf: whoever
 * holds one can submit a review for any pull request there, and the server
 * publishes the resulting gate through the shared installation. Issuing one to
 * somebody with no standing on the repository would let them place a passing
 * check on a commit they have nothing to do with — the App acting for them
 * against its own installer.
 *
 * So authority is established here, before a credential exists, and it is
 * established the same way the decision gate establishes it: through the App's
 * installation token, against the account the reviewer proved, compared by the
 * numeric id GitHub will not let anybody take.
 *
 * `admin` rather than write. Pushing to a repository and deciding what may
 * publish gates on it are different acts, and only the second one is being
 * granted here.
 */
const GITHUB_API = "https://api.github.com";

/** Permission levels that amount to administering a repository. */
const ADMINISTERING_PERMISSIONS = new Set(["admin"]);

export type RepositoryAuthorityRefusal =
  | "identity_required"
  | "identity_mismatch"
  | "app_not_configured"
  | "app_not_installed"
  | "repository_permission_insufficient"
  | "repository_verification_unavailable";

/** What was established, recorded so the connection can be accounted for. */
export interface VerifiedRepositoryAuthority {
  githubUserId: string;
  githubLogin: string;
  permission: string;
  verifiedAt: string;
}

export type RepositoryAuthorityVerdict =
  | { status: "verified"; authority: VerifiedRepositoryAuthority }
  | {
      status: "refused";
      code: RepositoryAuthorityRefusal;
      message: string;
      httpStatus: number;
    };

export interface ConnectingUser {
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

function refuse(
  code: RepositoryAuthorityRefusal,
  message: string,
  httpStatus: number
): RepositoryAuthorityVerdict {
  return { status: "refused", code, message, httpStatus };
}

/**
 * A 403 from the permission lookup is not an answer about permission.
 *
 * GitHub answers 403 for primary and secondary rate limits, IP allow lists and
 * organisation policy. Telling an administrator they lack access to their own
 * repository because GitHub is rate limiting sends them to fix something that
 * is not broken, so an unexplained refusal is reported as unavailable.
 */
function forbiddenIsNotAnAnswer(
  headers: SafeResponseHeaders | undefined
): RepositoryAuthorityVerdict {
  const detail =
    headers?.["retry-after"] || headers?.["x-ratelimit-remaining"] === "0"
      ? "GitHub is rate limiting this deployment"
      : "GitHub declined to answer";
  return refuse(
    "repository_verification_unavailable",
    `${detail}, so repository access could not be confirmed. Nothing has been connected; try again shortly.`,
    503
  );
}

export async function verifyRepositoryAuthority(
  repository: string,
  user: ConnectingUser,
  options: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date } = {}
): Promise<RepositoryAuthorityVerdict> {
  const env = options.env ?? process.env;

  // Both halves, because the question is asked by login and the answer is
  // checked against the id. One without the other cannot do either.
  if (!user.githubUserId || !user.githubLogin) {
    return refuse(
      "identity_required",
      "Link a GitHub account before connecting a repository. This deployment confirms " +
        "that whoever connects a repository administers it on GitHub.",
      403
    );
  }

  if (!isGitHubAppConfigured(env)) {
    return refuse(
      "app_not_configured",
      "This deployment has no GitHub App configured, so it cannot confirm who administers " +
        "a repository and will not issue a credential that could publish to one.",
      503
    );
  }

  const credential = await getInstallationToken(repository, {
    env,
    transport: options.transport,
    now: options.now,
  });
  if (credential.status === "not_installed") {
    return refuse(
      "app_not_installed",
      "The System Synthesis GitHub App is not installed on that repository. Install it " +
        "there first; connecting it here cannot grant access it does not have.",
      409
    );
  }
  if (credential.status !== "ok") {
    return refuse(
      "repository_verification_unavailable",
      "Repository access could not be confirmed with GitHub right now. Nothing has been " +
        "connected; try again shortly.",
      503
    );
  }

  const transport = options.transport ?? defaultTransport();
  const headers = {
    Authorization: `Bearer ${credential.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "system-synthesis",
  };

  try {
    const permission = await transport(
      `${GITHUB_API}/repos/${repository}/collaborators/${user.githubLogin}/permission`,
      { method: "GET", headers }
    );
    // GitHub declines to name a non-collaborator, which is an answer about
    // standing. A 403 is not one.
    if (permission.status === 404) {
      return refuse(
        "repository_permission_insufficient",
        "That GitHub account does not administer this repository, so it cannot connect it.",
        403
      );
    }
    if (permission.status === 403) return forbiddenIsNotAnAnswer(permission.headers);
    if (permission.status !== 200) {
      return refuse(
        "repository_verification_unavailable",
        "Repository access could not be confirmed with GitHub right now. Nothing has been " +
          "connected; try again shortly.",
        503
      );
    }

    const level = (await permission.json().catch(() => null)) as
      | { permission?: unknown; user?: { id?: unknown; login?: unknown } }
      | null;
    if (typeof level?.permission !== "string") {
      return refuse(
        "repository_verification_unavailable",
        "GitHub's answer about repository access was incomplete. Nothing has been connected; " +
          "try again shortly.",
        503
      );
    }
    // Asked before identity so somebody without access is told that, rather than
    // being told their account does not match when the access is the problem.
    if (!ADMINISTERING_PERMISSIONS.has(level.permission)) {
      return refuse(
        "repository_permission_insufficient",
        "Connecting a repository requires admin permission on it. This credential lets the " +
          "App publish checks there, which is more than write access grants.",
        403
      );
    }
    // The question was asked using a login, and a login can be given away. The
    // response names the account it resolved to, so the answer is about this
    // person only if that is the account they linked.
    const resolvedId = level.user?.id;
    if (typeof resolvedId !== "number") {
      return refuse(
        "repository_verification_unavailable",
        "GitHub did not name the account its answer was about, so repository access could " +
          "not be confirmed. Nothing has been connected.",
        503
      );
    }
    if (String(resolvedId) !== user.githubUserId) {
      return refuse(
        "identity_mismatch",
        "The GitHub account linked here no longer matches the account that login belongs to. " +
          "Re-link your GitHub account before connecting a repository.",
        403
      );
    }

    return {
      status: "verified",
      authority: {
        githubUserId: user.githubUserId,
        githubLogin:
          typeof level.user?.login === "string" ? level.user.login : user.githubLogin,
        permission: level.permission,
        verifiedAt: (options.now ?? new Date()).toISOString(),
      },
    };
  } catch {
    // Never the underlying error: it carries the request, and the request
    // carries the installation token.
    return refuse(
      "repository_verification_unavailable",
      "Repository access could not be confirmed with GitHub right now. Nothing has been " +
        "connected; try again shortly.",
      503
    );
  }
}
