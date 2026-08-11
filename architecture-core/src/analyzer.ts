import { fnv1a64, stableStringify } from "./provenance.js";
import { DEFAULT_RULES, type ArchitectureRule } from "./validation.js";

/**
 * Bump this when the behaviour of an existing rule changes while its id and
 * default severity stay the same — a reworded description does not count, but a
 * different set of findings does. Rule additions, removals, renames, and
 * severity changes are already detected by the fingerprint below, so this
 * number only covers what a fingerprint cannot see.
 *
 * `architecture-core/src/__tests__/analyzer.test.ts` pins the current rule set,
 * so a rule change cannot reach main without someone deciding what this
 * identity should become.
 *
 * Version 2 made exposure findings read the bind address instead of the mere
 * presence of a port. That also covers the impact wording, which the rule-set
 * fingerprint cannot see because no rule identity or severity changed.
 */
export const ANALYZER_VERSION = 2;

/**
 * Stable digest of the rule identities and default severities that decide a
 * verdict. Deliberately excludes titles, rationale, and references: those are
 * presentation, and rewording them must not invalidate stored reviews.
 */
export function analyzerRuleSetFingerprint(
  rules: readonly ArchitectureRule[] = DEFAULT_RULES
): string {
  const canonical = rules
    .map((rule) => [rule.id, rule.severity] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return fnv1a64(stableStringify(canonical));
}

/**
 * Identity of the deterministic analyzer that produced a review. Persisted with
 * every stored review so a frozen verdict can be told apart from one the
 * current rules would still produce.
 */
export function currentAnalyzerVersion(): string {
  return `v${ANALYZER_VERSION}+${analyzerRuleSetFingerprint()}`;
}
