import {
  dockerComposeAdapter,
  reviewArchitectureChange,
  type ArchitectureChangeReview,
} from "@system-synthesis/architecture-core";
import {
  parseArchitecturePolicy,
  reviewToJson,
  reviewToMarkdown,
  reviewToSarif,
} from "@system-synthesis/architecture-cli";

export interface ActionReviewInput {
  baseContent: string;
  headContent: string;
  sourcePath: string;
  repository?: string;
  baseRevision: string;
  headRevision: string;
  policyContent?: string;
  reviewedAt: Date;
}

export interface ActionReviewReports {
  exitCode: 0 | 1;
  review: ArchitectureChangeReview;
  json: string;
  markdown: string;
  sarif: string;
}

export function createActionReview(
  input: ActionReviewInput
): ActionReviewReports {
  const base = dockerComposeAdapter.import(
    [{ path: input.sourcePath, content: input.baseContent }],
    {
      repository: input.repository,
      revision: input.baseRevision,
    }
  );
  const head = dockerComposeAdapter.import(
    [{ path: input.sourcePath, content: input.headContent }],
    {
      repository: input.repository,
      revision: input.headRevision,
    }
  );
  const policy = input.policyContent
    ? parseArchitecturePolicy(input.policyContent)
    : {};
  const review = reviewArchitectureChange(
    base.graph,
    head.graph,
    policy,
    input.reviewedAt,
    {
      base: base.diagnostics,
      head: head.diagnostics,
    }
  );
  return {
    exitCode: review.status === "fail" ? 1 : 0,
    review,
    json: reviewToJson(review),
    markdown: reviewToMarkdown(review),
    sarif: reviewToSarif(review),
  };
}
