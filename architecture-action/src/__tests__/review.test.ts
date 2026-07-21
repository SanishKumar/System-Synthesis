import { describe, expect, it } from "vitest";
import { createActionReview } from "../review.js";

const base = `services:
  api:
    image: api:1.0.0
    ports: ["8080:3000"]
  database:
    image: postgres:16
`;

const head = `services:
  api:
    image: api:1.0.0
    ports: ["8080:3000"]
    depends_on: [database]
  database:
    image: postgres:16
`;

describe("GitHub Action review reports", () => {
  it("produces all report formats from one deterministic review", () => {
    const reports = createActionReview({
      baseContent: base,
      headContent: head,
      sourcePath: "deploy/compose.yaml",
      repository: "acme/shop",
      baseRevision: "abc123",
      headRevision: "def456",
      reviewedAt: new Date("2026-07-19T10:00:00.000Z"),
    });

    expect(reports.exitCode).toBe(1);
    expect(reports.review.status).toBe("fail");
    expect(JSON.parse(reports.json).reviewedAt).toBe(
      "2026-07-19T10:00:00.000Z"
    );
    expect(reports.markdown).toContain("changes requested");
    expect(JSON.parse(reports.sarif).runs[0].results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "compose-public-service-to-persistence",
        }),
      ])
    );
  });

  it("uses the supplied policy and rejects invalid exceptions", () => {
    expect(() => createActionReview({
      baseContent: base,
      headContent: head,
      sourcePath: "compose.yaml",
      baseRevision: "base",
      headRevision: "head",
      policyContent: JSON.stringify({
        suppressions: [{
          ruleId: "compose-public-service-to-persistence",
          justification: "",
        }],
      }),
      reviewedAt: new Date("2026-07-19T10:00:00.000Z"),
    })).toThrow("non-empty justification");
  });

  it("passes when the semantic architecture is unchanged", () => {
    const reports = createActionReview({
      baseContent: base,
      headContent: base,
      sourcePath: "compose.yaml",
      baseRevision: "base",
      headRevision: "head",
      reviewedAt: new Date("2026-07-19T10:00:00.000Z"),
    });

    expect(reports.exitCode).toBe(0);
    expect(reports.review.diff.stats.total).toBe(0);
  });
});
