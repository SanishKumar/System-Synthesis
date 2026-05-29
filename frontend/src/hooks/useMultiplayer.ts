"use client";

import { useEffect, useRef, useCallback } from "react";
import { getSocket } from "@/lib/socket";
import { useBoardStore } from "@/store/boardStore";
import type {
  SerializedNode,
  SerializedEdge,
  CursorPosition,
  BoardState,
  UserPresence,
  AIAnalysisResult,
  BoardOperation,
} from "@system-synthesis/shared";

const CURSOR_THROTTLE_MS = 50;
const OP_FLUSH_INTERVAL_MS = 100;

/**
 * Multiplayer hook — manages board room lifecycle.
 * 
 * Key design decisions to prevent reconnect storms:
 * 1. The socket SINGLETON stays connected for the app lifetime.
 *    We only join/leave ROOMS, never disconnect the socket itself.
 * 2. Event listeners are registered ONCE using a setup ref guard
 *    to handle React Strict Mode double-mounting.
 * 3. Cleanup only leaves the room — doesn't disconnect.
 * 
 * Operation-based sync:
 * - Local mutations record ops to `pendingOps` in the store.
 * - This hook flushes them at a regular interval and emits to the server.
 * - Incoming `operation_applied` events are applied via `applyRemoteOperation`.
 */
