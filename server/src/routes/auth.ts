/**
 * Authentication Routes
 *
 * POST /api/auth/register — Create account (userName + password)
 * POST /api/auth/login    — Login and receive JWT
 * GET  /api/auth/me       — Get current user info from token
 * POST /api/auth/guest    — Get a guest JWT (anonymous access)
 *
 * User records are stored in the PostgreSQL `users` table.
 */

import { Router } from "express";
import bcrypt from "bcryptjs";
import { signToken, requireAuth, signingSecret } from "../middleware/auth.js";
import { logger } from "../middleware/logger.js";
import {
  authorizeUrl,
  exchangeCodeForIdentity,
  readGitHubOAuthConfig,
  signLinkState,
  verifyLinkState,
} from "../services/githubIdentity.js";
import { getPool } from "../services/db.js";
import { v4 as uuid } from "uuid";
import { z } from "zod";

const router = Router();
const SALT_ROUNDS = 10;
const userNameSchema = z.string().trim().min(2).max(80);
const passwordSchema = z.string().min(8).max(128);
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const registerSchema = z.object({
  userName: userNameSchema,
  email: emailSchema,
  password: passwordSchema,
});
const loginSchema = z.object({ email: emailSchema, password: passwordSchema });
const guestSchema = z.object({ userName: userNameSchema.optional() });
const profileSchema = z.object({ userName: userNameSchema });

// --- In-Memory Fallback for when Postgres is disabled ---
const IN_MEMORY_USERS: any[] = [];

/** Get the DB pool or throw a 503-appropriate error */
function getDbOrNull() {
  return getPool();
}

// ── Ensure users table exists ──────────────────────────────────────

