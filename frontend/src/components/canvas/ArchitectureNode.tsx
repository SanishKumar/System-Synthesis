"use client";

import React, { memo, useState, useRef, useEffect, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Database,
  Server,
  Globe,
  Inbox,
  HardDrive,
  Monitor,
  Shield,
  Zap,
  AlertTriangle,
  Cloud,
  ShieldCheck,
  Waypoints,
  Container,
  CircuitBoard,
  Search,
  BarChart3,
  Radio,
  Network,
  KeyRound,
  Lock,
  Activity,
  BookOpen,
  Timer,
  FolderOpen,
} from "lucide-react";
import { useBoardStore } from "@/store/boardStore";
import type { ArchNodeData, ArchNodeType } from "@system-synthesis/shared";

const nodeIcons: Record<ArchNodeType, React.ReactNode> = {
  database: <Database className="w-4 h-4" />,
  service: <Server className="w-4 h-4" />,
  gateway: <Globe className="w-4 h-4" />,
  queue: <Inbox className="w-4 h-4" />,
  cache: <Zap className="w-4 h-4" />,
  client: <Monitor className="w-4 h-4" />,
  loadbalancer: <Shield className="w-4 h-4" />,
  storage: <HardDrive className="w-4 h-4" />,
  cdn: <Cloud className="w-4 h-4" />,
  firewall: <ShieldCheck className="w-4 h-4" />,
  dns: <Waypoints className="w-4 h-4" />,
  proxy: <Network className="w-4 h-4" />,
  container: <Container className="w-4 h-4" />,
  function: <CircuitBoard className="w-4 h-4" />,
  search: <Search className="w-4 h-4" />,
  warehouse: <BarChart3 className="w-4 h-4" />,
  stream: <Radio className="w-4 h-4" />,
  broker: <Network className="w-4 h-4" />,
  auth: <KeyRound className="w-4 h-4" />,
  vault: <Lock className="w-4 h-4" />,
  monitor: <Activity className="w-4 h-4" />,
  registry: <BookOpen className="w-4 h-4" />,
  scheduler: <Timer className="w-4 h-4" />,
  group: <FolderOpen className="w-4 h-4" />,
};

const nodeColors: Record<ArchNodeType, string> = {
  database: "#f59e0b",
  service: "#00dbe9",
  gateway: "#22c55e",
  queue: "#a78bfa",
  cache: "#ef4444",
  client: "#60a5fa",
  loadbalancer: "#f472b6",
  storage: "#fb923c",
  cdn: "#38bdf8",
  firewall: "#f43f5e",
  dns: "#2dd4bf",
  proxy: "#818cf8",
  container: "#34d399",
  function: "#fbbf24",
  search: "#c084fc",
  warehouse: "#fb7185",
  stream: "#22d3ee",
  broker: "#e879f9",
  auth: "#4ade80",
  vault: "#f97316",
  monitor: "#a3e635",
  registry: "#67e8f9",
  scheduler: "#fcd34d",
  group: "#94a3b8",
};

