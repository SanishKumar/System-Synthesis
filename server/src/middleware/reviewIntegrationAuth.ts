import type { NextFunction, Request, Response } from "express";
import {
  authenticateReviewIntegrationToken,
  findOidcReviewIntegration,
  isVerifiedIntegration,
  recordIntegrationAuthority,
  type ReviewIntegrationRecord,
} from "../services/reviewIntegrationRepository.js";
import { verifyRepositoryAuthority } from "../services/repositoryAuthority.js";
import { verifyGitHubOidcToken, type GitHubOidcClaims } from "../services/githubOidc.js";

declare global {
  namespace Express {
    interface Request {
      reviewIntegration?: ReviewIntegrationRecord;
      /**
       * What GitHub said about the run that sent this request. Present only
       * when it authenticated with an identity token rather than a stored one.
       */
      reviewOidcClaims?: GitHubOidcClaims;
    }
  }
}

/**
 * Three base64url segments: the shape of a signed identity token, and of
 * nothing this service issues itself. Which credential arrived is settled by
 * this before either is examined, so a token is never tried as the other kind.
 */
const IDENTITY_TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * How long authority established once is trusted before it is established
 * again.
 *
 * Confirming on every ingestion would put a GitHub call on the hot path of
 * every pull-request push and make a rate limit an outage. Never confirming
 * again leaves a credential publishing indefinitely after its owner has lost
 * the access that justified it. An hour bounds that window.
 */
export const AUTHORITY_REVALIDATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a failed revalidation is remembered before another is attempted.
 *
 * A refusal leaves the stored proof stale, so without this every subsequent
 * delivery would ask GitHub again and a repository whose owner has lost access
 * would generate a request per push forever. The cost is that restoring access
 * takes effect up to this long afterwards.
 */
export const AUTHORITY_FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * Revalidations in progress, so a burst of deliveries shares one lookup.
 *
 * Duplicate and concurrent deliveries are ordinary here: a push, a retry and a
 * re-run can arrive together, and each would otherwise find the same stale
 * proof and ask GitHub separately.
 *
 * This map is per process. Across several instances the bound is one lookup per
 * instance per interval, and what keeps them from disagreeing is the
 * compare-and-set on the write, not this.
 */
const revalidating = new Map<string, Promise<AuthorityOutcome>>();

/**
 * The refusal a failed revalidation produced, held until it may be retried.
 *
 * The refusal itself is kept, not just the deadline. A lost admin role and an
 * unreachable GitHub call for different responses, and answering both with
 * "try again shortly" for the next minute tells somebody whose permission was
 * removed to wait for something that will never change on its own.
 */
const backoff = new Map<
  string,
  { until: number; code: string; message: string; httpStatus: number }
>();

export function resetAuthorityRevalidationForTests(): void {
  revalidating.clear();
  backoff.clear();
}

type AuthorityOutcome =
  | { status: "current"; integration: ReviewIntegrationRecord }
  | { status: "refused"; code: string; message: string; httpStatus: number };

/**
 * Authenticate a delivery by the credential it presents: a repository-scoped
 * ingestion token, or the identity token GitHub issued to the run sending it.
 * Both are deliberately separate from user JWTs and are only accepted in a
 * Bearer header so they cannot leak through URLs.
 *
 * Does no network work per request. Rate limiting runs between this and the
 * authority refresh, so an unauthenticated flood is rejected before it can
 * make this server ask GitHub anything on its behalf. An identity token is
 * checked against a key set that is held and refetched at most once a minute
 * whatever arrives, and everything that can be decided from the token alone is
 * decided before that.
 */
