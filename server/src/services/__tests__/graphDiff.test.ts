import { describe, expect, it } from "vitest";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import { diffArchitectureGraphs } from "../graphDiff.js";

function node(id: string, label: string, instances = 1): SerializedNode {
  return {
    id,
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: {
      label,
      nodeType: "service",
      status: "active",
      instances,
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
    },
  };
}

describe("semantic graph diff", () => {
  it("describes additions, removals, replica changes, and connections", () => {
    const beforeNodes = [node("api", "API", 2), node("legacy", "Legacy worker")];
    const afterNodes = [node("api", "API", 4), node("redis", "Redis cache")];
    const afterEdges: SerializedEdge[] = [{ id: "api-redis", source: "api", target: "redis" }];

    const result = diffArchitectureGraphs(beforeNodes, [], afterNodes, afterEdges);

    expect(result.stats).toEqual({ added: 2, removed: 1, changed: 1, total: 4 });
    expect(result.changes.map((change) => change.summary)).toEqual(expect.arrayContaining([
      "~ Increased API replicas from 2 to 4",
      "- Removed Legacy worker",
      "+ Added Redis cache",
      "+ Connected API to Redis cache",
    ]));
  });

  it("is deterministic regardless of input ordering", () => {
    const before = [node("b", "B"), node("a", "A")];
    const after = [node("c", "C"), node("a", "A renamed")];
    expect(diffArchitectureGraphs(before, [], after, [])).toEqual(
      diffArchitectureGraphs([...before].reverse(), [], [...after].reverse(), [])
    );
  });
});

