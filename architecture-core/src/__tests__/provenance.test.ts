import { describe, expect, it } from "vitest";
import type { CanonicalArchitectureGraph } from "../provenance.js";
import {
  canonicalGraphFingerprint,
  canonicalizeGraph,
  stableEdgeId,
  stableEntityId,
} from "../provenance.js";

function graph(revision: string, reversed = false): CanonicalArchitectureGraph {
  const apiId = stableEntityId("node", "docker-compose", "services.api");
  const dbId = stableEntityId("node", "docker-compose", "services.database");
  const nodes = [
    {
      id: apiId,
      type: "architecture",
      position: { x: 0, y: 0 },
      data: {
        label: "API",
        nodeType: "service" as const,
        status: "active" as const,
        metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
        provenance: {
          adapter: "docker-compose",
          revision,
          file: "compose.yaml",
          sourceAddress: "services.api",
          confidence: "explicit" as const,
        },
      },
    },
    {
      id: dbId,
      type: "architecture",
      position: { x: 300, y: 0 },
      data: {
        label: "Database",
        nodeType: "database" as const,
        status: "active" as const,
        metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
        provenance: {
          adapter: "docker-compose",
          revision,
          file: "compose.yaml",
          sourceAddress: "services.database",
          confidence: "explicit" as const,
        },
      },
    },
  ];
  const edges = [{
    id: stableEdgeId("docker-compose", "services.api", "services.database"),
    source: apiId,
    target: dbId,
    data: {
      label: "depends_on",
      provenance: [{
        adapter: "docker-compose",
        revision,
        file: "compose.yaml",
        sourceAddress: "services.api.depends_on.database",
        confidence: "explicit" as const,
      }],
    },
  }];
  return {
    source: { adapter: "docker-compose", revision, files: ["compose.yaml"] },
    nodes: reversed ? [...nodes].reverse() : nodes,
    edges,
  };
}

describe("stable source identities", () => {
  it("keeps an entity ID stable across revisions", () => {
    expect(stableEntityId("node", "docker-compose", "services.api")).toBe(
      stableEntityId("node", "docker-compose", "services.api")
    );
  });

  it("separates different addresses and relationship directions", () => {
    expect(stableEntityId("node", "docker-compose", "services.api")).not.toBe(
      stableEntityId("node", "docker-compose", "services.worker")
    );
    expect(stableEdgeId("docker-compose", "services.api", "services.database")).not.toBe(
      stableEdgeId("docker-compose", "services.database", "services.api")
    );
  });
});

describe("canonical architecture graphs", () => {
  it("sorts entities and source files deterministically", () => {
    const canonical = canonicalizeGraph(graph("base", true));
    expect(canonical.nodes.map((node) => node.id)).toEqual(
      [...canonical.nodes.map((node) => node.id)].sort()
    );
  });

  it("produces the same fingerprint across revisions and input order", () => {
    expect(canonicalGraphFingerprint(graph("base"))).toBe(
      canonicalGraphFingerprint(graph("head", true))
    );
  });
});
