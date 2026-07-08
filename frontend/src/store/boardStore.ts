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
  ValidationResult,
} from "@system-synthesis/shared";
import * as Y from "yjs";

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
  yNodes: Y.Map<SerializedNode> | null;
  yEdges: Y.Map<SerializedEdge> | null;
  initYjs: () => void;
  applyToYjs: (op: BoardOperation) => void;
  applyYjsToLocal: () => void; // Syncs from Yjs -> Zustand when remote update arrives

  // --- Undo / Redo ---
  undoStack: BoardOperation[];
  redoStack: BoardOperation[];
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

// ---------- Helpers ----------

/** Serialize a React Flow node to a SerializedNode */
function serializeNode(n: Node<ArchNodeData>): SerializedNode {
  return {
    id: n.id,
    type: n.type || "architectureNode",
    position: n.position,
    data: n.data,
  };
}

/** Compute the inverse of an operation (for undo) */
function invertOperation(op: BoardOperation, state: BoardStore): BoardOperation | null {
  switch (op.op) {
    case "node_created": {
      return { op: "node_deleted", nodeId: op.node.id };
    }
    case "node_deleted": {
      const node = state.nodes.find((n) => n.id === op.nodeId);
      if (!node) return null;
      return { op: "node_created", node: serializeNode(node) };
    }
    case "node_moved": {
      const node = state.nodes.find((n) => n.id === op.nodeId);
      if (!node) return null;
      return { op: "node_moved", nodeId: op.nodeId, position: { ...node.position } };
    }
    case "node_updated": {
      const node = state.nodes.find((n) => n.id === op.nodeId);
      if (!node) return null;
      // Store the original values for every key in the patch
      const reversePatch: Partial<ArchNodeData> = {};
      for (const key of Object.keys(op.patch)) {
        (reversePatch as any)[key] = (node.data as any)[key];
      }
      return { op: "node_updated", nodeId: op.nodeId, patch: reversePatch };
    }
    case "edge_created": {
      return { op: "edge_deleted", edgeId: op.edge.id };
    }
    case "edge_updated": {
      const edge = state.edges.find((e) => e.id === op.edgeId);
      if (!edge) return null;
      const reversePatch: Partial<ArchEdgeData> = {};
      for (const key of Object.keys(op.patch)) {
        (reversePatch as any)[key] = (edge.data as any)?.[key];
      }
      return { op: "edge_updated", edgeId: op.edgeId, patch: reversePatch };
    }
    case "edge_deleted": {
      const edge = state.edges.find((e) => e.id === op.edgeId);
      if (!edge) return null;
      return {
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
    }
    case "bulk_sync":
      // Can't invert a full sync — just ignore
      return null;
  }
}

/** Apply a single operation to the store state (mutates nodes/edges in place via set) */
function applyOperation(
  op: BoardOperation,
  get: () => BoardStore,
  set: (partial: Partial<BoardStore>) => void
) {
  switch (op.op) {
    case "node_created": {
      const newNode: Node<ArchNodeData> = {
        id: op.node.id,
        type: op.node.type || "architectureNode",
        position: op.node.position,
        data: op.node.data,
      };
      set({ nodes: [...get().nodes, newNode] });
      break;
    }
    case "node_updated": {
      set({
        nodes: get().nodes.map((n) =>
          n.id === op.nodeId
            ? { ...n, data: { ...n.data, ...op.patch } }
            : n
        ),
      });
      break;
    }
    case "node_moved": {
      set({
        nodes: get().nodes.map((n) =>
          n.id === op.nodeId
            ? { ...n, position: op.position }
            : n
        ),
      });
      break;
    }
    case "node_deleted": {
      set({
        nodes: get().nodes.filter((n) => n.id !== op.nodeId),
        edges: get().edges.filter(
          (e) => e.source !== op.nodeId && e.target !== op.nodeId
        ),
      });
      break;
    }
    case "edge_created": {
      const newEdge: Edge<ArchEdgeData> = {
        id: op.edge.id,
        source: op.edge.source,
        target: op.edge.target,
        sourceHandle: op.edge.sourceHandle,
        targetHandle: op.edge.targetHandle,
        type: "architectureEdge",
        data: op.edge.data,
      };
      set({ edges: [...get().edges, newEdge] });
      break;
    }
    case "edge_updated": {
      set({
        edges: get().edges.map((e) =>
          e.id === op.edgeId
            ? { ...e, data: { ...e.data, ...op.patch } as ArchEdgeData }
            : e
        ),
      });
      break;
    }
    case "edge_deleted": {
      set({
        edges: get().edges.filter((e) => e.id !== op.edgeId),
      });
      break;
    }
    case "bulk_sync": {
      const newNodes = op.nodes.map((n) => ({
        id: n.id,
        type: n.type || "architectureNode",
        position: n.position,
        data: n.data,
      }));
      const newEdges = op.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "architectureEdge" as const,
        data: e.data,
      }));
      set({ nodes: newNodes, edges: newEdges });
      break;
    }
  }
}

