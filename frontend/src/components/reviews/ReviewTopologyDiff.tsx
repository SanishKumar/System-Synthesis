"use client";

import React, { memo, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GitCompareArrows, Network } from "lucide-react";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import { autoLayoutNodes } from "@/lib/layout";
import type { ReviewGraphChange } from "@/types/reviews";

type RevisionMode = "base" | "head";
type ChangeKind = ReviewGraphChange["kind"] | "unchanged";

interface ReviewTopologyDiffProps {
  baseNodes: SerializedNode[];
  baseEdges: SerializedEdge[];
  headNodes: SerializedNode[];
  headEdges: SerializedEdge[];
  changes: ReviewGraphChange[];
  baseRevision: string;
  headRevision: string;
}

interface DiffNodeData extends Record<string, unknown> {
  label: string;
  nodeType: string;
  zone?: string;
  changeKind: ChangeKind;
}

const changePresentation: Record<ChangeKind, {
  label: string;
  border: string;
  background: string;
  color: string;
}> = {
  added: {
    label: "added",
    border: "#10b981",
    background: "rgba(16, 185, 129, 0.10)",
    color: "#047857",
  },
  removed: {
    label: "removed",
    border: "#ef4444",
    background: "rgba(239, 68, 68, 0.10)",
    color: "#b91c1c",
  },
  changed: {
    label: "changed",
    border: "#f59e0b",
    background: "rgba(245, 158, 11, 0.11)",
    color: "#b45309",
  },
  unchanged: {
    label: "unchanged",
    border: "var(--color-border-light)",
    background: "var(--color-surface)",
    color: "var(--color-text-muted)",
  },
};

function ReviewDiffNode({ data }: NodeProps) {
  const nodeData = data as DiffNodeData;
  const presentation = changePresentation[nodeData.changeKind];

  return (
    <div
      className="min-w-[190px] rounded-xl border-2 px-3.5 py-3 shadow-[var(--shadow-soft)]"
      style={{
        borderColor: presentation.border,
        background: presentation.background,
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-accent-cyan">
          <Network className="h-4 w-4" />
        </span>
        <span
          className="rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em]"
          style={{ borderColor: presentation.border, color: presentation.color }}
        >
          {presentation.label}
        </span>
      </div>
      <p className="mt-3 max-w-[180px] truncate text-sm font-bold text-text-primary">
        {nodeData.label}
      </p>
      <p className="mt-1 font-mono text-[10px] text-text-muted">
        {nodeData.nodeType} · {nodeData.zone || "unscoped"}
      </p>
    </div>
  );
}

const MemoReviewDiffNode = memo(ReviewDiffNode);
const nodeTypes: NodeTypes = { reviewDiffNode: MemoReviewDiffNode };

function edgeClass(changeKind: ChangeKind): string {
  return `review-diff-edge review-diff-edge-${changeKind}`;
}

function modeChangeKind(
  entityId: string,
  mode: RevisionMode,
  changes: Map<string, ReviewGraphChange>
): ChangeKind {
  const change = changes.get(entityId);
  if (!change) return "unchanged";
  if (mode === "head" && change.kind === "removed") return "unchanged";
  if (mode === "base" && change.kind === "added") return "unchanged";
  return change.kind;
}

function revisionLabel(value: string): string {
  return value.length > 18 ? value.slice(0, 12) : value;
}

export default function ReviewTopologyDiff({
  baseNodes,
  baseEdges,
  headNodes,
  headEdges,
  changes,
  baseRevision,
  headRevision,
}: ReviewTopologyDiffProps) {
  const [mode, setMode] = useState<RevisionMode>("head");

  const topology = useMemo(() => {
    const nodeChanges = new Map(
      changes
        .filter((change) => change.entity === "node")
        .map((change) => [change.entityId, change])
    );
    const edgeChanges = new Map(
      changes
        .filter((change) => change.entity === "edge")
        .map((change) => [change.entityId, change])
    );

    const headNodeIds = new Set(headNodes.map((node) => node.id));
    const unionNodes = [
      ...headNodes,
      ...baseNodes.filter((node) => !headNodeIds.has(node.id)),
    ];
    const headEdgeIds = new Set(headEdges.map((edge) => edge.id));
    const unionEdges = [
      ...headEdges,
      ...baseEdges.filter((edge) => !headEdgeIds.has(edge.id)),
    ];
    const laidOut = autoLayoutNodes(unionNodes, unionEdges, {
      direction: "LR",
      nodeWidth: 210,
      nodeHeight: 112,
      rankSep: 90,
      nodeSep: 55,
    });
    const positions = new Map(laidOut.map((node) => [node.id, node.position]));

    function forRevision(
      revisionMode: RevisionMode,
      sourceNodes: SerializedNode[],
      sourceEdges: SerializedEdge[]
    ): { nodes: Node<DiffNodeData>[]; edges: Edge[] } {
      return {
        nodes: sourceNodes.map((node) => ({
          id: node.id,
          type: "reviewDiffNode",
          position: positions.get(node.id) || node.position,
          data: {
            label: String(node.data.label),
            nodeType: String(node.data.nodeType),
            zone: node.data.zone ? String(node.data.zone) : undefined,
            changeKind: modeChangeKind(node.id, revisionMode, nodeChanges),
          },
          draggable: false,
          selectable: true,
        })),
        edges: sourceEdges.map((edge) => {
          const changeKind = modeChangeKind(edge.id, revisionMode, edgeChanges);
          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: "smoothstep",
            className: edgeClass(changeKind),
            animated: changeKind === "added",
            selectable: true,
          };
        }),
      };
    }

    return {
      base: forRevision("base", baseNodes, baseEdges),
      head: forRevision("head", headNodes, headEdges),
    };
  }, [baseEdges, baseNodes, changes, headEdges, headNodes]);

  const active = topology[mode];
  const activeRevision = mode === "base" ? baseRevision : headRevision;

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-accent-cyan" />
            <h2 className="font-display text-base font-bold text-text-primary">
              Topology before and after
            </h2>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Toggle revisions without moving nodes; topology uses the persisted canonical graphs.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-canvas-50 p-1">
          {([
            ["base", `Base · ${revisionLabel(baseRevision)}`],
            ["head", `Proposed · ${revisionLabel(headRevision)}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                mode === value
                  ? "bg-surface text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-canvas-50 px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-[0.08em] text-text-muted">
          {(["added", "changed", "removed", "unchanged"] as const).map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: changePresentation[kind].border }}
              />
              {kind}
            </span>
          ))}
        </div>
        <span className="font-mono text-[10px] text-text-muted">
          {active.nodes.length} components · {active.edges.length} dependencies · {activeRevision}
        </span>
      </div>

      <div className="h-[480px] bg-canvas">
        {active.nodes.length ? (
          <ReactFlow
            key={mode}
            nodes={active.nodes}
            edges={active.edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.24, maxZoom: 1.15 }}
            minZoom={0.2}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) =>
                changePresentation[(node.data as DiffNodeData).changeKind].border
              }
              maskColor="var(--color-minimap-mask)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            This revision contains no modeled components.
          </div>
        )}
      </div>
    </section>
  );
}
