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
    direction = "LR", // Flow left-to-right (standard for architecture diagrams)
    nodeWidth = 256, // matches Tailwind w-64
    nodeHeight = 120, // slightly taller to account for descriptions/tags
    rankSep = 100, // horizontal distance between layers
    nodeSep = 80, // vertical distance between nodes in the same layer
  } = options;

  // Auto-detect direction based on current bounding box if not explicitly provided
  let finalDirection = direction;
  if (!options.direction && nodes.length > 1) {
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const maxX = Math.max(...nodes.map((n) => n.position.x + nodeWidth));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxY = Math.max(...nodes.map((n) => n.position.y + nodeHeight));
    
    const width = maxX - minX;
    const height = maxY - minY;
    
    // If the graph is wider than it is tall, flow Left-to-Right. Otherwise Top-to-Bottom.
    finalDirection = width >= height ? "LR" : "TB";
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: finalDirection,
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
  // We respect the actual edges drawn by the user to preserve complex microservice flows.
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
