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
  formatPublishedPort,
  hasReachablePort,
  nodePortExposures,
  type PortExposure,
} from "./portExposure.js";

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

/** Durable stores. Kept separate from caches and brokers so that widening one
 * rule's coverage cannot silently widen another's. */
const PERSISTENCE_TYPES = ["database", "storage", "warehouse"];
/** Services that routinely hold credentials, sessions, messages, or indexed
 * copies of production data, and should not be reachable from outside. */
const SENSITIVE_TYPES = [...PERSISTENCE_TYPES, "cache", "broker", "search"];

function isComposeGraph(graph: ArchitectureGraph): boolean {
  return graph.nodes.some((node) => node.data.provenance?.adapter === "docker-compose");
}

function exposedPorts(node: SerializedNode, reach: PortExposure[]): string[] {
  return nodePortExposures(node)
    .filter((entry) => reach.includes(entry.exposure))
    .map((entry) => formatPublishedPort(entry.binding));
}

const publishedPersistencePort: ArchitectureRule = {
  id: "compose-published-persistence-port",
  title: "Persistence port is publicly published",
  severity: "critical",
  rationale: "Databases and durable stores should not publish a host port unless external access is explicitly required and protected.",
  references: ["CWE-284"],
  appliesTo: isComposeGraph,
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!PERSISTENCE_TYPES.includes(node.data.nodeType)) return [];
      // Only a binding that reaches beyond the machine. A port restricted to
      // loopback is the recommended way to reach a database locally.
      const ports = exposedPorts(node, ["external"]);
      if (!ports.length) return [];
      return [issue(
        this,
        node.id,
        `The ${node.data.label} persistence service publishes host port(s) on every interface: ${ports.join(", ")}.`,
        [node.id]
      )];
    });
  },
};

const publishedSensitiveServicePort: ArchitectureRule = {
  id: "compose-published-sensitive-service-port",
  title: "Sensitive service port is publicly published",
  severity: "critical",
  rationale: "Caches, brokers, and search engines hold sessions, credentials, queued messages, and indexed copies of production data, and are frequently deployed without authentication because they are assumed to be internal.",
  references: ["CWE-284"],
  appliesTo: isComposeGraph,
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      // Deliberately disjoint from the persistence rule so one exposure cannot
      // produce two findings.
      if (!["cache", "broker", "search"].includes(node.data.nodeType)) return [];
      const ports = exposedPorts(node, ["external"]);
      if (!ports.length) return [];
      return [issue(
        this,
        node.id,
        `The ${node.data.label} ${node.data.nodeType} publishes host port(s) on every interface: ${ports.join(", ")}.`,
        [node.id]
      )];
    });
  },
};

