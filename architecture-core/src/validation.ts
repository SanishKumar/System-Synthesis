import type {
  SerializedEdge,
  SerializedNode,
  SourceProvenance,
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
  id?: string;
  ruleId: string;
  findingId?: string;
  nodeId?: string;
  edgeId?: string;
  sourceAddress?: string;
  justification: string;
  createdBy?: string;
  createdAt?: string;
  expiresAt?: string;
  ticket?: string;
}

export interface ValidationOptions {
  enabledRuleIds?: string[];
  disabledRuleIds?: string[];
  severityOverrides?: Partial<Record<string, ValidationSeverity>>;
  suppressions?: RuleSuppression[];
  additionalRules?: ArchitectureRule[];
  /** Makes expiry handling and report timestamps reproducible in tests/CI. */
  now?: string | Date;
}

export interface AppliedSuppression {
  finding: ValidationIssue;
  suppression: RuleSuppression;
}

export interface DetailedValidationResult {
  result: ValidationResult;
  suppressed: AppliedSuppression[];
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

function sourceStringArray(node: SerializedNode, key: string): string[] {
  const value = node.data.sourceProperties?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const publishedPersistencePort: ArchitectureRule = {
  id: "compose-published-persistence-port",
  title: "Persistence port is publicly published",
  severity: "critical",
  rationale: "Databases and durable stores should not publish a host port unless external access is explicitly required and protected.",
  references: ["CWE-284"],
  appliesTo: (graph) => graph.nodes.some(
    (node) => node.data.provenance?.adapter === "docker-compose"
  ),
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!["database", "storage", "warehouse"].includes(node.data.nodeType)) {
        return [];
      }
      const ports = sourceStringArray(node, "publishedPorts");
      if (!ports.length) return [];
      return [issue(
        this,
        node.id,
        `The ${node.data.label} persistence service publishes host port(s): ${ports.join(", ")}.`,
        [node.id]
      )];
    });
  },
};

const publicServiceToPersistence: ArchitectureRule = {
  id: "compose-public-service-to-persistence",
  title: "Public service directly depends on persistence",
  severity: "warning",
  rationale: "This is not universally invalid, but it expands the impact of a compromised public service and should be an explicit architectural decision.",
  appliesTo: (graph) => graph.nodes.some(
    (node) => node.data.provenance?.adapter === "docker-compose"
  ),
  evaluate(graph) {
    return graph.edges.flatMap((edge) => {
      const source = graph.nodesById.get(edge.source);
      const target = graph.nodesById.get(edge.target);
      if (!source || !target) return [];
      const sourceIsPublic = sourceStringArray(source, "publishedPorts").length > 0;
      const targetIsPersistence = ["database", "storage", "warehouse"].includes(
        target.data.nodeType
      );
      if (!sourceIsPublic || !targetIsPersistence) return [];
      return [issue(
        this,
        edge.id,
        `${source.data.label} publishes a host port and directly depends on ${target.data.label}.`,
        [source.id, target.id],
        [edge.id]
      )];
    });
  },
};

const dependencyWithoutHealthcheck: ArchitectureRule = {
  id: "compose-dependency-without-healthcheck",
  title: "Dependency has no modeled healthcheck",
  severity: "info",
  rationale: "Startup ordering is not readiness; a dependent service can start before its dependency is usable.",
  appliesTo: (graph) => graph.nodes.some(
    (node) => node.data.provenance?.adapter === "docker-compose"
  ),
  evaluate(graph) {
    const targets = [...new Set(graph.edges.map((edge) => edge.target))].sort();
    return targets.flatMap((nodeId) => {
      const node = graph.nodesById.get(nodeId);
      if (!node || node.data.sourceProperties?.hasHealthcheck === true) return [];
      return [issue(
        this,
        node.id,
        `${node.data.label} is a dependency but has no Docker Compose healthcheck.`,
        [node.id],
        graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.id)
      )];
    });
  },
};

export const DEFAULT_RULES: ArchitectureRule[] = [
  clientToPersistence,
  dependencyWithoutHealthcheck,
  dependencyCycle,
  singlePointOfFailure,
  trustBoundary,
  queueFlow,
  disconnectedComponent,
  highSlaNoRedundancy,
  publishedPersistencePort,
  publicServiceToPersistence,
];

function findingLocations(
  finding: ValidationIssue,
  graph: ArchitectureGraph
): SourceProvenance[] {
  const locations = [
    ...finding.nodeIds.flatMap((nodeId) => {
      const location = graph.nodesById.get(nodeId)?.data.provenance;
      return location ? [location] : [];
    }),
    ...finding.edgeIds.flatMap((edgeId) =>
      graph.edgesById.get(edgeId)?.data?.provenance || []
    ),
  ];
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

function matchingSuppression(
  finding: ValidationIssue,
  suppressions: RuleSuppression[],
  now: Date
): RuleSuppression | undefined {
  return suppressions.find((suppression) => {
    if (!suppression.justification.trim() || suppression.ruleId !== finding.ruleId) return false;
    if (suppression.findingId && suppression.findingId !== finding.id) return false;
    if (suppression.nodeId && !finding.nodeIds.includes(suppression.nodeId)) return false;
    if (suppression.edgeId && !finding.edgeIds.includes(suppression.edgeId)) return false;
    if (
      suppression.sourceAddress &&
      !finding.locations?.some(
        (location) => location.sourceAddress === suppression.sourceAddress
      )
    ) return false;
    if (suppression.expiresAt) {
      const expiry = new Date(suppression.expiresAt);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
        return false;
      }
    }
    return true;
  });
}

export function validateArchitectureDetailed(
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: ValidationOptions = {}
): DetailedValidationResult {
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
  const now = options.now instanceof Date
    ? options.now
    : options.now
      ? new Date(options.now)
      : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("ValidationOptions.now must be a valid date.");
  }
  const suppressed: AppliedSuppression[] = [];

  const findings = rules.flatMap((rule) => {
    if (!rule.appliesTo(graph)) return [];
    const severity = options.severityOverrides?.[rule.id] || rule.severity;
    return rule
      .evaluate(graph)
      .map((finding) => ({
        ...finding,
        severity,
        locations: findingLocations(finding, graph),
      }))
      .filter((finding) => {
        const suppression = matchingSuppression(finding, suppressions, now);
        if (!suppression) return true;
        suppressed.push({ finding, suppression });
        return false;
      });
  });
  const severityOrder: Record<ValidationSeverity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.id.localeCompare(right.id)
  );
  return {
    result: {
      issues: findings,
      timestamp: now.toISOString(),
      stats: {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        warning: findings.filter((finding) => finding.severity === "warning").length,
        info: findings.filter((finding) => finding.severity === "info").length,
      },
    },
    suppressed,
  };
}

export function validateArchitecture(
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: ValidationOptions = {}
): ValidationResult {
  return validateArchitectureDetailed(nodes, edges, options).result;
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
          locations: finding.locations?.length
            ? finding.locations.map((location) => ({
                physicalLocation: {
                  artifactLocation: { uri: location.file.replace(/\\/g, "/") },
                  ...(location.startLine
                    ? {
                        region: {
                          startLine: location.startLine,
                          ...(location.endLine
                            ? { endLine: location.endLine }
                            : {}),
                        },
                      }
                    : {}),
                },
              }))
            : undefined,
        })),
      },
    ],
  };
}