export function useMultiplayer(
  boardId: string,
  userName: string,
  identityId: string,
  isReady: boolean,
  onAccessRevokedCallback?: () => void
) {
  const lastCursorEmitRef = useRef<number>(0);
  const isRemoteUpdateRef = useRef(false);
  const currentBoardRef = useRef<string | null>(null);
  const listenersRegisteredRef = useRef(false);
  const mountedRef = useRef(true);
  const opFlushTimerRef = useRef<NodeJS.Timeout | null>(null);

  // --- Socket connection + room lifecycle ---
  useEffect(() => {
    // Don't connect until user identity is resolved
    if (!isReady) return;

    mountedRef.current = true;
    const socket = getSocket();

    // ——— Event handlers ———
    const onConnect = () => {
      if (!mountedRef.current) return;
      console.log("[Multiplayer] Connected to server");
      useBoardStore.getState().setIsConnected(true);

      // Join the current board room
      if (currentBoardRef.current) {
        socket.emit("join_board", currentBoardRef.current, userName, identityId);
      }
    };

    const onDisconnect = () => {
      if (!mountedRef.current) return;
      console.log("[Multiplayer] Disconnected from server");
      useBoardStore.getState().setIsConnected(false);
    };

    const onBoardState = (state: BoardState) => {
      if (!mountedRef.current) return;
      console.log(`[Multiplayer] Received board state: ${state.nodes.length} nodes`);
      isRemoteUpdateRef.current = true;

      const newNodes = state.nodes.map((n) => ({
        id: n.id,
        type: n.type || "architectureNode",
        position: n.position,
        data: n.data,
      }));
      const newEdges = state.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "smoothstep" as const,
        style: { stroke: "#444" },
        data: e.data,
      }));

      useBoardStore.getState().setNodes(newNodes);
      useBoardStore.getState().setEdges(newEdges);
      // Hydrate board metadata into Zustand so TopNav/VersionHistory can use it
      useBoardStore.setState({ boardName: state.name, boardId: state.id });

      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 200);
    };

    // NEW: Handle granular operations from other clients
    const onOperationApplied = (payload: {
      operation: BoardOperation;
      userId: string;
    }) => {
      if (!mountedRef.current) return;
      if (payload.userId === socket.id) return;

      isRemoteUpdateRef.current = true;
      useBoardStore.getState().applyRemoteOperation(payload.operation);
      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 100);
    };

    // LEGACY: Keep for backward compat with older servers
    const onNodesUpdated = (payload: {
      nodes: SerializedNode[];
      edges: SerializedEdge[];
      userId: string;
    }) => {
      if (!mountedRef.current) return;
      if (payload.userId === socket.id) return;

      isRemoteUpdateRef.current = true;

      const newNodes = payload.nodes.map((n) => ({
        id: n.id,
        type: n.type || "architectureNode",
        position: n.position,
        data: n.data,
      }));
      const newEdges = payload.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "smoothstep" as const,
        style: { stroke: "#444" },
        data: e.data,
      }));

      useBoardStore.getState().setNodes(newNodes);
      useBoardStore.getState().setEdges(newEdges);

      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 200);
    };

    const onCursorMoved = (cursor: CursorPosition) => {
      if (!mountedRef.current) return;
      if (cursor.userId === socket.id) return;
      useBoardStore.getState().updateRemoteCursor({
        userId: cursor.userId,
        userName: cursor.userName,
        x: cursor.x,
        y: cursor.y,
        color: cursor.color,
      });
    };

    const onUserJoined = (user: UserPresence) => {
      if (!mountedRef.current) return;
      console.log(`[Multiplayer] ${user.userName} joined`);
    };

    const onUserLeft = (userId: string) => {
      if (!mountedRef.current) return;
      console.log(`[Multiplayer] User ${userId} left`);
      useBoardStore.getState().removeRemoteCursor(userId);
    };

    const onAiResult = (result: AIAnalysisResult) => {
      if (!mountedRef.current) return;
      useBoardStore.getState().setAiAnalysis(result);
      useBoardStore.getState().setIsAnalyzing(false);
    };

    const onError = (message: string) => {
      if (message.includes("Access denied")) {
        // Prevent Next.js from popping up a red error overlay for an expected auth redirect
        if (onAccessRevokedCallback) onAccessRevokedCallback();
        return;
      }
      console.error("[Multiplayer] Server error:", message);
    };

    // --- Active ejection: board made private while connected ---
    const onBoardAccessRevoked = (payload: { boardId: string; ownerId: string }) => {
      if (!mountedRef.current) return;
      // If I'm not the owner, I need to leave
      if (payload.ownerId !== identityId) {
        console.log("[Multiplayer] Access revoked — board made private");
        socket.emit("leave_board", payload.boardId);
        currentBoardRef.current = null;
        onAccessRevokedCallback?.();
      }
    };

    // ——— Register listeners ONLY ONCE ———
    if (!listenersRegisteredRef.current) {
      socket.on("connect", onConnect);
      socket.on("disconnect", onDisconnect);
      socket.on("board_state", onBoardState);
      socket.on("operation_applied", onOperationApplied);
      socket.on("nodes_updated", onNodesUpdated);
      socket.on("cursor_moved", onCursorMoved);
      socket.on("user_joined", onUserJoined);
      socket.on("user_left", onUserLeft);
      socket.on("ai_analysis_result", onAiResult);
      socket.on("board_access_revoked", onBoardAccessRevoked as any);
      socket.on("error", onError);
      listenersRegisteredRef.current = true;
    }

    // ——— Connect socket (only if not already connected) ———
    if (!socket.connected) {
      currentBoardRef.current = boardId;
      socket.connect();
      // join_board will happen in onConnect handler above
    } else {
      // Already connected — just switch rooms
      if (currentBoardRef.current && currentBoardRef.current !== boardId) {
        socket.emit("leave_board", currentBoardRef.current);
      }
      currentBoardRef.current = boardId;
      socket.emit("join_board", boardId, userName, identityId);
    }

    // ——— Op flush interval: drain pendingOps and emit to server ———
    opFlushTimerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      if (isRemoteUpdateRef.current) return;

      const socket = getSocket();
      if (!socket.connected) return;

      const ops = useBoardStore.getState().flushPendingOps();
      if (ops.length === 0) return;

      const bid = currentBoardRef.current;
      if (!bid) return;

      for (const operation of ops) {
        socket.emit("board_operation", { boardId: bid, operation });
      }
    }, OP_FLUSH_INTERVAL_MS);

    // ——— Cleanup: leave room, but DON'T disconnect socket ———
    return () => {
      mountedRef.current = false;

      // Stop op flush
      if (opFlushTimerRef.current) {
        clearInterval(opFlushTimerRef.current);
        opFlushTimerRef.current = null;
      }

      // Leave the board room (not the socket)
      if (currentBoardRef.current) {
        socket.emit("leave_board", currentBoardRef.current);
        currentBoardRef.current = null;
      }

      // Remove listeners
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("board_state", onBoardState);
      socket.off("operation_applied", onOperationApplied);
      socket.off("nodes_updated", onNodesUpdated);
      socket.off("cursor_moved", onCursorMoved);
      socket.off("user_joined", onUserJoined);
      socket.off("user_left", onUserLeft);
      socket.off("ai_analysis_result", onAiResult);
      socket.off("board_access_revoked", onBoardAccessRevoked as any);
      socket.off("error", onError);
      listenersRegisteredRef.current = false;
    };
  }, [boardId, userName, identityId, isReady]);

  // --- Throttled cursor emission ---
  const emitCursor = useCallback(
    (x: number, y: number) => {
      const now = Date.now();
      if (now - lastCursorEmitRef.current < CURSOR_THROTTLE_MS) return;

      const socket = getSocket();
      if (!socket.connected) return;

      lastCursorEmitRef.current = now;
      socket.emit("cursor_moved", {
        boardId,
        cursor: {
          x,
          y,
          userId: socket.id || "",
          userName,
          color: "#ebb2ff",
        },
      });
    },
    [boardId, userName]
  );

  return { emitCursor };
}
