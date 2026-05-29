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
import { signToken, requireAuth } from "../middleware/auth.js";
import { getPool } from "../services/db.js";
import { v4 as uuid } from "uuid";

const router = Router();
const SALT_ROUNDS = 10;

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
  console.log("  ✅ Users table ready");
}

// ── Routes ─────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { userName: string, password: string, email?: string }
 */
router.post("/register", async (req, res) => {
  try {
    const { userName, password, email } = req.body;

    if (!userName || typeof userName !== "string" || userName.length < 2) {
      return res.status(400).json({ error: "userName is required (min 2 characters)" });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "password is required (min 6 characters)" });
    }

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
        [userId, userName.trim(), email?.toLowerCase() || null, passwordHash]
      );
    } else {
      IN_MEMORY_USERS.push({
        id: userId, user_name: userName.trim(), email: email?.toLowerCase() || null, password_hash: passwordHash, is_guest: false, created_at: new Date()
      });
    }

    const token = signToken({ userId, userName: userName.trim() });

    res.status(201).json({
      token,
      user: { userId, userName: userName.trim(), email: email?.toLowerCase() || null },
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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }

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

    const token = signToken({ userId: user.id, userName: user.user_name });

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
        "SELECT id, user_name, email, is_guest, created_at FROM users WHERE id = $1",
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
 * POST /api/auth/guest — Issue a guest JWT for anonymous access
 * Guest tokens allow creating/viewing public boards but
 * don't persist a user account.
 */
router.post("/guest", async (req, res) => {
  try {
    const { userName } = req.body;
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

    const token = signToken({ userId: guestId, userName: guestName });

    res.json({
      token,
      user: { userId: guestId, userName: guestName, isGuest: true },
    });
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
