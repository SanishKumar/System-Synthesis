import type {
  SerializedEdge,
  SerializedNode,
  SourceProvenance,
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "@system-synthesis/shared";
import { ArchitectureGraph } from "./graphAnalysis.js";
import {
  diffArchitectureGraphs,
  type SemanticGraphDiff,
} from "./graphDiff.js";
import type { CanonicalArchitectureGraph } from "./provenance.js";
import type { SourceImportDiagnostic } from "./adapters/types.js";
import {
  validateArchitectureDetailed,
  type AppliedSuppression,
  type RuleSuppression,
  type ValidationOptions,
} from "./validation.js";

export type ArchitectureImpactKind =
  | "resource-added"
  | "resource-removed"
  | "dependency-added"
  | "dependency-removed"
  | "public-exposure-added"
  | "public-exposure-removed"
  | "trust-boundary-crossing-added"
  | "trust-boundary-crossing-removed"
  | "redundancy-increased"
  | "redundancy-decreased"
  | "blast-radius-increased"
  | "blast-radius-decreased";

export interface ArchitectureImpact {
  id: string;
  kind: ArchitectureImpactKind;
  severity: ValidationSeverity;
  summary: string;
  description: string;
  nodeIds: string[];
  edgeIds: string[];
  locations: SourceProvenance[];
  before?: unknown;
  after?: unknown;
}

export interface ArchitectureRulePolicy {
  enabled?: boolean;
  severity?: ValidationSeverity;
  blockMerge?: boolean;
}

export interface ArchitecturePolicy {
  /** Severities that block when a finding is newly introduced. */
  failOn?: ValidationSeverity[];
  /** Set true to also block on findings that already existed on the base branch. */
  includeExistingFindings?: boolean;
  rules?: Record<string, ArchitectureRulePolicy>;
  suppressions?: RuleSuppression[];
}

export interface ArchitectureChangeReview {
  status: "pass" | "fail";
  base: CanonicalArchitectureGraph["source"];
  head: CanonicalArchitectureGraph["source"];
  reviewedAt: string;
  diff: SemanticGraphDiff;
  impacts: ArchitectureImpact[];
  baseValidation: ValidationResult;
  headValidation: ValidationResult;
  newFindings: ValidationIssue[];
  resolvedFindings: ValidationIssue[];
  blockingFindings: ValidationIssue[];
  suppressedFindings: AppliedSuppression[];
  baseDiagnostics: SourceImportDiagnostic[];
  headDiagnostics: SourceImportDiagnostic[];
}

export const DEFAULT_PR_POLICY: Required<
  Pick<ArchitecturePolicy, "failOn" | "includeExistingFindings">
> & Pick<ArchitecturePolicy, "rules"> = {
  failOn: ["critical"],
  includeExistingFindings: false,
  rules: {
    // Direct public-to-persistence access is sometimes intentional. The
    // default policy asks the team to document that decision explicitly.
    "compose-public-service-to-persistence": { blockMerge: true },
  },
};

function stringArray(node: SerializedNode, key: string): string[] {
  const value = node.data.sourceProperties?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function uniqueLocations(locations: SourceProvenance[]): SourceProvenance[] {
  return [...new Map(
    locations.map((location) => [
      `${location.file}:${location.startLine || 0}:${location.sourceAddress}`,
      location,
    ])
  ).values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.startLine || 0) - (right.startLine || 0) ||
      left.sourceAddress.localeCompare(right.sourceAddress)
  );
}

function nodeLocations(node: SerializedNode | undefined): SourceProvenance[] {
  return node?.data.provenance ? [node.data.provenance] : [];
}

function edgeLocations(edge: SerializedEdge | undefined): SourceProvenance[] {
  return edge?.data?.provenance || [];
}

function impact(
  id: string,
  kind: ArchitectureImpactKind,
  severity: ValidationSeverity,
  summary: string,
  description: string,
  nodeIds: string[],
  edgeIds: string[],
  locations: SourceProvenance[],
  before?: unknown,
  after?: unknown
): ArchitectureImpact {
  return {
    id,
    kind,
    severity,
    summary,
    description,
    nodeIds: [...new Set(nodeIds)].sort(),
    edgeIds: [...new Set(edgeIds)].sort(),
    locations: uniqueLocations(locations),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

function setDifference(left: string[], right: string[]): string[] {
  const rightValues = new Set(right);
  return left.filter((value) => !rightValues.has(value));
}

function trustBoundaryCrossing(
  edge: SerializedEdge,
  nodes: Map<string, SerializedNode>
): boolean {
  const sourceZone = nodes.get(edge.source)?.data.zone;
  const targetZone = nodes.get(edge.target)?.data.zone;
  return !!sourceZone && !!targetZone && sourceZone !== targetZone;
}

export function deriveArchitectureImpacts(
  base: CanonicalArchitectureGraph,
  head: CanonicalArchitectureGraph
): ArchitectureImpact[] {
  const impacts: ArchitectureImpact[] = [];
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const headNodes = new Map(head.nodes.map((node) => [node.id, node]));
  const baseEdges = new Map(base.edges.map((edge) => [edge.id, edge]));
  const headEdges = new Map(head.edges.map((edge) => [edge.id, edge]));

  for (const nodeId of [...new Set([...baseNodes.keys(), ...headNodes.keys()])].sort()) {
    const before = baseNodes.get(nodeId);
    const after = headNodes.get(nodeId);
    if (!before && after) {
      impacts.push(impact(
        `resource-added:${nodeId}`,
        "resource-added",
        "info",
        `Added ${after.data.label}`,
        `A new ${after.data.nodeType} resource was added.`,
        [nodeId],
        [],
        nodeLocations(after)
      ));
    } else if (before && !after) {
      impacts.push(impact(
        `resource-removed:${nodeId}`,
        "resource-removed",
        "warning",
        `Removed ${before.data.label}`,
        `The ${before.data.nodeType} resource was removed.`,
        [nodeId],
        [],
        nodeLocations(before)
      ));
    }
    if (!before || !after) continue;

    const beforePorts = stringArray(before, "publishedPorts");
    const afterPorts = stringArray(after, "publishedPorts");
    const addedPorts = setDifference(afterPorts, beforePorts);
    const removedPorts = setDifference(beforePorts, afterPorts);
    if (addedPorts.length) {
      const persistence = ["database", "storage", "warehouse"].includes(
        after.data.nodeType
      );
      impacts.push(impact(
        `public-exposure-added:${nodeId}:${addedPorts.join(",")}`,
        "public-exposure-added",
        persistence ? "critical" : "warning",
        `Published ${after.data.label} to the host`,
        `New host port(s): ${addedPorts.join(", ")}.`,
        [nodeId],
        [],
        nodeLocations(after),
        beforePorts,
        afterPorts
      ));
    }
    if (removedPorts.length) {
      impacts.push(impact(
        `public-exposure-removed:${nodeId}:${removedPorts.join(",")}`,
        "public-exposure-removed",
        "info",
        `Reduced exposure of ${after.data.label}`,
        `Removed host port(s): ${removedPorts.join(", ")}.`,
        [nodeId],
        [],
        nodeLocations(after),
        beforePorts,
        afterPorts
      ));
    }

    const beforeInstances = before.data.instances || 1;
    const afterInstances = after.data.instances || 1;
    if (beforeInstances !== afterInstances) {
      const increased = afterInstances > beforeInstances;
      impacts.push(impact(
        `redundancy-${increased ? "increased" : "decreased"}:${nodeId}`,
        increased ? "redundancy-increased" : "redundancy-decreased",
        increased ? "info" : "warning",
        `${increased ? "Increased" : "Decreased"} ${after.data.label} replicas`,
        `Replica count changed from ${beforeInstances} to ${afterInstances}.`,
        [nodeId],
        [],
        nodeLocations(after),
        beforeInstances,
        afterInstances
      ));
    }
  }

  for (const edgeId of [...new Set([...baseEdges.keys(), ...headEdges.keys()])].sort()) {
    const before = baseEdges.get(edgeId);
    const after = headEdges.get(edgeId);
    if (!before && after) {
      const source = headNodes.get(after.source);
      const target = headNodes.get(after.target);
      impacts.push(impact(
        `dependency-added:${edgeId}`,
        "dependency-added",
        "info",
        `Added dependency from ${source?.data.label || after.source} to ${target?.data.label || after.target}`,
        "A new runtime dependency was introduced.",
        [after.source, after.target],
        [edgeId],
        [...edgeLocations(after), ...nodeLocations(source), ...nodeLocations(target)]
      ));
      if (trustBoundaryCrossing(after, headNodes)) {
        impacts.push(impact(
          `trust-boundary-crossing-added:${edgeId}`,
          "trust-boundary-crossing-added",
          "warning",
          "Added a trust-boundary crossing",
          `${source?.data.label || after.source} and ${target?.data.label || after.target} are modeled in different trust zones.`,
          [after.source, after.target],
          [edgeId],
          edgeLocations(after)
        ));
      }
    } else if (before && !after) {
      const source = baseNodes.get(before.source);
      const target = baseNodes.get(before.target);
      impacts.push(impact(
        `dependency-removed:${edgeId}`,
        "dependency-removed",
        "warning",
        `Removed dependency from ${source?.data.label || before.source} to ${target?.data.label || before.target}`,
        "A runtime dependency was removed.",
        [before.source, before.target],
        [edgeId],
        [...edgeLocations(before), ...nodeLocations(source), ...nodeLocations(target)]
      ));
      if (trustBoundaryCrossing(before, baseNodes)) {
        impacts.push(impact(
          `trust-boundary-crossing-removed:${edgeId}`,
          "trust-boundary-crossing-removed",
          "info",
          "Removed a trust-boundary crossing",
          `${source?.data.label || before.source} no longer directly reaches ${target?.data.label || before.target}.`,
          [before.source, before.target],
          [edgeId],
          edgeLocations(before)
        ));
      }
    }
  }

  const baseAnalysis = new ArchitectureGraph(base.nodes, base.edges);
  const headAnalysis = new ArchitectureGraph(head.nodes, head.edges);
  for (const nodeId of [...baseNodes.keys()].filter((id) => headNodes.has(id)).sort()) {
    const before = baseAnalysis.blastRadius(nodeId).size;
    const after = headAnalysis.blastRadius(nodeId).size;
    if (before === after) continue;
    const increased = after > before;
    const node = headNodes.get(nodeId)!;
    impacts.push(impact(
      `blast-radius-${increased ? "increased" : "decreased"}:${nodeId}`,
      increased ? "blast-radius-increased" : "blast-radius-decreased",
      increased ? "warning" : "info",
      `${increased ? "Increased" : "Decreased"} blast radius of ${node.data.label}`,
      `Reachable downstream resources changed from ${before} to ${after}.`,
      [nodeId],
      [],
      nodeLocations(node),
      before,
      after
    ));
  }

  const severityOrder: Record<ValidationSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  return impacts.sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}

function validationOptions(
  policy: ArchitecturePolicy,
  now: Date
): ValidationOptions {
  const configuredRules = policy.rules || {};
  return {
    disabledRuleIds: Object.entries(configuredRules)
      .filter(([, configuration]) => configuration.enabled === false)
      .map(([ruleId]) => ruleId),
    severityOverrides: Object.fromEntries(
      Object.entries(configuredRules)
        .filter((entry): entry is [string, ArchitectureRulePolicy & { severity: ValidationSeverity }] =>
          !!entry[1].severity
        )
        .map(([ruleId, configuration]) => [ruleId, configuration.severity])
    ),
    suppressions: policy.suppressions,
    now,
  };
}

function mergePolicy(policy: ArchitecturePolicy): ArchitecturePolicy {
  return {
    ...DEFAULT_PR_POLICY,
    ...policy,
    failOn: policy.failOn || DEFAULT_PR_POLICY.failOn,
    rules: {
      ...DEFAULT_PR_POLICY.rules,
      ...(policy.rules || {}),
    },
    suppressions: policy.suppressions || [],
  };
}

export function reviewArchitectureChange(
  base: CanonicalArchitectureGraph,
  head: CanonicalArchitectureGraph,
  policy: ArchitecturePolicy = {},
  now: string | Date = new Date(),
  diagnostics: {
    base?: SourceImportDiagnostic[];
    head?: SourceImportDiagnostic[];
  } = {}
): ArchitectureChangeReview {
  if (base.source.adapter !== head.source.adapter) {
    throw new Error(
      `Cannot compare ${base.source.adapter} architecture to ${head.source.adapter} architecture.`
    );
  }
  const reviewedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(reviewedAt.getTime())) {
    throw new Error("Review time must be a valid date.");
  }
  const mergedPolicy = mergePolicy(policy);
  const options = validationOptions(mergedPolicy, reviewedAt);
  const baseValidation = validateArchitectureDetailed(
    base.nodes,
    base.edges,
    options
  );
  const headValidation = validateArchitectureDetailed(
    head.nodes,
    head.edges,
    options
  );
  const baseFindingIds = new Set(
    baseValidation.result.issues.map((finding) => finding.id)
  );
  const headFindingIds = new Set(
    headValidation.result.issues.map((finding) => finding.id)
  );
  const newFindings = headValidation.result.issues.filter(
    (finding) => !baseFindingIds.has(finding.id)
  );
  const resolvedFindings = baseValidation.result.issues.filter(
    (finding) => !headFindingIds.has(finding.id)
  );
  const candidates = mergedPolicy.includeExistingFindings
    ? headValidation.result.issues
    : newFindings;
  const failOn = new Set(mergedPolicy.failOn || []);
  const blockingFindings = candidates.filter(
    (finding) =>
      mergedPolicy.rules?.[finding.ruleId]?.blockMerge === true ||
      failOn.has(finding.severity)
  );

  return {
    status: blockingFindings.length ? "fail" : "pass",
    base: base.source,
    head: head.source,
    reviewedAt: reviewedAt.toISOString(),
    diff: diffArchitectureGraphs(
      base.nodes,
      base.edges,
      head.nodes,
      head.edges
    ),
    impacts: deriveArchitectureImpacts(base, head),
    baseValidation: baseValidation.result,
    headValidation: headValidation.result,
    newFindings,
    resolvedFindings,
    blockingFindings,
    suppressedFindings: headValidation.suppressed,
    baseDiagnostics: diagnostics.base || [],
    headDiagnostics: diagnostics.head || [],
  };
}
