import pg from "pg";
const { Pool } = pg;

export let pool: pg.Pool | null = null;

/**
 * SQL schema for the boards and snapshots tables.
 * Uses IF NOT EXISTS so it's safe to re-run.
 */
const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS boards (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT 'Untitled Board',
    description   TEXT DEFAULT '',
    owner_id      TEXT NOT NULL DEFAULT 'system',
    owner_name    TEXT NOT NULL DEFAULT 'Unknown',
    is_public     BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ,
    current_data  JSONB NOT NULL DEFAULT '{"nodes": [], "edges": []}'::jsonb
  );

  ALTER TABLE boards ADD COLUMN IF NOT EXISTS current_data JSONB NOT NULL DEFAULT '{"nodes": [], "edges": []}'::jsonb;

  CREATE TABLE IF NOT EXISTS board_snapshots (
    id            SERIAL PRIMARY KEY,
    board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    version       INT NOT NULL,
    data          JSONB NOT NULL,
    created_by    TEXT,
    created_by_name TEXT,
    name          TEXT,
    parent_version INT,
    source_board_id TEXT,
    source_version INT,
    change_summary JSONB NOT NULL DEFAULT '{"changes": [], "stats": {"added": 0, "removed": 0, "changed": 0, "total": 0}}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(board_id, version)
  );

  ALTER TABLE board_snapshots ADD COLUMN IF NOT EXISTS created_by_name TEXT;
  ALTER TABLE board_snapshots ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE board_snapshots ADD COLUMN IF NOT EXISTS parent_version INT;
  ALTER TABLE board_snapshots ADD COLUMN IF NOT EXISTS source_board_id TEXT;
  ALTER TABLE board_snapshots ADD COLUMN IF NOT EXISTS source_version INT;
  ALTER TABLE board_snapshots ADD COLUMN IF NOT EXISTS change_summary JSONB NOT NULL DEFAULT '{"changes": [], "stats": {"added": 0, "removed": 0, "changed": 0, "total": 0}}'::jsonb;

  -- Backfill current_data from the latest snapshot for existing boards
  UPDATE boards b
  SET current_data = s.data
  FROM (
      SELECT board_id, data,
             ROW_NUMBER() OVER(PARTITION BY board_id ORDER BY version DESC) as rn
      FROM board_snapshots
  ) s
  WHERE b.id = s.board_id AND s.rn = 1 AND b.current_data = '{"nodes": [], "edges": []}'::jsonb;

  CREATE INDEX IF NOT EXISTS idx_snapshots_board_id ON board_snapshots(board_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_board_version ON board_snapshots(board_id, version DESC);
  CREATE INDEX IF NOT EXISTS idx_boards_owner_id ON boards(owner_id);

  CREATE TABLE IF NOT EXISTS board_members (
    board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    invited_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (board_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS board_invitations (
    id            TEXT PRIMARY KEY,
    board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_by    TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_by       TEXT,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id            TEXT PRIMARY KEY,
    board_id      TEXT,
    actor_id      TEXT NOT NULL,
    action        TEXT NOT NULL,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS board_updates (
    sequence      BIGSERIAL PRIMARY KEY,
    board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    update_hash   TEXT NOT NULL,
    update_data   BYTEA NOT NULL,
    actor_id      TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (board_id, update_hash)
  );

  CREATE TABLE IF NOT EXISTS board_document_snapshots (
    board_id      TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
    state_data    BYTEA NOT NULL,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_board_invites_board ON board_invitations(board_id);
  CREATE INDEX IF NOT EXISTS idx_audit_board_created ON audit_logs(board_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_board_updates_replay ON board_updates(board_id, sequence);
`;

/**
 * Initialize the PostgreSQL connection pool and run migrations.
 * Returns true if the database is available, false if not configured.
 */
export async function initDatabase(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("  ⚡ DATABASE_URL not configured — Postgres disabled, using Redis/memory only");
    return false;
  }

  try {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000, // 20s to allow Serverless DBs (like Neon) to wake up from cold starts
      // Support SSL for cloud-hosted Postgres (Neon, Supabase, etc.)
      ssl: databaseUrl.includes("sslmode=require") || databaseUrl.startsWith("postgresql://") 
        ? { rejectUnauthorized: false }
        : undefined,
    });

    // Test connection
    const client = await pool.connect();
    console.log("  ✅ PostgreSQL connected");

    // Run migrations
    await client.query(MIGRATION_SQL);
    console.log("  ✅ PostgreSQL migrations applied");
    client.release();

    return true;
  } catch (err: any) {
    console.error("  ⚠ PostgreSQL connection failed:", err.message);
    pool = null;
    return false;
  }
}

/**
 * Get the PostgreSQL pool. Returns null if not initialized.
 */
export function getPool(): pg.Pool | null {
  return pool;
}

/**
 * Check if PostgreSQL is available.
 */
export function isDbAvailable(): boolean {
  return pool !== null;
}

/**
 * Gracefully close the pool.
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("  ✅ PostgreSQL pool closed");
  }
}
