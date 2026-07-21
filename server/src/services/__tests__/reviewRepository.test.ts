import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  dockerComposeAdapter,
  reviewArchitectureChange,
} from "@system-synthesis/architecture-core";
import {
  createArchitectureReview,
  getArchitectureReview,
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
