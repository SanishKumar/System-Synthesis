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

import * as Y from "yjs";

// Track active users per room
const roomUsers = new Map<
  string,
  Map<string, { userName: string; color: string; identityId: string }>
>();

// --- Server-side Yjs Documents per room ---
const roomDocs = new Map<string, Y.Doc>();
const roomCleanupTimers = new Map<string, NodeJS.Timeout>();

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
        const doc = roomDocs.get(boardId);
        if (doc) {
          const nodes = Array.from(doc.getMap<SerializedNode>("nodes").values());
          const edges = Array.from(doc.getMap<SerializedEdge>("edges").values());
          await saveBoardState(boardId, nodes, edges);
          console.log(`  💾 Board "${boardId}" saved (${nodes.length} nodes)`);
        }
      } catch (err: any) {
        console.error(`  ⚠ Save error for "${boardId}":`, err.message);
      }
      saveTimers.delete(boardId);
    }, 5000)
  );
}

/**
 * Schedule room cleanup to free up memory when empty
 */
function scheduleRoomCleanup(boardId: string) {
  const existing = roomCleanupTimers.get(boardId);
  if (existing) clearTimeout(existing);

  roomCleanupTimers.set(
    boardId,
    setTimeout(async () => {
      try {
        const doc = roomDocs.get(boardId);
        if (doc) {
          // Final save before destroy
          const nodes = Array.from(doc.getMap<SerializedNode>("nodes").values());
          const edges = Array.from(doc.getMap<SerializedEdge>("edges").values());
          await saveBoardState(boardId, nodes, edges);
          
          doc.destroy();
          roomDocs.delete(boardId);
          console.log(`  🧹 Cleaned up Y.Doc for "${boardId}"`);
        }
      } catch (err: any) {
        console.error(`  ⚠ Cleanup error for "${boardId}":`, err.message);
      }
      roomCleanupTimers.delete(boardId);
    }, 10000) // 10 seconds wait before GC
  );
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
      let doc = roomDocs.get(boardId);
      if (!doc) {
        doc = new Y.Doc();
        if (board) {
          const nodesMap = doc.getMap<SerializedNode>("nodes");
          const edgesMap = doc.getMap<SerializedEdge>("edges");
          board.nodes.forEach(n => nodesMap.set(n.id, n));
          board.edges.forEach(e => edgesMap.set(e.id, e));
        }
        roomDocs.set(boardId, doc);
      }

      // Cancel any pending cleanup for this room
      const cleanupTimer = roomCleanupTimers.get(boardId);
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        roomCleanupTimers.delete(boardId);
      }

      const userCount = roomUsers.get(boardId)!.size;
      console.log(
        `  📋 ${userName} joined board "${boardId}" (${userCount} user${userCount !== 1 ? "s" : ""})`
      );

      // Send the current metadata, then the full binary Yjs state
      if (board) {
        // Send basic board metadata (for name/id)
        socket.emit("board_state", { id: board.id, name: board.name });
      }
      
      const stateUpdate = Y.encodeStateAsUpdate(doc);
      socket.emit("yjs_full_state", stateUpdate);

      // Notify others in room
      socket.to(boardId).emit("user_joined", {
        userId,
        userName,
        color: userColor,
        connectedAt: new Date().toISOString(),
      });
    });

    // --- yjs_update (binary sync) ---
    socket.on("yjs_update", (payload: { boardId: string; update: Uint8Array }) => {
      // Buffer over socket.io comes as a Node Buffer or Uint8Array
      const updateArray = new Uint8Array(payload.update);
      const doc = roomDocs.get(payload.boardId);
      if (doc) {
        // Apply the incoming update to the server document
        Y.applyUpdate(doc, updateArray);

        // Broadcast to others in room
        socket.to(payload.boardId).emit("yjs_update", {
          update: updateArray,
          userId,
        });

        // Debounced save
        debouncedSave(payload.boardId);
      }
    });

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
          // Cleaned up after 10s by scheduleRoomCleanup
          scheduleRoomCleanup(boardId);
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
            scheduleRoomCleanup(currentBoard);
          }
        }
        socket.to(currentBoard).emit("user_left", userId);
      }
    });
  });
}
