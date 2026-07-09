"use client";

import React, { memo, useState, useRef, useEffect, useCallback } from "react";
import { Handle, Position, type NodeProps, NodeResizer } from "@xyflow/react";
import { FolderOpen } from "lucide-react";
import { useBoardStore } from "@/store/boardStore";
import type { ArchNodeData } from "@system-synthesis/shared";

/**
 * Group color palette — each group gets a distinct tint.
 * These are used for the border and subtle background.
 */
const GROUP_COLORS = [
  { border: "#00dbe9", bg: "rgba(0, 219, 233, 0.04)", text: "#00dbe9" },
  { border: "#a78bfa", bg: "rgba(167, 139, 250, 0.04)", text: "#a78bfa" },
  { border: "#22c55e", bg: "rgba(34, 197, 94, 0.04)", text: "#22c55e" },
  { border: "#f59e0b", bg: "rgba(245, 158, 11, 0.04)", text: "#f59e0b" },
  { border: "#f43f5e", bg: "rgba(244, 63, 94, 0.04)", text: "#f43f5e" },
  { border: "#60a5fa", bg: "rgba(96, 165, 250, 0.04)", text: "#60a5fa" },
  { border: "#e879f9", bg: "rgba(232, 121, 249, 0.04)", text: "#e879f9" },
  { border: "#fb923c", bg: "rgba(251, 146, 60, 0.04)", text: "#fb923c" },
];

function getGroupColor(id: string) {
  // Deterministic color based on node ID hash
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}

/**
 * GroupNode — A resizable container that holds child nodes.
 * - Renders as a semi-transparent box with a colored title bar
 * - Supports inline rename via double-click
 * - Resizable via NodeResizer
 * - Children are visually contained within
 */
function GroupNode({ id, data, selected }: NodeProps & { data: ArchNodeData }) {
  const color = getGroupColor(id);

  // --- Inline rename state ---
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameText, setRenameText] = useState(data.label);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

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
    e.stopPropagation();
  };

  return (
    <>
      {/* Resizer handles */}
      <NodeResizer
        isVisible={!!selected}
        minWidth={300}
        minHeight={200}
        lineClassName="!border-accent-cyan/40"
        handleClassName="!w-2.5 !h-2.5 !bg-accent-cyan !border-accent-cyan !rounded-sm"
      />

      <div
        className="w-full h-full rounded-lg overflow-visible pointer-events-none"
        style={{
          backgroundColor: color.bg,
          border: `1.5px ${selected ? "solid" : "dashed"} ${color.border}${selected ? "" : "80"}`,
          minWidth: 300,
          minHeight: 200,
        }}
      >
        {/* Title bar */}
        <div
          className="custom-drag-handle flex items-center gap-2 px-3 py-2 rounded-t-lg pointer-events-auto cursor-grab active:cursor-grabbing"
          style={{
            backgroundColor: `${color.border}12`,
            borderBottom: `1px solid ${color.border}30`,
          }}
        >
          <FolderOpen
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: color.text }}
          />
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onBlur={saveRename}
              onKeyDown={handleRenameKeyDown}
              className="font-display font-semibold text-xs uppercase tracking-wider flex-1 bg-transparent border-b outline-none nodrag nopan nowheel"
              style={{ color: color.text, borderColor: color.border }}
              spellCheck={false}
            />
          ) : (
            <span
              className="font-display font-semibold text-xs uppercase tracking-wider flex-1 truncate cursor-text select-none"
              style={{ color: color.text }}
              onDoubleClick={handleLabelDoubleClick}
              title="Double-click to rename"
            >
              {data.label}
            </span>
          )}
        </div>

        {/* Drop zone — children render inside here via React Flow's parent system */}
      </div>

      {/* Minimal handles for connecting groups */}
      <Handle type="target" position={Position.Top} id="top-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="source" position={Position.Top} id="top-source" isConnectable={true} className="!bg-transparent !border-transparent !w-2 !h-2 z-10" />
      <Handle type="target" position={Position.Bottom} id="bottom-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="source" position={Position.Bottom} id="bottom-source" isConnectable={true} className="!bg-transparent !border-transparent !w-2 !h-2 z-10" />
      <Handle type="target" position={Position.Left} id="left-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="source" position={Position.Left} id="left-source" isConnectable={true} className="!bg-transparent !border-transparent !w-2 !h-2 z-10" />
      <Handle type="target" position={Position.Right} id="right-target" isConnectable={true} className="!bg-transparent !border-transparent !w-3 !h-3" />
      <Handle type="source" position={Position.Right} id="right-source" isConnectable={true} className="!bg-transparent !border-transparent !w-2 !h-2 z-10" />
    </>
  );
}

export default memo(GroupNode);
