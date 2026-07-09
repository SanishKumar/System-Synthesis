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
 * Run Dagre layout on a set of nodes and edges.
 * Returns a map of nodeId -> { x, y }.
 */
function runDagre(
  nodeIds: string[],
  edges: { source: string; target: string }[],
  direction: string,
  rankSep: number,
  nodeSep: number,
  sizes: Map<string, { width: number; height: number }>
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: rankSep,
    nodesep: nodeSep,
    marginx: 0,
    marginy: 0,
  });

  nodeIds.forEach((id) => {
    const size = sizes.get(id) || { width: 256, height: 120 };
    g.setNode(id, { width: size.width, height: size.height });
  });

  edges.forEach((edge) => {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  nodeIds.forEach((id) => {
    const gNode = g.node(id);
    const size = sizes.get(id) || { width: 256, height: 120 };
    positions.set(id, {
      x: gNode.x - size.width / 2,
      y: gNode.y - size.height / 2,
    });
  });

  return positions;
}

/**
 * Apply Dagre automatic layout to nodes and edges.
 *
 * Rules:
 * 1. Group boxes are PINNED — they never move. Only the user can move them manually.
 * 2. Children inside a group are rearranged within the group's current bounds.
 * 3. Ungrouped nodes are rearranged but stay near their current visible area
 *    (offset-preserving — not flying off to Dagre's 0,0 origin).
 */
export function autoLayoutNodes(
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: LayoutOptions = {}
): SerializedNode[] {
  const {
    direction = "LR",
    nodeWidth = 256,
    nodeHeight = 120,
    rankSep = 100,
    nodeSep = 80,
  } = options;

  if (nodes.length === 0) return nodes;

  // Auto-detect direction based on bounding box of all nodes
  let finalDirection = direction;
  if (!options.direction && nodes.length > 1) {
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const maxX = Math.max(...nodes.map((n) => n.position.x + nodeWidth));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxY = Math.max(...nodes.map((n) => n.position.y + nodeHeight));
    finalDirection = (maxX - minX) >= (maxY - minY) ? "LR" : "TB";
  }

  // Separate nodes into categories
  const groupNodes = nodes.filter((n) => n.type === "groupNode");
  const groupIds = new Set(groupNodes.map((g) => g.id));

  const childrenByGroup = new Map<string, SerializedNode[]>();
  const ungroupedNodes: SerializedNode[] = [];

  for (const node of nodes) {
    if (node.type === "groupNode") continue;
    if (node.parentId && groupIds.has(node.parentId)) {
      const list = childrenByGroup.get(node.parentId) || [];
      list.push(node);
      childrenByGroup.set(node.parentId, list);
    } else {
      ungroupedNodes.push(node);
    }
  }



  // --- Group-aware layout ---
  const result = new Map<string, SerializedNode>();

  // Step 1: Groups stay PINNED at their current position
  for (const group of groupNodes) {
    result.set(group.id, { ...group });
  }

  // Step 2: Layout children within each group's current bounds
  const CHILD_PADDING_X = 20;
  const CHILD_PADDING_TOP = 50; // Space for group title bar
  const CHILD_PADDING_BOTTOM = 20;

  for (const group of groupNodes) {
    const children = childrenByGroup.get(group.id) || [];
    if (children.length === 0) continue;

    const groupW = (group.style?.width as number) || 500;
    const groupH = (group.style?.height as number) || 300;

    // Get internal edges (both source and target are in this group)
    const childIds = new Set(children.map((c) => c.id));
    const internalEdges = edges
      .filter((e) => childIds.has(e.source) && childIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    const childSizes = new Map<string, { width: number; height: number }>();
    children.forEach(c => childSizes.set(c.id, { width: nodeWidth, height: nodeHeight }));

    // Layout children using Dagre
    const childPositions = runDagre(
      children.map((c) => c.id),
      internalEdges,
      finalDirection,
      Math.floor(rankSep * 0.6),
      Math.floor(nodeSep * 0.6),
      childSizes
    );

    // Compute bounding box of the Dagre output
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of childPositions.values()) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + nodeWidth);
      maxY = Math.max(maxY, pos.y + nodeHeight);
    }

    const contentW = maxX - minX;
    const contentH = maxY - minY;

    // Available space inside the group
    const availW = groupW - CHILD_PADDING_X * 2;
    const availH = groupH - CHILD_PADDING_TOP - CHILD_PADDING_BOTTOM;

    // Scale down if children don't fit; never scale up
    const scaleX = contentW > availW ? availW / contentW : 1;
    const scaleY = contentH > availH ? availH / contentH : 1;
    const scale = Math.min(scaleX, scaleY, 1);

    // Center children within the group
    const scaledW = contentW * scale;
    const scaledH = contentH * scale;
    const offsetX = CHILD_PADDING_X + (availW - scaledW) / 2;
    const offsetY = CHILD_PADDING_TOP + (availH - scaledH) / 2;

    for (const child of children) {
      const pos = childPositions.get(child.id);
      if (!pos) continue;

      result.set(child.id, {
        ...child,
        parentId: group.id,
        position: {
          x: (pos.x - minX) * scale + offsetX,
          y: (pos.y - minY) * scale + offsetY,
        },
      });
    }

    // Auto-resize group if children overflow (expand, never shrink below current)
    const neededW = contentW + CHILD_PADDING_X * 2;
    const neededH = contentH + CHILD_PADDING_TOP + CHILD_PADDING_BOTTOM;

    if (neededW > groupW || neededH > groupH) {
      const updatedGroup = result.get(group.id)!;
      result.set(group.id, {
        ...updatedGroup,
        style: {
          ...((updatedGroup.style as Record<string, unknown>) || {}),
          width: Math.max(groupW, neededW),
          height: Math.max(groupH, neededH),
        },
      });
    }
  }

  // Step 3: Layout top-level elements (ungrouped nodes AND group nodes)
  const topLevelNodes = [...ungroupedNodes, ...groupNodes.map(g => result.get(g.id) || g)];
  if (topLevelNodes.length > 0) {
    const parentMap = new Map<string, string>();
    for (const node of nodes) {
      if (node.parentId) parentMap.set(node.id, node.parentId);
    }
    const getTopId = (id: string) => parentMap.get(id) || id;

    const topLevelEdges: { source: string; target: string }[] = [];
    const addedEdges = new Set<string>();
    
    for (const e of edges) {
      const topSource = getTopId(e.source);
      const topTarget = getTopId(e.target);
      if (topSource !== topTarget) {
        const key = `${topSource}->${topTarget}`;
        if (!addedEdges.has(key)) {
          addedEdges.add(key);
          topLevelEdges.push({ source: topSource, target: topTarget });
        }
      }
    }

    const sizes = new Map<string, { width: number; height: number }>();
    for (const node of topLevelNodes) {
      if (node.type === "groupNode") {
        sizes.set(node.id, {
          width: (node.style?.width as number) || 500,
          height: (node.style?.height as number) || 300,
        });
      } else {
        sizes.set(node.id, { width: nodeWidth, height: nodeHeight });
      }
    }

    // Compute current center of mass for all top-level nodes
    let currentSumX = 0, currentSumY = 0;
    for (const node of topLevelNodes) {
      const s = sizes.get(node.id)!;
      currentSumX += node.position.x + s.width / 2;
      currentSumY += node.position.y + s.height / 2;
    }
    const currentCenterX = currentSumX / topLevelNodes.length;
    const currentCenterY = currentSumY / topLevelNodes.length;

    // Run Dagre for top-level nodes
    const topPositions = runDagre(
      topLevelNodes.map(n => n.id),
      topLevelEdges,
      finalDirection,
      rankSep,
      nodeSep,
      sizes
    );

    // Compute Dagre output center of mass
    let dagreSumX = 0, dagreSumY = 0;
    const posArr = Array.from(topPositions.values());
    for (const id of topPositions.keys()) {
      const p = topPositions.get(id)!;
      const s = sizes.get(id)!;
      dagreSumX += p.x + s.width / 2;
      dagreSumY += p.y + s.height / 2;
    }
    const dagreCenterX = posArr.length > 0 ? dagreSumX / posArr.length : 0;
    const dagreCenterY = posArr.length > 0 ? dagreSumY / posArr.length : 0;

    const dx = currentCenterX - dagreCenterX;
    const dy = currentCenterY - dagreCenterY;

    // Apply layout positions (with offset) to all top-level nodes
    for (const node of topLevelNodes) {
      const pos = topPositions.get(node.id);
      if (!pos) continue;
      
      const newX = pos.x + dx;
      const newY = pos.y + dy;
      
      if (node.type === "groupNode") {
        // Update the group node in the result map
        const g = result.get(node.id)!;
        result.set(node.id, {
          ...g,
          position: { x: newX, y: newY }
        });
      } else {
        // Add ungrouped node to the result map
        result.set(node.id, {
          ...node,
          position: { x: newX, y: newY }
        });
      }
    }
  }

  // Assemble final result preserving original order
  return nodes.map((n) => result.get(n.id) || n);
}
