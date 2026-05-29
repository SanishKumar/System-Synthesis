/**
 * JWT Authentication Middleware
 *
 * Two modes:
 *   1. `requireAuth`  — Rejects unauthenticated requests with 401
 *   2. `optionalAuth` — Attaches user if token present, proceeds either way
 *
 * Also exports helpers used by Socket.io and auth routes.
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ── Config ─────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || "ss-dev-secret-change-in-production";
const JWT_EXPIRES_IN_SECONDS = parseInt(process.env.JWT_EXPIRES_IN_SECONDS || "604800", 10); // 7 days

export interface JwtPayload {
  userId: string;
  userName: string;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ── Token Helpers ──────────────────────────────────────────────────

/** Sign a JWT token for a user */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN_SECONDS });
}

/** Verify and decode a JWT token. Returns null on failure. */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

// ── Middleware ──────────────────────────────────────────────────────

/**
 * Extract token from:
 *   1. Authorization: Bearer <token>
 *   2. x-auth-token header
 *   3. ?token= query param (for WebSocket upgrade)
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  if (req.headers["x-auth-token"]) {
    return req.headers["x-auth-token"] as string;
  }
  if (req.query.token) {
    return req.query.token as string;
  }
  return null;
}

/**
 * Require valid JWT. Rejects with 401 if missing/invalid.
 * Falls back to legacy x-user-id header during migration.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
      return next();
    }
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // --- Legacy fallback: accept x-user-id header during migration ---
  const legacyUserId = req.headers["x-user-id"] as string;
  if (legacyUserId) {
    req.user = {
      userId: legacyUserId,
      userName: (req.headers["x-user-name"] as string) || "Anonymous",
    };
    return next();
  }

  res.status(401).json({ error: "Authentication required" });
}

/**
 * Optional auth. Attaches user if token present but doesn't reject.
 * Falls back to legacy x-user-id header during migration.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  // --- Legacy fallback ---
  if (!req.user) {
    const legacyUserId = req.headers["x-user-id"] as string;
    if (legacyUserId) {
      req.user = {
        userId: legacyUserId,
        userName: (req.headers["x-user-name"] as string) || "Anonymous",
      };
    }
  }

  next();
}
