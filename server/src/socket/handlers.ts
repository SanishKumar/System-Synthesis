import type { Server, Socket } from "socket.io";
import type {
  CursorPosition,
  SerializedNode,
  SerializedEdge,
  ServerToClientEvents,
  ClientToServerEvents,
  BoardOperation,
  BoardState,
} from "@system-synthesis/shared";
import { getBoardState, saveBoardState } from "../services/boardRepository.js";
import { analyzeArchitecture } from "../services/ai.js";
import { verifyToken } from "../middleware/auth.js";
import { shouldThrottleCursor, clearCursorThrottle } from "../middleware/rateLimit.js";
import { v4 as uuid } from "uuid";

// Track active users per room
const roomUsers = new Map<
  string,
  Map<string, { userName: string; color: string; identityId: string }>
>();

// --- Server-side authoritative graph state per room ---
const roomGraphs = new Map<
  string,
  { nodes: SerializedNode[]; edges: SerializedEdge[] }
>();

// Multiplayer cursor colors
const CURSOR_COLORS = [
  "#ebb2ff", // purple
  "#00dbe9", // cyan
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#60a5fa", // blue
  "#f472b6", // pink
  "#a78bfa", // violet
];

function getRandomColor(): string {
  return CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
}

// Debounce save timers per board
const saveTimers = new Map<string, NodeJS.Timeout>();

function debouncedSave(boardId: string) {
  const existing = saveTimers.get(boardId);
  if (existing) clearTimeout(existing);

  saveTimers.set(
    boardId,
    setTimeout(async () => {
      try {
        const graph = roomGraphs.get(boardId);
        if (graph) {
          await saveBoardState(boardId, graph.nodes, graph.edges);
          console.log(`  💾 Board "${boardId}" saved (${graph.nodes.length} nodes)`);
        }
      } catch (err: any) {
        console.error(`  ⚠ Save error for "${boardId}":`, err.message);
      }
      saveTimers.delete(boardId);
    }, 1000)
  );
}

/**
 * Apply a BoardOperation to the server-side authoritative graph.
 * Returns true if the operation was applied successfully.
 */
function applyOperationToGraph(
  boardId: string,
  operation: BoardOperation
): boolean {
  let graph = roomGraphs.get(boardId);
  if (!graph) {
    graph = { nodes: [], edges: [] };
    roomGraphs.set(boardId, graph);
  }

  switch (operation.op) {
    case "node_created": {
      // Don't duplicate if node already exists
      if (graph.nodes.some((n) => n.id === operation.node.id)) return false;
      graph.nodes.push(operation.node);
      return true;
    }
    case "node_updated": {
      const idx = graph.nodes.findIndex((n) => n.id === operation.nodeId);
      if (idx === -1) return false;
      graph.nodes[idx] = {
        ...graph.nodes[idx],
        data: { ...graph.nodes[idx].data, ...operation.patch },
      };
      return true;
    }
    case "node_moved": {
      const idx = graph.nodes.findIndex((n) => n.id === operation.nodeId);
      if (idx === -1) return false;
      graph.nodes[idx] = {
        ...graph.nodes[idx],
        position: operation.position,
      };
      return true;
    }
    case "node_deleted": {
      const prevLen = graph.nodes.length;
      graph.nodes = graph.nodes.filter((n) => n.id !== operation.nodeId);
      // Also remove connected edges
      graph.edges = graph.edges.filter(
        (e) => e.source !== operation.nodeId && e.target !== operation.nodeId
      );
      return graph.nodes.length < prevLen;
    }
    case "edge_created": {
      if (graph.edges.some((e) => e.id === operation.edge.id)) return false;
      graph.edges.push(operation.edge);
      return true;
    }
    case "edge_updated": {
      const idx = graph.edges.findIndex((e) => e.id === operation.edgeId);
      if (idx === -1) return false;
      graph.edges[idx] = {
        ...graph.edges[idx],
        data: { ...graph.edges[idx].data, ...operation.patch },
      };
      return true;
    }
    case "edge_deleted": {
      const prevLen = graph.edges.length;
      graph.edges = graph.edges.filter((e) => e.id !== operation.edgeId);
      return graph.edges.length < prevLen;
    }
    case "bulk_sync": {
      graph.nodes = [...operation.nodes];
      graph.edges = [...operation.edges];
      return true;
    }
  }
}

/**
 * Register all Socket.io event handlers.
 */