export async function requireReviewIntegration(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  if (!token) {
    res.status(401).json({ error: "Repository ingestion credential required" });
    return;
  }
  if (IDENTITY_TOKEN_SHAPE.test(token)) {
    await authenticateIdentityToken(token, req, res, next);
    return;
  }
  try {
    const integration = await authenticateReviewIntegrationToken(token);
    if (!integration) {
      res.status(401).json({ error: "Invalid or revoked repository ingestion credential" });
      return;
    }
    // Issued before this deployment confirmed who may connect a repository, or
    // carrying evidence that no longer meets the bar. Refused rather than
    // honoured: the capability it carries is the one the check exists for, and
    // nothing stored can establish that it was ever legitimate. Said plainly,
    // because the holder already has the token and needs to know that
    // reconnecting is what fixes it.
    if (!isVerifiedIntegration(integration)) {
      res.status(403).json({
        error:
          "This credential was issued before repository access was verified and is no " +
          "longer accepted. Reconnect the repository to issue a new one; connecting now " +
          "confirms that your GitHub account administers it.",
        code: "integration_unverified",
      });
      return;
    }
    req.reviewIntegration = integration;
    next();
  } catch {
    // Authentication storage failures must fail closed.
    res.status(503).json({ error: "Repository credential verification unavailable" });
  }
}

/**
 * Authenticate a delivery by the identity token GitHub issued to its run.
 *
 * A verified token says which repository a request came from. It does not say
 * the repository was ever connected here, so the connection is still what
 * decides whose account the review belongs to, and it has to be one whose
 * administrator chose to accept identity tokens. A connection made for a
 * stored token is never matched: somebody who keeps that token behind an
 * approval step has not agreed to a second way in.
 */
async function authenticateIdentityToken(
  token: string,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const verdict = await verifyGitHubOidcToken(token);
    if (verdict.status === "refused") {
      res.status(verdict.httpStatus).json({ error: verdict.message, code: verdict.code });
      return;
    }
    const claims = verdict.claims;
    // A review belongs to a pull request. A run started by anything else has
    // no pull request for one to be about, however genuine its token is.
    if (claims.eventName !== "pull_request") {
      res.status(403).json({
        error:
          "Browser reviews are created from pull_request runs only. This run was started " +
          "by a different event.",
        code: "oidc_event_unsupported",
      });
      return;
    }
    const lookup = await findOidcReviewIntegration("github", claims.repository);
    if (lookup.status === "none") {
      res.status(403).json({
        error:
          `No connection for ${claims.repository} accepts GitHub Actions identity tokens. ` +
          "An administrator of the repository connects it here and chooses GitHub OIDC; a " +
          "connection made for an ingestion token only accepts that token.",
        code: "repository_not_connected_for_oidc",
      });
      return;
    }
    if (lookup.status === "ambiguous") {
      res.status(409).json({
        error:
          "More than one connection is waiting for this repository's identity tokens, so " +
          "nothing has been recorded. All but one of them must be revoked.",
        code: "repository_connection_ambiguous",
      });
      return;
    }
    if (!isVerifiedIntegration(lookup.integration)) {
      res.status(403).json({
        error:
          "This repository's connection carries no proof that its owner administers it. " +
          "Reconnect the repository.",
        code: "integration_unverified",
      });
      return;
    }
    req.reviewIntegration = lookup.integration;
    req.reviewOidcClaims = claims;
    next();
  } catch {
    // Storage or verification failing must not be read as acceptance.
    res.status(503).json({ error: "Repository credential verification unavailable" });
  }
}

