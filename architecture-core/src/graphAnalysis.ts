import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";

export class ArchitectureGraph {
  readonly nodesById = new Map<string, SerializedNode>();
  readonly edgesById = new Map<string, SerializedEdge>();
  readonly outgoing = new Map<string, Set<string>>();
  readonly incoming = new Map<string, Set<string>>();

  constructor(
    readonly nodes: SerializedNode[],
    readonly edges: SerializedEdge[]
  ) {
    for (const node of nodes) {
      this.nodesById.set(node.id, node);
      this.outgoing.set(node.id, new Set());
      this.incoming.set(node.id, new Set());
    }
    for (const edge of edges) {
      if (!this.nodesById.has(edge.source) || !this.nodesById.has(edge.target)) continue;
      this.edgesById.set(edge.id, edge);
      this.outgoing.get(edge.source)!.add(edge.target);
      this.incoming.get(edge.target)!.add(edge.source);
    }
  }

  reachableFrom(startId: string, excludedNodeId?: string): Set<string> {
    const visited = new Set<string>();
    if (!this.nodesById.has(startId) || startId === excludedNodeId) return visited;
    const queue = [startId];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current) || current === excludedNodeId) continue;
      visited.add(current);
      for (const next of this.outgoing.get(current) || []) {
        if (!visited.has(next) && next !== excludedNodeId) queue.push(next);
      }
    }
    return visited;
  }

  reverseReachableFrom(startId: string): Set<string> {
    const visited = new Set<string>();
    const queue = this.nodesById.has(startId) ? [startId] : [];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const previous of this.incoming.get(current) || []) {
        if (!visited.has(previous)) queue.push(previous);
      }
    }
    return visited;
  }

  blastRadius(nodeId: string): Set<string> {
    const reachable = this.reachableFrom(nodeId);
    reachable.delete(nodeId);
    return reachable;
  }

  stronglyConnectedComponents(): string[][] {
    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indices = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const components: string[][] = [];

    const visit = (nodeId: string) => {
      indices.set(nodeId, index);
      lowLinks.set(nodeId, index);
      index += 1;
      stack.push(nodeId);
      onStack.add(nodeId);

      for (const target of this.outgoing.get(nodeId) || []) {
        if (!indices.has(target)) {
          visit(target);
          lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(target)!));
        } else if (onStack.has(target)) {
          lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indices.get(target)!));
        }
      }

      if (lowLinks.get(nodeId) === indices.get(nodeId)) {
        const component: string[] = [];
        let current: string;
        do {
          current = stack.pop()!;
          onStack.delete(current);
          component.push(current);
        } while (current !== nodeId);
        components.push(component.sort());
      }
    };

    for (const nodeId of [...this.nodesById.keys()].sort()) {
      if (!indices.has(nodeId)) visit(nodeId);
    }
    return components.sort((left, right) => left[0].localeCompare(right[0]));
  }

  cycles(): string[][] {
    return this.stronglyConnectedComponents().filter((component) => {
      if (component.length > 1) return true;
      return this.outgoing.get(component[0])?.has(component[0]) || false;
    });
  }

  articulationPoints(): Set<string> {
    const adjacency = this.undirectedAdjacency();
    const visited = new Set<string>();
    const discovery = new Map<string, number>();
    const low = new Map<string, number>();
    const parent = new Map<string, string | null>();
    const points = new Set<string>();
    let time = 0;

    const visit = (nodeId: string) => {
      visited.add(nodeId);
      discovery.set(nodeId, ++time);
      low.set(nodeId, time);
      let children = 0;
      for (const neighbor of adjacency.get(nodeId) || []) {
        if (!visited.has(neighbor)) {
          children += 1;
          parent.set(neighbor, nodeId);
          visit(neighbor);
          low.set(nodeId, Math.min(low.get(nodeId)!, low.get(neighbor)!));
          if (parent.get(nodeId) == null && children > 1) points.add(nodeId);
          if (parent.get(nodeId) != null && low.get(neighbor)! >= discovery.get(nodeId)!) points.add(nodeId);
        } else if (neighbor !== parent.get(nodeId)) {
          low.set(nodeId, Math.min(low.get(nodeId)!, discovery.get(neighbor)!));
        }
      }
    };

    for (const nodeId of this.nodesById.keys()) {
      if (!visited.has(nodeId)) {
        parent.set(nodeId, null);
        visit(nodeId);
      }
    }
    return points;
  }

  bridges(): SerializedEdge[] {
    return this.edges.filter((edge) => !this.hasAlternatePath(edge.source, edge.target, edge.id));
  }

  topologicalLayers(): string[][] {
    const indegree = new Map<string, number>();
    for (const nodeId of this.nodesById.keys()) indegree.set(nodeId, this.incoming.get(nodeId)?.size || 0);
    let frontier = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
    const layers: string[][] = [];
    const processed = new Set<string>();
    while (frontier.length) {
      layers.push(frontier);
      const next: string[] = [];
      for (const nodeId of frontier) {
        processed.add(nodeId);
        for (const target of this.outgoing.get(nodeId) || []) {
          indegree.set(target, indegree.get(target)! - 1);
          if (indegree.get(target) === 0) next.push(target);
        }
      }
      frontier = next.sort();
    }
    const cyclic = [...this.nodesById.keys()].filter((id) => !processed.has(id)).sort();
    if (cyclic.length) layers.push(cyclic);
    return layers;
  }

  trustBoundaryCrossings(): SerializedEdge[] {
    return this.edges.filter((edge) => {
      const sourceZone = this.nodesById.get(edge.source)?.data.zone;
      const targetZone = this.nodesById.get(edge.target)?.data.zone;
      return !!sourceZone && !!targetZone && sourceZone !== targetZone;
    });
  }

  disconnectedNodeIds(): string[] {
    return [...this.nodesById.keys()].filter(
      (id) => (this.outgoing.get(id)?.size || 0) === 0 && (this.incoming.get(id)?.size || 0) === 0
    );
  }

  dependencyDepth(startId: string): number {
    const distances = new Map<string, number>([[startId, 0]]);
    const queue = [startId];
    let maximum = 0;
    while (queue.length) {
      const current = queue.shift()!;
      const distance = distances.get(current)!;
      for (const next of this.outgoing.get(current) || []) {
        if (!distances.has(next)) {
          distances.set(next, distance + 1);
          maximum = Math.max(maximum, distance + 1);
          queue.push(next);
        }
      }
    }
    return maximum;
  }

  hasAlternatePath(source: string, target: string, excludedEdgeId: string): boolean {
    const queue = [source];
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of this.edges) {
        if (edge.id === excludedEdgeId) continue;
        if (edge.source === current && !visited.has(edge.target)) queue.push(edge.target);
        if (edge.target === current && !visited.has(edge.source)) queue.push(edge.source);
      }
    }
    return false;
  }

  private undirectedAdjacency(): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const id of this.nodesById.keys()) adjacency.set(id, new Set());
    for (const edge of this.edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    return adjacency;
  }
}
