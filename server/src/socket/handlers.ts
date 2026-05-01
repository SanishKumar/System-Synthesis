import type { Server, Socket } from "socket.io";
import type {
  CursorPosition,
  SerializedNode,
  SerializedEdge,
  ServerToClientEvents,
  ClientToServerEvents,
} from "@system-synthesis/shared";
import { getBoardState, saveBoardState } from "../services/redis.js";
import { analyzeArchitecture } from "../services/ai.js";
import { v4 as uuid } from "uuid";

// Track active users per room
const roomUsers = new Map<
  string,
  Map<string, { userName: string; color: string; identityId: string }>
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

function debouncedSave(
  boardId: string,
  nodes: SerializedNode[],
  edges: SerializedEdge[]
) {
  const existing = saveTimers.get(boardId);
  if (existing) clearTimeout(existing);

  saveTimers.set(
    boardId,
    setTimeout(async () => {
      try {
        await saveBoardState(boardId, nodes, edges);
        console.log(`  💾 Board "${boardId}" saved (${nodes.length} nodes)`);
      } catch (err: any) {
        console.error(`  ⚠ Save error for "${boardId}":`, err.message);
      }
      saveTimers.delete(boardId);
    }, 1000)
  );
}

/**
 * Register all Socket.io event handlers.
 */
export function registerSocketHandlers(io: Server): void {
  io.on("connection", (socket: Socket) => {
    const userId = socket.id;
    let currentBoard: string | null = null;
    let userName = "Anonymous";
    let identityId = "";
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

    // --- update_nodes ---
    socket.on(
      "update_nodes",
      (payload: {
        boardId: string;
        nodes: SerializedNode[];
        edges: SerializedEdge[];
      }) => {
        // Broadcast to all other users in the room
        socket.to(payload.boardId).emit("nodes_updated", {
          nodes: payload.nodes,
          edges: payload.edges,
          userId,
        });

        // Debounced save to Redis
        debouncedSave(payload.boardId, payload.nodes, payload.edges);
      }
    );

    // --- cursor_moved ---
    socket.on(
      "cursor_moved",
      (payload: { boardId: string; cursor: CursorPosition }) => {
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
