/**
 * Deterministic Architecture Validation Engine
 * 
 * Runs a set of static rules against the board graph and produces
 * ValidationIssues grouped by severity. No AI/LLM calls — pure logic.
 * 
 * Rules are ordered by severity: critical → warning → info
 */

import type {
  SerializedNode,
  SerializedEdge,
  ArchNodeData,
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "@system-synthesis/shared";

// Utility to generate deterministic issue IDs
let issueCounter = 0;
function makeId(ruleId: string, ...parts: string[]): string {
  return `${ruleId}:${parts.join(":")}`;
}

// ============================================================
// Individual Rule Functions
// ============================================================

/**
 * CRITICAL: Client → Database direct connection.
 * A client node should never connect directly to a database — there should
 * be a service or gateway in between.
 */
function ruleClientToDatabase(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const clientIds = new Set(nodes.filter((n) => n.data.nodeType === "client").map((n) => n.id));
  const dbIds = new Set(nodes.filter((n) => n.data.nodeType === "database").map((n) => n.id));

  for (const edge of edges) {
    if (clientIds.has(edge.source) && dbIds.has(edge.target)) {
      const client = nodes.find((n) => n.id === edge.source);
      const db = nodes.find((n) => n.id === edge.target);
      issues.push({
        id: makeId("client-to-db", edge.id),
        severity: "critical",
        title: "Client → Database Direct Connection",
        description: `"${client?.data.label}" connects directly to "${db?.data.label}". Route traffic through a service or API gateway instead.`,
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        ruleId: "client-to-db",
      });
    }
  }

  return issues;
}

/**
 * CRITICAL: Gateway → Database direct connection.
 * API gateways should route to services, not directly to databases.
 */
function ruleGatewayToDatabase(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const gwIds = new Set(nodes.filter((n) => n.data.nodeType === "gateway").map((n) => n.id));
  const dbIds = new Set(nodes.filter((n) => n.data.nodeType === "database").map((n) => n.id));

  for (const edge of edges) {
    if (gwIds.has(edge.source) && dbIds.has(edge.target)) {
      const gw = nodes.find((n) => n.id === edge.source);
      const db = nodes.find((n) => n.id === edge.target);
      issues.push({
        id: makeId("gateway-to-db", edge.id),
        severity: "critical",
        title: "Gateway → Database Direct Access",
        description: `"${gw?.data.label}" connects directly to "${db?.data.label}". API gateways should route to services, not databases.`,
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        ruleId: "gateway-to-db",
      });
    }
  }

  return issues;
}

/**
 * WARNING: Queue with no producer or no consumer.
 * A queue that nobody writes to or reads from is dead infrastructure.
 */
function ruleOrphanedQueue(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const queueNodes = nodes.filter((n) => n.data.nodeType === "queue");

  for (const queue of queueNodes) {
    const hasProducer = edges.some((e) => e.target === queue.id);
    const hasConsumer = edges.some((e) => e.source === queue.id);

    if (!hasProducer && !hasConsumer) {
      issues.push({
        id: makeId("orphaned-queue", queue.id),
        severity: "warning",
        title: "Disconnected Queue",
        description: `"${queue.data.label}" has no producers or consumers. It is completely isolated.`,
        nodeIds: [queue.id],
        edgeIds: [],
        ruleId: "orphaned-queue",
      });
    } else if (!hasProducer) {
      issues.push({
        id: makeId("queue-no-producer", queue.id),
        severity: "warning",
        title: "Queue Without Producer",
        description: `"${queue.data.label}" has no incoming connections (producers). Nothing is publishing messages to it.`,
        nodeIds: [queue.id],
        edgeIds: [],
        ruleId: "queue-no-producer",
      });
    } else if (!hasConsumer) {
      issues.push({
        id: makeId("queue-no-consumer", queue.id),
        severity: "warning",
        title: "Queue Without Consumer",
        description: `"${queue.data.label}" has no outgoing connections (consumers). Messages will queue indefinitely.`,
        nodeIds: [queue.id],
        edgeIds: [],
        ruleId: "queue-no-consumer",
      });
    }
  }

  return issues;
}

/**
 * WARNING: Database with >5 incoming edges (monolithic smell).
 * Many services connecting to one database suggests tight coupling.
 */
function ruleMonolithicDatabase(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const dbNodes = nodes.filter((n) => n.data.nodeType === "database");
  const THRESHOLD = 5;

  for (const db of dbNodes) {
    const incomingEdges = edges.filter((e) => e.target === db.id);
    if (incomingEdges.length > THRESHOLD) {
      issues.push({
        id: makeId("monolithic-db", db.id),
        severity: "warning",
        title: "Monolithic Database Smell",
        description: `"${db.data.label}" has ${incomingEdges.length} incoming connections (threshold: ${THRESHOLD}). Consider splitting into domain-specific databases.`,
        nodeIds: [db.id, ...incomingEdges.map((e) => e.source)],
        edgeIds: incomingEdges.map((e) => e.id),
        ruleId: "monolithic-db",
      });
    }
  }

  return issues;
}

/**
 * WARNING: Service with 0 incoming edges (orphaned).
 * A service nobody calls is likely dead code or misconfigured.
 */
function ruleOrphanedService(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const serviceNodes = nodes.filter((n) => n.data.nodeType === "service");

  for (const svc of serviceNodes) {
    const hasIncoming = edges.some((e) => e.target === svc.id);
    const hasOutgoing = edges.some((e) => e.source === svc.id);

    // Only flag if it has no incoming AND has outgoing (i.e., it calls others but nobody calls it)
    // If it has neither, it'll be caught by the disconnected-node rule
    if (!hasIncoming && hasOutgoing) {
      issues.push({
        id: makeId("orphaned-service", svc.id),
        severity: "warning",
        title: "Orphaned Service",
        description: `"${svc.data.label}" has outgoing connections but no incoming traffic. Nothing is calling this service.`,
        nodeIds: [svc.id],
        edgeIds: [],
        ruleId: "orphaned-service",
      });
    }
  }

  return issues;
}

/**
 * WARNING: Completely disconnected node (no edges at all).
 * Applies to all node types except clients (which may be entry points).
 */
function ruleDisconnectedNode(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }

  for (const node of nodes) {
    // Skip text labels
    if (node.data.metadata?.notes === "__text_label__") continue;
    // Clients can be entry points
    if (node.data.nodeType === "client") continue;

    if (!connectedIds.has(node.id)) {
      issues.push({
        id: makeId("disconnected-node", node.id),
        severity: "warning",
        title: "Disconnected Component",
        description: `"${node.data.label}" (${node.data.nodeType}) has no connections. It may be misconfigured or forgotten.`,
        nodeIds: [node.id],
        edgeIds: [],
        ruleId: "disconnected-node",
      });
    }
  }

  return issues;
}

