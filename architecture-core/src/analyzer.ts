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
 *
 * Version 3 stopped treating a legacy port string with no recorded address as
 * proof of external reach, since the old importer discarded the address of a
 * long-syntax entry, and classified removal impacts the same way as additions.
 * Both change stored findings and impacts without touching any rule identity.
 *
 * Version 4 changed what `k8s-sensitive-workload-without-network-policy` means
 * while keeping its identity and severity. It fired on a workload no policy
 * selected; it now fires on one no policy governs inbound, and stays silent
 * where coverage could not be established or was never recorded. Same id, same
 * severity, different verdict from the same graph — which is precisely what the
 * rule-set fingerprint cannot see and this number exists to record.
 *
 * Version 5 changed the evidence the Kubernetes exposure findings carry. They
 * name the Service that published a workload from `exposedServiceTypes` rather
 * than from every Service selecting it, so a workload behind a LoadBalancer and
 * a ClusterIP is no longer reported as published by the ClusterIP. This is not
 * a rewording, which is why it is here rather than being left to the rule-set
 * fingerprint: given one unchanged stored graph the analyzer now produces
 * different text, and a graph extracted before that field existed drops to a
 * plain "Service" instead of reusing a list that could name the wrong one. Rule
 * identities and severities are untouched, and the same findings still fire.
 */
export const ANALYZER_VERSION = 5;

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