const restrictedSensitivePort: ArchitectureRule = {
  id: "compose-restricted-sensitive-service-port",
  title: "Sensitive service port is bound to a reachable address",
  severity: "warning",
  rationale: "A port bound to a specific non-loopback address is reachable from that network, and one whose address cannot be resolved may be reachable from anywhere. Neither is contained, and neither is as clear-cut as publishing on every interface.",
  appliesTo: isComposeGraph,
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!SENSITIVE_TYPES.includes(node.data.nodeType)) return [];
      // A separate rule because a rule carries one severity, and these are not
      // as certain as an external binding.
      const ports = exposedPorts(node, ["host", "unknown"]);
      if (!ports.length) return [];
      return [issue(
        this,
        node.id,
        `The ${node.data.label} ${node.data.nodeType} binds host port(s) to an address that is not loopback: ${ports.join(", ")}.`,
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
      // Reachable from beyond the machine, rather than merely having a port.
      const sourceIsPublic = hasReachablePort(source);
      const targetIsPersistence = PERSISTENCE_TYPES.includes(target.data.nodeType);
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

function isKubernetesGraph(graph: ArchitectureGraph): boolean {
  return graph.nodes.some((node) => node.data.provenance?.adapter === "kubernetes");
}

/**
 * How far a workload's Services carry it. Absent means the adapter recorded no
 * reach for it, which is the case for a workload no Service selects.
 */
function clusterReach(node: SerializedNode): string {
  const value = node.data.sourceProperties?.clusterExposure;
  return typeof value === "string" ? value : "cluster";
}

/**
 * What kind of Service published this workload.
 *
 * Read from `exposedServiceTypes`, which lists only the Services whose own
 * reach leaves the cluster. It deliberately does not fall back to
 * `serviceTypes`: that list names every Service selecting the workload, so a
 * graph extracted before exposure was tracked per Service would let a finding
 * report that a ClusterIP published something when a separate LoadBalancer
 * did. An older graph says "Service" and claims nothing further.
 */
function describeServices(node: SerializedNode): string {
  const types = [...new Set(sourceStringArray(node, "exposedServiceTypes"))];
  return types.length ? types.join(", ") : "Service";
}

const exposedPersistenceWorkload: ArchitectureRule = {
  id: "k8s-exposed-persistence-workload",
  title: "Persistence workload is published outside the cluster",
  severity: "critical",
  rationale: "Databases and durable stores should not be routable from outside the cluster unless external access is explicitly required and protected.",
  references: ["CWE-284"],
  appliesTo: isKubernetesGraph,
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!PERSISTENCE_TYPES.includes(node.data.nodeType)) return [];
      // A ClusterIP port is how a datastore is supposed to be reached. Only a
      // route past the cluster boundary is a finding.
      const reach = clusterReach(node);
      if (reach !== "external" && reach !== "node") return [];
      const ports = sourceStringArray(node, "exposedPorts");
      return [issue(
        this,
        node.id,
        `The ${node.data.label} persistence workload is published outside the cluster by a ${describeServices(node)} Service${ports.length ? `: ${ports.join(", ")}` : ""}.`,
        [node.id]
      )];
    });
  },
};

const exposedSensitiveWorkload: ArchitectureRule = {
  id: "k8s-exposed-sensitive-workload",
  title: "Sensitive workload is published outside the cluster",
  severity: "critical",
  rationale: "Caches, brokers, and search engines hold sessions, credentials, queued messages, and indexed copies of production data, and are frequently deployed without authentication because they are assumed to be cluster-internal.",
  references: ["CWE-284"],
  appliesTo: isKubernetesGraph,
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      // Deliberately disjoint from the persistence rule so one exposure cannot
      // produce two findings.
      if (!["cache", "broker", "search"].includes(node.data.nodeType)) return [];
      const reach = clusterReach(node);
      if (reach !== "external" && reach !== "node") return [];
      const ports = sourceStringArray(node, "exposedPorts");
      return [issue(
        this,
        node.id,
        `The ${node.data.label} ${node.data.nodeType} is published outside the cluster by a ${describeServices(node)} Service${ports.length ? `: ${ports.join(", ")}` : ""}.`,
        [node.id]
      )];
    });
  },
};

const unresolvedWorkloadExposure: ArchitectureRule = {
  id: "k8s-unresolved-workload-exposure",
  title: "Sensitive workload has an unresolved Service type",
  severity: "warning",
  rationale: "A Service type this import could not resolve may be LoadBalancer or NodePort once applied. The reach cannot be established from the source, and an unestablished reach is not a contained one.",
  appliesTo: isKubernetesGraph,
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!SENSITIVE_TYPES.includes(node.data.nodeType)) return [];
      if (clusterReach(node) !== "unknown") return [];
      return [issue(
        this,
        node.id,
        `The ${node.data.label} ${node.data.nodeType} is fronted by a Service whose type this import could not resolve.`,
        [node.id]
      )];
    });
  },
};

/**
 * What the import established about inbound protection, if anything.
 *
 * `unstated` is the answer for a graph extracted before coverage was recorded
 * per direction. Reading an absent field as `uncovered` turned silence in
 * storage into a finding about somebody's cluster: re-analysis reuses stored
 * graphs rather than re-reading source, so the claim would rest on nothing.
 *
 * The version that stored no coverage stored `selectedByNetworkPolicy`, and
 * that value is not convertible into one. It ignored `policyTypes`, so it
 * counted a policy governing only egress, and it read a `matchExpressions`
 * selector as an empty one, which selects an entire namespace. Its `true` may
 * mean neither, and its `false` may mean a selector it could not evaluate.
 * Neither direction is safe to infer, so neither is inferred.
 */
