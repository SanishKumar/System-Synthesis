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
import {
  formatPublishedPort,
  nodePortExposures,
  type PortExposure,
} from "./portExposure.js";
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
  // Distinct kinds so a consumer is not obliged to read prose to tell how far a
  // new binding actually reaches.
  | "restricted-exposure-added"
  | "restricted-exposure-removed"
  | "unresolved-exposure-added"
  | "unresolved-exposure-removed"
  | "loopback-binding-added"
  | "loopback-binding-removed"
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

/**
 * Whether the author of a change may certify it, and on what grounds.
 *
 * Proposing a change and certifying it are different acts, so the default
 * refuses the author however much permission they hold. Two exceptions exist
 * because refusing is not always protecting anything:
 *
 * - `sole_reviewer` allows it only where the provider confirms nobody else
 *   holds deciding permission. There is no separation of duties to preserve in
 *   a repository of one, and refusing there is a wall rather than a gate.
 * - `admin_override` allows an administrator to decide their own change even
 *   where others could have. This genuinely weakens the gate, which is why it
 *   has to be asked for, is checked against live permission, and is recorded
 *   under its own basis rather than looking like a peer review afterwards.
 */
export type SelfApprovalPolicy = "forbidden" | "sole_reviewer" | "admin_override";

export interface DecisionPolicy {
  /** Defaults to `forbidden`. */
  selfApproval?: SelfApprovalPolicy;
}

export interface ArchitecturePolicy {
  /** Severities that block when a finding is newly introduced. */
  failOn?: ValidationSeverity[];
  /** Set true to also block on findings that already existed on the base branch. */
  includeExistingFindings?: boolean;
  rules?: Record<string, ArchitectureRulePolicy>;
  suppressions?: RuleSuppression[];
  /**
   * Who may decide a review. Read from the base commit like every other policy
   * value, so a pull request cannot widen the rule that governs it.
   */
  decision?: DecisionPolicy;
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

/**
 * Groups a set of port strings by how far the node's matching bindings reach.
 *
 * A graph whose ports cannot be classified at all falls back to `unknown`
 * rather than dropping the impact or asserting external reach, matching how the
 * rules treat evidence that does not establish where a port is bound.
 */
function groupByReach(
  node: SerializedNode,
  ports: string[]
): Array<[PortExposure, string[]]> {
  const wanted = new Set(ports);
  const byReach = new Map<PortExposure, string[]>();
  for (const { binding, exposure } of nodePortExposures(node)) {
    const rendered = formatPublishedPort(binding);
    if (!wanted.has(rendered)) continue;
    byReach.set(exposure, [...(byReach.get(exposure) || []), rendered]);
  }
  if (!byReach.size) byReach.set("unknown", ports);
  return [...byReach].sort((left, right) => left[0].localeCompare(right[0]));
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
      // Grouped by how far each new port reaches. Describing a loopback binding
      // as a public exposure contradicts the rules, which correctly raise
      // nothing for it, and the contradiction is visible in the same report.
      for (const [reach, ports] of groupByReach(after, addedPorts)) {
        const presentation: {
          kind: ArchitectureImpactKind;
          severity: ValidationSeverity;
          summary: string;
          description: string;
        } = {
          external: {
            kind: "public-exposure-added" as const,
            severity: persistence ? ("critical" as const) : ("warning" as const),
            summary: `Published ${after.data.label} to the host`,
            description: `New host port(s) on every interface: ${ports.join(", ")}.`,
          },
          host: {
            kind: "restricted-exposure-added" as const,
            severity: "warning" as const,
            summary: `Bound ${after.data.label} to a reachable address`,
            description: `New host port(s) bound to a specific non-loopback address: ${ports.join(", ")}.`,
          },
          unknown: {
            kind: "unresolved-exposure-added" as const,
            severity: "warning" as const,
            summary: `Bound ${after.data.label} to an unresolved address`,
            description: `New host port(s) whose bind address could not be resolved: ${ports.join(", ")}.`,
          },
          loopback: {
            kind: "loopback-binding-added" as const,
            severity: "info" as const,
            summary: `Bound ${after.data.label} to loopback`,
            description: `New host port(s) reachable only from the machine: ${ports.join(", ")}.`,
          },
        }[reach];
        impacts.push(impact(
          `${presentation.kind}:${nodeId}:${ports.join(",")}`,
          presentation.kind,
          presentation.severity,
          presentation.summary,
          presentation.description,
          [nodeId],
          [],
          nodeLocations(after),
          beforePorts,
          afterPorts
        ));
      }
    }
    if (removedPorts.length) {
      // Classified from the node as it was, since the binding no longer exists
      // to classify. Removing a loopback binding reduced nothing public, and
      // saying otherwise is the same overstatement in the opposite direction.
      for (const [reach, ports] of groupByReach(before, removedPorts)) {
        const presentation: {
          kind: ArchitectureImpactKind;
          summary: string;
          description: string;
        } = {
          external: {
            kind: "public-exposure-removed" as const,
            summary: `Reduced exposure of ${after.data.label}`,
            description: `Removed host port(s) published on every interface: ${ports.join(", ")}.`,
          },
          host: {
            kind: "restricted-exposure-removed" as const,
            summary: `Removed a reachable binding from ${after.data.label}`,
            description: `Removed host port(s) bound to a specific non-loopback address: ${ports.join(", ")}.`,
          },
          unknown: {
            kind: "unresolved-exposure-removed" as const,
            summary: `Removed an unresolved binding from ${after.data.label}`,
            description: `Removed host port(s) whose bind address could not be resolved: ${ports.join(", ")}.`,
          },
          loopback: {
            kind: "loopback-binding-removed" as const,
            summary: `Removed a loopback binding from ${after.data.label}`,
            description: `Removed host port(s) that were reachable only from the machine: ${ports.join(", ")}.`,
          },
        }[reach];
        impacts.push(impact(
          `${presentation.kind}:${nodeId}:${ports.join(",")}`,
          presentation.kind,
          "info",
          presentation.summary,
          presentation.description,
          [nodeId],
          [],
          nodeLocations(after),
          beforePorts,
          afterPorts
        ));
      }
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
