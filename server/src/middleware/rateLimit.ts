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

/** Key extractor: use verified JWT identity or IP */
function keyGenerator(req: any, res: any): string {
  return req.user?.userId || ipKeyGenerator(req, res);
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

/** Architecture source comparisons are CPU-bound and accept larger payloads. */
export const reviewCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "Architecture review limit reached. Max 20 reviews per hour." },
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
const CURSOR_THROTTLE_MS = 100; // max 10 cursor updates/sec per user
const socketEventWindows = new Map<string, { startedAt: number; count: number }>();

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
  for (const key of socketEventWindows.keys()) {
    if (key.startsWith(`${socketId}:`)) socketEventWindows.delete(key);
  }
}

/** Fixed-window socket event limiter, scoped by socket and event name. */
export function shouldThrottleSocketEvent(
  socketId: string,
  eventName: string,
  maxEvents: number,
  windowMs: number
): boolean {
  const key = `${socketId}:${eventName}`;
  const now = Date.now();
  const current = socketEventWindows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    socketEventWindows.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > maxEvents;
}