function ingressCoverage(node: SerializedNode): string {
  const value = node.data.sourceProperties?.ingressPolicyCoverage;
  return value === "covered" || value === "uncovered" || value === "unknown"
    ? value
    : "unstated";
}

const sensitiveWorkloadWithoutNetworkPolicy: ArchitectureRule = {
  id: "k8s-sensitive-workload-without-network-policy",
  title: "Sensitive workload is not covered by an ingress NetworkPolicy",
  severity: "warning",
  rationale: "Without a policy governing traffic into it, a workload accepts connections from every pod in the cluster, so a compromise anywhere reaches it directly. A policy that governs only egress does not answer this.",
  references: ["CWE-1327"],
  // Only where the source models network boundaries at all. Reporting every
  // workload in a repository that uses none would say nothing about that
  // repository beyond the fact that it uses none.
  appliesTo: (graph) => isKubernetesGraph(graph) && graph.nodes.some(
    (node) => node.data.sourceProperties?.networkPoliciesDeclared === true
  ),
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!SENSITIVE_TYPES.includes(node.data.nodeType)) return [];
      if (node.data.sourceProperties?.networkPoliciesDeclared !== true) return [];
      // Only a coverage this import actually established as absent. A selector
      // it could not evaluate is a separate finding, because it is a different
      // claim about a different thing.
      if (ingressCoverage(node) !== "uncovered") return [];
      return [issue(
        this,
        node.id,
        `${node.data.label} holds sensitive data and no NetworkPolicy in this import governs traffic into it.`,
        [node.id]
      )];
    });
  },
};

const unevaluatedNetworkPolicySelector: ArchitectureRule = {
  id: "k8s-unevaluated-network-policy-selector",
  title: "NetworkPolicy coverage could not be established",
  severity: "warning",
  rationale: "A policy whose selector this import cannot evaluate — set-based matchExpressions, or a value it could not resolve — leaves inbound protection unestablished. Reading such a selector as though it covered the workload is how an unrelated policy comes to satisfy a protection finding.",
  references: ["CWE-1327"],
  appliesTo: (graph) => isKubernetesGraph(graph) && graph.nodes.some(
    (node) => node.data.sourceProperties?.networkPoliciesDeclared === true
  ),
  evaluate(graph) {
    return graph.nodes.flatMap((node) => {
      if (!SENSITIVE_TYPES.includes(node.data.nodeType)) return [];
      if (node.data.sourceProperties?.networkPoliciesDeclared !== true) return [];
      if (ingressCoverage(node) !== "unknown") return [];
      return [issue(
        this,
        node.id,
        `A NetworkPolicy that may select ${node.data.label} uses a selector this import cannot evaluate, so its inbound protection is unestablished rather than confirmed.`,
        [node.id]
      )];
    });
  },
};

const dependencyWithoutReadinessProbe: ArchitectureRule = {
  id: "k8s-dependency-without-readiness-probe",
  title: "Dependency has no modeled readiness probe",
  severity: "info",
  rationale: "Without a readiness probe a pod receives Service traffic as soon as it starts, so a dependent workload can be routed to a dependency that is not yet usable.",
  appliesTo: isKubernetesGraph,
  evaluate(graph) {
    const targets = [...new Set(graph.edges.map((edge) => edge.target))].sort();
    return targets.flatMap((nodeId) => {
      const node = graph.nodesById.get(nodeId);
      if (!node || node.data.sourceProperties?.hasReadinessProbe === true) return [];
      // An Ingress has no pods and therefore no probe to model.
      if (node.data.sourceProperties?.kind === "Ingress") return [];
      return [issue(
        this,
        node.id,
        `${node.data.label} is a dependency but declares no readiness probe.`,
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
  publishedSensitiveServicePort,
  restrictedSensitivePort,
  publicServiceToPersistence,
  exposedPersistenceWorkload,
  exposedSensitiveWorkload,
  unresolvedWorkloadExposure,
  sensitiveWorkloadWithoutNetworkPolicy,
  unevaluatedNetworkPolicySelector,
  dependencyWithoutReadinessProbe,
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
