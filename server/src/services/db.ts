import { readFileSync } from "node:fs";
import pg from "pg";
import {
  connectionHost,
  decideTransportTls,
  describeTls,
  readUrlTlsIntent,
  withoutDriverSslParameters,
  type TransportTls,
} from "./transportSecurity.js";
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
    -- What was established about the connecting account when the credential
    -- was issued. Null on a row written before connections were verified.
    verified_github_user_id TEXT,
    verified_github_login   TEXT,
    verified_permission     TEXT,
    verified_at             TIMESTAMPTZ,
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

/**
 * How this connection should treat transport security.
 *
 * `unverified` encrypts but accepts any certificate, which stops passive
 * eavesdropping and does nothing about an active attacker: anything able to
 * answer for the database's address can present its own certificate and read
 * and rewrite every query. It is a deliberate escape hatch, not a default.
 */
export type DatabaseTls = TransportTls;

/**
 * A decision that can actually become a connection.
 *
 * Refusal is deliberately not part of it. Every other mode answers "how should
 * this connect"; a refusal answers "it should not", and the two only look alike
 * until something tries to build a pool from the second.
 */
export type UsableDatabaseTls = Exclude<DatabaseTls, { mode: "refused" }>;

/**
 * Decides transport security from the connection string and environment.
 *
 * Deliberately explicit rather than delegated to the driver. node-postgres
 * currently reads `sslmode=require` as full verification and warns that a
 * future major will switch it to libpq's weaker meaning, so a deployment that
 * relied on the driver's reading would quietly stop verifying at some later
 * upgrade. Stating the decision here makes that impossible.
 *
 * The answer comes from the host and what the URL asked for, never from the
 * scheme: `postgres://` and `postgresql://` name the same database and must be
 * treated the same way.
 */
export function databaseTls(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = defaultReadFile
): DatabaseTls {
  const host = connectionHost(databaseUrl);
  if (host === null) {
    return { mode: "refused", reason: "DATABASE_URL is not a valid connection string" };
  }
  const intent = readUrlTlsIntent(databaseUrl);
  if (intent.invalid) {
    return { mode: "refused", reason: `DATABASE_URL: ${intent.invalid}` };
  }

  // A client certificate cannot be honoured here, and the driver will not see
  // it either now that the string is stripped of its TLS parameters. Refusing
  // says so; carrying on would drop mutual authentication without a word.
  if (intent.clientCertificateParameters.length > 0) {
    return {
      mode: "refused",
      reason:
        `DATABASE_URL sets ${intent.clientCertificateParameters.join(" and ")}, and client ` +
        "certificate authentication is not supported. Remove it, or connect through " +
        "something that terminates the client certificate.",
    };
  }

  // An inline authority wins over a path, so a deployment that cannot mount a
  // file still has a way in. A path that cannot be read is a refusal rather
  // than a fallback to Node's roots: the operator asked for a specific trust
  // anchor, and quietly substituting a different one is the whole failure this
  // module exists to prevent.
  let ca = env.DATABASE_CA_CERT?.trim() || undefined;
  if (!ca && intent.caPath) {
    try {
      ca = readFile(intent.caPath).trim();
    } catch (error) {
      return {
        mode: "refused",
        reason:
          `DATABASE_URL asks to trust the authorities in ${intent.caPath}, which could not ` +
          `be read: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  return decideTransportTls({
    service: "PostgreSQL",
    host,
    requested: intent.requested,
    // Recoverable without a redeploy. If a certificate chain stops validating in
    // production — an expired root, a provider migration — an operator can set
    // this, restart, and be encrypted again while the cause is found.
    noVerify: env.DATABASE_SSL_NO_VERIFY === "true",
    ca,
    allowPlaintext: env.DATABASE_ALLOW_PLAINTEXT === "true",
    nodeEnv: env.NODE_ENV,
  });
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
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

/**
 * Exactly what the pool is constructed with.
 *
 * Exported so a test can hand it to a real client and read back the settings
 * the driver resolved. Checking the decision function alone proved nothing
 * about the connection: the driver was discarding that decision, and every test
 * still passed.
 */
export function poolConfig(databaseUrl: string, tls: UsableDatabaseTls) {
  // A refusal is not a configuration, and `ssl: false` is not "no answer" — it
  // is a working plaintext connection. Returning one here would turn every
  // future refusal into exactly the thing it refused. The type excludes it so a
  // caller cannot reach this, and the check catches the cast that gets around
  // the type.
  const decision = tls as DatabaseTls;
  if (decision.mode === "refused") {
    throw new Error(
      `A refused transport decision cannot be turned into a connection: ${decision.reason}`
    );
  }
  return {
    // Stripped of its own TLS parameters, so the decision above is the one that
    // reaches the socket rather than being replaced by the string.
    connectionString: withoutDriverSslParameters(databaseUrl),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000, // 20s for serverless databases waking up.
    ssl: poolSsl(tls),
  };
}

/** The driver's shape for a decision already made. A refusal cannot get here. */
function poolSsl(tls: UsableDatabaseTls): false | { rejectUnauthorized: boolean; ca?: string } {
  if (tls.mode === "disabled") return false;
  if (tls.mode === "unverified") return { rejectUnauthorized: false };
  return tls.ca ? { rejectUnauthorized: true, ca: tls.ca } : { rejectUnauthorized: true };
}

function announceTls(tls: DatabaseTls): void {
  const message = describeTls("PostgreSQL", tls);
  if (tls.mode === "unverified") {
    if (process.env.NODE_ENV === "production") console.warn(`  ⚠ ${message}`);
    else console.log(`  ⚡ ${message}`);
    return;
  }
  console.log(`  ${tls.mode === "verified" ? "🔒" : "⚡"} ${message}`);
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

  const tls = databaseTls(databaseUrl);
  announceTls(tls);
  if (tls.mode === "refused") {
    // A misconfiguration, not an outage. Recorded as a persistence failure so a
    // production boot halts on it rather than promoting an instance that would
    // carry credentials across a network in the clear.
    persistenceState = { mode: "failed", reason: tls.reason };
    console.error(`  ⚠ PostgreSQL not connected: ${tls.reason}`);
    return false;
  }

  try {
    pool = new Pool(poolConfig(databaseUrl, tls));

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
