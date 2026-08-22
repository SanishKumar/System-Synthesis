import type { NextFunction, Request, Response } from "express";
import {
  authenticateReviewIntegrationToken,
  isVerifiedIntegration,
  recordIntegrationAuthority,
  type ReviewIntegrationRecord,
} from "../services/reviewIntegrationRepository.js";
import { verifyRepositoryAuthority } from "../services/repositoryAuthority.js";

/**
 * How long authority established once is trusted before it is established
 * again.
 *
 * Confirming on every ingestion would put a GitHub call on the hot path of
 * every pull-request push and make a rate limit an outage. Never confirming
 * again leaves a credential publishing indefinitely after its owner has lost
 * the access that justified it. An hour bounds that window while costing about
 * one extra request per repository per hour.
 *
 * A revalidation that cannot be completed refuses the ingestion. Nothing is
 * stored and no check is published: an unestablished authority is the case
 * this check exists for, and GitHub being unreachable does not make it
 * established.
 */
export const AUTHORITY_REVALIDATION_INTERVAL_MS = 60 * 60 * 1000;

declare global {
  namespace Express {
    interface Request {
      reviewIntegration?: ReviewIntegrationRecord;
    }
  }
}

/**
 * Authenticate a repository-scoped ingestion token. These credentials are
 * deliberately separate from user JWTs and are only accepted in a Bearer
 * header so they cannot leak through URLs.
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
  try {
    const integration = await authenticateReviewIntegrationToken(token);
    if (!integration) {
      res.status(401).json({ error: "Invalid or revoked repository ingestion credential" });
      return;
    }
    // Issued before this deployment confirmed who may connect a repository.
    // Refused rather than honoured: the capability it carries is the one the
    // check exists for, and nothing stored can establish that it was ever
    // legitimate. Said plainly, because the holder already has the token and
    // needs to know that reconnecting is what fixes it.
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
    const verifiedAt = Date.parse(integration.verifiedAt || "");
    const age = Number.isFinite(verifiedAt)
      ? Date.now() - verifiedAt
      : Number.POSITIVE_INFINITY;
    if (age >= AUTHORITY_REVALIDATION_INTERVAL_MS) {
      const authority = await verifyRepositoryAuthority(integration.repository, {
        githubUserId: integration.verifiedGithubUserId,
        githubLogin: integration.verifiedGithubLogin,
      });
      if (authority.status === "refused") {
        res.status(authority.httpStatus).json({
          error: authority.message,
          code: authority.code,
        });
        return;
      }
      await recordIntegrationAuthority(integration.id, authority.authority);
      integration.verifiedGithubLogin = authority.authority.githubLogin;
      integration.verifiedPermission = authority.authority.permission;
      integration.verifiedAt = authority.authority.verifiedAt;
    }
    req.reviewIntegration = integration;
    next();
  } catch {
    // Authentication storage failures must fail closed.
    res.status(503).json({ error: "Repository credential verification unavailable" });
  }
}
