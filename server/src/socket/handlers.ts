import type { Server, Socket } from "socket.io";
import type {
  BoardRole,
  BoardState,
  CursorPosition,
  SerializedEdge,
  SerializedNode,
} from "@system-synthesis/shared";
import { z } from "zod";
import * as Y from "yjs";
import { getBoardState, saveBoardState } from "../services/boardRepository.js";
import { analyzeArchitecture } from "../services/ai.js";
import { verifyToken, type JwtPayload } from "../middleware/auth.js";
import {
  clearCursorThrottle,
  shouldThrottleCursor,
  shouldThrottleSocketEvent,
} from "../middleware/rateLimit.js";
import {
  recordAudit,
  resolveBoardRole,
  roleAllows,
} from "../services/accessControl.js";
import {
  initializeGraphDoc,
  serializeGraphDoc,
} from "../services/yjsGraph.js";
import {
  appendCollaborationUpdate,
  compactCollaborationDocument,
  ensureCollaborationSnapshot,
  replayCollaborationUpdates,
} from "../services/collaborationUpdates.js";

export const MAX_YJS_UPDATE_BYTES = 128 * 1024;

const boardIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid board identifier");

const joinBoardSchema = z.object({ boardId: boardIdSchema });
const yjsUpdateSchema = z
  .object({
    boardId: boardIdSchema,
    update: z.union([
      z.instanceof(Uint8Array),
      z.array(z.number().int().min(0).max(255)).max(MAX_YJS_UPDATE_BYTES),
    ]),
  })
  .superRefine((payload, context) => {
    if (payload.update.length > MAX_YJS_UPDATE_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_YJS_UPDATE_BYTES,
        inclusive: true,
        type: "array",
        message: "Yjs update exceeds the maximum payload size",
      });
    }
  });
const cursorSchema = z.object({
  boardId: boardIdSchema,
  cursor: z.object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  }),
});
const analysisSchema = z.object({ boardId: boardIdSchema });

type RoomUser = {
  userName: string;
  color: string;
  userId: string;
  role: BoardRole;
};

const roomUsers = new Map<string, Map<string, RoomUser>>();
const roomDocs = new Map<string, Y.Doc>();
const roomLoadPromises = new Map<string, Promise<Y.Doc>>();
const roomCleanupTimers = new Map<string, NodeJS.Timeout>();
const saveTimers = new Map<string, NodeJS.Timeout>();

/** Apply a pub/sub update to this process's loaded authoritative document. */
export function applyRemoteCollaborationUpdate(
  boardId: string,
  update: Uint8Array,
  actorId: string
): boolean {
  const doc = roomDocs.get(boardId);
  if (!doc) return false;
  Y.applyUpdate(doc, update, "remote-server");
  debouncedSave(boardId, actorId);
  return true;
}

/** Read the current authoritative in-process graph for REST checkpoints. */
export function getLoadedCollaborationState(boardId: string): {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
} | null {
  const doc = roomDocs.get(boardId);
  return doc ? serializeGraphDoc(doc) : null;
}

/** Replay the durable tail into every loaded room after transport recovery. */
export async function reconcileLoadedCollaborationDocuments(): Promise<number> {
  let reconciled = 0;
  for (const [boardId, doc] of roomDocs.entries()) {
    await replayCollaborationUpdates(boardId, doc);
    debouncedSave(boardId, "durable-reconciliation");
    reconciled += 1;
  }
  return reconciled;
}

const CURSOR_COLORS = [
  "#6c4ff7",
  "#218a69",
  "#b7791f",
  "#c84f64",
  "#4f6eb6",
  "#8b6ff7",
];

function getRandomColor(): string {
  return CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
}

async function getOrLoadRoomDoc(board: BoardState): Promise<Y.Doc> {
  const loaded = roomDocs.get(board.id);
  if (loaded) return loaded;
  const loading = roomLoadPromises.get(board.id);
  if (loading) return loading;

  const promise = (async () => {
    const doc = new Y.Doc();
    // Publish the doc before replay so live pub/sub updates cannot fall into a
    // gap between the durable range read and installing the in-memory state.
    roomDocs.set(board.id, doc);
    try {
      const replayed = await replayCollaborationUpdates(board.id, doc);
      if (replayed === 0) {
        const fallback = new Y.Doc();
        initializeGraphDoc(fallback, board.nodes, board.edges);
        const canonicalBase = await ensureCollaborationSnapshot(board.id, fallback);
        fallback.destroy();
        Y.applyUpdate(doc, canonicalBase, "canonical-base");
      }
      return doc;
    } catch (error) {
      roomDocs.delete(board.id);
      doc.destroy();
      throw error;
    } finally {
      roomLoadPromises.delete(board.id);
    }
  })();
  roomLoadPromises.set(board.id, promise);
  return promise;
}

