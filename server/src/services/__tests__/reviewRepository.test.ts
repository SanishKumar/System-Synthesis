import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  dockerComposeAdapter,
  reviewArchitectureChange,
} from "@system-synthesis/architecture-core";
import {
  analyzerStatus,
  createArchitectureReview,
  CURRENT_ANALYZER_VERSION,
  CURRENT_IMPORT_VERSION,
  getArchitectureReview,
  importStatus,
  ingestArchitectureReview,
  recomputeArchitectureReviewAnalysis,
  listArchitectureReviewEvents,
  listArchitectureReviews,
  resetMemoryReviewsForTests,
  updateArchitectureReviewAnalysis,
  updateArchitectureReviewDecision,
} from "../reviewRepository.js";

const baseSource = `services:
  api:
    image: api:1.0.0
    ports: ["8080:3000"]
  database:
    image: postgres:16
`;
const headSource = `services:
  api:
    image: api:1.0.0
    ports: ["8080:3000"]
    depends_on: [database]
  database:
    image: postgres:16
`;

function analysis() {
  const base = dockerComposeAdapter.import(
    [{ path: "compose.yaml", content: baseSource }],
    { revision: "base" }
  );
  const head = dockerComposeAdapter.import(
    [{ path: "compose.yaml", content: headSource }],
    { revision: "head" }
  );
  return {
    base,
    head,
    report: reviewArchitectureChange(
      base.graph,
      head.graph,
      {},
      "2026-07-19T10:00:00.000Z"
    ),
  };
}

async function create(ownerId = "owner-1") {
  const { base, head, report } = analysis();
  return createArchitectureReview({
    ownerId,
    title: "Checkout dependency review",
    repository: "acme/shop",
    sourcePath: "compose.yaml",
    baseRevision: "base",
    headRevision: "head",
    baseGraph: base.graph,
    headGraph: head.graph,
    policy: {},
    report,
  });
}

describe("architecture review repository memory fallback", () => {
  beforeEach(() => resetMemoryReviewsForTests());

  it("persists reviews with owner isolation and a creation event", async () => {
    const review = await create();

    await expect(getArchitectureReview(review.id, "owner-1")).resolves.toMatchObject({
      id: review.id,
      ownerId: "owner-1",
      revision: 1,
      decision: "pending",
    });
    await expect(getArchitectureReview(review.id, "other-user")).resolves.toBeNull();
    await expect(listArchitectureReviews("owner-1")).resolves.toEqual([
      expect.objectContaining({
        id: review.id,
        analysisStatus: "fail",
        blockingFindings: 1,
        semanticChanges: 1,
      }),
    ]);
    await expect(listArchitectureReviewEvents(review.id, "owner-1")).resolves.toEqual([
      expect.objectContaining({
        eventType: "review.created",
        reviewRevision: 1,
      }),
    ]);
  });

  it("rejects stale analysis updates instead of losing a concurrent decision", async () => {
    const review = await create();
    const updatedReport = {
      ...review.report,
      status: "pass" as const,
      blockingFindings: [],
    };
    const updated = await updateArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      1,
      { suppressions: [] },
      updatedReport,
      { ruleId: "example-rule" }
    );
    expect(updated).toMatchObject({
      status: "updated",
      review: { revision: 2, decision: "pending" },
    });

    await expect(updateArchitectureReviewDecision(
      review.id,
      "owner-1",
      1,
      "approved",
      null
    )).resolves.toEqual({ status: "conflict" });
  });

  it("records suppression and decision events with monotonic revisions", async () => {
    const review = await create();
    const passingReport = {
      ...review.report,
      status: "pass" as const,
      blockingFindings: [],
    };
    const suppressed = await updateArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      1,
      {
        suppressions: [{
          ruleId: "compose-public-service-to-persistence",
          justification: "Approved by ADR-014.",
        }],
      },
      passingReport,
      { ruleId: "compose-public-service-to-persistence" }
    );
    expect(suppressed.status).toBe("updated");

    const decided = await updateArchitectureReviewDecision(
      review.id,
      "owner-1",
      2,
      "approved",
      "Matches ADR-014."
    );
    expect(decided).toMatchObject({
      status: "updated",
      review: {
        decision: "approved",
        revision: 3,
      },
    });
    const events = await listArchitectureReviewEvents(review.id, "owner-1");
    expect(events.map((event) => [
      event.eventType,
      event.reviewRevision,
    ])).toEqual([
      ["review.created", 1],
      ["suppression.added", 2],
      ["decision.changed", 3],
    ]);
  });
});

