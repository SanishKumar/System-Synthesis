import type {
  SerializedEdge,
  SerializedNode,
  SourceProvenance,
} from "@system-synthesis/shared";

export interface CanonicalGraphSource {
  adapter: string;
  repository?: string;
  revision?: string;
  files: string[];
}

export interface CanonicalArchitectureGraph {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  source: CanonicalGraphSource;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizeSourceAddress(address: string): string {
  return address.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function addressSlug(address: string): string {
  const segment = normalizeSourceAddress(address).split(/[./:[\]]/).filter(Boolean).at(-1) || "resource";
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "resource";
}

export function stableEntityId(
  kind: "node" | "edge",
  adapter: string,
  sourceAddress: string
): string {
  const normalizedAddress = normalizeSourceAddress(sourceAddress);
  const namespace = `${adapter.trim().toLowerCase()}:${kind}:${normalizedAddress}`;
  return `src-${kind}-${addressSlug(normalizedAddress)}-${fnv1a64(namespace)}`;
}

export function stableEdgeId(
  adapter: string,
  sourceAddress: string,
  targetAddress: string,
  relationship = "depends_on"
): string {
  const address = `${normalizeSourceAddress(sourceAddress)}->${normalizeSourceAddress(targetAddress)}:${relationship}`;
  return stableEntityId("edge", adapter, address);
}

export function canonicalizeGraph(graph: CanonicalArchitectureGraph): CanonicalArchitectureGraph {
  return {
    source: {
      ...graph.source,
      files: [...new Set(graph.source.files.map(normalizeSourceAddress))].sort(),
    },
    nodes: graph.nodes
      .map((node) => stableValue(node) as SerializedNode)
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: graph.edges
      .map((edge) => stableValue(edge) as SerializedEdge)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Fingerprints architecture content rather than a particular commit. Revision
 * and source-location metadata are deliberately excluded so semantically
 * identical graphs hash identically even when YAML keys move between lines.
 */
export function canonicalGraphFingerprint(graph: CanonicalArchitectureGraph): string {
  const canonical = canonicalizeGraph(graph);
  const content = {
    nodes: canonical.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        provenance: undefined,
      },
    })),
    edges: canonical.edges.map((edge) => ({
      ...edge,
      data: edge.data
        ? { ...edge.data, provenance: undefined }
        : edge.data,
    })),
  };
  return fnv1a64(stableStringify(content));
}
