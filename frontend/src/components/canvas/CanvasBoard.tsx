"use client";

import React, { useCallback, useRef, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Connection,
  useReactFlow,
  ConnectionMode,
  getNodesBounds,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import "@xyflow/react/dist/style.css";

import { useBoardStore } from "@/store/boardStore";
import ArchitectureNode from "./ArchitectureNode";
import ArchitectureEdge from "./ArchitectureEdge";
import RemoteCursors from "./RemoteCursors";
import type { ArchNodeData, ArchEdgeData } from "@system-synthesis/shared";

const nodeTypes: NodeTypes = {
  architectureNode: ArchitectureNode as any,
};

const edgeTypes: EdgeTypes = {
  architectureEdge: ArchitectureEdge as any,
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
  cdn: "New CDN",
  firewall: "New Firewall",
  dns: "New DNS",
  proxy: "New Proxy",
  container: "New Container",
  function: "New Function",
  search: "New Search Engine",
  warehouse: "New Data Warehouse",
  stream: "New Stream Processor",
  broker: "New Message Broker",
  auth: "New Auth Provider",
  vault: "New Secrets Vault",
  monitor: "New Monitor",
  registry: "New Service Registry",
  scheduler: "New Scheduler",
};

interface CanvasBoardProps {
  onCursorMove?: (x: number, y: number) => void;
  activeTool?: string;
  pendingNodeType?: string | null;
  onNodePlaced?: () => void;
  onToolReset?: () => void;
}

export default function CanvasBoard({
  onCursorMove,
  activeTool = "select",
  pendingNodeType,
  onNodePlaced,
  onToolReset,
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

  // Filter out corrupted edges that might be stuck in the store from previous bugs
  // React Flow strictly expects sourceHandle to end in '-source' and targetHandle to end in '-target'
  const validEdges = useMemo(() => {
    return edges.filter((e) => {
      if (e.sourceHandle && !e.sourceHandle.endsWith("-source")) return false;
      if (e.targetHandle && !e.targetHandle.endsWith("-target")) return false;
      return true;
    });
  }, [edges]);

  // Validate connections: prevent self-loops and duplicate node pairs
  const isValidConnection = useCallback(
    (connection: Connection | { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      // Prevent self-connection
      if (connection.source === connection.target) return false;

      // Only ONE edge between any two nodes (regardless of handles or direction)
      // This matches how draw.io and Lucidchart work
      const alreadyConnected = validEdges.some(
        (e: any) =>
          (e.source === connection.source && e.target === connection.target) ||
          (e.source === connection.target && e.target === connection.source)
      );
      if (alreadyConnected) return false;

      return true;
    },
    [validEdges]
  );

  // ——— Keyboard shortcuts ———
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";

      // ESC: cancel current tool, return to select mode
      if (e.key === "Escape" && !isTyping) {
        onToolReset?.();
        return;
      }

      // Undo: Ctrl+Z (not while typing)
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && !isTyping) {
        e.preventDefault();
        useBoardStore.getState().undo();
        return;
      }

      // Redo: Ctrl+Shift+Z (not while typing)
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey && !isTyping) {
        e.preventDefault();
        useBoardStore.getState().redo();
        return;
      }

      // Redo: Ctrl+Y (not while typing)
      if ((e.ctrlKey || e.metaKey) && e.key === "y" && !isTyping) {
        e.preventDefault();
        useBoardStore.getState().redo();
        return;
      }

      // Delete selected node or edges
      if (e.key === "Delete" || e.key === "Backspace") {
        if (isTyping) return;

        const state = useBoardStore.getState();
        const selectedId = state.selectedNodeId;

        // Delete selected node first
        if (selectedId) {
          state.deleteNode(selectedId);
          state.setSelectedNodeId(null);
          state.setSidebarMode("none");
          return;
        }

        // Otherwise delete selected edges
        const selectedEdges = state.edges.filter((edge) => edge.selected);
        if (selectedEdges.length > 0) {
          for (const edge of selectedEdges) {
            state.deleteEdge(edge.id);
          }
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToolReset]);

  // ——— Export PNG handler ———
  useEffect(() => {
    function handleExport() {
      if (nodes.length === 0) {
        alert("Board is empty!");
        return;
      }
      
      const nodesBounds = getNodesBounds(nodes);
      // Add padding
      const padding = 50;
      const width = nodesBounds.width + padding * 2;
      const height = nodesBounds.height + padding * 2;

      const viewportEl = document.querySelector(".react-flow__viewport") as HTMLElement;
      if (!viewportEl) return;

      toPng(viewportEl, {
        backgroundColor: "#0A0A0A",
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${-nodesBounds.x + padding}px, ${-nodesBounds.y + padding}px) scale(1)`,
        },
      }).then((dataUrl) => {
        const a = document.createElement("a");
        a.setAttribute("download", "system-architecture.png");
        a.setAttribute("href", dataUrl);
        a.click();
      }).catch((err) => {
        console.error("Export failed", err);
        alert("Failed to export PNG");
      });
    }

    window.addEventListener("export-png", handleExport);
    return () => window.removeEventListener("export-png", handleExport);
  }, [nodes]);

  // ——— Edge update handlers (label + data from ArchitectureEdge) ———
  useEffect(() => {
    function handleLabelUpdate(e: Event) {
      const { edgeId, label } = (e as CustomEvent).detail;
      useBoardStore.getState().updateEdgeData(edgeId, { label });
    }

    function handleDataUpdate(e: Event) {
      const { edgeId, data } = (e as CustomEvent).detail;
      useBoardStore.getState().updateEdgeData(edgeId, data);
    }

    window.addEventListener("edge-label-update", handleLabelUpdate);
    window.addEventListener("edge-data-update", handleDataUpdate);
    return () => {
      window.removeEventListener("edge-label-update", handleLabelUpdate);
      window.removeEventListener("edge-data-update", handleDataUpdate);
    };
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
        edges={validEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        isValidConnection={isValidConnection}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        connectOnClick={isConnectMode}
        nodesDraggable
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={{
          type: "architectureEdge",
          style: { stroke: "var(--color-rf-edge)", strokeWidth: 1.5 },
        }}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--color-grid)"
        />
        <Controls
          showZoom
          showFitView
          showInteractive={false}
          className="!bottom-20"
        />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor="var(--color-surface-lighter)"
          maskColor="var(--color-minimap-mask)"
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
