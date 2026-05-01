import dagre from "@dagrejs/dagre";
import type { SerializedNode, SerializedEdge } from "@system-synthesis/shared";

interface LayoutOptions {
  direction?: "TB" | "LR" | "BT" | "RL";
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

/**
 * Apply Dagre automatic layout to nodes and edges.
 * Returns new node positions without mutating originals.
 */
export function autoLayoutNodes(
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: LayoutOptions = {}
): SerializedNode[] {
  const {
    direction = "TB",
    nodeWidth = 240,
    nodeHeight = 100,
    rankSep = 80,
    nodeSep = 60,
  } = options;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: rankSep,
    nodesep: nodeSep,
    marginx: 40,
    marginy: 40,
  });

  // Add nodes
  nodes.forEach((node) => {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  // Add edges
  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  // Run layout
  dagre.layout(g);

  // Map back to serialized nodes with new positions
  return nodes.map((node) => {
    const gNode = g.node(node.id);
    return {
      ...node,
      position: {
        x: gNode.x - nodeWidth / 2,
        y: gNode.y - nodeHeight / 2,
      },
    };
  });
}
