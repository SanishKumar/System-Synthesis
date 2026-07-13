import * as Y from "yjs";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";

export type SharedRecord = Y.Map<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function patchSharedRecord(target: SharedRecord, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      target.delete(key);
      continue;
    }
    if (isRecord(value)) {
      const current = target.get(key);
      if (current instanceof Y.Map) {
        patchSharedRecord(current, value);
      } else {
        target.set(key, createSharedRecord(value));
      }
      continue;
    }
    target.set(key, value);
  }
}

export function createSharedRecord(value: Record<string, unknown>): SharedRecord {
  const record = new Y.Map<unknown>();
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    record.set(key, isRecord(child) ? createSharedRecord(child) : child);
  }
  return record;
}

export function readSharedRecord<T>(record: SharedRecord): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of record.entries()) {
    output[key] = value instanceof Y.Map ? readSharedRecord(value) : value;
  }
  return output as T;
}

export function readSharedValue<T>(value: unknown): T {
  return (value instanceof Y.Map ? readSharedRecord(value) : value) as T;
}

export function upsertSharedRecord(
  root: Y.Map<SharedRecord>,
  id: string,
  value: Record<string, unknown>
): SharedRecord {
  const current = root.get(id);
  if (current instanceof Y.Map) {
    patchSharedRecord(current, value);
    return current;
  }
  const created = createSharedRecord(value);
  root.set(id, created);
  return created;
}

export function initializeGraphDoc(
  doc: Y.Doc,
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): void {
  const nodeRoot = doc.getMap<SharedRecord>("nodes");
  const edgeRoot = doc.getMap<SharedRecord>("edges");
  doc.transact(() => {
    nodes.forEach((node) => upsertSharedRecord(nodeRoot, node.id, node as unknown as Record<string, unknown>));
    edges.forEach((edge) => upsertSharedRecord(edgeRoot, edge.id, edge as unknown as Record<string, unknown>));
  }, "hydrate");
}

export function serializeGraphDoc(doc: Y.Doc): {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
} {
  return {
    nodes: Array.from(doc.getMap<SharedRecord>("nodes").values()).map((value) =>
      readSharedValue<SerializedNode>(value)
    ),
    edges: Array.from(doc.getMap<SharedRecord>("edges").values()).map((value) =>
      readSharedValue<SerializedEdge>(value)
    ),
  };
}
