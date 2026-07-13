import { createHash } from "node:crypto";
import { z } from "zod";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";

export type ExportTarget = "docker-compose" | "terraform";

export interface InfrastructureResource {
  id: string;
  sourceNodeId: string;
  name: string;
  kind: string;
  tech?: string;
  instances: number;
  zone?: string;
  dependsOn: string[];
}

export interface InfrastructureIR {
  schemaVersion: "1.0";
  generator: "system-synthesis";
  target: ExportTarget;
  sourceHash: string;
  resources: InfrastructureResource[];
}

export class UnsupportedExportError extends Error {
  constructor(
    message: string,
    readonly unsupported: Array<{ nodeId: string; nodeType: string; reason: string }>
  ) {
    super(message);
    this.name = "UnsupportedExportError";
  }
}

const irSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generator: z.literal("system-synthesis"),
  target: z.enum(["docker-compose", "terraform"]),
  sourceHash: z.string().length(64),
  resources: z.array(z.object({
    id: z.string().min(1),
    sourceNodeId: z.string().min(1),
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    kind: z.string().min(1),
    tech: z.string().optional(),
    instances: z.number().int().positive(),
    zone: z.string().optional(),
    dependsOn: z.array(z.string()),
  })),
});

const TARGET_SUPPORT: Record<ExportTarget, Set<string>> = {
  "docker-compose": new Set([
    "service", "database", "cache", "queue", "gateway", "loadbalancer", "storage", "client",
  ]),
  terraform: new Set([
    "service", "database", "cache", "queue", "gateway", "loadbalancer", "storage", "client",
  ]),
};

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

function sourceHash(nodes: SerializedNode[], edges: SerializedEdge[]): string {
  const canonical = {
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map(stable),
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)).map(stable),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sanitizeName(label: string, separator: "-" | "_"): string {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "");
  return /^[a-z]/.test(name) ? name : `resource${separator}${name || "unnamed"}`;
}

export function buildInfrastructureIR(
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  target: ExportTarget
): InfrastructureIR {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dangling = edges.filter((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target));
  if (dangling.length) {
    throw new UnsupportedExportError("The graph contains dangling dependencies", dangling.map((edge) => ({
      nodeId: edge.id,
      nodeType: "edge",
      reason: `Missing endpoint for ${edge.source} -> ${edge.target}`,
    })));
  }

  const unsupported = nodes
    .filter((node) => !TARGET_SUPPORT[target].has(node.data.nodeType))
    .map((node) => ({
      nodeId: node.id,
      nodeType: node.data.nodeType,
      reason: `${node.data.nodeType} is outside the documented ${target} subset`,
    }));
  if (unsupported.length) {
    throw new UnsupportedExportError(`Unsupported resources for ${target}`, unsupported);
  }

  const separator = target === "terraform" ? "_" : "-";
  const orderedNodes = [...nodes].sort(
    (left, right) => left.data.label.localeCompare(right.data.label) || left.id.localeCompare(right.id)
  );
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const node of orderedNodes) {
    const base = sanitizeName(node.data.label, separator);
    let name = base;
    if (used.has(name)) {
      const suffix = createHash("sha256").update(node.id).digest("hex").slice(0, 8);
      name = `${base}${separator}${suffix}`;
    }
    used.add(name);
    names.set(node.id, name);
  }

  const resources = orderedNodes.map((node) => ({
    id: `${node.data.nodeType}:${node.id}`,
    sourceNodeId: node.id,
    name: names.get(node.id)!,
    kind: node.data.nodeType,
    ...(node.data.tech ? { tech: node.data.tech } : {}),
    instances: Math.max(1, Math.floor(node.data.instances || 1)),
    ...(node.data.zone ? { zone: node.data.zone } : {}),
    dependsOn: edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => names.get(edge.target)!)
      .filter(Boolean)
      .sort(),
  }));

  return irSchema.parse({
    schemaVersion: "1.0",
    generator: "system-synthesis",
    target,
    sourceHash: sourceHash(nodes, edges),
    resources,
  });
}

export interface InfrastructureDiff {
  added: InfrastructureResource[];
  removed: InfrastructureResource[];
  changed: Array<{ before: InfrastructureResource; after: InfrastructureResource }>;
}

export function diffInfrastructureIR(before: InfrastructureIR, after: InfrastructureIR): InfrastructureDiff {
  const oldResources = new Map(before.resources.map((resource) => [resource.sourceNodeId, resource]));
  const newResources = new Map(after.resources.map((resource) => [resource.sourceNodeId, resource]));
  return {
    added: after.resources.filter((resource) => !oldResources.has(resource.sourceNodeId)),
    removed: before.resources.filter((resource) => !newResources.has(resource.sourceNodeId)),
    changed: after.resources.flatMap((resource) => {
      const previous = oldResources.get(resource.sourceNodeId);
      return previous && JSON.stringify(previous) !== JSON.stringify(resource)
        ? [{ before: previous, after: resource }]
        : [];
    }),
  };
}

export function provenanceHeader(ir: InfrastructureIR, prefix = "#"): string {
  return [
    `${prefix} Generated by System Synthesis`,
    `${prefix} IR schema: ${ir.schemaVersion}`,
    `${prefix} Target: ${ir.target}`,
    `${prefix} Source graph SHA-256: ${ir.sourceHash}`,
    `${prefix} Deterministic output: timestamps are intentionally omitted`,
  ].join("\n");
}
