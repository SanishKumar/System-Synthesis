import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";

export type GraphChangeKind = "added" | "removed" | "changed";
export type GraphEntityKind = "node" | "edge";

export interface GraphFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface SemanticGraphChange {
  id: string;
  kind: GraphChangeKind;
  entity: GraphEntityKind;
  entityId: string;
  summary: string;
  fields: GraphFieldChange[];
}

export interface SemanticGraphDiff {
  changes: SemanticGraphChange[];
  stats: {
    added: number;
    removed: number;
    changed: number;
    total: number;
  };
}

const EMPTY_STATS = { added: 0, removed: 0, changed: 0, total: 0 };

export const EMPTY_GRAPH_DIFF: SemanticGraphDiff = {
  changes: [],
  stats: EMPTY_STATS,
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function label(node: SerializedNode | undefined, fallback: string): string {
  return String(node?.data?.label || fallback);
}

function nodeFields(before: SerializedNode, after: SerializedNode): GraphFieldChange[] {
  const fields: GraphFieldChange[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (!equal(left, right)) fields.push({ field, before: left, after: right });
  };

  compare("type", before.type, after.type);
  compare("position", before.position, after.position);
  compare("parentId", before.parentId, after.parentId);
  compare("extent", before.extent, after.extent);
  compare("style", before.style, after.style);

  const dataKeys = new Set([
    ...Object.keys(before.data || {}),
    ...Object.keys(after.data || {}),
  ]);
  for (const key of [...dataKeys].sort()) {
    // Source locations can move when a file is reformatted without changing
    // the architecture. They are evidence, not semantic graph state.
    if (key === "provenance") continue;
    compare(`data.${key}`, before.data?.[key], after.data?.[key]);
  }
  return fields;
}

function edgeFields(before: SerializedEdge, after: SerializedEdge): GraphFieldChange[] {
  const fields: GraphFieldChange[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (!equal(left, right)) fields.push({ field, before: left, after: right });
  };
  compare("source", before.source, after.source);
  compare("target", before.target, after.target);
  compare("sourceHandle", before.sourceHandle, after.sourceHandle);
  compare("targetHandle", before.targetHandle, after.targetHandle);
  compare("animated", before.animated, after.animated);
  const beforeData = before.data
    ? { ...before.data, provenance: undefined }
    : before.data;
  const afterData = after.data
    ? { ...after.data, provenance: undefined }
    : after.data;
  compare("data", beforeData, afterData);
  return fields;
}

function nodeChangeSummary(before: SerializedNode, after: SerializedNode, fields: GraphFieldChange[]): string {
  const beforeLabel = label(before, before.id);
  const afterLabel = label(after, after.id);
  if (beforeLabel !== afterLabel) return `~ Renamed ${beforeLabel} to ${afterLabel}`;

  const replicas = fields.find((field) => field.field === "data.instances");
  if (replicas) {
    const from = Number(replicas.before || 0);
    const to = Number(replicas.after || 0);
    const verb = to > from ? "Increased" : to < from ? "Decreased" : "Changed";
    return `~ ${verb} ${afterLabel} replicas from ${String(replicas.before ?? "unset")} to ${String(replicas.after ?? "unset")}`;
  }
  if (fields.some((field) => field.field === "position")) return `~ Moved ${afterLabel}`;
  const names = fields.slice(0, 3).map((field) => field.field.replace(/^data\./, ""));
  return `~ Updated ${afterLabel}${names.length ? `: ${names.join(", ")}` : ""}`;
}

export function diffArchitectureGraphs(
  beforeNodes: SerializedNode[],
  beforeEdges: SerializedEdge[],
  afterNodes: SerializedNode[],
  afterEdges: SerializedEdge[]
): SemanticGraphDiff {
  const changes: SemanticGraphChange[] = [];
  const beforeNodeById = new Map(beforeNodes.map((node) => [node.id, node]));
  const afterNodeById = new Map(afterNodes.map((node) => [node.id, node]));
  const beforeEdgeById = new Map(beforeEdges.map((edge) => [edge.id, edge]));
  const afterEdgeById = new Map(afterEdges.map((edge) => [edge.id, edge]));

  for (const id of [...new Set([...beforeNodeById.keys(), ...afterNodeById.keys()])].sort()) {
    const before = beforeNodeById.get(id);
    const after = afterNodeById.get(id);
    if (!before && after) {
      changes.push({
        id: `node:${id}:added`,
        kind: "added",
        entity: "node",
        entityId: id,
        summary: `+ Added ${label(after, id)}`,
        fields: [],
      });
    } else if (before && !after) {
      changes.push({
        id: `node:${id}:removed`,
        kind: "removed",
        entity: "node",
        entityId: id,
        summary: `- Removed ${label(before, id)}`,
        fields: [],
      });
    } else if (before && after) {
      const fields = nodeFields(before, after);
      if (fields.length) {
        changes.push({
          id: `node:${id}:changed`,
          kind: "changed",
          entity: "node",
          entityId: id,
          summary: nodeChangeSummary(before, after, fields),
          fields,
        });
      }
    }
  }

  const nodeName = (id: string, preferAfter = true) =>
    label((preferAfter ? afterNodeById : beforeNodeById).get(id) || afterNodeById.get(id) || beforeNodeById.get(id), id);
  for (const id of [...new Set([...beforeEdgeById.keys(), ...afterEdgeById.keys()])].sort()) {
    const before = beforeEdgeById.get(id);
    const after = afterEdgeById.get(id);
    if (!before && after) {
      changes.push({
        id: `edge:${id}:added`,
        kind: "added",
        entity: "edge",
        entityId: id,
        summary: `+ Connected ${nodeName(after.source)} to ${nodeName(after.target)}`,
        fields: [],
      });
    } else if (before && !after) {
      changes.push({
        id: `edge:${id}:removed`,
        kind: "removed",
        entity: "edge",
        entityId: id,
        summary: `- Disconnected ${nodeName(before.source, false)} from ${nodeName(before.target, false)}`,
        fields: [],
      });
    } else if (before && after) {
      const fields = edgeFields(before, after);
      if (fields.length) {
        changes.push({
          id: `edge:${id}:changed`,
          kind: "changed",
          entity: "edge",
          entityId: id,
          summary: `~ Updated connection ${nodeName(after.source)} to ${nodeName(after.target)}`,
          fields,
        });
      }
    }
  }

  const stats = changes.reduce(
    (result, change) => {
      result[change.kind] += 1;
      result.total += 1;
      return result;
    },
    { ...EMPTY_STATS }
  );
  return { changes, stats };
}