/**
 * INFO: High SLA (≥99.99%) but single instance.
 * A single instance cannot realistically achieve four-nines availability.
 */
function ruleHighSlaNoRedundancy(
  nodes: SerializedNode[],
  _edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const node of nodes) {
    const sla = node.data.sla;
    const instances = node.data.instances;

    if (sla && instances !== undefined) {
      // Parse SLA: "99.99%" or "99.99"
      const slaNum = parseFloat(sla.replace("%", ""));
      if (slaNum >= 99.99 && instances <= 1) {
        issues.push({
          id: makeId("high-sla-single-instance", node.id),
          severity: "info",
          title: "High SLA Without Redundancy",
          description: `"${node.data.label}" has SLA ${sla} but only ${instances} instance(s). Consider adding replicas for availability.`,
          nodeIds: [node.id],
          edgeIds: [],
          ruleId: "high-sla-single-instance",
        });
      }
    }
  }

  return issues;
}

/**
 * INFO: No load balancer for multi-instance services.
 * If a service has multiple instances, there should be a load balancer upstream.
 */
function ruleNoLoadBalancer(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lbIds = new Set(nodes.filter((n) => n.data.nodeType === "loadbalancer").map((n) => n.id));

  for (const node of nodes) {
    if (node.data.nodeType !== "service") continue;
    const instances = node.data.instances;
    if (instances === undefined || instances <= 1) continue;

    // Check if any upstream connection comes from a load balancer
    const hasLbUpstream = edges.some(
      (e) => e.target === node.id && lbIds.has(e.source)
    );

    if (!hasLbUpstream) {
      issues.push({
        id: makeId("no-lb-multi-instance", node.id),
        severity: "info",
        title: "Multi-Instance Without Load Balancer",
        description: `"${node.data.label}" has ${instances} instances but no load balancer upstream. Traffic may not be distributed evenly.`,
        nodeIds: [node.id],
        edgeIds: [],
        ruleId: "no-lb-multi-instance",
      });
    }
  }

  return issues;
}

/**
 * INFO: Cache node not connected to any service.
 * A cache that no service reads from is unused.
 */
function ruleCacheNotUsed(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cacheNodes = nodes.filter((n) => n.data.nodeType === "cache");
  const serviceIds = new Set(nodes.filter((n) => n.data.nodeType === "service").map((n) => n.id));

  for (const cache of cacheNodes) {
    const hasServiceConnection = edges.some(
      (e) =>
        (e.source === cache.id && serviceIds.has(e.target)) ||
        (e.target === cache.id && serviceIds.has(e.source))
    );

    if (!hasServiceConnection) {
      issues.push({
        id: makeId("unused-cache", cache.id),
        severity: "info",
        title: "Unused Cache Layer",
        description: `"${cache.data.label}" is not connected to any service. It may not be providing performance benefits.`,
        nodeIds: [cache.id],
        edgeIds: [],
        ruleId: "unused-cache",
      });
    }
  }

  return issues;
}

// ============================================================
// Public API
// ============================================================

/** All rules in execution order (critical → warning → info) */
const ALL_RULES = [
  // Critical
  ruleClientToDatabase,
  ruleGatewayToDatabase,
  // Warning
  ruleOrphanedQueue,
  ruleMonolithicDatabase,
  ruleOrphanedService,
  ruleDisconnectedNode,
  // Info
  ruleHighSlaNoRedundancy,
  ruleNoLoadBalancer,
  ruleCacheNotUsed,
];

/**
 * Validate a board graph against all architecture rules.
 */
export function validateArchitecture(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): ValidationResult {
  // Filter out text labels from validation
  const realNodes = nodes.filter(
    (n) => n.data.metadata?.notes !== "__text_label__"
  );

  const allIssues: ValidationIssue[] = [];

  for (const rule of ALL_RULES) {
    const ruleIssues = rule(realNodes, edges);
    allIssues.push(...ruleIssues);
  }

  // Sort: critical first, then warning, then info
  const severityOrder: Record<ValidationSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    issues: allIssues,
    timestamp: new Date().toISOString(),
    stats: {
      critical: allIssues.filter((i) => i.severity === "critical").length,
      warning: allIssues.filter((i) => i.severity === "warning").length,
      info: allIssues.filter((i) => i.severity === "info").length,
    },
  };
}
