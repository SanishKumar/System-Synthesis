import type {
  SerializedEdge,
  SerializedNode,
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "@system-synthesis/shared";
import { ArchitectureGraph } from "./graphAnalysis.js";

export interface ArchitectureRule {
  id: string;
  title: string;
  severity: ValidationSeverity;
  appliesTo(graph: ArchitectureGraph): boolean;
  evaluate(graph: ArchitectureGraph): ValidationIssue[];
  rationale: string;
  references?: string[];
}

export interface RuleSuppression {
  ruleId: string;
  nodeId?: string;
  edgeId?: string;
  justification: string;
}

export interface ValidationOptions {
  enabledRuleIds?: string[];
  disabledRuleIds?: string[];
  severityOverrides?: Partial<Record<string, ValidationSeverity>>;
  suppressions?: RuleSuppression[];
  additionalRules?: ArchitectureRule[];
}

function issue(
  rule: Pick<ArchitectureRule, "id" | "title" | "severity">,
  suffix: string,
  description: string,
  nodeIds: string[],
  edgeIds: string[] = []
): ValidationIssue {
  return {
    id: `${rule.id}:${suffix}`,
    ruleId: rule.id,
    severity: rule.severity,
    title: rule.title,
    description,
    nodeIds: [...new Set(nodeIds)].sort(),
    edgeIds: [...new Set(edgeIds)].sort(),
  };
}

const clientToPersistence: ArchitectureRule = {
  id: "client-to-persistence",
  title: "Direct client-to-persistence connection",
  severity: "critical",
  rationale: "Client traffic should cross an authenticated service boundary before reaching durable state.",
  references: ["OWASP-ASVS-V4"],
  appliesTo: (graph) => graph.nodes.some((node) => node.data.nodeType === "client"),
  evaluate(graph) {
    const clients = new Set(graph.nodes.filter((node) => node.data.nodeType === "client").map((node) => node.id));
    const persistent = new Set(
      graph.nodes
        .filter((node) => ["database", "storage", "warehouse"].includes(node.data.nodeType))
        .map((node) => node.id)
    );
    return graph.edges.flatMap((edge) =>
      clients.has(edge.source) && persistent.has(edge.target)
        ? [issue(this, edge.id, "A client reaches persistent storage without a service boundary.", [edge.source, edge.target], [edge.id])]
        : []
    );
  },
};

const dependencyCycle: ArchitectureRule = {
  id: "dependency-cycle",
  title: "Cyclic dependency",
  severity: "warning",
  rationale: "Cycles complicate deployment ordering, isolation, and failure recovery.",
  appliesTo: (graph) => graph.edges.length > 0,
  evaluate(graph) {
    return graph.cycles().map((component) => {
      const edgeIds = graph.edges
        .filter((edge) => component.includes(edge.source) && component.includes(edge.target))
        .map((edge) => edge.id);
      return issue(this, component.join("-"), `The dependency cycle contains ${component.length} component(s).`, component, edgeIds);
    });
  },
};

const singlePointOfFailure: ArchitectureRule = {
  id: "single-point-of-failure",
  title: "Potential single point of failure",
  severity: "warning",
  rationale: "Removing this component breaks an existing user-facing path to all persistent stores.",
  appliesTo: (graph) => graph.nodes.length >= 3,
  evaluate(graph) {
    const clients = graph.nodes.filter((node) => node.data.nodeType === "client");
    const persistentIds = new Set(
      graph.nodes
        .filter((node) => ["database", "storage", "warehouse"].includes(node.data.nodeType))
        .map((node) => node.id)
    );
    const findings: ValidationIssue[] = [];
    for (const candidate of graph.articulationPoints()) {
      if (persistentIds.has(candidate) || clients.some((client) => client.id === candidate)) continue;
      const affected = clients.filter((client) => {
        const before = [...graph.reachableFrom(client.id)].some((id) => persistentIds.has(id));
        const after = [...graph.reachableFrom(client.id, candidate)].some((id) => persistentIds.has(id));
        return before && !after;
      });
      if (affected.length) {
        const radius = [...graph.blastRadius(candidate)];
        findings.push(
          issue(
            this,
            candidate,
            `Removing this component disconnects ${affected.length} user-facing path(s); its downstream blast radius is ${radius.length}.`,
            [candidate, ...affected.map((node) => node.id), ...radius]
          )
        );
      }
    }
    return findings;
  },
};

const trustBoundary: ArchitectureRule = {
  id: "unmediated-trust-boundary",
  title: "Unmediated trust-boundary crossing",
  severity: "warning",
  rationale: "Connections crossing network trust zones should identify an explicit enforcement point.",
  appliesTo: (graph) => graph.nodes.some((node) => !!node.data.zone),
  evaluate(graph) {
    return graph.trustBoundaryCrossings().flatMap((edge) => {
      const source = graph.nodesById.get(edge.source)!;
      const target = graph.nodesById.get(edge.target)!;
      const enforcementTypes = new Set(["firewall", "gateway", "proxy"]);
      if (enforcementTypes.has(source.data.nodeType) || enforcementTypes.has(target.data.nodeType)) return [];
      return [
        issue(
          this,
          edge.id,
          `The connection crosses from ${source.data.zone} to ${target.data.zone} without a modeled enforcement component.`,
          [source.id, target.id],
          [edge.id]
        ),
      ];
    });
  },
};

const queueFlow: ArchitectureRule = {
  id: "incomplete-queue-flow",
  title: "Incomplete queue flow",
  severity: "warning",
  rationale: "A queue needs at least one modeled producer and one modeled consumer.",
  appliesTo: (graph) => graph.nodes.some((node) => ["queue", "broker"].includes(node.data.nodeType)),
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!["queue", "broker"].includes(node.data.nodeType)) return [];
      const producers = graph.incoming.get(node.id)?.size || 0;
      const consumers = graph.outgoing.get(node.id)?.size || 0;
      if (producers && consumers) return [];
      return [issue(this, node.id, `This component has ${producers} producer(s) and ${consumers} consumer(s).`, [node.id])];
    });
  },
};

