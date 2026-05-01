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
};

function ArchitectureNode({ id, data, selected }: NodeProps & { data: ArchNodeData }) {
  const icon = nodeIcons[data.nodeType] || <Server className="w-4 h-4" />;
  const statusColor =
    data.status === "active"
      ? "bg-status-active"
      : data.status === "analyzing"
      ? "bg-status-warning animate-pulse-slow"
      : "bg-status-inactive";

  // Detect text label nodes
  const isTextLabel =
    data.label === "Text Label" || data.metadata?.notes === "__text_label__";

  if (isTextLabel) {
    return <TextLabelNode id={id} data={data} selected={!!selected} />;
  }

  return (
    <div
      className={`group relative min-w-[200px] max-w-[280px] rounded-md transition-all duration-200 ${
        selected
          ? "border border-accent-cyan shadow-glow-cyan-md"
          : "border border-border hover:border-border-light"
      }`}
      style={{
        backgroundColor: "var(--node-bg, #121414)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <span
          className="flex items-center justify-center w-5 h-5"
          style={{ color: nodeColors[data.nodeType] }}
        >
          {icon}
        </span>
        <span className="font-display font-semibold text-sm text-text-primary flex-1 truncate">
          {data.label}
        </span>
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

      {/* Metadata indicator */}
      {(data.metadata?.notes || data.metadata?.codeSnippet || (data.metadata?.links?.length ?? 0) > 0) && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border">
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
      )}

      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-border !border-border-light !w-2 !h-2 !rounded-sm hover:!bg-accent-cyan hover:!border-accent-cyan"
      />

      {/* Selection glow overlay */}
      {selected && (
        <div className="absolute -inset-px rounded-md border border-accent-cyan/30 pointer-events-none" />
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

      {/* Minimal handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-transparent !border-transparent !w-1.5 !h-1.5 hover:!bg-accent-cyan hover:!border-accent-cyan"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-transparent !border-transparent !w-1.5 !h-1.5 hover:!bg-accent-cyan hover:!border-accent-cyan"
      />
      {selected && (
        <div className="absolute -inset-px rounded-sm border border-accent-cyan/20 pointer-events-none" />
      )}
    </div>
  );
}

export default memo(ArchitectureNode);