// Track node positions before a drag to detect when a move completes
let dragStartPositions: Map<string, { x: number; y: number }> = new Map();

// ---------- Store ----------

export const useBoardStore = create<BoardStore>((set, get) => ({
  boardId: "",
  boardName: "",

  nodes: [],
  edges: [],

  yDoc: null,
  yNodes: null,
  yEdges: null,

  initYjs: () => {
    const currentDoc = get().yDoc;
    if (currentDoc) {
      currentDoc.destroy();
    }
    const doc = new Y.Doc();
    set({
      yDoc: doc,
      yNodes: doc.getMap<SerializedNode>("nodes"),
      yEdges: doc.getMap<SerializedEdge>("edges"),
      nodes: [],
      edges: []
    });
  },

  applyYjsToLocal: () => {
    const { yNodes, yEdges } = get();
    if (!yNodes || !yEdges) return;
    const nodes = Array.from(yNodes.values()).map(n => ({
      id: n.id,
      type: n.type || "architectureNode",
      position: n.position,
      data: n.data,
    }));
    const edges = Array.from(yEdges.values()).map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: "architectureEdge" as const,
      data: e.data,
    }));
    set({ nodes, edges });
  },

  applyToYjs: (op) => {
    const { yDoc, yNodes, yEdges } = get();
    if (!yDoc || !yNodes || !yEdges) return;

    yDoc.transact(() => {
      switch (op.op) {
        case "node_created":
          yNodes.set(op.node.id, op.node);
          break;
        case "node_updated":
        case "node_moved": {
          const n = yNodes.get(op.nodeId);
          if (n) {
            yNodes.set(op.nodeId, op.op === "node_updated" ? { ...n, data: { ...n.data, ...op.patch } } : { ...n, position: op.position });
          }
          break;
        }
        case "node_deleted":
          yNodes.delete(op.nodeId);
          Array.from(yEdges.values()).forEach(e => {
            if (e.source === op.nodeId || e.target === op.nodeId) yEdges.delete(e.id);
          });
          break;
        case "edge_created":
          yEdges.set(op.edge.id, op.edge);
          break;
        case "edge_updated": {
          const e = yEdges.get(op.edgeId);
          if (e) yEdges.set(op.edgeId, { ...e, data: { ...e.data, ...op.patch } });
          break;
        }
        case "edge_deleted":
          yEdges.delete(op.edgeId);
          break;
        case "bulk_sync":
          Array.from(yNodes.keys()).forEach(k => yNodes.delete(k));
          Array.from(yEdges.keys()).forEach(k => yEdges.delete(k));
          op.nodes.forEach(n => yNodes.set(n.id, n));
          op.edges.forEach(e => yEdges.set(e.id, e));
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
    set({ nodes: newNodes });

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
            // Record inverse (original position) for undo
            const inverseOp: BoardOperation = {
              op: "node_moved",
              nodeId: change.id,
              position: startPos,
            };
            get().applyToYjs(moveOp);
            set({
              undoStack: [...get().undoStack, inverseOp],
              redoStack: [],
              canUndo: true,
              canRedo: false,
            });
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
          const inverseOp: BoardOperation = {
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
          get().applyToYjs(deleteOp);
          set({
            undoStack: [...get().undoStack, inverseOp],
            redoStack: [],
            canUndo: true,
            canRedo: false,
          });
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
      undoStack: [...get().undoStack, { op: "edge_deleted", edgeId: newEdge.id }],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });
  },

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  updateNodeData: (nodeId, data) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    // Compute inverse patch
    const reversePatch: Partial<ArchNodeData> = {};
    for (const key of Object.keys(data)) {
      (reversePatch as any)[key] = (node.data as any)[key];
    }

    const updateOp: BoardOperation = { op: "node_updated", nodeId, patch: data };
    const inverseOp: BoardOperation = { op: "node_updated", nodeId, patch: reversePatch };

    get().applyToYjs(updateOp);

    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ...data } }
          : n
      ),
      undoStack: [...get().undoStack, inverseOp],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  addNode: (node) => {
    const createOp: BoardOperation = {
      op: "node_created",
      node: serializeNode(node),
    };
    const inverseOp: BoardOperation = { op: "node_deleted", nodeId: node.id };

    get().applyToYjs(createOp);

    set({
      nodes: [...get().nodes, node],
      undoStack: [...get().undoStack, inverseOp],
      redoStack: [],
      canUndo: true,
      canRedo: false,
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
    const inverseOp: BoardOperation = { op: "edge_deleted", edgeId: edge.id };

    get().applyToYjs(createOp);

    set({
      edges: [...get().edges, edge],
      undoStack: [...get().undoStack, inverseOp],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });
  },

  updateEdgeData: (edgeId, data) => {
    const edge = get().edges.find((e) => e.id === edgeId);
    if (!edge) return;

    // Compute inverse patch
    const reversePatch: Partial<ArchEdgeData> = {};
    for (const key of Object.keys(data)) {
      (reversePatch as any)[key] = (edge.data as any)?.[key];
    }

    const updateOp: BoardOperation = { op: "edge_updated", edgeId, patch: data };
    const inverseOp: BoardOperation = { op: "edge_updated", edgeId, patch: reversePatch };

    get().applyToYjs(updateOp);

    set({
      edges: get().edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...e.data, ...data } as ArchEdgeData }
          : e
      ),
      undoStack: [...get().undoStack, inverseOp],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });
  },

  deleteNode: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const connectedEdges = get().edges.filter(
      (e) => e.source === nodeId || e.target === nodeId
    );

    const deleteOp: BoardOperation = { op: "node_deleted", nodeId };
    // Inverse: recreate the node (connected edges will be handled as separate ops)
    const inverseOp: BoardOperation = {
      op: "node_created",
      node: serializeNode(node),
    };

    // Also record edge deletion ops
    const edgeDeleteOps: BoardOperation[] = connectedEdges.map((e) => ({
      op: "edge_deleted" as const,
      edgeId: e.id,
    }));
    const edgeInverseOps: BoardOperation[] = connectedEdges.map((e) => ({
      op: "edge_created" as const,
      edge: {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        data: e.data,
      },
    }));

    get().applyToYjs(deleteOp);
    edgeDeleteOps.forEach(op => get().applyToYjs(op));

    set({
      nodes: get().nodes.filter((n) => n.id !== nodeId),
      edges: get().edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId
      ),
      undoStack: [...get().undoStack, ...edgeInverseOps, inverseOp],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    });
  },

  deleteEdge: (edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId);
    if (!edge) return;

    const deleteOp: BoardOperation = { op: "edge_deleted", edgeId };
    const inverseOp: BoardOperation = {
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

    get().applyToYjs(deleteOp);

    set({
      edges: get().edges.filter((e) => e.id !== edgeId),
      undoStack: [...get().undoStack, inverseOp],
      redoStack: [],
      canUndo: true,
      canRedo: false,
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
    get().nodes.map((n) => ({
      id: n.id,
      type: n.type || "architectureNode",
      position: n.position,
      data: n.data,
    })),

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
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  undo: () => {
    const stack = get().undoStack;
    if (stack.length === 0) return;

    const inverseOp = stack[stack.length - 1];

    // Compute the forward op (to push to redo) BEFORE applying the inverse
    const forwardOp = invertOperation(inverseOp, get());

    // Apply the inverse operation locally
    applyOperation(inverseOp, get, set);
    get().applyToYjs(inverseOp);

    // Also emit the inverse op to sync with other clients
    const newUndoStack = stack.slice(0, -1);
    const newRedoStack = forwardOp
      ? [...get().redoStack, forwardOp]
      : get().redoStack;

    set({
      undoStack: newUndoStack,
      redoStack: newRedoStack,
      canUndo: newUndoStack.length > 0,
      canRedo: newRedoStack.length > 0,
    });
  },

  redo: () => {
    const stack = get().redoStack;
    if (stack.length === 0) return;

    const forwardOp = stack[stack.length - 1];

    // Compute inverse (to push back to undo) BEFORE applying
    const inverseOp = invertOperation(forwardOp, get());

    // Apply the forward operation locally
    applyOperation(forwardOp, get, set);
    get().applyToYjs(forwardOp);

    const newRedoStack = stack.slice(0, -1);
    const newUndoStack = inverseOp
      ? [...get().undoStack, inverseOp]
      : get().undoStack;

    set({
      undoStack: newUndoStack,
      redoStack: newRedoStack,
      canUndo: newUndoStack.length > 0,
      canRedo: newRedoStack.length > 0,
    });
  },
}));
