import { createHash } from "node:crypto";
import * as Y from "yjs";
import type { ArchNodeData, SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import {
  createSharedRecord,
  initializeGraphDoc,
  patchSharedRecord,
  serializeGraphDoc,
  type SharedRecord,
} from "../services/yjsGraph.js";

export interface SimulationOptions {
  clients: number;
  operations: number;
  seed?: number;
  duplicateRate?: number;
  immediateDeliveryRate?: number;
}

export interface SimulationResult {
  converged: boolean;
  clientHashes: string[];
  serverHash: string;
  generatedUpdates: number;
  duplicateDeliveries: number;
  delayedDeliveries: number;
}

type UpdateEnvelope = { source: number; update: Uint8Array };

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)])
    );
  }
  return value;
}

export function canonicalGraphHash(doc: Y.Doc): string {
  const graph = serializeGraphDoc(doc);
  const canonical = {
    nodes: graph.nodes.sort((left, right) => left.id.localeCompare(right.id)).map(stable),
    edges: graph.edges.sort((left, right) => left.id.localeCompare(right.id)).map(stable),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function baseNode(id: string, index: number): SerializedNode {
  return {
    id,
    type: "architectureNode",
    position: { x: index * 80, y: index * 40 },
    data: {
      label: `Service ${index}`,
      nodeType: "service",
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
    },
  };
}

function transactAndCapture(doc: Y.Doc, mutate: () => void): Uint8Array | null {
  let captured: Uint8Array | null = null;
  const listener = (update: Uint8Array, origin: unknown) => {
    if (origin === "simulated-user") captured = update.slice();
  };
  doc.on("update", listener);
  doc.transact(mutate, "simulated-user");
  doc.off("update", listener);
  return captured;
}

function performRandomOperation(
  doc: Y.Doc,
  undoManager: Y.UndoManager,
  clientIndex: number,
  operationIndex: number,
  random: () => number
): Uint8Array | null {
  const nodes = doc.getMap<SharedRecord>("nodes");
  const edges = doc.getMap<SharedRecord>("edges");
  const nodeIds = Array.from(nodes.keys());
  const action = Math.floor(random() * 8);

  if (action === 7 && undoManager.undoStack.length > 0) {
    let captured: Uint8Array | null = null;
    const listener = (update: Uint8Array, origin: unknown) => {
      if (origin === undoManager) captured = update.slice();
    };
    doc.on("update", listener);
    undoManager.undo();
    doc.off("update", listener);
    return captured;
  }

  if (action === 0 || nodeIds.length < 2) {
    const id = `c${clientIndex}-n${operationIndex}`;
    return transactAndCapture(doc, () => {
      nodes.set(id, createSharedRecord(baseNode(id, operationIndex) as unknown as Record<string, unknown>));
    });
  }

  const nodeId = nodeIds[Math.floor(random() * nodeIds.length)];
  const node = nodes.get(nodeId);
  if (!node) return null;

  if (action === 1) {
    return transactAndCapture(doc, () => {
      patchSharedRecord(node.get("position") as SharedRecord, {
        x: Math.round(random() * 2_000),
        y: Math.round(random() * 2_000),
      });
    });
  }
  if (action === 2) {
    return transactAndCapture(doc, () => {
      patchSharedRecord(node.get("data") as SharedRecord, {
        label: `client-${clientIndex}-rename-${operationIndex}`,
      });
    });
  }
  if (action === 3) {
    return transactAndCapture(doc, () => {
      patchSharedRecord(node.get("data") as SharedRecord, {
        status: random() > 0.5 ? "active" : "inactive",
        instances: 1 + Math.floor(random() * 12),
      } satisfies Partial<ArchNodeData>);
    });
  }
  if (action === 4 && nodeIds.length > 3) {
    return transactAndCapture(doc, () => {
      nodes.delete(nodeId);
      for (const [edgeId, edge] of edges.entries()) {
        if (edge.get("source") === nodeId || edge.get("target") === nodeId) edges.delete(edgeId);
      }
    });
  }
  if (action === 5) {
    const target = nodeIds[Math.floor(random() * nodeIds.length)];
    if (target === nodeId) return null;
    const edgeId = `c${clientIndex}-e${operationIndex}`;
    const edge: SerializedEdge = { id: edgeId, source: nodeId, target };
    return transactAndCapture(doc, () => {
      edges.set(edgeId, createSharedRecord(edge as unknown as Record<string, unknown>));
    });
  }

  const edgeIds = Array.from(edges.keys());
  if (edgeIds.length === 0) return null;
  return transactAndCapture(doc, () => {
    edges.delete(edgeIds[Math.floor(random() * edgeIds.length)]);
  });
}

export function runConvergenceSimulation(options: SimulationOptions): SimulationResult {
  const random = seededRandom(options.seed ?? 0x5eed1234);
  const duplicateRate = options.duplicateRate ?? 0.15;
  const immediateRate = options.immediateDeliveryRate ?? 0.45;
  const seedDoc = new Y.Doc();
  initializeGraphDoc(
    seedDoc,
    Array.from({ length: 8 }, (_, index) => baseNode(`seed-${index}`, index)),
    []
  );
  const seedUpdate = Y.encodeStateAsUpdate(seedDoc);
  seedDoc.destroy();

  const clients = Array.from({ length: options.clients }, () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate, "seed");
    return doc;
  });
  const undoManagers = clients.map((doc) => new Y.UndoManager(
    [doc.getMap("nodes"), doc.getMap("edges")],
    { trackedOrigins: new Set(["simulated-user"]), captureTimeout: 0 }
  ));
  const serverA = new Y.Doc();
  let serverB = new Y.Doc();
  Y.applyUpdate(serverA, seedUpdate, "seed");
  Y.applyUpdate(serverB, seedUpdate, "seed");

  const updates: UpdateEnvelope[] = [];
  let duplicates = 0;
  let delayed = 0;

  for (let operation = 0; operation < options.operations; operation += 1) {
    const source = operation % clients.length;
    const update = performRandomOperation(
      clients[source],
      undoManagers[source],
      source,
      operation,
      random
    );
    if (!update) continue;
    const envelope = { source, update };
    updates.push(envelope);

    // Model intermittent connectivity by delivering to a random subset now;
    // all delayed updates are reconciled during the final state-vector sync.
    for (let target = 0; target < clients.length; target += 1) {
      if (target === source) continue;
      if (random() < immediateRate) Y.applyUpdate(clients[target], update, "network");
      else delayed += 1;
      if (random() < duplicateRate) {
        Y.applyUpdate(clients[target], update, "duplicate");
        duplicates += 1;
      }
    }
    const destination = random() > 0.5 ? serverA : serverB;
    Y.applyUpdate(destination, update, "ingress");

    if (operation === Math.floor(options.operations / 2)) {
      serverB.destroy();
      serverB = new Y.Doc();
      Y.applyUpdate(serverB, seedUpdate, "restart-snapshot");
      for (const persisted of shuffle(updates, random)) {
        Y.applyUpdate(serverB, persisted.update, "restart-replay");
      }
    }
  }

  // Different orders on every participant plus duplicate delivery exercise
  // commutativity and idempotence. The two server docs represent two backend
  // instances receiving the same durable tail through independent paths.
  for (const client of clients) {
    for (const envelope of shuffle(updates, random)) {
      Y.applyUpdate(client, envelope.update, "reconciliation");
      if (random() < duplicateRate) Y.applyUpdate(client, envelope.update, "duplicate");
    }
  }
  for (const envelope of shuffle(updates, random)) Y.applyUpdate(serverA, envelope.update, "replay");
  for (const envelope of shuffle(updates, random)) {
    Y.applyUpdate(serverB, envelope.update, "pubsub");
    if (random() < duplicateRate) Y.applyUpdate(serverB, envelope.update, "duplicate");
  }

  const clientHashes = clients.map(canonicalGraphHash);
  const serverHash = canonicalGraphHash(serverA);
  const secondServerHash = canonicalGraphHash(serverB);
  const converged = [...clientHashes, serverHash, secondServerHash].every(
    (hash) => hash === serverHash
  );

  undoManagers.forEach((manager) => manager.destroy());
  clients.forEach((doc) => doc.destroy());
  serverA.destroy();
  serverB.destroy();
  return {
    converged,
    clientHashes,
    serverHash,
    generatedUpdates: updates.length,
    duplicateDeliveries: duplicates,
    delayedDeliveries: delayed,
  };
}