async function refreshAuthority(
  integration: ReviewIntegrationRecord
): Promise<AuthorityOutcome> {
  const authority = await verifyRepositoryAuthority(
    integration.repository,
    {
      githubUserId: integration.verifiedGithubUserId,
      githubLogin: integration.verifiedGithubLogin,
    },
    // For a connection that accepts identity tokens, which repository the name
    // refers to is part of what has to be established again. Proof that an
    // administrator still administers "that name" is not enough to go on
    // matching tokens against an id nobody has just confirmed.
    { requireRepositoryId: integration.authMode === "oidc" }
  );
  if (authority.status === "refused") {
    backoff.set(integration.id, {
      until: Date.now() + AUTHORITY_FAILURE_BACKOFF_MS,
      code: authority.code,
      message: authority.message,
      httpStatus: authority.httpStatus,
    });
    return {
      status: "refused",
      code: authority.code,
      message: authority.message,
      httpStatus: authority.httpStatus,
    };
  }

  // Conditional on the credential this request authenticated with, and on the
  // proof it read. A rotation or a revocation while the lookup was in flight
  // means the row this would write to is no longer the row it was about.
  const persisted = await recordIntegrationAuthority(integration.id, authority.authority, {
    previousVerifiedAt: integration.verifiedAt,
  });
  if (!persisted) {
    return {
      status: "refused",
      code: "integration_changed",
      message:
        "This credential was rotated or revoked while its repository access was being " +
        "confirmed. Nothing has been recorded; retry with the current credential.",
      httpStatus: 409,
    };
  }

  backoff.delete(integration.id);
  return {
    status: "current",
    integration: {
      ...integration,
      verifiedGithubLogin: authority.authority.githubLogin,
      verifiedPermission: authority.authority.permission,
      verifiedAt: authority.authority.verifiedAt,
      verifiedRepositoryId: authority.authority.repositoryId,
    },
  };
}

/**
 * Establish repository authority again once the stored proof has gone stale.
 *
 * Runs after rate limiting, so the GitHub lookup is behind the same limit as
 * everything else, and shares one lookup across concurrent deliveries.
 *
 * A refusal stops the request here. Nothing is stored and no check is
 * published: an authority that cannot be established is the case this exists
 * for, and GitHub being unreachable does not make it established.
 */
export async function requireCurrentRepositoryAuthority(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const integration = req.reviewIntegration;
  if (!integration) {
    res.status(401).json({ error: "Repository ingestion credential required" });
    return;
  }

  const verifiedAt = Date.parse(integration.verifiedAt || "");
  const age = Number.isFinite(verifiedAt)
    ? Date.now() - verifiedAt
    : Number.POSITIVE_INFINITY;
  if (age < AUTHORITY_REVALIDATION_INTERVAL_MS) {
    next();
    return;
  }

  // The same answer the attempt gave, not a generic one. Nothing has changed
  // since, and repeating what was actually established is more useful than
  // reporting an outage that is not happening.
  const held = backoff.get(integration.id);
  if (held && Date.now() < held.until) {
    res.status(held.httpStatus).json({ error: held.message, code: held.code });
    return;
  }

  try {
    let attempt = revalidating.get(integration.id);
    if (!attempt) {
      attempt = refreshAuthority(integration).finally(() => {
        revalidating.delete(integration.id);
      });
      revalidating.set(integration.id, attempt);
    }
    const outcome = await attempt;
    if (outcome.status === "refused") {
      res.status(outcome.httpStatus).json({
        error: outcome.message,
        code: outcome.code,
      });
      return;
    }
    req.reviewIntegration = outcome.integration;
    next();
  } catch {
    res.status(503).json({
      error: "Repository access could not be confirmed right now. Nothing has been recorded.",
      code: "repository_verification_unavailable",
    });
  }
}

/**
 * Confirm an identity token came from the repository this connection is about.
 *
 * Runs after authority has been established, because that is what records the
 * repository's id. The token was matched to this connection by name, and a
 * name can be released and registered by somebody else; the id cannot. So a
 * token is accepted only from the repository whose id was confirmed when an
 * administrator's authority over it was last established, and a difference is
 * a refusal rather than a reason to look again: whoever holds a name now does
 * not get to make this server ask GitHub about it.
 */
export function requireOidcRepositoryIdentity(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const claims = req.reviewOidcClaims;
  if (!claims) {
    next();
    return;
  }
  const established = req.reviewIntegration?.verifiedRepositoryId;
  if (!established || established !== claims.repositoryId) {
    res.status(403).json({
      error:
        "This identity token comes from a different repository than the one this " +
        "connection was verified for. If the repository was renamed, transferred or " +
        "recreated, an administrator needs to connect it again.",
      code: "repository_identity_mismatch",
    });
    return;
  }
  next();
}
