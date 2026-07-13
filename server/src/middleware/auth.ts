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

const DEVELOPMENT_SECRET = "ss-development-only-secret";
const JWT_SECRET = process.env.JWT_SECRET || DEVELOPMENT_SECRET;
const JWT_EXPIRES_IN_SECONDS = parseInt(process.env.JWT_EXPIRES_IN_SECONDS || "604800", 10); // 7 days

if (process.env.NODE_ENV === "production" && JWT_SECRET === DEVELOPMENT_SECRET) {
  throw new Error("JWT_SECRET must be configured in production");
}

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
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    audience: "system-synthesis-client",
    issuer: "system-synthesis",
    expiresIn: JWT_EXPIRES_IN_SECONDS,
  });
}

/** Verify and decode a JWT token. Returns null on failure. */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "system-synthesis-client",
      issuer: "system-synthesis",
    }) as JwtPayload;
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
 * Tokens are deliberately not accepted from query strings because URLs are
 * commonly captured in logs and browser history.
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  if (req.headers["x-auth-token"]) {
    return req.headers["x-auth-token"] as string;
  }
  return null;
}

/**
 * Require valid JWT. Rejects with 401 if missing/invalid.
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

  res.status(401).json({ error: "Authentication required" });
}

/**
 * Optional auth. Attaches user if token present but doesn't reject.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}
