import type { NextFunction, Request, Response } from "express";
import {
  authenticateReviewIntegrationToken,
  type ReviewIntegrationRecord,
} from "../services/reviewIntegrationRepository.js";

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
    req.reviewIntegration = integration;
    next();
  } catch {
    // Authentication storage failures must fail closed.
    res.status(503).json({ error: "Repository credential verification unavailable" });
  }
}
