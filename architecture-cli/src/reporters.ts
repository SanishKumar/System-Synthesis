import {
  stableStringify,
  validationToSarif,
  type ArchitectureChangeReview,
  type ArchitectureImpact,
} from "@system-synthesis/architecture-core";
import type {
  SourceProvenance,
  ValidationIssue,
} from "@system-synthesis/shared";

export type ReviewOutputFormat = "json" | "markdown" | "sarif";

function location(location: SourceProvenance | undefined): string {
  if (!location) return "";
  return `${location.file}${location.startLine ? `:${location.startLine}` : ""}`;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function severityIcon(severity: ArchitectureImpact["severity"]): string {
  if (severity === "critical") return "🔴";
  if (severity === "warning") return "🟠";
  return "🔵";
}

function findingList(findings: ValidationIssue[]): string {
  if (!findings.length) return "_None._";
  return findings
    .map((finding) => {
      const evidence = location(finding.locations?.[0]);
      return `- **${escapeTable(finding.title)}** (\`${finding.ruleId}\`) — ${escapeTable(finding.description)}${evidence ? ` _[${evidence}]_` : ""}`;
    })
    .join("\n");
}

export function reviewToMarkdown(review: ArchitectureChangeReview): string {
  const passed = review.status === "pass";
  const lines = [
    `## ${passed ? "✅" : "❌"} Architecture change review: ${passed ? "passed" : "changes requested"}`,
    "",
    `Compared \`${review.base.revision || "base"}\` → \`${review.head.revision || "head"}\` using the \`${review.head.adapter}\` adapter.`,
    "",
    `**${review.diff.stats.total} semantic change(s)** · **${review.newFindings.length} new finding(s)** · **${review.blockingFindings.length} blocking** · **${review.resolvedFindings.length} resolved**`,
    "",
    "### Semantic impact",
    "",
  ];
  if (!review.impacts.length) {
    lines.push("_No architecture impact detected._");
  } else {
    lines.push("| Severity | Change | Evidence |", "|---|---|---|");
    for (const item of review.impacts) {
      lines.push(
        `| ${severityIcon(item.severity)} ${item.severity} | ${escapeTable(item.summary)} | ${escapeTable(location(item.locations[0]) || "Derived graph analysis")} |`
      );
    }
  }
  lines.push(
    "",
    "### Blocking findings",
    "",
    findingList(review.blockingFindings),
    "",
    "### Other new findings",
    "",
    findingList(
      review.newFindings.filter(
        (finding) => !review.blockingFindings.some(
          (blocking) => blocking.id === finding.id
        )
      )
    ),
    "",
    "### Resolved findings",
    "",
    findingList(review.resolvedFindings),
    ""
  );
  if (review.headDiagnostics.length) {
    lines.push(
      "### Import diagnostics",
      "",
      ...review.headDiagnostics.map((diagnostic) =>
        `- **${diagnostic.severity}** \`${diagnostic.code}\` — ${escapeTable(diagnostic.message)}${diagnostic.file ? ` _[${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}]_` : ""}`
      ),
      ""
    );
  }
  if (review.suppressedFindings.length) {
    lines.push(
      "### Accepted exceptions",
      "",
      ...review.suppressedFindings.map(({ finding, suppression }) =>
        `- \`${finding.ruleId}\` — ${escapeTable(suppression.justification)}${suppression.ticket ? ` (${suppression.ticket})` : ""}${suppression.expiresAt ? `; expires ${suppression.expiresAt}` : ""}`
      ),
      ""
    );
  }
  lines.push(
    "<sub>Generated deterministically by System Synthesis. An LLM is not used to create findings.</sub>",
    ""
  );
  return lines.join("\n");
}

export function reviewToSarif(review: ArchitectureChangeReview): string {
  const sarif = validationToSarif({
    ...review.headValidation,
    issues: review.newFindings,
  });
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

export function reviewToJson(review: ArchitectureChangeReview): string {
  return `${JSON.stringify(JSON.parse(stableStringify(review)), null, 2)}\n`;
}

export function formatReview(
  review: ArchitectureChangeReview,
  format: ReviewOutputFormat
): string {
  if (format === "markdown") return reviewToMarkdown(review);
  if (format === "sarif") return reviewToSarif(review);
  return reviewToJson(review);
}
