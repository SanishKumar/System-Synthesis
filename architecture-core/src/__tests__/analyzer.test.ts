import { describe, expect, it } from "vitest";
import {
  ANALYZER_VERSION,
  analyzerRuleSetFingerprint,
  currentAnalyzerVersion,
} from "../analyzer.js";
import { DEFAULT_RULES, type ArchitectureRule } from "../validation.js";

/**
 * This list is the deliberate gate. Changing the rule set fails here first, so
 * the analyzer identity is always an explicit decision rather than a silent
 * side effect of editing rules.
 *
 * Adding the Kubernetes rules changed the fingerprint but not ANALYZER_VERSION.
 * The version records what the fingerprint cannot see — wording and impact
 * classification — and every Kubernetes rule is scoped to a Kubernetes graph,
 * so no verdict this analyzer had already reached moves. The identity change is
 * carried by the fingerprint alone, which is what it is for.
 */
const PINNED_RULE_SET = [
  "client-to-persistence:critical",
  "compose-dependency-without-healthcheck:info",
  "compose-public-service-to-persistence:warning",
  "compose-published-persistence-port:critical",
  "compose-published-sensitive-service-port:critical",
  "compose-restricted-sensitive-service-port:warning",
  "dependency-cycle:warning",
  "disconnected-component:info",
  "high-sla-single-instance:info",
  "incomplete-queue-flow:warning",
  "k8s-dependency-without-readiness-probe:info",
  "k8s-exposed-persistence-workload:critical",
  "k8s-exposed-sensitive-workload:critical",
  "k8s-sensitive-workload-without-network-policy:warning",
  "k8s-unevaluated-network-policy-selector:warning",
  "k8s-unresolved-workload-exposure:warning",
  "single-point-of-failure:warning",
  "unmediated-trust-boundary:warning",
];

function ruleSignature(rules: readonly ArchitectureRule[]): string[] {
  return rules.map((rule) => `${rule.id}:${rule.severity}`).sort();
}

describe("analyzer identity", () => {
  it("pins the numeric analyzer version", () => {
    // The fingerprint moves on its own whenever a rule id or severity changes.
    // This number is the part nothing computes: it records a change in what a
    // rule means while its identity stays the same, which is why it has to be
    // asserted rather than derived. Version 4 is the Kubernetes NetworkPolicy
    // rule, which kept its id and severity and changed its verdict.
    expect(ANALYZER_VERSION).toBe(4);
  });

  it("pins the deterministic rule set", () => {
    expect(ruleSignature(DEFAULT_RULES)).toEqual(PINNED_RULE_SET);
  });

  it("is stable across calls", () => {
    expect(currentAnalyzerVersion()).toBe(currentAnalyzerVersion());
    expect(currentAnalyzerVersion()).toBe(
      `v${ANALYZER_VERSION}+${analyzerRuleSetFingerprint()}`
    );
  });

  it("ignores rule ordering", () => {
    expect(analyzerRuleSetFingerprint([...DEFAULT_RULES].reverse())).toBe(
      analyzerRuleSetFingerprint(DEFAULT_RULES)
    );
  });

  it("changes when a rule is added", () => {
    const extra: ArchitectureRule = {
      id: "example-extra-rule",
      title: "Example",
      severity: "info",
      rationale: "Test rule.",
      appliesTo: () => false,
      evaluate: () => [],
    };
    expect(analyzerRuleSetFingerprint([...DEFAULT_RULES, extra])).not.toBe(
      analyzerRuleSetFingerprint(DEFAULT_RULES)
    );
  });

  it("changes when a default severity changes", () => {
    const escalated = DEFAULT_RULES.map((rule, index) =>
      index === 0 ? { ...rule, severity: "critical" as const } : rule
    );
    const relaxed = DEFAULT_RULES.map((rule, index) =>
      index === 0 ? { ...rule, severity: "info" as const } : rule
    );
    expect(analyzerRuleSetFingerprint(escalated)).not.toBe(
      analyzerRuleSetFingerprint(relaxed)
    );
  });

  it("ignores presentation-only edits", () => {
    const reworded = DEFAULT_RULES.map((rule) => ({
      ...rule,
      title: `${rule.title} (reworded)`,
      rationale: "Rewritten rationale.",
      references: ["EXAMPLE-1"],
    }));
    expect(analyzerRuleSetFingerprint(reworded)).toBe(
      analyzerRuleSetFingerprint(DEFAULT_RULES)
    );
  });
});