export function registerSocketHandlers(io: Server): void {
  // --- Socket.io JWT auth middleware ---
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token && typeof token === "string") {
      const payload = verifyToken(token);
      if (payload) {
        (socket as any).authUser = payload;
        return next();
      }
    }
    // Legacy fallback: accept connections without token (migration period)
    // They'll use socket.handshake.auth.userName / userId
    (socket as any).authUser = null;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const authUser = (socket as any).authUser;
    const userId = socket.id;
    let currentBoard: string | null = null;
    let userName = authUser?.userName || "Anonymous";
    let identityId = authUser?.userId || "";
    let userColor = getRandomColor();

    console.log(`  🔌 Client connected: ${userId}`);

    // --- join_board (with access check) ---
    socket.on("join_board", async (boardId: string, name: string, userIdentityId: string) => {
      // If already in a board, leave it first
      if (currentBoard && currentBoard !== boardId) {
        socket.leave(currentBoard);
        roomUsers.get(currentBoard)?.delete(userId);
        socket.to(currentBoard).emit("user_left", userId);
      }

      currentBoard = boardId;
      userName = name || "Anonymous";
      identityId = userIdentityId || "";

      // Access check: private boards require matching ownerId
      const board = await getBoardState(boardId);
      if (board && !board.isPublic && board.ownerId !== identityId && board.ownerId !== "system") {
        socket.emit("error", "Access denied — this board is private");
        currentBoard = null;
        return;
      }

      // Join Socket.io room
      socket.join(boardId);

      // Track user in room
      if (!roomUsers.has(boardId)) {
        roomUsers.set(boardId, new Map());
      }
      roomUsers.get(boardId)!.set(userId, { userName, color: userColor, identityId });

      // Initialize server-side graph from persisted state (if not already loaded)
      if (!roomGraphs.has(boardId) && board) {
        roomGraphs.set(boardId, {
          nodes: [...board.nodes],
          edges: [...board.edges],
        });
      }

      const userCount = roomUsers.get(boardId)!.size;
      console.log(
        `  📋 ${userName} joined board "${boardId}" (${userCount} user${userCount !== 1 ? "s" : ""})`
      );

      // Send current board state to the joining user
      if (board) {
        socket.emit("board_state", board);
      }

      // Notify others in room
      socket.to(boardId).emit("user_joined", {
        userId,
        userName,
        color: userColor,
        connectedAt: new Date().toISOString(),
      });
    });

    // --- board_operation (NEW: granular operation) ---
    socket.on(
      "board_operation",
      (payload: { boardId: string; operation: BoardOperation }) => {
        // Apply to server-side authoritative graph
        const applied = applyOperationToGraph(payload.boardId, payload.operation);

        if (applied) {
          // Broadcast the operation to all OTHER users in the room
          socket.to(payload.boardId).emit("operation_applied", {
            operation: payload.operation,
            userId,
          });

          // Debounced save to Redis
          debouncedSave(payload.boardId);
        }
      }
    );

    // --- update_nodes (LEGACY: full graph sync — kept for backward compat) ---
    socket.on(
      "update_nodes",
      (payload: {
        boardId: string;
        nodes: SerializedNode[];
        edges: SerializedEdge[];
      }) => {
        // Update server-side graph
        roomGraphs.set(payload.boardId, {
          nodes: [...payload.nodes],
          edges: [...payload.edges],
        });

        // Broadcast to all other users in the room
        socket.to(payload.boardId).emit("nodes_updated", {
          nodes: payload.nodes,
          edges: payload.edges,
          userId,
        });

        // Debounced save to Redis
        debouncedSave(payload.boardId);
      }
    );

    // --- cursor_moved (with server-side throttle guard) ---
    socket.on(
      "cursor_moved",
      (payload: { boardId: string; cursor: CursorPosition }) => {
        // Server-side throttle: max 20 updates/sec per socket
        if (shouldThrottleCursor(userId)) return;

        socket.to(payload.boardId).emit("cursor_moved", {
          ...payload.cursor,
          userId,
          userName,
          color: userColor,
        });
      }
    );

    // --- request_ai_analysis ---
    socket.on(
      "request_ai_analysis",
      async (payload: {
        boardId: string;
        nodes: SerializedNode[];
        edges: SerializedEdge[];
      }) => {
        try {
          console.log(
            `  🤖 AI analysis requested for board "${payload.boardId}"`
          );
          const result = await analyzeArchitecture(
            payload.nodes,
            payload.edges
          );
          socket.emit("ai_analysis_result", result);
        } catch (err: any) {
          socket.emit("error", `AI analysis failed: ${err.message}`);
        }
      }
    );

    // --- leave_board ---
    socket.on("leave_board", (boardId: string) => {
      if (!boardId) return;

      socket.leave(boardId);
      const users = roomUsers.get(boardId);
      if (users) {
        users.delete(userId);
        if (users.size === 0) {
          roomUsers.delete(boardId);
          // Keep the graph in memory for a while in case someone rejoins quickly
          // It will be cleaned up naturally or on next save
        }
      }
      socket.to(boardId).emit("user_left", userId);

      if (userName !== "Anonymous") {
        console.log(`  📋 ${userName} left board "${boardId}"`);
      }

      if (currentBoard === boardId) {
        currentBoard = null;
      }
    });

    // --- disconnect ---
    socket.on("disconnect", () => {
      // Clean up cursor throttle state
      clearCursorThrottle(userId);

      if (userName !== "Anonymous") {
        console.log(`  🔌 Client disconnected: ${userId} (${userName})`);
      }

      if (currentBoard) {
        const users = roomUsers.get(currentBoard);
        if (users) {
          users.delete(userId);
          if (users.size === 0) {
            roomUsers.delete(currentBoard);
          }
        }
        socket.to(currentBoard).emit("user_left", userId);
      }
    });
  });
}