describe("analyzer provenance", () => {
  beforeEach(() => resetMemoryReviewsForTests());

  function externalSource(changeVersion: number) {
    return {
      provider: "github" as const,
      repository: "acme/shop",
      changeNumber: 7,
      changeUrl: "https://github.com/acme/shop/pull/7",
      changeVersion,
      workflowRunId: "1001",
      workflowRunUrl: "https://github.com/acme/shop/actions/runs/1001",
    };
  }

  async function ingest(headRevision: string, changeVersion: number) {
    const { base, head, report } = analysis();
    return ingestArchitectureReview({
      ownerId: "owner-1",
      title: "Checkout dependency review",
      repository: "acme/shop",
      sourcePath: "compose.yaml",
      baseRevision: "base",
      headRevision,
      baseGraph: base.graph,
      headGraph: { ...head.graph, source: { ...head.graph.source, revision: headRevision } },
      policy: {},
      report,
      externalSource: externalSource(changeVersion),
    });
  }

  it("stamps the running analyzer on a manually created review", async () => {
    const review = await create();

    expect(review.analyzerVersion).toBe(CURRENT_ANALYZER_VERSION);
    expect(analyzerStatus(review)).toEqual({
      analyzerVersion: CURRENT_ANALYZER_VERSION,
      currentAnalyzerVersion: CURRENT_ANALYZER_VERSION,
      analyzerOutdated: false,
    });
    await expect(listArchitectureReviews("owner-1")).resolves.toEqual([
      expect.objectContaining({
        analyzerVersion: CURRENT_ANALYZER_VERSION,
        analyzerOutdated: false,
      }),
    ]);
  });

  it("stamps ingested reviews and re-stamps every pull-request refresh", async () => {
    const created = await ingest("head", 1_000);
    expect(created.status).toBe("created");
    expect(created.review.analyzerVersion).toBe(CURRENT_ANALYZER_VERSION);

    const refreshed = await ingest("head-2", 2_000);
    expect(refreshed.status).toBe("updated");
    expect(refreshed.review.id).toBe(created.review.id);
    expect(refreshed.review.analyzerVersion).toBe(CURRENT_ANALYZER_VERSION);
  });

  it("reports stored graphs extracted by the current importer as current", async () => {
    const review = await create();

    expect(importStatus(review)).toEqual({
      importVersion: CURRENT_IMPORT_VERSION,
      currentImportVersion: CURRENT_IMPORT_VERSION,
      importOutdated: false,
    });
  });

  it("treats an older, unknown, or disagreeing import as outdated", async () => {
    const review = await create();
    const older = (version: unknown) => ({
      ...review.headGraph,
      source: { ...review.headGraph.source, adapterVersion: version },
    }) as typeof review.headGraph;

    // A graph produced by an older pinned Action.
    expect(importStatus({
      baseGraph: older(CURRENT_IMPORT_VERSION - 1),
      headGraph: older(CURRENT_IMPORT_VERSION - 1),
    })).toMatchObject({
      importVersion: CURRENT_IMPORT_VERSION - 1,
      importOutdated: true,
    });
    // Written before extraction was versioned.
    expect(importStatus({
      baseGraph: older(undefined),
      headGraph: older(undefined),
    })).toMatchObject({ importVersion: null, importOutdated: true });
    // Sides disagreeing cannot describe one extraction contract.
    expect(importStatus({
      baseGraph: older(CURRENT_IMPORT_VERSION - 1),
      headGraph: review.headGraph,
    })).toMatchObject({ importVersion: null, importOutdated: true });
  });

  it("keeps import staleness independent of analyzer staleness", async () => {
    const review = await create();
    const stale = {
      ...review,
      baseGraph: {
        ...review.baseGraph,
        source: { ...review.baseGraph.source, adapterVersion: 1 },
      },
      headGraph: {
        ...review.headGraph,
        source: { ...review.headGraph.source, adapterVersion: 1 },
      },
    };

    // Re-analysis reuses these graphs, so it cannot clear an outdated import.
    expect(analyzerStatus(stale).analyzerOutdated).toBe(false);
    expect(importStatus(stale).importOutdated).toBe(true);
  });

  it("treats an unknown or foreign analyzer as outdated", () => {
    // Rows written before this column existed.
    expect(analyzerStatus({ analyzerVersion: null })).toMatchObject({
      analyzerVersion: null,
      analyzerOutdated: true,
    });
    // A verdict produced by a different rule set must never read as current.
    expect(analyzerStatus({ analyzerVersion: "v0+0000000000000000" })).toMatchObject({
      analyzerOutdated: true,
    });
  });

  it("treats a freshly computed identical analysis as unchanged", async () => {
    const review = await create();
    // Exactly what the endpoint does: stored graphs and policy, new clock. The
    // report carries wall-clock stamps, so a naive comparison reports a changed
    // verdict here and silently revokes decisions on every recompute.
    const recomputedReport = reviewArchitectureChange(
      review.baseGraph,
      review.headGraph,
      review.policy,
      new Date(),
      {
        base: review.report.baseDiagnostics,
        head: review.report.headDiagnostics,
      }
    );

    const result = await recomputeArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      1,
      recomputedReport
    );

    expect(result).toMatchObject({
      status: "unchanged",
      review: { revision: 1, decision: "pending" },
    });
  });

  it("re-stamps without disturbing an approved review when the verdict is unchanged", async () => {
    const review = await create();
    const passingReport = {
      ...review.report,
      status: "pass" as const,
      blockingFindings: [],
    };
    await updateArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      1,
      { suppressions: [] },
      passingReport,
      { ruleId: "compose-public-service-to-persistence" }
    );
    const approved = await updateArchitectureReviewDecision(
      review.id,
      "owner-1",
      2,
      "approved",
      "Matches ADR-014."
    );
    expect(approved).toMatchObject({ status: "updated" });

    const recomputed = await recomputeArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      3,
      // Same verdict, only the review timestamp moves.
      { ...passingReport, reviewedAt: new Date().toISOString() }
    );

    expect(recomputed).toMatchObject({
      status: "unchanged",
      review: {
        revision: 3,
        decision: "approved",
        decisionNote: "Matches ADR-014.",
        analyzerVersion: CURRENT_ANALYZER_VERSION,
      },
    });
    const events = await listArchitectureReviewEvents(review.id, "owner-1");
    expect(events.at(-1)).toMatchObject({
      eventType: "review.recomputed",
      reviewRevision: 3,
      data: { changed: false },
    });
  });

  it("returns a changed verdict to pending on a new revision", async () => {
    const review = await create();
    const recomputed = await recomputeArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      1,
      { ...review.report, status: "pass" as const, blockingFindings: [] }
    );

    expect(recomputed).toMatchObject({
      status: "updated",
      review: {
        revision: 2,
        decision: "pending",
        analyzerVersion: CURRENT_ANALYZER_VERSION,
      },
    });
    const events = await listArchitectureReviewEvents(review.id, "owner-1");
    expect(events.at(-1)).toMatchObject({
      eventType: "review.recomputed",
      reviewRevision: 2,
      data: { changed: true, previousBlockingFindings: 1, blockingFindings: 0 },
    });
  });

  it("refuses a stale or foreign recompute", async () => {
    const review = await create();

    await expect(
      recomputeArchitectureReviewAnalysis(review.id, "owner-1", 99, review.report)
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      recomputeArchitectureReviewAnalysis(review.id, "other-user", 1, review.report)
    ).resolves.toEqual({ status: "not_found" });
    // A refused recompute must not have touched the row.
    await expect(getArchitectureReview(review.id, "owner-1")).resolves.toMatchObject({
      revision: 1,
      decision: "pending",
    });
  });

  it("returns to current after the report is recomputed", async () => {
    const review = await create();
    const updated = await updateArchitectureReviewAnalysis(
      review.id,
      "owner-1",
      1,
      { suppressions: [] },
      { ...review.report, status: "pass" as const, blockingFindings: [] },
      { ruleId: "compose-public-service-to-persistence" }
    );

    expect(updated).toMatchObject({
      status: "updated",
      review: { analyzerVersion: CURRENT_ANALYZER_VERSION },
    });
  });
});
