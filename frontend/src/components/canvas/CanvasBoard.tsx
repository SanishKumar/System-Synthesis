"use client";

import React, { useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type Node,
  useReactFlow,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useBoardStore } from "@/store/boardStore";
import ArchitectureNode from "./ArchitectureNode";
import RemoteCursors from "./RemoteCursors";
import type { ArchNodeData } from "@system-synthesis/shared";

const nodeTypes: NodeTypes = {
  architectureNode: ArchitectureNode as any,
};

const NODE_TYPE_LABELS: Record<string, string> = {
  service: "New Service",
  database: "New Database",
  gateway: "New Gateway",
  queue: "New Queue",
  cache: "New Cache",
  client: "New Client",
  loadbalancer: "New Load Balancer",
  storage: "New Storage",
};

interface CanvasBoardProps {
  onCursorMove?: (x: number, y: number) => void;
  activeTool?: string;
  pendingNodeType?: string | null;
  onNodePlaced?: () => void;
}

export default function CanvasBoard({
  onCursorMove,
  activeTool = "select",
  pendingNodeType,
  onNodePlaced,
}: CanvasBoardProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useReactFlow();
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setSelectedNodeId,
    selectedNodeId,
    setSidebarMode,
    sidebarMode,
    remoteCursors,
    addNode,
    setNodes,
    setEdges,
  } = useBoardStore();

  // ——— Delete key handler ———
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        // Don't delete if user is typing in an input
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;

        const state = useBoardStore.getState();
        const selectedId = state.selectedNodeId;
        if (selectedId) {
          // Remove the node and any connected edges
          state.setNodes(state.nodes.filter((n) => n.id !== selectedId));
          state.setEdges(
            state.edges.filter(
              (e) => e.source !== selectedId && e.target !== selectedId
            )
          );
          state.setSelectedNodeId(null);
          state.setSidebarMode("none");
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id);
      setSidebarMode("inspector");
    },
    [setSelectedNodeId, setSidebarMode]
  );

  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      // If we have a pending node type (shapes tool), place it at click location
      if (activeTool === "shapes" && pendingNodeType) {
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        const newNode: Node<ArchNodeData> = {
          id: `node-${Date.now()}`,
          type: "architectureNode",
          position,
          data: {
            label: NODE_TYPE_LABELS[pendingNodeType] || `New ${pendingNodeType}`,
            subtitle: "Click to configure",
            nodeType: pendingNodeType as any,
            status: "inactive",
            metadata: {
              notes: "",
              links: [],
              codeSnippet: "",
              attachedFiles: [],
            },
          },
        };

        addNode(newNode);
        onNodePlaced?.();
        return;
      }

      // Text tool — place a text-like node with distinct visual
      if (activeTool === "text") {
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        const newNode: Node<ArchNodeData> = {
          id: `node-${Date.now()}`,
          type: "architectureNode",
          position,
          data: {
            label: "Text Label",
            subtitle: "Double-click to edit",
            nodeType: "client",
            status: "inactive",
            metadata: {
              notes: "",
              links: [],
              codeSnippet: "",
              attachedFiles: [],
            },
          },
        };

        addNode(newNode);
        onNodePlaced?.();
        return;
      }

      // Default: deselect
      setSelectedNodeId(null);
      if (sidebarMode === "inspector") {
        setSidebarMode("none");
      }
    },
    [
      setSelectedNodeId,
      setSidebarMode,
      sidebarMode,
      activeTool,
      pendingNodeType,
      addNode,
      onNodePlaced,
      reactFlowInstance,
    ]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!onCursorMove || !reactFlowWrapper.current) return;
      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      onCursorMove(event.clientX - bounds.left, event.clientY - bounds.top);
    },
    [onCursorMove]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData("application/reactflow");
      if (!type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node<ArchNodeData> = {
        id: `node-${Date.now()}`,
        type: "architectureNode",
        position,
        data: {
          label: NODE_TYPE_LABELS[type] || `New ${type}`,
          subtitle: "Click to configure",
          nodeType: type as any,
          status: "inactive",
          metadata: {
            notes: "",
            links: [],
            codeSnippet: "",
            attachedFiles: [],
          },
        },
      };

      addNode(newNode);
    },
    [addNode, reactFlowInstance]
  );

  // Cursor style based on active tool
  const cursorClass =
    activeTool === "shapes" && pendingNodeType
      ? "cursor-crosshair"
      : activeTool === "draw"
      ? "cursor-crosshair"
      : activeTool === "text"
      ? "cursor-text"
      : "";

  // In Connect mode: enable connectOnClick so clicking a node starts edge drawing,
  // and disable node dragging so drag = connection instead of move
  const isConnectMode = activeTool === "draw";

  return (
    <div
      ref={reactFlowWrapper}
      className={`w-full h-full canvas-grid ${cursorClass}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseMove={handleMouseMove}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        connectOnClick={isConnectMode}
        nodesDraggable={!isConnectMode}
        connectionMode={
          isConnectMode ? ConnectionMode.Loose : ConnectionMode.Strict
        }
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { stroke: "#333", strokeWidth: 1.5 },
        }}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#262626"
        />
        <Controls
          showZoom
          showFitView
          showInteractive={false}
          className="!bottom-20"
        />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor="#1a1c1c"
          maskColor="rgba(5, 5, 5, 0.8)"
          className="!bg-surface !border-border !rounded-md"
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>

      {/* Connect mode indicator */}
      {isConnectMode && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 px-4 py-1.5 bg-accent-cyan/15 border border-accent-cyan/40 rounded-sm text-xs font-display text-accent-cyan animate-fade-in">
          Click a node handle to start drawing an edge · Press ESC to cancel
        </div>
      )}

      {/* Remote Cursors Overlay */}
      <RemoteCursors
        cursors={remoteCursors.map((c) => ({
          userId: c.userId,
          userName: c.userName,
          x: c.x,
          y: c.y,
          color: c.color,
        }))}
      />
    </div>
  );
}