const disconnectedComponent: ArchitectureRule = {
  id: "disconnected-component",
  title: "Disconnected component",
  severity: "info",
  rationale: "Disconnected modeled resources may be incomplete or intentionally staged.",
  appliesTo: (graph) => graph.nodes.length > 0,
  evaluate(graph) {
    return graph.disconnectedNodeIds().flatMap((nodeId) => {
      const node = graph.nodesById.get(nodeId)!;
      if (node.data.nodeType === "client") return [];
      return [issue(this, nodeId, "This component has no modeled dependencies.", [nodeId])];
    });
  },
};

const highSlaNoRedundancy: ArchitectureRule = {
  id: "high-sla-single-instance",
  title: "High SLA without modeled redundancy",
  severity: "info",
  rationale: "A single process or replica is unlikely to satisfy a four-nines availability target.",
  appliesTo: (graph) => graph.nodes.some((node) => !!node.data.sla),
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      const sla = Number.parseFloat((node.data.sla || "").replace("%", ""));
      if (!Number.isFinite(sla) || sla < 99.99 || (node.data.instances || 1) > 1) return [];
      return [issue(this, node.id, `${node.data.sla} is modeled with ${node.data.instances || 1} instance.`, [node.id])];
    });
  },
};

export const DEFAULT_RULES: ArchitectureRule[] = [
  clientToPersistence,
  dependencyCycle,
  singlePointOfFailure,
  trustBoundary,
  queueFlow,
  disconnectedComponent,
  highSlaNoRedundancy,
];

function isSuppressed(finding: ValidationIssue, suppressions: RuleSuppression[]): boolean {
  return suppressions.some((suppression) => {
    if (!suppression.justification.trim() || suppression.ruleId !== finding.ruleId) return false;
    if (suppression.nodeId && !finding.nodeIds.includes(suppression.nodeId)) return false;
    if (suppression.edgeId && !finding.edgeIds.includes(suppression.edgeId)) return false;
    return true;
  });
}

export function validateArchitecture(
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: ValidationOptions = {}
): ValidationResult {
  const graph = new ArchitectureGraph(
    nodes.filter((node) => node.data.metadata?.notes !== "__text_label__"),
    edges
  );
  const enabled = options.enabledRuleIds ? new Set(options.enabledRuleIds) : null;
  const disabled = new Set(options.disabledRuleIds || []);
  const rules = [...DEFAULT_RULES, ...(options.additionalRules || [])]
    .filter((rule) => (!enabled || enabled.has(rule.id)) && !disabled.has(rule.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const suppressions = options.suppressions || [];

  const findings = rules.flatMap((rule) => {
    if (!rule.appliesTo(graph)) return [];
    const severity = options.severityOverrides?.[rule.id] || rule.severity;
    return rule
      .evaluate(graph)
      .map((finding) => ({ ...finding, severity }))
      .filter((finding) => !isSuppressed(finding, suppressions));
  });
  const severityOrder: Record<ValidationSeverity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.id.localeCompare(right.id)
  );
  return {
    issues: findings,
    timestamp: new Date().toISOString(),
    stats: {
      critical: findings.filter((finding) => finding.severity === "critical").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
    },
  };
}

export function validationToSarif(result: ValidationResult) {
  const rules = new Map(DEFAULT_RULES.map((rule) => [rule.id, rule]));
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "System Synthesis Architecture Linter",
            rules: [...new Set(result.issues.map((finding) => finding.ruleId))].sort().map((ruleId) => ({
              id: ruleId,
              name: rules.get(ruleId)?.title || ruleId,
              help: { text: rules.get(ruleId)?.rationale || "Custom architecture policy" },
            })),
          },
        },
        results: result.issues.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.severity === "critical" ? "error" : finding.severity === "warning" ? "warning" : "note",
          message: { text: finding.description },
          properties: { nodeIds: finding.nodeIds, edgeIds: finding.edgeIds },
        })),
      },
    ],
  };
}
