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
  process.env.DATABASE_URL = TEST_DATABASE_URL;

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
    await db.initDatabase();
    const pool = db.getPool();
    if (!pool) throw new Error("TEST_DATABASE_URL did not yield a usable pool");
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
});
