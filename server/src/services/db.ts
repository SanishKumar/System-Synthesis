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
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(board_id, version)
  );

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
