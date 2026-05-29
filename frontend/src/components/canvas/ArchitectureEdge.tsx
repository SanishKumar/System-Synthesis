"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import type { ArchEdgeData } from "@system-synthesis/shared";

/**
 * Protocol → visual style mapping.
 * Used for automatic edge differentiation.
 */
const PROTOCOL_STYLES: Record<string, { strokeDasharray?: string; stroke?: string; label?: string }> = {
  http:        { stroke: "var(--color-accent-cyan)", label: "HTTP" },
  https:       { stroke: "var(--color-accent-cyan)", label: "HTTPS" },
  grpc:        { stroke: "var(--color-accent-purple)", label: "gRPC" },
  graphql:     { stroke: "var(--color-accent-purple)", label: "GraphQL" },
  websocket:   { stroke: "var(--color-status-active)", label: "WS" },
  event:       { strokeDasharray: "6 4", stroke: "var(--color-status-warning)", label: "Event" },
  pubsub:      { strokeDasharray: "6 4", stroke: "var(--color-status-warning)", label: "Pub/Sub" },
  queue:       { strokeDasharray: "6 4", stroke: "var(--color-status-warning)", label: "Queue" },
  replication: { strokeDasharray: "3 3", stroke: "var(--color-status-error)", label: "Replication" },
  sync:        { strokeDasharray: "3 3", stroke: "var(--color-status-active)", label: "Sync" },
  tcp:         { stroke: "var(--color-rf-edge)", label: "TCP" },
  sql:         { stroke: "var(--color-accent-purple)", label: "SQL" },
};

const PROTOCOL_OPTIONS = [
  "", "http", "https", "grpc", "graphql", "websocket",
  "event", "pubsub", "queue", "replication", "sync", "tcp", "sql",
];

/**
 * ArchitectureEdge — Custom edge with:
 *   - Protocol-based stroke styling (solid/dashed/dotted, color-coded)
 *   - Inline label display
 *   - Double-click to edit label
 *   - Right-click context menu for protocol & direction
 */