function serializeDoc(doc: Y.Doc): {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
} {
  return serializeGraphDoc(doc);
}

function debouncedSave(boardId: string, actorId: string) {
  const existing = saveTimers.get(boardId);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    boardId,
    setTimeout(async () => {
      try {
        const doc = roomDocs.get(boardId);
        if (doc) {
          const { nodes, edges } = serializeDoc(doc);
          await saveBoardState(boardId, nodes, edges, actorId);
        }
      } finally {
        saveTimers.delete(boardId);
      }
    }, 1500)
  );
}

function scheduleRoomCleanup(boardId: string) {
  const existing = roomCleanupTimers.get(boardId);
  if (existing) clearTimeout(existing);
  roomCleanupTimers.set(
    boardId,
    setTimeout(async () => {
      try {
        const doc = roomDocs.get(boardId);
        if (doc) {
          const { nodes, edges } = serializeDoc(doc);
          await saveBoardState(boardId, nodes, edges);
          await compactCollaborationDocument(boardId, doc);
          doc.destroy();
          roomDocs.delete(boardId);
        }
      } finally {
        roomCleanupTimers.delete(boardId);
      }
    }, 10_000)
  );
}

function emitError(socket: Socket, message: string): void {
  socket.emit("error", message);
}

export function registerSocketHandlers(io: Server): void {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") return next(new Error("Authentication required"));
    const payload = verifyToken(token);
    if (!payload) return next(new Error("Invalid or expired token"));
    (socket as Socket & { authUser: JwtPayload }).authUser = payload;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const authUser = (socket as Socket & { authUser: JwtPayload }).authUser;
    const socketId = socket.id;
    const userId = authUser.userId;
    const userName = authUser.userName;
    socket.data.userId = userId;
    socket.data.userName = userName;
    const userColor = getRandomColor();
    let currentBoard: string | null = null;
    let currentRole: BoardRole | null = null;

    const leaveCurrentBoard = (boardId: string) => {
      if (currentBoard !== boardId) return;
      socket.leave(boardId);
      const users = roomUsers.get(boardId);
      users?.delete(socketId);
      if (users?.size === 0) {
        roomUsers.delete(boardId);
        scheduleRoomCleanup(boardId);
      }
      socket.to(boardId).emit("user_left", socketId);
      currentBoard = null;
      currentRole = null;
    };

    const isJoinedWithRole = (boardId: string, requiredRole: BoardRole): boolean => {
      return (
        currentBoard === boardId &&
        socket.rooms.has(boardId) &&
        roleAllows(currentRole, requiredRole)
      );
    };

    socket.on("join_board", async (rawPayload: unknown) => {
      const parsed = joinBoardSchema.safeParse(
        typeof rawPayload === "string" ? { boardId: rawPayload } : rawPayload
      );
      if (!parsed.success) return emitError(socket, "Invalid board join request");
      const { boardId } = parsed.data;

      if (currentBoard && currentBoard !== boardId) leaveCurrentBoard(currentBoard);
      const board = await getBoardState(boardId);
      if (!board) return emitError(socket, "Board not found");
      const role = await resolveBoardRole(board, userId);
      if (!role) {
        await recordAudit(boardId, userId, "board.join.denied");
        return emitError(socket, "Access denied — you are not a member of this board");
      }

      currentBoard = boardId;
      currentRole = role;
      await socket.join(boardId);
      if (!roomUsers.has(boardId)) roomUsers.set(boardId, new Map());
      roomUsers.get(boardId)!.set(socketId, {
        userId,
        userName,
        color: userColor,
        role,
      });

      const doc = await getOrLoadRoomDoc(board);

      const cleanupTimer = roomCleanupTimers.get(boardId);
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        roomCleanupTimers.delete(boardId);
      }

      socket.emit("board_state", { ...board, role });
      socket.emit("yjs_full_state", Y.encodeStateAsUpdate(doc));
      socket.to(boardId).emit("user_joined", {
        userId: socketId,
        userName,
        color: userColor,
        connectedAt: new Date().toISOString(),
        role,
      });
      await recordAudit(boardId, userId, "board.join", { role });
    });

    socket.on("yjs_update", async (rawPayload: unknown) => {
      if (shouldThrottleSocketEvent(socketId, "yjs_update", 80, 1000)) {
        return emitError(socket, "Mutation rate limit exceeded");
      }
      const parsed = yjsUpdateSchema.safeParse(rawPayload);
      if (!parsed.success) return emitError(socket, "Malformed or oversized Yjs update");
      const { boardId } = parsed.data;
      if (!isJoinedWithRole(boardId, "editor")) {
        await recordAudit(boardId, userId, "mutation.denied", { reason: "insufficient_role" });
        return emitError(socket, "Editor role required for board mutations");
      }

      // Resolve the role again for every mutation so a revoked editor cannot
      // continue writing with a stale joined-room state.
      const board = await getBoardState(boardId);
      const freshRole = board ? await resolveBoardRole(board, userId) : null;
      if (!roleAllows(freshRole, "editor")) {
        currentRole = freshRole;
        await recordAudit(boardId, userId, "mutation.denied", { reason: "role_revoked" });
        return emitError(socket, "Editor role required for board mutations");
      }
      currentRole = freshRole;

      const doc = roomDocs.get(boardId);
      if (!doc) return emitError(socket, "Board document is not loaded");
      const update = new Uint8Array(parsed.data.update);
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc), "validation-base");
        Y.applyUpdate(candidate, update, "validation-candidate");
      } catch {
        candidate.destroy();
        await recordAudit(boardId, userId, "mutation.denied", { reason: "invalid_yjs_update" });
        return emitError(socket, "Invalid Yjs update");
      }
      candidate.destroy();

      try {
        await appendCollaborationUpdate(boardId, update, userId);
      } catch {
        await recordAudit(boardId, userId, "mutation.denied", { reason: "persistence_unavailable" });
        return emitError(socket, "Mutation could not be durably stored");
      }

      Y.applyUpdate(doc, update, "authorized-client");

      socket.to(boardId).emit("yjs_update", { update, userId: socketId });
      debouncedSave(boardId, userId);
      await recordAudit(boardId, userId, "board.mutation", { bytes: update.byteLength });
    });

    socket.on("cursor_moved", (rawPayload: unknown) => {
      if (shouldThrottleCursor(socketId)) return;
      const parsed = cursorSchema.safeParse(rawPayload);
      if (!parsed.success || !isJoinedWithRole(parsed.data.boardId, "viewer")) return;
      const cursor: CursorPosition = {
        ...parsed.data.cursor,
        userId: socketId,
        userName,
        color: userColor,
      };
      socket.to(parsed.data.boardId).emit("cursor_moved", cursor);
    });

    socket.on("request_ai_analysis", async (rawPayload: unknown) => {
      if (shouldThrottleSocketEvent(socketId, "ai_analysis", 5, 60_000)) {
        return emitError(socket, "AI analysis rate limit exceeded");
      }
      const parsed = analysisSchema.safeParse(rawPayload);
      if (!parsed.success || !isJoinedWithRole(parsed.data.boardId, "viewer")) {
        return emitError(socket, "Board access required for analysis");
      }
      const doc = roomDocs.get(parsed.data.boardId);
      if (!doc) return emitError(socket, "Board document is not loaded");
      try {
        const { nodes, edges } = serializeDoc(doc);
        const result = await analyzeArchitecture(nodes, edges);
        socket.emit("ai_analysis_result", result);
        await recordAudit(parsed.data.boardId, userId, "board.ai_explanation");
      } catch {
        emitError(socket, "AI analysis failed");
      }
    });

    socket.on("leave_board", (rawBoardId: unknown) => {
      const parsed = boardIdSchema.safeParse(rawBoardId);
      if (parsed.success) leaveCurrentBoard(parsed.data);
    });

    socket.on("disconnect", () => {
      clearCursorThrottle(socketId);
      if (currentBoard) leaveCurrentBoard(currentBoard);
    });
  });
}
