import { describe, expect, it } from "vitest";
import { reviewArchitectureChange } from "../index.js";
import type { CanonicalArchitectureGraph } from "../provenance.js";

const REVIEWED_AT = "2026-08-21T00:00:00.000Z";

/**
 * A graph as importer version 1 stored it.
 *
 * Version 1 recorded `selectedByNetworkPolicy` and nothing about direction. It
 * read only `matchLabels`, so a `matchExpressions` selector reduced to an empty
 * one and selected the whole namespace, and it ignored `policyTypes`, so an
 * egress-only policy counted. Neither value it stored can be turned into a
 * coverage claim after the fact, in either direction: `false` may have been a
 * policy it could not evaluate, and `true` may have been a policy that governs
 * only egress.
 *
 * Constructed by hand rather than by the adapter, because no current adapter
 * can produce this shape — which is the point. These graphs exist in storage.
 */
function legacyGraph(selectedByNetworkPolicy: boolean): CanonicalArchitectureGraph {
  return {
    source: {
      adapter: "kubernetes",
      adapterVersion: 1,
      repository: "acme/shop",
      revision: "head",
      files: ["k8s/shop.yaml"],
    },
    nodes: [
      {
        id: "src-node-primary-0000000000000001",
        type: "architecture",
        position: { x: 0, y: 0 },
        data: {
          label: "primary",
          subtitle: "Kubernetes StatefulSet",
          nodeType: "database",
          status: "active",
          metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
          zone: "private",
          provenance: {
            adapter: "kubernetes",
            revision: "head",
            file: "k8s/shop.yaml",
            sourceAddress: "shop/StatefulSet/primary",
            confidence: "explicit",
          },
          sourceProperties: {
            kind: "StatefulSet",
            namespace: "shop",
            images: ["postgres:16"],
            containerPorts: ["5432"],
            clusterExposure: "cluster",
            serviceTypes: ["ClusterIP"],
            serviceNames: ["primary"],
            exposedPorts: [],
            hasReadinessProbe: false,
            hasLivenessProbe: false,
            networkPoliciesDeclared: true,
            // The v1 field. No ingressPolicyCoverage, no egressPolicyCoverage.
            selectedByNetworkPolicy,
          },
        },
      },
    ],
    edges: [],
  };
}

const EMPTY: CanonicalArchitectureGraph = {
  source: { adapter: "kubernetes", adapterVersion: 1, files: [] },
  nodes: [],
  edges: [],
};

const COVERAGE_RULES = new Set([
  "k8s-sensitive-workload-without-network-policy",
  "k8s-unevaluated-network-policy-selector",
]);

function coverageFindings(graph: CanonicalArchitectureGraph): string[] {
  const review = reviewArchitectureChange(EMPTY, graph, {}, REVIEWED_AT);
  return review.headValidation.issues
    .map((finding) => finding.ruleId)
    .filter((id) => COVERAGE_RULES.has(id))
    .sort();
}

describe("a graph an earlier importer stored makes no coverage claim", () => {
  it("does not invent a missing-policy finding from a field that was never recorded", () => {
    // The defect: an absent coverage field read as `uncovered` turns silence in
    // storage into a finding about the source. Re-analysis reuses these graphs
    // rather than re-reading anything, so the finding would be manufactured
    // from information the import never established.
    expect(coverageFindings(legacyGraph(false))).toEqual([]);
  });

  it("does not treat the old selected flag as coverage either", () => {
    // Reading `true` as covered would be the same mistake pointed the other
    // way: v1 counted an egress-only policy and a selector it had misread.
    expect(coverageFindings(legacyGraph(true))).toEqual([]);
  });

  it("still says the graphs need a new delivery", () => {
    // Making no claim is not the same as saying nothing is wrong. Import
    // staleness remains the signal, and it is not fixable by re-analysis.
    const review = reviewArchitectureChange(EMPTY, legacyGraph(false), {}, REVIEWED_AT);
    expect(review.head.adapterVersion).toBe(1);
  });
});
