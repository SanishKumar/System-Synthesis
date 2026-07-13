"use client";

import { create } from "zustand";
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";
import type {
  ArchNodeData,
  ArchEdgeData,
  CursorPosition,
  AIAnalysisResult,
  SerializedNode,
  SerializedEdge,
  BoardOperation,
  BoardRole,
  ValidationResult,
} from "@system-synthesis/shared";
import * as Y from "yjs";
import {
  createSharedRecord,
  patchSharedRecord,
  readSharedValue,
  type SharedRecord,
  upsertSharedRecord,
} from "@/lib/yjsGraph";

// ---------- Store Types ----------

interface CursorState {
  userId: string;
  userName: string;
  x: number;
  y: number;
  color: string;
}

interface BoardStore {
  // Board identity
  boardId: string;
  boardName: string;
  boardRole: BoardRole | null;

  // React Flow state
  nodes: Node<ArchNodeData>[];
  edges: Edge<ArchEdgeData>[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Selection
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;

  // Node data mutations
  updateNodeData: (nodeId: string, data: Partial<ArchNodeData>) => void;

  // Layout
  setNodes: (nodes: Node<ArchNodeData>[]) => void;
  setEdges: (edges: Edge<ArchEdgeData>[]) => void;

  // Add node/edge
  addNode: (node: Node<ArchNodeData>) => void;
  addEdgeItem: (edge: Edge<ArchEdgeData>) => void;

  // Edge data mutations
  updateEdgeData: (edgeId: string, data: Partial<import("@system-synthesis/shared").ArchEdgeData>) => void;

  // Delete node/edge
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;

  // Multiplayer
  remoteCursors: CursorState[];
  setRemoteCursors: (cursors: CursorState[]) => void;
  updateRemoteCursor: (cursor: CursorState) => void;
  removeRemoteCursor: (userId: string) => void;

  // Connection state
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;

  // AI Analysis
  aiAnalysis: AIAnalysisResult | null;
  isAnalyzing: boolean;
  setAiAnalysis: (result: AIAnalysisResult | null) => void;
  setIsAnalyzing: (analyzing: boolean) => void;

  // Validation
  validationResult: ValidationResult | null;
  isValidating: boolean;
  setValidationResult: (result: ValidationResult | null) => void;
  setIsValidating: (validating: boolean) => void;

  // Sidebar
  sidebarMode: "none" | "inspector" | "ai-assist" | "version-history";
  setSidebarMode: (mode: "none" | "inspector" | "ai-assist" | "version-history") => void;

  // Serialization helpers
  getSerializedNodes: () => SerializedNode[];
  getSerializedEdges: () => SerializedEdge[];

  // --- Yjs Conflict Resolution ---
  yDoc: Y.Doc | null;
  yNodes: Y.Map<SharedRecord> | null;
  yEdges: Y.Map<SharedRecord> | null;
  undoManager: Y.UndoManager | null;
  initYjs: () => void;
  applyToYjs: (op: BoardOperation) => void;
  applyYjsToLocal: () => void; // Syncs from Yjs -> Zustand when remote update arrives

  // --- Undo / Redo ---
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

// ---------- Helpers ----------

/** Serialize a React Flow node to a SerializedNode */
function serializeNode(n: Node<ArchNodeData>): SerializedNode {
  const serialized: SerializedNode = {
    id: n.id,
    type: n.type || "architectureNode",
    position: n.position,
    data: n.data,
  };
  // Preserve group containment fields
  if ((n as any).parentId) serialized.parentId = (n as any).parentId;
  if ((n as any).extent) serialized.extent = (n as any).extent;
  if (n.style) serialized.style = n.style as Record<string, unknown>;
  return serialized;
}

/** React Flow requires parent nodes to appear before their children in the array */
function sortNodesForReactFlow<T extends { type?: string; parentId?: string; id: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    const aHasParent = !!(a as any).parentId;
    const bHasParent = !!(b as any).parentId;
    if (aHasParent && !bHasParent) return 1; // child comes after non-child
    if (!aHasParent && bHasParent) return -1;
    
    const aIsGroup = a.type === "groupNode";
    const bIsGroup = b.type === "groupNode";
    if (aIsGroup && !bIsGroup) return -1; // groups come before normal nodes
    if (!aIsGroup && bIsGroup) return 1;
    
    return 0;
  });
}

