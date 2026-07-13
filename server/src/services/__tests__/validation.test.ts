import { describe, expect, it } from "vitest";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import { ArchitectureGraph } from "../graphAnalysis.js";
import { validateArchitecture, validationToSarif } from "../validation.js";

function node(id: string, nodeType: string, data: Record<string, unknown> = {}): SerializedNode {
  return {
    id,
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      nodeType,
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
      ...data,
    },
  } as SerializedNode;
}

function edge(id: string, source: string, target: string): SerializedEdge {
  return { id, source, target };
}

describe("ArchitectureGraph algorithms", () => {
  it("finds strongly connected components, cycles, layers, bridges, and blast radius", () => {
    const graph = new ArchitectureGraph(
      [node("a", "service"), node("b", "service"), node("c", "database"), node("d", "monitor")],
      [edge("ab", "a", "b"), edge("ba", "b", "a"), edge("bc", "b", "c"), edge("cd", "c", "d")]
    );
    expect(graph.cycles()).toEqual([["a", "b"]]);
    expect(graph.blastRadius("b")).toEqual(new Set(["a", "c", "d"]));
    expect(graph.articulationPoints()).toEqual(new Set(["b", "c"]));
    expect(graph.bridges().map((item) => item.id).sort()).toEqual(["bc", "cd"]);
    expect(graph.topologicalLayers().at(-1)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("calculates reachability, reverse reachability, and dependency depth", () => {
    const graph = new ArchitectureGraph(
      [node("client", "client"), node("api", "service"), node("db", "database")],
      [edge("one", "client", "api"), edge("two", "api", "db")]
    );
    expect(graph.reachableFrom("client")).toEqual(new Set(["client", "api", "db"]));
    expect(graph.reverseReachableFrom("db")).toEqual(new Set(["db", "api", "client"]));
    expect(graph.dependencyDepth("client")).toBe(2);
  });
});

describe("extensible deterministic architecture rules", () => {
  it("detects direct persistence access, cycles, and a real path-level SPOF", () => {
    const nodes = [
      node("client", "client"),
      node("gateway", "gateway"),
      node("service", "service"),
      node("db", "database"),
      node("direct-client", "client"),
    ];
    const edges = [
      edge("cg", "client", "gateway"),
      edge("gs", "gateway", "service"),
      edge("sd", "service", "db"),
      edge("sg", "service", "gateway"),
      edge("direct", "direct-client", "db"),
    ];
    const result = validateArchitecture(nodes, edges);
    expect(result.issues.some((finding) => finding.ruleId === "client-to-persistence")).toBe(true);
    expect(result.issues.some((finding) => finding.ruleId === "dependency-cycle")).toBe(true);
    expect(result.issues.some((finding) => finding.ruleId === "single-point-of-failure")).toBe(true);
  });

  it("detects unmediated trust-zone crossings but accepts an explicit firewall", () => {
    const unsafe = validateArchitecture(
      [node("web", "client", { zone: "public" }), node("db", "database", { zone: "restricted" })],
      [edge("cross", "web", "db")]
    );
    expect(unsafe.issues.some((finding) => finding.ruleId === "unmediated-trust-boundary")).toBe(true);

    const mediated = validateArchitecture(
      [
        node("web", "client", { zone: "public" }),
        node("waf", "firewall", { zone: "dmz" }),
        node("db", "database", { zone: "restricted" }),
      ],
      [edge("wf", "web", "waf"), edge("fd", "waf", "db")]
    );
    expect(mediated.issues.some((finding) => finding.ruleId === "unmediated-trust-boundary")).toBe(false);
  });

  it("supports rule selection, severity overrides, and justified suppression", () => {
    const nodes = [node("client", "client"), node("db", "database")];
    const edges = [edge("direct", "client", "db")];
    const overridden = validateArchitecture(nodes, edges, {
      enabledRuleIds: ["client-to-persistence"],
      severityOverrides: { "client-to-persistence": "warning" },
    });
    expect(overridden.issues).toHaveLength(1);
    expect(overridden.issues[0].severity).toBe("warning");

    const suppressed = validateArchitecture(nodes, edges, {
      suppressions: [
        {
          ruleId: "client-to-persistence",
          edgeId: "direct",
          justification: "Approved migration bridge until 2026-10-01",
        },
      ],
    });
    expect(suppressed.issues.some((finding) => finding.ruleId === "client-to-persistence")).toBe(false);
  });

  it("does not treat arbitrary database fan-in thresholds as correctness", () => {
    const db = node("db", "database");
    const services = Array.from({ length: 12 }, (_, index) => node(`service-${index}`, "service"));
    const edges = services.map((service, index) => edge(`edge-${index}`, service.id, db.id));
    const result = validateArchitecture([db, ...services], edges);
    expect(result.issues.some((finding) => finding.ruleId === "monolithic-db")).toBe(false);
  });

  it("exports machine-readable SARIF with deterministic rule identifiers", () => {
    const result = validateArchitecture(
      [node("client", "client"), node("db", "database")],
      [edge("direct", "client", "db")]
    );
    const sarif = validationToSarif(result);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0].ruleId).toBe("client-to-persistence");
    expect(sarif.runs[0].results[0].level).toBe("error");
  });
});