function ArchitectureNode({ id, data, selected }: NodeProps & { data: ArchNodeData }) {
  const icon = nodeIcons[data.nodeType] || <Server className="w-4 h-4" />;
  const statusColor =
    data.status === "active"
      ? "bg-status-active"
      : data.status === "analyzing"
      ? "bg-status-warning animate-pulse-slow"
      : "bg-status-inactive";

  // --- Inline rename state ---
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameText, setRenameText] = useState(data.label);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Focus input when rename starts
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  // Sync from external data changes (e.g., multiplayer)
  useEffect(() => {
    if (!isRenaming) setRenameText(data.label);
  }, [data.label, isRenaming]);

  const saveRename = useCallback(() => {
    const finalLabel = renameText.trim() || data.label;
    setIsRenaming(false);
    if (finalLabel !== data.label) {
      useBoardStore.getState().updateNodeData(id, { label: finalLabel });
    }
  }, [id, renameText, data.label]);

  const handleLabelDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRenaming(true);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename();
    }
    if (e.key === "Escape") {
      setRenameText(data.label);
      setIsRenaming(false);
    }
    // Prevent node deletion/undo/redo while typing
    e.stopPropagation();
  };

  // Validation badge: count issues affecting this node
  const validationResult = useBoardStore((s) => s.validationResult);
  const nodeIssues = validationResult?.issues.filter((i) => i.nodeIds.includes(id)) || [];
  const worstSeverity = nodeIssues.length > 0
    ? nodeIssues[0].severity // issues are sorted critical→warning→info
    : null;

  // Detect text label nodes
  const isTextLabel =
    data.label === "Text Label" || data.metadata?.notes === "__text_label__";

  if (isTextLabel) {
    return <TextLabelNode id={id} data={data} selected={!!selected} />;
  }

  return (
    <div
      className={`group relative min-w-[200px] max-w-[280px] rounded-md transition-all duration-200 bg-surface ${
        selected
          ? "border border-accent-cyan shadow-glow-cyan-md"
          : "border border-border hover:border-border-light"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <span
          className="flex items-center justify-center w-5 h-5"
          style={{ color: nodeColors[data.nodeType] }}
        >
          {icon}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={saveRename}
            onKeyDown={handleRenameKeyDown}
            className="font-display font-semibold text-sm text-text-primary flex-1 bg-transparent border-b border-accent-cyan/50 outline-none nodrag nopan nowheel"
            spellCheck={false}
          />
        ) : (
          <span
            className="font-display font-semibold text-sm text-text-primary flex-1 truncate cursor-text"
            onDoubleClick={handleLabelDoubleClick}
            title="Double-click to rename"
          >
            {data.label}
          </span>
        )}
        <span className={`status-dot ${statusColor} shrink-0`} />
      </div>

      {/* Body */}
      {data.subtitle && (
        <div className="px-3 py-2">
          <p className="text-xs font-mono text-text-muted whitespace-pre-line leading-relaxed">
            {data.subtitle}
          </p>
        </div>
      )}

      {/* Metadata indicator + tech badge */}
      {(data.metadata?.notes || data.metadata?.codeSnippet || (data.metadata?.links?.length ?? 0) > 0 || data.tech) && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border">
          {data.tech && (
            <span className="text-[9px] font-mono text-text-muted bg-canvas-50 px-1.5 py-0.5 rounded-sm border border-border">
              {data.tech}
            </span>
          )}
          <div className="flex items-center gap-1 ml-auto">
            {data.metadata?.notes && data.metadata.notes !== "__text_label__" && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan/60" title="Has notes" />
            )}
            {data.metadata?.codeSnippet && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent-purple/60" title="Has code" />
            )}
            {(data.metadata?.links?.length ?? 0) > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-status-active/60" title="Has links" />
            )}
          </div>
        </div>
      )}

      {/* Handles — bidirectional (source+target) at each position, perfectly stacked */}
      {/* Top */}
      <Handle type="target" position={Position.Top} id="top-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3 !-mt-0.5" />
      <Handle type="source" position={Position.Top} id="top-source" isConnectable={true} className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan z-10" />
      
      {/* Bottom */}
      <Handle type="target" position={Position.Bottom} id="bottom-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3 !-mb-0.5" />
      <Handle type="source" position={Position.Bottom} id="bottom-source" isConnectable={true} className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan z-10" />
      
      {/* Left */}
      <Handle type="target" position={Position.Left} id="left-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3 !-ml-0.5" />
      <Handle type="source" position={Position.Left} id="left-source" isConnectable={true} className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan z-10" />
      
      {/* Right */}
      <Handle type="target" position={Position.Right} id="right-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3 !-mr-0.5" />
      <Handle type="source" position={Position.Right} id="right-source" isConnectable={true} className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan z-10" />

      {/* Selection glow overlay */}
      {selected && (
        <div className="absolute -inset-px rounded-md border border-accent-cyan/30 pointer-events-none" />
      )}

      {/* Validation badge */}
      {worstSeverity && (
        <div
          className={`absolute -top-2 -right-2 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-display font-bold shadow-sm border pointer-events-none z-10 ${
            worstSeverity === "critical"
              ? "bg-status-error text-white border-status-error"
              : worstSeverity === "warning"
              ? "bg-status-warning text-canvas border-status-warning"
              : "bg-accent-cyan text-canvas border-accent-cyan"
          }`}
          title={`${nodeIssues.length} validation issue(s)`}
        >
          <AlertTriangle className="w-2.5 h-2.5" />
          {nodeIssues.length}
        </div>
      )}
    </div>
  );
}

/**
 * Inline-editable text label node.
 * Double-click to enter edit mode, type text, click away or press Enter/Escape to save.
 */
function TextLabelNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: ArchNodeData;
  selected: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(data.subtitle || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when editing starts
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  // Sync from external data changes (e.g. multiplayer updates)
  useEffect(() => {
    if (!isEditing) {
      setEditText(data.subtitle || "");
    }
  }, [data.subtitle, isEditing]);

  const saveText = useCallback(() => {
    const finalText = editText.trim() || "Double-click to edit";
    setIsEditing(false);

    // Update the node in the store
    const store = useBoardStore.getState();
    const updatedNodes = store.nodes.map((n) => {
      if (n.id === id) {
        return {
          ...n,
          data: {
            ...n.data,
            subtitle: finalText,
            metadata: {
              ...n.data.metadata,
              notes: "__text_label__",
            },
          },
        };
      }
      return n;
    });
    store.setNodes(updatedNodes);
  }, [id, editText]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveText();
    }
    if (e.key === "Escape") {
      setEditText(data.subtitle || "");
      setIsEditing(false);
    }
    // Prevent node deletion while typing
    e.stopPropagation();
  };

  const displayText =
    data.subtitle && data.subtitle !== "Double-click to edit"
      ? data.subtitle
      : "Double-click to edit";

  return (
    <div
      className={`group relative px-4 py-2 rounded-sm transition-all duration-200 min-w-[140px] ${
        selected
          ? "border border-accent-cyan/50 bg-accent-cyan/5"
          : "border border-transparent hover:border-border bg-transparent"
      }`}
      onDoubleClick={handleDoubleClick}
    >
      {isEditing ? (
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={saveText}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-sm font-body text-text-primary italic leading-relaxed resize-none outline-none border-b border-accent-cyan/40 min-h-[24px] nodrag nopan"
          rows={Math.max(1, editText.split("\n").length)}
          placeholder="Type your note..."
        />
      ) : (
        <p
          className={`text-sm font-body italic leading-relaxed select-none ${
            displayText === "Double-click to edit"
              ? "text-text-muted/50"
              : "text-text-secondary"
          }`}
        >
          {displayText}
        </p>
      )}

      {/* Minimal handles — bidirectional */}
      <Handle type="target" position={Position.Top} id="top-target" isConnectable={true} className="!bg-transparent !border-transparent !w-2 !h-2" />
      <Handle type="source" position={Position.Top} id="top-source" isConnectable={true} className="!bg-transparent !border-transparent !w-1.5 !h-1.5 hover:!bg-accent-cyan hover:!border-accent-cyan z-10" />
      
      <Handle type="target" position={Position.Bottom} id="bottom-target" isConnectable={true} className="!bg-transparent !border-transparent !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} id="bottom-source" isConnectable={true} className="!bg-transparent !border-transparent !w-1.5 !h-1.5 hover:!bg-accent-cyan hover:!border-accent-cyan z-10" />
      {selected && (
        <div className="absolute -inset-px rounded-sm border border-accent-cyan/20 pointer-events-none" />
      )}
    </div>
  );
}

export default memo(ArchitectureNode);