export async function ensureUsersTable(): Promise<void> {
  const pool = getDbOrNull();
  if (!pool) {
    console.log("  ⚠️ Postgres disabled, using in-memory users");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      user_name   TEXT NOT NULL,
      email       TEXT UNIQUE,
      password_hash TEXT,
      is_guest    BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // A verified GitHub account, for accounts that have linked one. The numeric
  // id is what identity is matched on, because GitHub does not reuse it and a
  // login can be changed by its owner. Unique, so two accounts here cannot both
  // claim to be the same person on GitHub — which is the whole point of asking.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS github_user_id TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS github_linked_at TIMESTAMPTZ`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_user_id
       ON users(github_user_id) WHERE github_user_id IS NOT NULL`
  );
  console.log("  ✅ Users table ready");
}

// ── Routes ─────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { userName: string, password: string, email?: string }
 */
router.post("/register", async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid registration details" });
    const { userName, password, email } = parsed.data;

    const pool = getDbOrNull();
    
    // Check if email already exists
    if (email) {
      if (pool) {
        const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
        if (existing.rows.length > 0) {
          return res.status(409).json({ error: "Email already registered" });
        }
      } else {
        const existing = IN_MEMORY_USERS.find(u => u.email === email.toLowerCase());
        if (existing) return res.status(409).json({ error: "Email already registered" });
      }
    }

    const userId = uuid();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    if (pool) {
      await pool.query(
        `INSERT INTO users (id, user_name, email, password_hash, is_guest)
         VALUES ($1, $2, $3, $4, false)`,
        [userId, userName, email, passwordHash]
      );
    } else {
      IN_MEMORY_USERS.push({
        id: userId, user_name: userName, email, password_hash: passwordHash, is_guest: false, created_at: new Date()
      });
    }

    const token = signToken({ userId, userName, isGuest: false });

    res.status(201).json({
      token,
      user: { userId, userName, email },
    });
  } catch (err: any) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 */
router.post("/login", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid email or password format" });
    const { email, password } = parsed.data;

    const pool = getDbOrNull();
    let user;

    if (pool) {
      const result = await pool.query(
        "SELECT id, user_name, password_hash FROM users WHERE email = $1 AND is_guest = false",
        [email.toLowerCase()]
      );
      if (result.rows.length === 0) return res.status(401).json({ error: "Invalid email or password" });
      user = result.rows[0];
    } else {
      user = IN_MEMORY_USERS.find(u => u.email === email.toLowerCase() && !u.is_guest);
      if (!user) return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Update last active
    if (pool) {
      await pool.query("UPDATE users SET updated_at = NOW() WHERE id = $1", [user.id]);
    }

    const token = signToken({ userId: user.id, userName: user.user_name, isGuest: false });

    res.json({
      token,
      user: { userId: user.id, userName: user.user_name, email: email.toLowerCase() },
    });
  } catch (err: any) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me — Get current user from JWT
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { userId, userName } = req.user!;

    const pool = getDbOrNull();
    let row;
    
    if (pool) {
      const result = await pool.query(
        `SELECT id, user_name, email, is_guest, created_at,
                github_user_id, github_login, github_linked_at
           FROM users WHERE id = $1`,
        [userId]
      );
      if (result.rows.length > 0) row = result.rows[0];
    } else {
      row = IN_MEMORY_USERS.find(u => u.id === userId);
    }

    if (row) {
      res.json({
        userId: row.id || row.userId,
        userName: row.user_name,
        email: row.email,
        isGuest: row.is_guest,
        createdAt: row.created_at,
        // Absent until the account proves a GitHub identity. Reported plainly
        // so the interface can say "unverified" rather than implying otherwise.
        github: row.github_user_id
          ? {
              userId: row.github_user_id,
              login: row.github_login,
              linkedAt: row.github_linked_at,
            }
          : null,
      });
    } else {
      // Legacy user (not in DB yet)
      res.json({ userId, userName, isGuest: true });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/auth/me — Update current user's profile
 * Body: { userName: string }
 */
router.put("/me", requireAuth, async (req, res) => {
  try {
    const { userId } = req.user!;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid user name" });
    const { userName } = parsed.data;

    const pool = getDbOrNull();
    if (pool) {
      await pool.query(
        "UPDATE users SET user_name = $1, updated_at = NOW() WHERE id = $2",
        [userName.trim(), userId]
      );
    } else {
      const user = IN_MEMORY_USERS.find(u => u.id === userId);
      if (user) {
        user.user_name = userName.trim();
        user.updated_at = new Date();
      }
    }

    // We must return a new token because userName is baked into the JWT
    const token = signToken({
      userId,
      userName: userName.trim(),
      isGuest: req.user!.isGuest ?? userId.startsWith("guest-"),
    });
    res.json({ token, userName: userName.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/guest — Issue a guest JWT for anonymous access
 * Guest tokens allow creating/viewing public boards but
 * don't persist a user account.
 */
router.post("/guest", async (req, res) => {
  try {
    const parsed = guestSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid guest profile" });
    const { userName } = parsed.data;
    const guestName = userName || generateGuestName();
    const guestId = `guest-${uuid().slice(0, 8)}`;

    const pool = getDbOrNull();
    if (pool) {
      await pool.query(
        `INSERT INTO users (id, user_name, is_guest)
         VALUES ($1, $2, true)
         ON CONFLICT (id) DO NOTHING`,
        [guestId, guestName]
      );
    } else {
      if (!IN_MEMORY_USERS.find(u => u.id === guestId)) {
        IN_MEMORY_USERS.push({ id: guestId, user_name: guestName, is_guest: true, created_at: new Date() });
      }
    }

    const token = signToken({ userId: guestId, userName: guestName, isGuest: true });

    res.json({
      token,
      user: { userId: guestId, userName: guestName, isGuest: true },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/upgrade — Convert a guest account to a permanent account
 * Body: { userName: string, email: string, password: string }
 */
router.post("/upgrade", requireAuth, async (req, res) => {
  try {
    const { userId } = req.user!;
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid account details" });
    const { userName, email, password } = parsed.data;

    const pool = getDbOrNull();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    if (pool) {
      const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
      if (existing.rows.length > 0 && existing.rows[0].id !== userId) {
        return res.status(409).json({ error: "Email already registered" });
      }

      await pool.query(
        `UPDATE users 
         SET user_name = $1, email = $2, password_hash = $3, is_guest = false 
         WHERE id = $4 AND is_guest = true`,
        [userName.trim(), email.toLowerCase(), passwordHash, userId]
      );
    } else {
      const user = IN_MEMORY_USERS.find(u => u.id === userId && u.is_guest);
      if (!user) return res.status(404).json({ error: "Guest user not found" });
      const existing = IN_MEMORY_USERS.find(u => u.email === email.toLowerCase());
      if (existing && existing.id !== userId) return res.status(409).json({ error: "Email already registered" });
      user.user_name = userName.trim();
      user.email = email.toLowerCase();
      user.password_hash = passwordHash;
      user.is_guest = false;
    }

    const token = signToken({ userId, userName: userName.trim(), isGuest: false });
    res.json({ token, user: { userId, userName: userName.trim(), email: email.toLowerCase() } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub identity ────────────────────────────────────────────────

/**
 * Where GitHub returns the reviewer after they authorise. Registered on the App
 * and sent again at exchange, so a code issued for this deployment cannot be
 * redeemed against another.
 */
function callbackUrl(): string {
  const base = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`;
  return new URL("/api/auth/github/callback", base).toString();
}

function frontendUrl(path: string): string {
  return new URL(path, process.env.FRONTEND_URL || "http://localhost:3000").toString();
}

/**
 * GET /api/auth/github/start — begin proving which GitHub account this is.
 *
 * Returns the URL rather than redirecting, because the caller is a script in a
 * page holding a bearer token: a redirect would arrive without it.
 */
router.get("/github/start", requireAuth, (req, res) => {
  const config = readGitHubOAuthConfig();
  if (!config) {
    return res.status(503).json({
      error: "GitHub identity is not configured on this server",
      code: "not_configured",
    });
  }
  if (req.user!.isGuest ?? req.user!.userId.startsWith("guest-")) {
    return res.status(403).json({ error: "A permanent account is required to link GitHub" });
  }
  const state = signLinkState(req.user!.userId, signingSecret());
  res.setHeader("Cache-Control", "no-store");
  res.json({ url: authorizeUrl(config, state, callbackUrl()) });
});

/**
 * GET /api/auth/github/callback — GitHub returns the reviewer here.
 *
 * The account being linked comes from the signed state, never from the query,
 * so a callback cannot attach an identity to somebody else's account. Failures
 * return the reviewer to the interface with a stable reason rather than a stack.
 */
router.get("/github/callback", async (req, res) => {
  const back = (reason: string) =>
    res.redirect(frontendUrl(`/integrations?github=${encodeURIComponent(reason)}`));

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) return back("state_invalid");

  const verified = verifyLinkState(state, signingSecret());
  if (!verified) return back("state_invalid");

  try {
    const identity = await exchangeCodeForIdentity(code, { redirectUri: callbackUrl() });
    if (identity.status !== "ok") {
      logger.warn("GitHub identity link failed", {
        userId: verified.userId,
        code: identity.code,
        detail: identity.detail,
      });
      return back(identity.code);
    }

    const pool = getDbOrNull();
    if (pool) {
      // One GitHub account, one reviewer. The partial unique index refuses the
      // second claim rather than letting two accounts answer to one person.
      const taken = await pool.query(
        "SELECT id FROM users WHERE github_user_id = $1 AND id <> $2",
        [identity.githubUserId, verified.userId]
      );
      if (taken.rows.length > 0) return back("already_linked");
      await pool.query(
        `UPDATE users
            SET github_user_id = $2, github_login = $3,
                github_linked_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [verified.userId, identity.githubUserId, identity.login]
      );
    } else {
      const claimed = IN_MEMORY_USERS.find(
        (u) => u.github_user_id === identity.githubUserId && u.id !== verified.userId
      );
      if (claimed) return back("already_linked");
      const user = IN_MEMORY_USERS.find((u) => u.id === verified.userId);
      if (user) {
        user.github_user_id = identity.githubUserId;
        user.github_login = identity.login;
        user.github_linked_at = new Date();
      }
    }
    return back("linked");
  } catch (err: any) {
    logger.warn("GitHub identity link failed", {
      userId: verified.userId,
      code: "unexpected_error",
      detail: err?.message,
    });
    return back("unexpected_error");
  }
});

/**
 * The GitHub account an account has proved, if any.
 *
 * Read wherever a decision has to be attributed to a person rather than to a
 * session. Returns nulls rather than throwing for an account that never linked
 * one, because "not linked" is an answer the caller has to act on.
 */
export async function linkedGitHubIdentity(
  userId: string
): Promise<{ githubUserId: string | null; githubLogin: string | null }> {
  const pool = getDbOrNull();
  if (pool) {
    const found = await pool.query(
      "SELECT github_user_id, github_login FROM users WHERE id = $1",
      [userId]
    );
    const row = found.rows[0];
    return {
      githubUserId: row?.github_user_id ?? null,
      githubLogin: row?.github_login ?? null,
    };
  }
  const user = IN_MEMORY_USERS.find((u) => u.id === userId);
  return {
    githubUserId: user?.github_user_id ?? null,
    githubLogin: user?.github_login ?? null,
  };
}

/**
 * Brings the stored display login back in line with GitHub.
 *
 * A login is a label the account holder can change; the numeric id is what the
 * link is anchored to. Called only once GitHub has confirmed the id still
 * matches, so this renames a known account rather than adopting a new one.
 */
export async function refreshGitHubLogin(userId: string, login: string): Promise<void> {
  const pool = getDbOrNull();
  if (pool) {
    await pool.query(
      "UPDATE users SET github_login = $2 WHERE id = $1 AND github_login IS DISTINCT FROM $2",
      [userId, login]
    );
    return;
  }
  const user = IN_MEMORY_USERS.find((u) => u.id === userId);
  if (user) user.github_login = login;
}

/** DELETE /api/auth/github — unlink, so a mistaken or shared account can be undone. */
router.delete("/github", requireAuth, async (req, res) => {
  try {
    const pool = getDbOrNull();
    if (pool) {
      await pool.query(
        `UPDATE users SET github_user_id = NULL, github_login = NULL,
                          github_linked_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [req.user!.userId]
      );
    } else {
      const user = IN_MEMORY_USERS.find((u) => u.id === req.user!.userId);
      if (user) {
        user.github_user_id = null;
        user.github_login = null;
        user.github_linked_at = null;
      }
    }
    res.json({ github: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function generateGuestName(): string {
  const adjectives = ["Swift", "Clever", "Bold", "Bright", "Sharp", "Keen"];
  const nouns = ["Architect", "Builder", "Designer", "Engineer", "Planner", "Mapper"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

export default router;