// Track node positions before a drag to detect when a move completes
let dragStartPositions: Map<string, { x: number; y: number }> = new Map();

// ---------- Store ----------

export const useBoardStore = create<BoardStore>((set, get) => ({
  boardId: "",
  boardName: "",
  boardRole: null,

  nodes: [],
  edges: [],

  yDoc: null,
  yNodes: null,
  yEdges: null,
  undoManager: null,

  initYjs: () => {
    const currentDoc = get().yDoc;
    if (currentDoc) {
      currentDoc.destroy();
    }
    const doc = new Y.Doc();
    const yNodes = doc.getMap<SharedRecord>("nodes");
    const yEdges = doc.getMap<SharedRecord>("edges");
    const undoManager = new Y.UndoManager([yNodes, yEdges], {
      trackedOrigins: new Set(["local"]),
      captureTimeout: 250,
    });
    const refreshUndoState = () => {
      set({
        canUndo: undoManager.undoStack.length > 0,
        canRedo: undoManager.redoStack.length > 0,
      });
    };
    undoManager.on("stack-item-added", refreshUndoState);
    undoManager.on("stack-item-popped", refreshUndoState);
    undoManager.on("stack-cleared", refreshUndoState);
    set({
      yDoc: doc,
      yNodes,
      yEdges,
      undoManager,
      nodes: [],
      edges: [],
      canUndo: false,
      canRedo: false,
    });
  },

  applyYjsToLocal: () => {
    const { yNodes, yEdges } = get();
    if (!yNodes || !yEdges) return;
    const nodes = Array.from(yNodes.values()).map(value => {
      const n = readSharedValue<SerializedNode>(value);
      const node: any = {
        id: n.id,
        type: n.type || "architectureNode",
        position: n.position,
        data: n.data,
      };
      if (n.parentId) node.parentId = n.parentId;
      if (n.extent) node.extent = n.extent;
      if (n.style) node.style = n.style;
      if (n.type === "groupNode") node.zIndex = -1;
      return node;
    });
    const edges = Array.from(yEdges.values()).map(value => {
      const e = readSharedValue<SerializedEdge>(value);
      return ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: "architectureEdge" as const,
      data: e.data,
      });
    });
    set({ nodes: sortNodesForReactFlow(nodes), edges });
  },

  applyToYjs: (op) => {
    const { yDoc, yNodes, yEdges } = get();
    if (!yDoc || !yNodes || !yEdges) return;

    yDoc.transact(() => {
      switch (op.op) {
        case "node_created":
          yNodes.set(op.node.id, createSharedRecord(op.node as unknown as Record<string, unknown>));
          break;
        case "node_updated": {
          const n = yNodes.get(op.nodeId);
          const data = n?.get("data");
          if (data instanceof Y.Map) patchSharedRecord(data, op.patch as Record<string, unknown>);
          break;
        }
        case "node_moved": {
          const n = yNodes.get(op.nodeId);
          const position = n?.get("position");
          if (position instanceof Y.Map) patchSharedRecord(position, op.position);
          break;
        }
        case "node_deleted":
          yNodes.delete(op.nodeId);
          Array.from(yEdges.entries()).forEach(([edgeId, value]) => {
            const e = readSharedValue<SerializedEdge>(value);
            if (e.source === op.nodeId || e.target === op.nodeId) yEdges.delete(edgeId);
          });
          break;
        case "edge_created":
          yEdges.set(op.edge.id, createSharedRecord(op.edge as unknown as Record<string, unknown>));
          break;
        case "edge_updated": {
          const e = yEdges.get(op.edgeId);
          if (e) {
            const existingData = e.get("data");
            const dataMap: SharedRecord = existingData instanceof Y.Map
              ? existingData
              : createSharedRecord({});
            if (!(existingData instanceof Y.Map)) e.set("data", dataMap);
            patchSharedRecord(dataMap, op.patch as Record<string, unknown>);
          }
          break;
        }
        case "edge_deleted":
          yEdges.delete(op.edgeId);
          break;
        case "bulk_sync":
          for (const id of yNodes.keys()) {
            if (!op.nodes.some((node) => node.id === id)) yNodes.delete(id);
          }
          for (const id of yEdges.keys()) {
            if (!op.edges.some((edge) => edge.id === id)) yEdges.delete(id);
          }
          op.nodes.forEach((node) =>
            upsertSharedRecord(yNodes, node.id, node as unknown as Record<string, unknown>)
          );
          op.edges.forEach((edge) =>
            upsertSharedRecord(yEdges, edge.id, edge as unknown as Record<string, unknown>)
          );
          break;
      }
    }, "local");
  },

  onNodesChange: (changes) => {
    const prevNodes = get().nodes;

    // Capture positions at drag start
    for (const change of changes) {
      if (change.type === "position" && change.dragging === true) {
        const node = prevNodes.find((n) => n.id === change.id);
        if (node && !dragStartPositions.has(change.id)) {
          dragStartPositions.set(change.id, { ...node.position });
        }
      }
    }

    // Apply changes
    const newNodes = applyNodeChanges(changes, prevNodes) as Node<ArchNodeData>[];
    set({ nodes: sortNodesForReactFlow(newNodes) });

    // Detect drag end — record a node_moved operation
    for (const change of changes) {
      if (change.type === "position" && change.dragging === false) {
        const startPos = dragStartPositions.get(change.id);
        const movedNode = newNodes.find((n) => n.id === change.id);
        if (startPos && movedNode) {
          const dx = Math.abs(movedNode.position.x - startPos.x);
          const dy = Math.abs(movedNode.position.y - startPos.y);
          // Only emit if the node actually moved (not just a click)
          if (dx > 1 || dy > 1) {
            const moveOp: BoardOperation = {
              op: "node_moved",
              nodeId: change.id,
              position: { ...movedNode.position },
            };
            get().applyToYjs(moveOp);
          }
        }
        dragStartPositions.delete(change.id);
      }
    }
  },

  onEdgesChange: (changes) => {
    const prevEdges = get().edges;

    // Detect edge removals before applying
    for (const change of changes) {
      if (change.type === "remove") {
        const edge = prevEdges.find((e) => e.id === change.id);
        if (edge) {
          const deleteOp: BoardOperation = { op: "edge_deleted", edgeId: change.id };
          get().applyToYjs(deleteOp);
        }
      }
    }

    set({ edges: applyEdgeChanges(changes, prevEdges) as Edge<ArchEdgeData>[] });
  },

  onConnect: (connection) => {
    // Guard: prevent self-connections
    if (connection.source === connection.target) return;

    // Guard: prevent duplicate edges — only ONE edge between any node pair
    const existingEdges = get().edges;
    const alreadyConnected = existingEdges.some(
      (e) =>
        (e.source === connection.source && e.target === connection.target) ||
        (e.source === connection.target && e.target === connection.source)
    );
    if (alreadyConnected) return;

    // SANITIZE HANDLES:
    // React Flow requires sourceHandle to be a 'source' type handle, and targetHandle to be a 'target' type handle.
    // Because we use ConnectionMode.Loose and stacked handles, users might drag target-to-target or source-to-source.
    // We seamlessly fix the IDs here so the edge renders correctly without Error 008.
    let { sourceHandle, targetHandle } = connection;
    
    if (sourceHandle) {
      sourceHandle = sourceHandle.replace("-target", "-source");
    }
    if (targetHandle) {
      targetHandle = targetHandle.replace("-source", "-target");
    }

    const newEdge: Edge<ArchEdgeData> = {
      ...connection,
      sourceHandle,
      targetHandle,
      id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: "architectureEdge",
    } as Edge<ArchEdgeData>;

    const createOp: BoardOperation = {
      op: "edge_created",
      edge: {
        id: newEdge.id,
        source: newEdge.source,
        target: newEdge.target,
        sourceHandle: newEdge.sourceHandle ?? undefined,
        targetHandle: newEdge.targetHandle ?? undefined,
        data: newEdge.data,
      },
    };

    get().applyToYjs(createOp);

    set({
      edges: addEdge(newEdge, get().edges) as Edge<ArchEdgeData>[],
    });
  },

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  updateNodeData: (nodeId, data) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const updateOp: BoardOperation = { op: "node_updated", nodeId, patch: data };

    get().applyToYjs(updateOp);

    set({
      nodes: sortNodesForReactFlow(get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ...data } }
          : n
      )),
    });
  },

  setNodes: (nodes) => set({ nodes: sortNodesForReactFlow(nodes) }),
  setEdges: (edges) => set({ edges }),

  addNode: (node) => {
    const createOp: BoardOperation = {
      op: "node_created",
      node: serializeNode(node),
    };
    get().applyToYjs(createOp);

    set({
      nodes: sortNodesForReactFlow([...get().nodes, node]),
    });
  },

  addEdgeItem: (edge) => {
    const createOp: BoardOperation = {
      op: "edge_created",
      edge: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? undefined,
        targetHandle: edge.targetHandle ?? undefined,
        data: edge.data,
      },
    };
    get().applyToYjs(createOp);

    set({
      edges: [...get().edges, edge],
    });
  },

  updateEdgeData: (edgeId, data) => {
    const edge = get().edges.find((e) => e.id === edgeId);
    if (!edge) return;

    const updateOp: BoardOperation = { op: "edge_updated", edgeId, patch: data };

    get().applyToYjs(updateOp);

    set({
      edges: get().edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...e.data, ...data } as ArchEdgeData }
          : e
      ),
    });
  },

  deleteNode: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const deleteOp: BoardOperation = { op: "node_deleted", nodeId };

    get().applyToYjs(deleteOp);

    set({
      nodes: get().nodes.filter((n) => n.id !== nodeId),
      edges: get().edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId
      ),
    });
  },

  deleteEdge: (edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId);
    if (!edge) return;

    const deleteOp: BoardOperation = { op: "edge_deleted", edgeId };
    get().applyToYjs(deleteOp);

    set({
      edges: get().edges.filter((e) => e.id !== edgeId),
    });
  },

  remoteCursors: [],
  setRemoteCursors: (cursors) => set({ remoteCursors: cursors }),
  updateRemoteCursor: (cursor) => {
    set({
      remoteCursors: [
        ...get().remoteCursors.filter((c) => c.userId !== cursor.userId),
        cursor,
      ],
    });
  },
  removeRemoteCursor: (userId) => {
    set({
      remoteCursors: get().remoteCursors.filter((c) => c.userId !== userId),
    });
  },

  isConnected: false,
  setIsConnected: (connected) => set({ isConnected: connected }),

  aiAnalysis: null,
  isAnalyzing: false,
  setAiAnalysis: (result) => set({ aiAnalysis: result }),
  setIsAnalyzing: (analyzing) => set({ isAnalyzing: analyzing }),

  validationResult: null,
  isValidating: false,
  setValidationResult: (result) => set({ validationResult: result }),
  setIsValidating: (validating) => set({ isValidating: validating }),

  sidebarMode: "none",
  setSidebarMode: (mode) => set({ sidebarMode: mode }),

  getSerializedNodes: () =>
    get().nodes.map((n) => serializeNode(n)),

  getSerializedEdges: () =>
    get().edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      data: e.data,
    })),

  // --- Undo / Redo ---
  canUndo: false,
  canRedo: false,

  undo: () => {
    const manager = get().undoManager;
    if (!manager?.canUndo()) return;
    manager.undo();
    get().applyYjsToLocal();
    set({
      canUndo: manager.canUndo(),
      canRedo: manager.canRedo(),
    });
  },

  redo: () => {
    const manager = get().undoManager;
    if (!manager?.canRedo()) return;
    manager.redo();
    get().applyYjsToLocal();
    set({
      canUndo: manager.canUndo(),
      canRedo: manager.canRedo(),
    });
  },
}));
