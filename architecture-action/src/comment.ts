import type { ArchitectureChangeReview } from "@system-synthesis/architecture-core";

/**
 * Stable marker so repeated runs update one comment instead of appending a new
 * one. Part of the Action's public contract: consumers match on it.
 */
export const COMMENT_MARKER = "<!-- system-synthesis-architecture-review -->";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Pull-request comment body.
 *
 * The deterministic report is thorough, which is exactly why it buries the one
 * thing a reviewer has to act on. A reader arriving at a failing check needs the
 * verdict, the reason, and the way to resolve it before any tables — so the
 * outcome and the decision link lead, and the full report follows unchanged.
 */
export function composeReviewComment(input: {
  markdown: string;
  review: ArchitectureChangeReview;
  reviewUrl?: string;
}): string {
  const { review, reviewUrl } = input;
  const blocking = review.blockingFindings.length;
  const lines = [COMMENT_MARKER];

  if (blocking > 0) {
    lines.push(
      `### ❌ Action required · ${plural(blocking, "blocking architecture change")}`,
      ""
    );
    // The leading finding explains the verdict in the reviewer's own terms;
    // the rest stay in the report below rather than competing with the call to
    // action.
    const headline = review.blockingFindings[0];
    if (headline) lines.push(headline.description, "");
    lines.push(
      reviewUrl
        ? `**[→ Open the architecture review to accept or reject this change](${reviewUrl})**`
        : "_Resolve the finding, or record a justified exception in your policy file._",
      ""
    );
  } else if (review.diff.stats.total > 0) {
    lines.push(
      `### ✅ Architecture reviewed · ${plural(review.diff.stats.total, "change")}, no blocking findings`,
      ""
    );
    if (reviewUrl) lines.push(`[View the architecture review](${reviewUrl})`, "");
  } else {
    lines.push("### ✅ No architecture change detected", "");
    if (reviewUrl) lines.push(`[View the architecture review](${reviewUrl})`, "");
  }

  lines.push("---", "", input.markdown);
  return lines.join("\n");
}
