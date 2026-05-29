/**
 * Rate Limiting Middleware
 *
 * Configurable limiters for different endpoint classes:
 *   - apiLimiter:      General API (100 req/min)
 *   - boardCreateLimiter: Board creation (10/hour)
 *   - aiLimiter:       AI calls (5/min)
 *   - exportLimiter:   Export calls (10/min)
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** Key extractor: use JWT userId or x-user-id header or IP */
function keyGenerator(req: any, res: any): string {
  return req.user?.userId || req.headers["x-user-id"] || ipKeyGenerator(req, res);
}

/**
 * General API rate limiter — 100 requests per minute per user
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "Too many requests. Please try again in a minute." },
});

/**
 * Board creation rate limiter — 10 boards per hour per user
 */
export const boardCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "Board creation limit reached. Max 10 boards per hour." },
});

/**
 * AI rate limiter — 5 AI calls per minute per user
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "AI rate limit reached. Max 5 AI calls per minute." },
});

/**
 * Export rate limiter — 10 exports per minute per user
 */
export const exportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "Export rate limit reached. Max 10 exports per minute." },
});

// ── Socket.io cursor throttle guard ────────────────────────────────

const cursorTimestamps = new Map<string, number>();
const CURSOR_THROTTLE_MS = 50; // max 20 cursor updates/sec per user

/**
 * Returns true if the cursor update should be BLOCKED (too frequent).
 */
export function shouldThrottleCursor(socketId: string): boolean {
  const now = Date.now();
  const last = cursorTimestamps.get(socketId) || 0;
  if (now - last < CURSOR_THROTTLE_MS) {
    return true; // too fast
  }
  cursorTimestamps.set(socketId, now);
  return false;
}

/**
 * Clean up cursor throttle state for disconnected sockets.
 */
export function clearCursorThrottle(socketId: string): void {
  cursorTimestamps.delete(socketId);
}
