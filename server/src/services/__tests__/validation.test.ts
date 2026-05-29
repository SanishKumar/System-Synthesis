/**
 * Validation Engine — Unit Tests
 *
 * Tests every rule in validation.ts against purpose-built graphs
 * that trigger (or don't trigger) each rule.
 */

import { describe, it, expect } from "vitest";
import { validateArchitecture } from "../../services/validation.js";
import type { SerializedNode, SerializedEdge } from "@system-synthesis/shared";

// ── Helpers ──────────────────────────────────────────────────────────

function makeNode(
  id: string,
  nodeType: string,
  overrides: Record<string, unknown> = {}
): SerializedNode {
  return {
    id,
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      nodeType,
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
      ...overrides,
    },
  } as SerializedNode;
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  overrides: Record<string, unknown> = {}
): SerializedEdge {
  return { id, source, target, data: {}, ...overrides } as SerializedEdge;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("validateArchitecture", () => {
  it("returns empty issues for an empty board", () => {
    const result = validateArchitecture([], []);
    expect(result.issues).toHaveLength(0);
    expect(result.stats.critical).toBe(0);
    expect(result.stats.warning).toBe(0);
    expect(result.stats.info).toBe(0);
  });

  it("returns empty issues for a well-formed architecture", () => {
    const nodes = [
      makeNode("client", "client"),
      makeNode("gw", "gateway"),
      makeNode("svc", "service"),
      makeNode("db", "database"),
    ];
    const edges = [
      makeEdge("e1", "client", "gw"),
      makeEdge("e2", "gw", "svc"),
      makeEdge("e3", "svc", "db"),
    ];
    const result = validateArchitecture(nodes, edges);
    const criticals = result.issues.filter((i) => i.severity === "critical");
    expect(criticals).toHaveLength(0);
  });

  // ── Critical Rules ──

  describe("CRITICAL: client-to-db", () => {
    it("flags Client → Database direct connection", () => {
      const nodes = [makeNode("c", "client"), makeNode("d", "database")];
      const edges = [makeEdge("e1", "c", "d")];
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter((i) => i.ruleId === "client-to-db");
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("critical");
      expect(issues[0].nodeIds).toContain("c");
      expect(issues[0].nodeIds).toContain("d");
    });

    it("does NOT flag Client → Service → Database", () => {
      const nodes = [
        makeNode("c", "client"),
        makeNode("s", "service"),
        makeNode("d", "database"),
      ];
      const edges = [makeEdge("e1", "c", "s"), makeEdge("e2", "s", "d")];
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter((i) => i.ruleId === "client-to-db");
      expect(issues).toHaveLength(0);
    });
  });

  describe("CRITICAL: gateway-to-db", () => {
    it("flags Gateway → Database direct connection", () => {
      const nodes = [makeNode("gw", "gateway"), makeNode("db", "database")];
      const edges = [makeEdge("e1", "gw", "db")];
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter((i) => i.ruleId === "gateway-to-db");
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("critical");
    });
  });

  // ── Warning Rules ──

  describe("WARNING: orphaned-queue", () => {
    it("flags a queue with no producers AND no consumers", () => {
      const nodes = [makeNode("q", "queue")];
      const result = validateArchitecture(nodes, []);
      const issues = result.issues.filter((i) => i.ruleId === "orphaned-queue");
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("warning");
    });

    it("flags a queue with no producer", () => {
      const nodes = [makeNode("q", "queue"), makeNode("s", "service")];
      const edges = [makeEdge("e1", "q", "s")]; // queue → service (consumer exists)
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "queue-no-producer"
      );
      expect(issues).toHaveLength(1);
    });

    it("flags a queue with no consumer", () => {
      const nodes = [makeNode("s", "service"), makeNode("q", "queue")];
      const edges = [makeEdge("e1", "s", "q")]; // service → queue (producer exists)
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "queue-no-consumer"
      );
      expect(issues).toHaveLength(1);
    });
  });

  describe("WARNING: monolithic-database", () => {
    it("flags database with >5 incoming edges", () => {
      const db = makeNode("db", "database");
      const services = Array.from({ length: 6 }, (_, i) =>
        makeNode(`s${i}`, "service")
      );
      const edges = services.map((s, i) => makeEdge(`e${i}`, s.id, "db"));
      const result = validateArchitecture([db, ...services], edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "monolithic-db"
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("warning");
    });

    it("does NOT flag database with ≤5 incoming edges", () => {
      const db = makeNode("db", "database");
      const services = Array.from({ length: 3 }, (_, i) =>
        makeNode(`s${i}`, "service")
      );
      const edges = services.map((s, i) => makeEdge(`e${i}`, s.id, "db"));
      const result = validateArchitecture([db, ...services], edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "monolithic-db"
      );
      expect(issues).toHaveLength(0);
    });
  });

  describe("WARNING: orphaned-service", () => {
    it("flags service with 0 incoming edges", () => {
      const nodes = [makeNode("svc", "service"), makeNode("db", "database")];
      const edges = [makeEdge("e1", "svc", "db")]; // svc has outgoing but no incoming
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "orphaned-service"
      );
      expect(issues).toHaveLength(1);
    });
  });

  describe("WARNING: disconnected-node", () => {
    it("flags a totally disconnected node", () => {
      const nodes = [
        makeNode("svc", "service"),
        makeNode("lonely", "service"),
        makeNode("db", "database"),
      ];
      const edges = [makeEdge("e1", "svc", "db")];
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "disconnected-node"
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].nodeIds).toContain("lonely");
    });
  });

  // ── Info Rules ──

  describe("INFO: high-sla-no-redundancy", () => {
    it("flags SLA ≥99.99% with only 1 instance", () => {
      const nodes = [makeNode("svc", "service", { sla: "99.99%", instances: 1 })];
      const result = validateArchitecture(nodes, []);
      const issues = result.issues.filter(
        (i) => i.ruleId === "high-sla-single-instance"
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("info");
    });

    it("does NOT flag SLA ≥99.99% with >1 instance", () => {
      const nodes = [makeNode("svc", "service", { sla: "99.99%", instances: 3 })];
      const result = validateArchitecture(nodes, []);
      const issues = result.issues.filter(
        (i) => i.ruleId === "high-sla-no-redundancy"
      );
      expect(issues).toHaveLength(0);
    });
  });

  describe("INFO: no-load-balancer", () => {
    it("flags multi-instance service with no load balancer", () => {
      const nodes = [makeNode("svc", "service", { instances: 3 })];
      const result = validateArchitecture(nodes, []);
      const issues = result.issues.filter(
        (i) => i.ruleId === "no-lb-multi-instance"
      );
      expect(issues).toHaveLength(1);
    });

    it("does NOT flag when a load balancer is connected upstream", () => {
      const nodes = [
        makeNode("svc", "service", { instances: 3 }),
        makeNode("lb", "loadbalancer"),
      ];
      const edges = [makeEdge("e1", "lb", "svc")];
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter(
        (i) => i.ruleId === "no-lb-multi-instance"
      );
      expect(issues).toHaveLength(0);
    });
  });

  describe("INFO: unused-cache", () => {
    it("flags a cache with 0 incoming edges", () => {
      const nodes = [makeNode("c", "cache")];
      const result = validateArchitecture(nodes, []);
      const issues = result.issues.filter((i) => i.ruleId === "unused-cache");
      expect(issues).toHaveLength(1);
    });

    it("does NOT flag a cache connected to a service", () => {
      const nodes = [makeNode("svc", "service"), makeNode("c", "cache")];
      const edges = [makeEdge("e1", "svc", "c")];
      const result = validateArchitecture(nodes, edges);
      const issues = result.issues.filter((i) => i.ruleId === "unused-cache");
      expect(issues).toHaveLength(0);
    });
  });

  // ── Stats ──

  it("stats are correctly computed", () => {
    const nodes = [
      makeNode("c", "client"),
      makeNode("d", "database"),
      makeNode("q", "queue"),
    ];
    const edges = [makeEdge("e1", "c", "d")];
    const result = validateArchitecture(nodes, edges);
    expect(result.stats.critical).toBeGreaterThanOrEqual(1);
    expect(result.stats.warning).toBeGreaterThanOrEqual(1);
    expect(result.timestamp).toBeTruthy();
  });

  // ── Sorting ──

  it("issues are sorted critical → warning → info", () => {
    const nodes = [
      makeNode("c", "client"),
      makeNode("d", "database"),
      makeNode("q", "queue"), // orphaned → warning
      makeNode("cache", "cache"), // unused → info
    ];
    const edges = [makeEdge("e1", "c", "d")]; // client-to-db → critical
    const result = validateArchitecture(nodes, edges);
    const severities = result.issues.map((i) => i.severity);
    const order = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });
});
