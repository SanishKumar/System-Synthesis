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
} from "@system-synthesis/shared";

// ---------- Demo Data ----------

const initialNodes: Node<ArchNodeData>[] = [
  {
    id: "gateway-1",
    type: "architectureNode",
    position: { x: 350, y: 50 },
    data: {
      label: "API Gateway",
      subtitle: "Kong / Nginx\nRate Limit: 10k/min",
      nodeType: "gateway",
      status: "active",
      metadata: {
        notes: "Main entry point for all client requests. Handles SSL termination and rate limiting.",
        links: ["https://docs.konghq.com"],
        codeSnippet: `server {
  listen 443 ssl;
  location /api {
    proxy_pass http://backend;
  }
}`,
        attachedFiles: [],
      },
    },
  },
  {
    id: "auth-1",
    type: "architectureNode",
    position: { x: 100, y: 220 },
    data: {
      label: "Auth Service",
      subtitle: "Node.js / Express\nPods: 3/3",
      nodeType: "service",
      status: "active",
      metadata: {
        notes: "JWT-based authentication service. Handles user login, registration, and token refresh.",
        links: [],
        codeSnippet: `app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findByEmail(email);
  const token = jwt.sign({ id: user.id }, SECRET);
  res.json({ token });
});`,
        attachedFiles: [],
      },
    },
  },
  {
    id: "user-db",
    type: "architectureNode",
    position: { x: 100, y: 420 },
    data: {
      label: "User DB",
      subtitle: "PostgreSQL v14\nReplica: Active",
      nodeType: "database",
      status: "active",
      metadata: {
        notes: "Primary user database with read replicas. Stores user profiles, credentials, and session data.",
        links: [],
        codeSnippet: "",
        attachedFiles: [],
      },
    },
  },
  {
    id: "api-1",
    type: "architectureNode",
    position: { x: 550, y: 220 },
    data: {
      label: "Core API",
      subtitle: "Node.js / Fastify\nPods: 5/5",
      nodeType: "service",
      status: "active",
      metadata: {
        notes: "Main business logic service. Handles all CRUD operations for the platform.",
        links: ["https://www.fastify.io/docs/latest/"],
        codeSnippet: "",
        attachedFiles: [],
      },
    },
  },
  {
    id: "cache-1",
    type: "architectureNode",
    position: { x: 550, y: 420 },
    data: {
      label: "Redis Cache",
      subtitle: "Redis 7.2\nMemory: 2.1GB/4GB",
      nodeType: "cache",
      status: "active",
      metadata: {
        notes: "Session cache and API response caching layer. TTL: 15min for most keys.",
        links: [],
        codeSnippet: "",
        attachedFiles: [],
      },
    },
  },
  {
    id: "queue-1",
    type: "architectureNode",
    position: { x: 350, y: 420 },
    data: {
      label: "Message Queue",
      subtitle: "RabbitMQ\nQueues: 12 active",
      nodeType: "queue",
      status: "active",
      metadata: {
        notes: "Async job processing for emails, notifications, and background tasks.",
        links: [],
        codeSnippet: "",
        attachedFiles: [],
      },
    },
  },
];

const initialEdges: Edge<ArchEdgeData>[] = [
  {
    id: "e-gw-auth",
    source: "gateway-1",
    target: "auth-1",
    type: "smoothstep",
    animated: true,
    style: { stroke: "#333", strokeDasharray: "5 5" },
  },
  {
    id: "e-gw-api",
    source: "gateway-1",
    target: "api-1",
    type: "smoothstep",
    animated: true,
    style: { stroke: "#333", strokeDasharray: "5 5" },
  },
  {
    id: "e-auth-db",
    source: "auth-1",
    target: "user-db",
    type: "smoothstep",
    style: { stroke: "#444" },
  },
  {
    id: "e-api-cache",
    source: "api-1",
    target: "cache-1",
    type: "smoothstep",
    style: { stroke: "#444" },
  },
  {
    id: "e-api-queue",
    source: "api-1",
    target: "queue-1",
    type: "smoothstep",
    style: { stroke: "#444" },
  },
];

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

  // Add node
  addNode: (node: Node<ArchNodeData>) => void;

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

  // Sidebar
  sidebarMode: "none" | "inspector" | "ai-assist";
  setSidebarMode: (mode: "none" | "inspector" | "ai-assist") => void;

  // Serialization helpers
  getSerializedNodes: () => SerializedNode[];
  getSerializedEdges: () => SerializedEdge[];
}

// ---------- Store ----------

export const useBoardStore = create<BoardStore>((set, get) => ({
  boardId: "",
  boardName: "",

  nodes: [],
  edges: [],

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as Node<ArchNodeData>[] });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) as Edge<ArchEdgeData>[] });
  },

  onConnect: (connection) => {
    set({
      edges: addEdge(
        {
          ...connection,
          type: "smoothstep",
          style: { stroke: "#444" },
        },
        get().edges
      ) as Edge<ArchEdgeData>[],
    });
  },

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  updateNodeData: (nodeId, data) => {
    set({
      nodes: get().nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      ),
    });
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  addNode: (node) => set({ nodes: [...get().nodes, node] }),

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
}));