export default function ArchitectureEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  style,
  markerEnd,
}: EdgeProps) {
  const edgeData = (data || {}) as ArchEdgeData;
  const [isEditing, setIsEditing] = useState(false);
  const [labelText, setLabelText] = useState(edgeData.label || "");
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Sync label from data
  useEffect(() => {
    setLabelText(edgeData.label || "");
  }, [edgeData.label]);

  // Close context menu on outside click
  useEffect(() => {
    if (!showContextMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showContextMenu]);

  // Auto-focus input on edit
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Path
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  // Protocol-based styling
  const protocolStyle = edgeData.protocol
    ? PROTOCOL_STYLES[edgeData.protocol.toLowerCase()] || {}
    : {};

  const edgeStroke = protocolStyle.stroke || style?.stroke || "var(--color-rf-edge)";
  const edgeDash = protocolStyle.strokeDasharray || undefined;
  const displayLabel = edgeData.label || protocolStyle.label || "";

  // Commit label change
  const commitLabel = useCallback(() => {
    setIsEditing(false);
    if (labelText !== (edgeData.label || "")) {
      // Dispatch custom event to update the edge data
      window.dispatchEvent(
        new CustomEvent("edge-label-update", {
          detail: { edgeId: id, label: labelText },
        })
      );
    }
  }, [id, labelText, edgeData.label]);

  // Handle protocol change from context menu
  const handleProtocolChange = (protocol: string) => {
    window.dispatchEvent(
      new CustomEvent("edge-data-update", {
        detail: { edgeId: id, data: { protocol: protocol || undefined } },
      })
    );
    setShowContextMenu(false);
  };

  // Handle direction change from context menu
  const handleDirectionChange = (dir: "unidirectional" | "bidirectional") => {
    window.dispatchEvent(
      new CustomEvent("edge-data-update", {
        detail: { edgeId: id, data: { direction: dir } },
      })
    );
    setShowContextMenu(false);
  };

  // Handle animation toggle
  const handleToggleAnimation = () => {
    window.dispatchEvent(
      new CustomEvent("edge-data-update", {
        detail: { edgeId: id, data: { animated: !edgeData.animated } },
      })
    );
    setShowContextMenu(false);
  };

  return (
    <>
      {/* Edge Path */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: selected ? "var(--color-accent-cyan)" : edgeStroke,
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: edgeDash,
          transition: "stroke 0.2s, stroke-width 0.2s",
        }}
        markerEnd={markerEnd}
      />

      {/* Invisible wider path for easier click/hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setIsEditing(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextPos({ x: e.clientX, y: e.clientY });
          setShowContextMenu(true);
        }}
        style={{ cursor: "pointer" }}
      />

      {/* Edge Label */}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          {isEditing ? (
            <input
              ref={inputRef}
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLabel();
                if (e.key === "Escape") {
                  setLabelText(edgeData.label || "");
                  setIsEditing(false);
                }
              }}
              className="px-2 py-0.5 text-[10px] font-display bg-surface border border-accent-cyan rounded text-text-primary outline-none min-w-[60px] text-center"
              style={{ fontSize: "10px" }}
            />
          ) : displayLabel ? (
            <div
              onDoubleClick={() => setIsEditing(true)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextPos({ x: e.clientX, y: e.clientY });
                setShowContextMenu(true);
              }}
              className={`px-2 py-0.5 rounded text-[10px] font-display font-medium cursor-pointer transition-all
                ${selected
                  ? "bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40"
                  : "bg-surface/80 text-text-muted border border-border hover:text-text-primary hover:border-border-light"
                }`}
            >
              {displayLabel}
            </div>
          ) : selected ? (
            <div
              onDoubleClick={() => setIsEditing(true)}
              className="px-2 py-0.5 rounded text-[10px] font-display text-text-muted/50 border border-dashed border-border cursor-pointer hover:border-accent-cyan/30 hover:text-text-muted"
            >
              ···
            </div>
          ) : null}
        </div>

        {/* Context Menu */}
        {showContextMenu && (
          <div
            ref={menuRef}
            className="fixed z-[100] w-48 bg-surface border border-border rounded-md shadow-card overflow-hidden animate-fade-in"
            style={{ left: contextPos.x, top: contextPos.y }}
          >
            {/* Protocol Section */}
            <div className="px-3 py-1.5 bg-surface-light/50 border-b border-border">
              <span className="text-[10px] font-display text-text-muted uppercase tracking-wider">
                Protocol
              </span>
            </div>
            <div className="max-h-36 overflow-y-auto p-1">
              {PROTOCOL_OPTIONS.map((proto) => {
                const isActive = (edgeData.protocol || "") === proto;
                return (
                  <button
                    key={proto || "__none__"}
                    onClick={() => handleProtocolChange(proto)}
                    className={`w-full text-left px-2.5 py-1.5 text-xs font-display rounded-sm transition-colors ${
                      isActive
                        ? "bg-accent-cyan/15 text-accent-cyan"
                        : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
                    }`}
                  >
                    {proto || "None (default)"}
                  </button>
                );
              })}
            </div>

            {/* Direction Section */}
            <div className="px-3 py-1.5 bg-surface-light/50 border-t border-b border-border">
              <span className="text-[10px] font-display text-text-muted uppercase tracking-wider">
                Direction
              </span>
            </div>
            <div className="p-1">
              <button
                onClick={() => handleDirectionChange("unidirectional")}
                className={`w-full text-left px-2.5 py-1.5 text-xs font-display rounded-sm transition-colors ${
                  (edgeData.direction || "unidirectional") === "unidirectional"
                    ? "bg-accent-cyan/15 text-accent-cyan"
                    : "text-text-secondary hover:bg-surface-light"
                }`}
              >
                → Unidirectional
              </button>
              <button
                onClick={() => handleDirectionChange("bidirectional")}
                className={`w-full text-left px-2.5 py-1.5 text-xs font-display rounded-sm transition-colors ${
                  edgeData.direction === "bidirectional"
                    ? "bg-accent-cyan/15 text-accent-cyan"
                    : "text-text-secondary hover:bg-surface-light"
                }`}
              >
                ↔ Bidirectional
              </button>
            </div>

            {/* Animation Toggle */}
            <div className="p-1 border-t border-border">
              <button
                onClick={handleToggleAnimation}
                className={`w-full text-left px-2.5 py-1.5 text-xs font-display rounded-sm transition-colors ${
                  edgeData.animated
                    ? "bg-accent-cyan/15 text-accent-cyan"
                    : "text-text-secondary hover:bg-surface-light"
                }`}
              >
                {edgeData.animated ? "✓ Animated" : "  Animate Flow"}
              </button>
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
