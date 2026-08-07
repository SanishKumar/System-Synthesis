import { describe, expect, it } from "vitest";
import { COMMENT_MARKER, composeReviewComment } from "../comment.js";
import type { ArchitectureChangeReview } from "@system-synthesis/architecture-core";

const REPORT = "## ❌ Architecture change review: changes requested\n\n| Severity |\n";

function review(overrides: Partial<ArchitectureChangeReview> = {}) {
  return {
    status: "fail",
    blockingFindings: [],
    newFindings: [],
    resolvedFindings: [],
    diff: { stats: { added: 0, removed: 0, changed: 0, total: 0 } },
    ...overrides,
  } as unknown as ArchitectureChangeReview;
}

function blocking(description: string) {
  return { id: "r:1", ruleId: "r", severity: "warning", title: "t", description, nodeIds: [], edgeIds: [] };
}

describe("pull-request comment composition", () => {
  it("leads with the decision link rather than burying it under the report", () => {
    const body = composeReviewComment({
      markdown: REPORT,
      reviewUrl: "https://example.invalid/reviews/abc",
      review: review({
        blockingFindings: [blocking("frontend publishes a host port and directly depends on postgres.")] as never,
        diff: { changes: [], stats: { added: 1, removed: 0, changed: 1, total: 2 } } as never,
      }),
    });

    const action = body.indexOf("Action required");
    const link = body.indexOf("https://example.invalid/reviews/abc");
    const report = body.indexOf("Architecture change review: changes requested");
    expect(action).toBeGreaterThan(-1);
    expect(link).toBeLessThan(report);
    expect(body).toContain("frontend publishes a host port and directly depends on postgres.");
  });

  it("carries the marker first so repeated runs update one comment", () => {
    const body = composeReviewComment({ markdown: REPORT, review: review() });
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("counts blocking findings in the heading", () => {
    const one = composeReviewComment({
      markdown: REPORT,
      review: review({ blockingFindings: [blocking("a")] as never }),
    });
    const two = composeReviewComment({
      markdown: REPORT,
      review: review({ blockingFindings: [blocking("a"), blocking("b")] as never }),
    });
    expect(one).toContain("1 blocking architecture change");
    expect(two).toContain("2 blocking architecture changes");
  });

  it("never invents a link when ingestion did not run", () => {
    const body = composeReviewComment({
      markdown: REPORT,
      review: review({ blockingFindings: [blocking("a")] as never }),
    });
    expect(body).not.toContain("](");
    expect(body).toContain("record a justified exception");
  });

  it("stays quiet when the change carries no architecture impact", () => {
    const body = composeReviewComment({
      markdown: REPORT,
      review: review({ status: "pass" }),
      reviewUrl: "https://example.invalid/reviews/abc",
    });
    expect(body).toContain("No architecture change detected");
    expect(body).not.toContain("Action required");
  });

  it("reports a reviewed change that introduced nothing blocking", () => {
    const body = composeReviewComment({
      markdown: REPORT,
      review: review({
        status: "pass",
        diff: { changes: [], stats: { added: 2, removed: 0, changed: 0, total: 2 } } as never,
      }),
    });
    expect(body).toContain("2 changes, no blocking findings");
  });

  it("always embeds the full report unchanged", () => {
    const body = composeReviewComment({ markdown: REPORT, review: review() });
    expect(body.endsWith(REPORT)).toBe(true);
  });
});
