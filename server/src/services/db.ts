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

  CREATE TABLE IF NOT EXISTS architecture_reviews (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    title           TEXT NOT NULL,
    repository      TEXT,
    source_path     TEXT NOT NULL,
    base_revision   TEXT NOT NULL,
    head_revision   TEXT NOT NULL,
    base_graph      JSONB NOT NULL,
    head_graph      JSONB NOT NULL,
    policy          JSONB NOT NULL DEFAULT '{}'::jsonb,
    report          JSONB NOT NULL,
    decision        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (decision IN ('pending', 'approved', 'rejected')),
    decision_note   TEXT,
    decided_at      TIMESTAMPTZ,
    revision        INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS integration_provider TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS external_repository TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS external_change_number INT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS external_change_url TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS external_change_version BIGINT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS workflow_run_id TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS workflow_run_url TEXT;
  -- Rows created before analyzer provenance keep NULL and are reported as
  -- produced by an unknown analyzer rather than silently assumed current.
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS analyzer_version TEXT;
  -- Whether the decision this review holds has reached GitHub. Kept beside the
  -- review so it can be marked pending in the same transaction that changes the
  -- decision; a crash between the two would otherwise leave the interface
  -- claiming a gate was published when publication was never attempted.
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_status TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_conclusion TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_revision INT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_head TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_reason TEXT;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_attempted_at TIMESTAMPTZ;
  ALTER TABLE architecture_reviews ADD COLUMN IF NOT EXISTS github_sync_succeeded_at TIMESTAMPTZ;

  CREATE TABLE IF NOT EXISTS architecture_review_integrations (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    provider        TEXT NOT NULL CHECK (provider IN ('github')),
    repository      TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    token_prefix    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    UNIQUE(owner_id, provider, repository)
  );

  CREATE TABLE IF NOT EXISTS architecture_review_events (
    id              TEXT PRIMARY KEY,
    review_id       TEXT NOT NULL REFERENCES architecture_reviews(id) ON DELETE CASCADE,
    actor_id        TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    review_revision INT NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_board_invites_board ON board_invitations(board_id);
  CREATE INDEX IF NOT EXISTS idx_audit_board_created ON audit_logs(board_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_board_updates_replay ON board_updates(board_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_architecture_reviews_owner_updated
    ON architecture_reviews(owner_id, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_architecture_reviews_external_change
    ON architecture_reviews(
      owner_id,
      integration_provider,
      external_repository,
      external_change_number
    )
    WHERE integration_provider IS NOT NULL
      AND external_repository IS NOT NULL
      AND external_change_number IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_architecture_review_events_review
    ON architecture_review_events(review_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_architecture_review_integrations_owner
    ON architecture_review_integrations(owner_id, updated_at DESC);
`;

/** Whether the connection string asks for TLS to be off, as libpq spells it. */
export function sslDisabled(databaseUrl: string): boolean {
  try {
    return new URL(databaseUrl).searchParams.get("sslmode") === "disable";
  } catch {
    return false;
  }
}

/**
 * Why persistence is or is not active.
 *
 * `disabled` and `failed` both mean "no PostgreSQL", but they are not the same
 * situation and must not be treated alike. Running without a database is a
 * legitimate development choice; failing to reach one the operator explicitly
 * configured is an error, and quietly serving memory-backed storage in that
 * case loses every write on the next restart while looking healthy.
 */
export type PersistenceState =
  | { mode: "disabled" }
  | { mode: "active" }
  | { mode: "failed"; reason: string };

let persistenceState: PersistenceState = { mode: "disabled" };

export function getPersistenceState(): PersistenceState {
  return persistenceState;
}

/**
 * A configured database that cannot be reached or migrated must stop a
 * production boot. The platform can then fail the deploy and keep the previous
 * release, instead of promoting an instance whose data disappears on restart.
 * Development stays runnable, loudly.
 */
export function shouldHaltOnPersistenceFailure(
  state: PersistenceState,
  nodeEnv: string | undefined
): boolean {
  return state.mode === "failed" && nodeEnv === "production";
}

/** Records a schema failure discovered after the pool itself came up. */
export function markPersistenceFailed(reason: string): void {
  persistenceState = { mode: "failed", reason };
  pool = null;
}

/**
 * Initialize the PostgreSQL connection pool and run migrations.
 * Returns true if the database is available, false otherwise; inspect
 * `getPersistenceState()` to tell an intended memory mode from a failure.
 */
export async function initDatabase(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    persistenceState = { mode: "disabled" };
    console.log("  ⚡ DATABASE_URL not configured — Postgres disabled, using Redis/memory only");
    return false;
  }

  try {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000, // 20s to allow Serverless DBs (like Neon) to wake up from cold starts
      // Support SSL for cloud-hosted Postgres (Neon, Supabase, etc.). An
      // explicit `sslmode=disable` is honoured rather than overridden, because
      // a database reached over a loopback interface — a test service in CI, a
      // local instance — has no TLS to negotiate, and forcing it there fails
      // the connection outright.
      //
      // Whether a verified certificate should be required for the rest is a
      // separate question, and still open: see docs/KNOWN_LIMITATIONS.md.
      ssl: sslDisabled(databaseUrl)
        ? undefined
        : databaseUrl.includes("sslmode=require") || databaseUrl.startsWith("postgresql://")
          ? { rejectUnauthorized: false }
          : undefined,
    });

    // Test connection
    const client = await pool.connect();
    console.log("  ✅ PostgreSQL connected");

    // Run migrations. PostgreSQL DDL is transactional, so an explicit
    // transaction keeps a failed migration from leaving a half-applied schema
    // that the next boot would treat as already migrated.
    try {
      await client.query("BEGIN");
      await client.query(MIGRATION_SQL);
      await client.query("COMMIT");
    } catch (migrationError) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw migrationError;
    } finally {
      client.release();
    }
    console.log("  ✅ PostgreSQL migrations applied");

    persistenceState = { mode: "active" };
    return true;
  } catch (err: any) {
    // DATABASE_URL was set, so memory storage is not what the operator asked
    // for. Record the failure rather than silently degrading.
    persistenceState = { mode: "failed", reason: err?.message || String(err) };
    console.error("  ⚠ PostgreSQL unavailable:", persistenceState.reason);
    if (pool) await pool.end().catch(() => undefined);
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
