import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { useBoardStore } from "../boardStore";
import type { ArchNodeData, BoardOperation } from "../boardStore";

/**
 * Dragging a multiple selection has to record a move for every node in it.
 *
 * React Flow reports one position change per selected node, so a handler that
 * looks at the first change, or at the node the pointer happened to be over,
 * moves the whole group on screen and persists one of them. The rest snap back
 * for everyone else in the room, and for this reviewer on the next reload.
 */
function node(id: string, x: number, y: number): Node<ArchNodeData> {
  return {
    id,
    type: "architectureNode",
    position: { x, y },
    data: {
      label: id,
      subtitle: "",
      nodeType: "service",
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
    } as unknown as ArchNodeData,
  };
}

describe("moving a selection of nodes", () => {
  let recorded: BoardOperation[];

  beforeEach(() => {
    recorded = [];
    useBoardStore.setState({
      nodes: [node("a", 0, 0), node("b", 100, 0), node("c", 200, 0)],
      edges: [],
      applyToYjs: (operation: BoardOperation) => void recorded.push(operation),
    } as never);
  });

  /** What React Flow emits for a drag: dragging true, then false at the end. */
  function drag(moves: Array<{ id: string; x: number; y: number }>) {
    const change = useBoardStore.getState().onNodesChange;
    change(
      moves.map((move) => ({
        type: "position" as const,
        id: move.id,
        position: useBoardStore.getState().nodes.find((n) => n.id === move.id)!.position,
        dragging: true,
      }))
    );
    change(
      moves.map((move) => ({
        type: "position" as const,
        id: move.id,
        position: { x: move.x, y: move.y },
        dragging: false,
      }))
    );
  }

  it("records a move for every node in the selection", () => {
    drag([
      { id: "a", x: 60, y: 40 },
      { id: "b", x: 160, y: 40 },
    ]);

    expect(recorded).toEqual([
      { op: "node_moved", nodeId: "a", position: { x: 60, y: 40 } },
      { op: "node_moved", nodeId: "b", position: { x: 160, y: 40 } },
    ]);
  });

  it("leaves a node nobody dragged exactly where it was", () => {
    drag([{ id: "a", x: 60, y: 40 }]);

    expect(recorded).toHaveLength(1);
    expect(useBoardStore.getState().nodes.find((n) => n.id === "c")!.position).toEqual({
      x: 200,
      y: 0,
    });
  });

  it("moves the whole selection by the same offset", () => {
    // The property that makes it one gesture rather than several: relative
    // spacing survives, so a group keeps its shape.
    drag([
      { id: "a", x: 60, y: 40 },
      { id: "b", x: 160, y: 40 },
      { id: "c", x: 260, y: 40 },
    ]);

    const moved = useBoardStore.getState().nodes;
    const xs = moved.map((n) => n.position.x);
    expect(xs).toEqual([60, 160, 260]);
    expect(moved.every((n) => n.position.y === 40)).toBe(true);
  });

  it("records nothing for a selection that was clicked but not moved", () => {
    // A click registers as a drag of zero distance. Emitting for it would put a
    // no-op in the history of every node in the selection.
    drag([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 100, y: 0 },
    ]);

    expect(recorded).toEqual([]);
  });
});
