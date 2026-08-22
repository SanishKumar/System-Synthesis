import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The same synchronization contract as `githubSync.test.ts`, executed against a
 * real PostgreSQL instead of memory storage.
 *
 * The two backends have already drifted once: the compare-and-set that protects
 * an outcome lived only in SQL, the timestamps a new generation clears lived
 * only in memory, and a skip cleared different columns in each. Reading both
 * implementations is not enough to catch that, because each is correct on its
 * own terms — only running the same expectations against both shows the
 * disagreement.
 *
 * Opt-in, because the suite needs a database it is allowed to write to:
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/scratch npm test --workspace=server
 *
 * Point it at a scratch database. It writes and deletes rows in
 * `architecture_reviews`, and must never be pointed at production data.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("GitHub synchronization state on PostgreSQL", () => {
  // Only when the suite is actually going to run: the describe body is still
  // evaluated when skipped, and assigning an absent value would leave
  // DATABASE_URL set to the string "undefined".
  if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

  // Imported lazily so the module graph resolves `getPool()` to the real pool
  // this suite initializes, rather than to the mocked one other suites install.
  const load = async () => {
    const db = await import("../db.js");
    const repository = await import("../reviewRepository.js");
    const checks = await import("../githubChecks.js");
    const core = await import("@system-synthesis/architecture-core");
    return { db, repository, checks, core };
  };

  const OWNER = "owner-postgres-contract";
  const BASE = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const NEXT_HEAD = "c".repeat(40);
  const BASE_SOURCE = `services:\n  web:\n    image: web:1\n    ports: ["3000:3000"]\n  db:\n    image: postgres:16\n`;
  const HEAD_SOURCE = `services:\n  web:\n    image: web:1\n    ports: ["3000:3000"]\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n`;

  async function ingest(headRevision = HEAD, changeVersion = 1_000) {
    const { repository, core } = await load();
    const graph = (revision: string, content: string) =>
      core.dockerComposeAdapter.import([{ path: "compose.yaml", content }], {
        repository: "acme/shop",
        revision,
      }).graph;
    const baseGraph = graph(BASE, BASE_SOURCE);
    const headGraph = graph(headRevision, HEAD_SOURCE);
    return repository.ingestArchitectureReview({
      ownerId: OWNER,
      title: "Gate",
      repository: "acme/shop",
      sourcePath: "compose.yaml",
      baseRevision: BASE,
      headRevision,
      baseGraph,
      headGraph,
      policy: {},
      report: core.reviewArchitectureChange(baseGraph, headGraph, {}, "2026-08-12T00:00:00.000Z"),
      externalSource: {
        provider: "github",
        repository: "acme/shop",
        changeNumber: 9,
        changeUrl: "https://github.com/acme/shop/pull/9",
        changeVersion,
        workflowRunId: null,
        workflowRunUrl: null,
      },
    });
  }

  beforeEach(async () => {
    const { db } = await load();
    // Once per suite: initDatabase builds a fresh pool every call, and the old
    // one would be left open.
    if (!db.getPool()) {
      await db.initDatabase();
    }
    const pool = db.getPool();
    if (!pool) {
      const state = db.getPersistenceState();
      throw new Error(
        `TEST_DATABASE_URL did not yield a usable pool: ${
          state.mode === "failed" ? state.reason : state.mode
        }`
      );
    }
    await pool.query("DELETE FROM architecture_reviews WHERE owner_id = $1", [OWNER]);
  });

  afterAll(async () => {
    const { db } = await load();
    const pool = db.getPool();
    if (pool) {
      await pool.query("DELETE FROM architecture_reviews WHERE owner_id = $1", [OWNER]);
      await db.closeDatabase();
    }
  });

  it("clears the previous attempt's timestamps when a new generation goes pending", async () => {
    const { repository } = await load();
    const { review } = await ingest();
    const synced = await repository.recordGitHubSyncOutcome(review.id, {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion!,
      status: "synced",
      reason: null,
    });
    expect(synced?.succeededAt).not.toBeNull();

    const refreshed = await ingest(NEXT_HEAD, 2_000);
    // An attempt time carried over from the previous commit would date a
    // revision that has never been attempted.
    expect(refreshed.review.githubSync).toMatchObject({
      status: "pending",
      attemptedAt: null,
      succeededAt: null,
    });
  });

  it("refuses an outcome recorded against a superseded generation", async () => {
    const { repository } = await load();
    const { review } = await ingest();
    await ingest(NEXT_HEAD, 2_000);

    const discarded = await repository.recordGitHubSyncOutcome(review.id, {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion!,
      status: "synced",
      reason: null,
    });
    expect(discarded).toBeNull();
    const stored = await repository.getArchitectureReview(review.id, OWNER);
    expect(stored?.githubSync.status).toBe("pending");
  });

  it("refuses a skip recorded against a superseded generation", async () => {
    const { repository } = await load();
    const { review } = await ingest();
    const refreshed = await ingest(NEXT_HEAD, 2_000);

    const discarded = await repository.recordGitHubSyncSkipped(review.id, {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion,
      reason: "not_installed",
    });
    expect(discarded).toBeNull();
    const stored = await repository.getArchitectureReview(review.id, OWNER);
    expect(stored?.githubSync).toMatchObject({
      status: "pending",
      headRevision: refreshed.review.headRevision,
    });
  });

  it("keeps the generation a skip applies to, as memory storage does", async () => {
    const { repository } = await load();
    const { review } = await ingest();
    const recorded = await repository.recordGitHubSyncSkipped(review.id, {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion,
      reason: "not_configured",
    });
    expect(recorded).toMatchObject({
      status: "skipped",
      reason: "not_configured",
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion,
    });
    expect(recorded?.attemptedAt).not.toBeNull();

    const stored = await repository.getArchitectureReview(review.id, OWNER);
    expect(stored?.githubSync).toEqual(recorded);
  });

  it("adopts a row written before synchronization was tracked", async () => {
    const { db, repository } = await load();
    const { review } = await ingest();
    const pool = db.getPool()!;
    // Exactly what an existing production row looks like: no sync columns at
    // all. Reading it back reports pending with no generation.
    await pool.query(
      `UPDATE architecture_reviews
       SET github_sync_status = NULL,
           github_sync_conclusion = NULL,
           github_sync_revision = NULL,
           github_sync_head = NULL,
           github_sync_reason = NULL,
           github_sync_attempted_at = NULL,
           github_sync_succeeded_at = NULL
       WHERE id = $1`,
      [review.id]
    );
    const legacy = (await repository.getArchitectureReview(review.id, OWNER))!;
    expect(legacy.githubSync).toMatchObject({ status: "pending", conclusion: null });

    const recorded = await repository.recordGitHubSyncOutcome(review.id, {
      revision: legacy.revision,
      headRevision: legacy.headRevision,
      conclusion: "action_required",
      status: "synced",
      reason: null,
    });

    // Requiring the computed conclusion to equal the stored null refused every
    // attempt such a row could ever make: GitHub carried the check while the
    // review claimed forever that it had never reached a pull request.
    expect(recorded).toMatchObject({
      status: "synced",
      conclusion: "action_required",
      revision: legacy.revision,
      headRevision: legacy.headRevision,
    });
  });

  it("does not let a slower failure or skip undo a success", async () => {
    const { repository } = await load();
    const { review } = await ingest();
    const generation = {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion!,
    };
    await repository.recordGitHubSyncOutcome(review.id, {
      ...generation,
      status: "synced",
      reason: null,
    });

    const lateFailure = await repository.recordGitHubSyncOutcome(review.id, {
      ...generation,
      status: "failed",
      reason: "github_unreachable",
    });
    expect(lateFailure).toBeNull();

    const lateSkip = await repository.recordGitHubSyncSkipped(review.id, {
      ...generation,
      reason: "not_installed",
    });
    expect(lateSkip).toBeNull();

    const stored = await repository.getArchitectureReview(review.id, OWNER);
    expect(stored?.githubSync).toMatchObject({ status: "synced", reason: null });
  });

  it("still records a later success for the same generation", async () => {
    const { repository } = await load();
    const { review } = await ingest();
    const generation = {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: review.githubSync.conclusion!,
    };
    await repository.recordGitHubSyncOutcome(review.id, {
      ...generation,
      status: "failed",
      reason: "check_write_forbidden",
    });
    const recovered = await repository.recordGitHubSyncOutcome(review.id, {
      ...generation,
      status: "synced",
      reason: null,
    });
    expect(recovered).toMatchObject({ status: "synced", reason: null });
  });

  it("matches a null conclusion rather than failing the guard on it", async () => {
    const { db, repository } = await load();
    const { review } = await ingest();
    const pool = db.getPool()!;
    // A row whose desired conclusion was never computed: the guard has to treat
    // null as a value it can match, which `=` would not.
    await pool.query(
      "UPDATE architecture_reviews SET github_sync_conclusion = NULL WHERE id = $1",
      [review.id]
    );
    const recorded = await repository.recordGitHubSyncSkipped(review.id, {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: null,
      reason: "not_configured",
    });
    expect(recorded).toMatchObject({ status: "skipped", reason: "not_configured" });
  });

  /**
   * The decision audit, run against real SQL.
   *
   * Memory storage keeps a JavaScript object; PostgreSQL round-trips the same
   * evidence through a JSONB column. Asserting it only in memory would prove
   * the object was constructed, not that it survives being written and read
   * back — and the two backends have drifted before.
   */
  describe("entitlement evidence", () => {
    const VERIFIED = {
      basis: "verified" as const,
      repository: "acme/shop",
      githubUserId: "9002",
      githubLogin: "octo-reviewer",
      permission: "write",
      checkedAt: "2026-08-20T10:00:00.000Z",
    };

    it("survives the round trip into the decision event", async () => {
      const { repository } = await load();
      const { review } = await ingest();
      const decided = await repository.updateArchitectureReviewDecision(
        review.id,
        OWNER,
        review.revision,
        "approved",
        null,
        VERIFIED
      );
      expect(decided.status).toBe("updated");

      const events = await repository.listArchitectureReviewEvents(review.id, OWNER);
      const decision = events.find((event) => event.eventType === "decision.changed");
      expect(decision?.data).toMatchObject({ decision: "approved", entitlement: VERIFIED });
    });

    it("records an unverified decision as unverified", async () => {
      // A deployment that cannot check is allowed to decide and is not allowed
      // to look like one that did.
      const { repository } = await load();
      const { review } = await ingest();
      await repository.updateArchitectureReviewDecision(
        review.id,
        OWNER,
        review.revision,
        "rejected",
        "Not this shape.",
        { basis: "unenforced", repository: "acme/shop" }
      );
      const events = await repository.listArchitectureReviewEvents(review.id, OWNER);
      const decision = events.find((event) => event.eventType === "decision.changed");
      const stored = (decision?.data as Record<string, unknown>).entitlement as Record<string, unknown>;
      expect(stored.basis).toBe("unenforced");
      expect(stored.githubUserId).toBeUndefined();
      expect(stored.permission).toBeUndefined();
    });

    it("writes the evidence in the same transaction as the decision", async () => {
      // A decision that landed without its evidence is the defect this closes.
      // Nothing may leave a decision row behind with no event beside it.
      const { db, repository } = await load();
      const { review } = await ingest();
      await repository.updateArchitectureReviewDecision(
        review.id,
        OWNER,
        review.revision,
        "approved",
        null,
        VERIFIED
      );
      const pool = db.getPool()!;
      const orphaned = await pool.query(
        `SELECT r.id FROM architecture_reviews r
          WHERE r.id = $1
            AND r.decision <> 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM architecture_review_events e
               WHERE e.review_id = r.id
                 AND e.event_type = 'decision.changed'
                 AND e.data ? 'entitlement'
            )`,
        [review.id]
      );
      expect(orphaned.rows).toEqual([]);
    });
  });

  /**
   * What a connection recorded about the account that made it, against real
   * SQL.
   *
   * Memory storage keeps an object; PostgreSQL round-trips the same proof
   * through four columns and an upsert that has to carry them on conflict as
   * well as on insert. Asserting it only in memory would show the object was
   * built, not that a rotation keeps it.
   */
  describe("repository connection authority", () => {
    const VERIFIED = {
      githubUserId: "9002",
      githubLogin: "octo-admin",
      permission: "admin",
      verifiedAt: "2026-08-21T00:00:00.000Z",
    };

    it("stores what was verified, and keeps it across a rotation", async () => {
      const integrations = await import("../reviewIntegrationRepository.js");
      const repository = `acme/authority-${Date.now()}`;

      const created = await integrations.createOrRotateReviewIntegration({
        ownerId: OWNER,
        provider: "github",
        repository,
        verified: VERIFIED,
      });
      expect(created.integration).toMatchObject({
        verifiedGithubUserId: "9002",
        verifiedGithubLogin: "octo-admin",
        verifiedPermission: "admin",
      });
      expect(created.integration.verifiedAt).toBeTruthy();

      // Rotating re-proves authority, so the record must carry the new proof
      // rather than the one the row was created with.
      const rotated = await integrations.createOrRotateReviewIntegration({
        ownerId: OWNER,
        provider: "github",
        repository,
        verified: { ...VERIFIED, githubLogin: "renamed-admin" },
      });
      expect(rotated.integration.verifiedGithubLogin).toBe("renamed-admin");
      expect(rotated.ingestionToken).not.toBe(created.ingestionToken);
    });

    it("leaves no connection row behind when authority was never established", async () => {
      // The route refuses before reaching storage, so a repository nobody
      // proved authority over has nothing stored against it at all.
      const { db } = await load();
      const pool = db.getPool()!;
      const orphaned = await pool.query(
        `SELECT id FROM architecture_review_integrations
          WHERE revoked_at IS NULL AND verified_github_user_id IS NULL
            AND created_at > NOW() - INTERVAL '1 hour'`
      );
      expect(orphaned.rows).toEqual([]);
    });
  });

  /**
   * The upgrade, not the fresh install.
   *
   * Every other test here runs against a schema this build created, where the
   * new columns are present because CREATE TABLE wrote them. Production is the
   * other case: the table already exists, CREATE TABLE IF NOT EXISTS leaves it
   * exactly as it was, and only an ALTER reaches it. A suite that never starts
   * from the old shape cannot tell the two apart, and the first symptom would
   * have been every connection attempt failing after deploy.
   */
  describe("upgrading a database that already has the old table", () => {
    it("adds the verification columns to a table created without them", async () => {
      const { db } = await load();
      const pool = db.getPool()!;
      const table = `legacy_integrations_${Date.now()}`;

      // The table as the vulnerable build defined it.
      await pool.query(
        `CREATE TABLE ${table} (
           id              TEXT PRIMARY KEY,
           owner_id        TEXT NOT NULL,
           provider        TEXT NOT NULL,
           repository      TEXT NOT NULL,
           token_hash      TEXT NOT NULL UNIQUE,
           token_prefix    TEXT NOT NULL,
           created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           last_used_at    TIMESTAMPTZ,
           revoked_at      TIMESTAMPTZ,
           UNIQUE(owner_id, provider, repository)
         )`
      );
      try {
        // A credential issued under the old rules, with no proof behind it.
        await pool.query(
          `INSERT INTO ${table} (id, owner_id, provider, repository, token_hash, token_prefix)
           VALUES ('legacy-1', 'someone', 'github', 'victim/repository', 'hash-1', 'ssri_legacy')`
        );

        // Re-declaring the table must not touch it, which is the trap.
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY)`);
        const beforeAlter = await pool.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = $1 AND column_name = 'verified_github_user_id'`,
          [table]
        );
        expect(beforeAlter.rows).toEqual([]);

        // The migration this build ships, against the same table.
        for (const column of [
          "verified_github_user_id TEXT",
          "verified_github_login TEXT",
          "verified_permission TEXT",
          "verified_at TIMESTAMPTZ",
        ]) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
        }

        const afterAlter = await pool.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = $1 AND column_name LIKE 'verified%'
            ORDER BY column_name`,
          [table]
        );
        expect(afterAlter.rows.map((row) => row.column_name)).toEqual([
          "verified_at",
          "verified_github_login",
          "verified_github_user_id",
          "verified_permission",
        ]);

        // The insert this build performs now succeeds against the upgraded table,
        // which is what would have failed on a production deploy without the ALTER.
        await pool.query(
          `INSERT INTO ${table} (
             id, owner_id, provider, repository, token_hash, token_prefix,
             verified_github_user_id, verified_github_login, verified_permission, verified_at
           ) VALUES ('new-1', 'admin', 'github', 'acme/shop', 'hash-2', 'ssri_new',
                     '9002', 'octo-admin', 'admin', NOW())`
        );

        // The pre-existing row keeps its nulls, which is how it is recognised
        // as one nobody proved anything about.
        const legacy = await pool.query(
          `SELECT verified_github_user_id, verified_at FROM ${table} WHERE id = 'legacy-1'`
        );
        expect(legacy.rows[0].verified_github_user_id).toBeNull();
        expect(legacy.rows[0].verified_at).toBeNull();
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    it("brings the real table back up to date after the columns are removed", async () => {
      // The migration this build actually ships, against the canonical table,
      // reduced to the shape a deployment upgrading from the previous release
      // would have. A copy of the table can only show that ALTER works; this
      // shows that the statements reach the table they have to reach.
      const { db } = await load();
      const pool = db.getPool()!;
      for (const column of [
        "verified_github_user_id",
        "verified_github_login",
        "verified_permission",
        "verified_at",
      ]) {
        await pool.query(
          `ALTER TABLE architecture_review_integrations DROP COLUMN IF EXISTS ${column}`
        );
      }
      const removed = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'architecture_review_integrations'
            AND column_name LIKE 'verified%'`
      );
      expect(removed.rows).toEqual([]);

      await pool.query(db.MIGRATION_SQL);

      const restored = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'architecture_review_integrations'
            AND column_name LIKE 'verified%'
          ORDER BY column_name`
      );
      expect(restored.rows.map((row: { column_name: string }) => row.column_name)).toEqual([
        "verified_at",
        "verified_github_login",
        "verified_github_user_id",
        "verified_permission",
      ]);
    });

    it("ships those statements rather than relying on CREATE TABLE", async () => {
      // Reading the migration source, because a fresh schema cannot show the
      // difference between a column declared and a column migrated.
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(new URL("../db.ts", import.meta.url), "utf8");
      for (const column of [
        "verified_github_user_id",
        "verified_github_login",
        "verified_permission",
        "verified_at",
      ]) {
        expect(source).toContain(
          `ALTER TABLE architecture_review_integrations ADD COLUMN IF NOT EXISTS ${column}`
        );
      }
    });
  });
});
