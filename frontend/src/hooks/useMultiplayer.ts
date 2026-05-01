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
} from "@system-synthesis/shared";

const CURSOR_THROTTLE_MS = 50;
const NODE_SYNC_DEBOUNCE_MS = 500;

/**
 * Multiplayer hook — manages board room lifecycle.
 * 
 * Key design decisions to prevent reconnect storms:
 * 1. The socket SINGLETON stays connected for the app lifetime.
 *    We only join/leave ROOMS, never disconnect the socket itself.
 * 2. Event listeners are registered ONCE using a setup ref guard
 *    to handle React Strict Mode double-mounting.
 * 3. Cleanup only leaves the room — doesn't disconnect.
 */
export function useMultiplayer(
  boardId: string,
  userName: string,
  identityId: string,
  onAccessRevokedCallback?: () => void
) {
  const syncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastCursorEmitRef = useRef<number>(0);
  const isRemoteUpdateRef = useRef(false);
  const prevNodesRef = useRef<string>("");
  const prevEdgesRef = useRef<string>("");
  const currentBoardRef = useRef<string | null>(null);
  const listenersRegisteredRef = useRef(false);
  const mountedRef = useRef(true);

  // --- Socket connection + room lifecycle ---
  useEffect(() => {
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

      prevNodesRef.current = JSON.stringify(
        newNodes.map((n) => ({ id: n.id, position: n.position }))
      );
      prevEdgesRef.current = JSON.stringify(
        newEdges.map((e) => ({ id: e.id, source: e.source, target: e.target }))
      );

      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 200);
    };

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

      prevNodesRef.current = JSON.stringify(
        newNodes.map((n) => ({ id: n.id, position: n.position }))
      );
      prevEdgesRef.current = JSON.stringify(
        newEdges.map((e) => ({ id: e.id, source: e.source, target: e.target }))
      );

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

    // ——— Cleanup: leave room, but DON'T disconnect socket ———
    return () => {
      mountedRef.current = false;

      // Leave the board room (not the socket)
      if (currentBoardRef.current) {
        socket.emit("leave_board", currentBoardRef.current);
        currentBoardRef.current = null;
      }

      // Remove listeners
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("board_state", onBoardState);
      socket.off("nodes_updated", onNodesUpdated);
      socket.off("cursor_moved", onCursorMoved);
      socket.off("user_joined", onUserJoined);
      socket.off("user_left", onUserLeft);
      socket.off("ai_analysis_result", onAiResult);
      socket.off("board_access_revoked", onBoardAccessRevoked as any);
      socket.off("error", onError);
      listenersRegisteredRef.current = false;

      // Clear any pending sync timers
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [boardId, userName, identityId]);

  // --- Debounced node/edge sync ---  // Subscribe to node/edge changes for sync
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);

  useEffect(() => {
    if (isRemoteUpdateRef.current) return;

    const socket = getSocket();
    if (!socket.connected) return;

    // Check if nodes/edges actually changed
    const state = useBoardStore.getState();
    const currentNodesKey = JSON.stringify(
      state.nodes.map((n) => ({
        id: n.id,
        position: n.position,
        data: n.data,
      }))
    );
    const currentEdgesKey = JSON.stringify(
      state.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      }))
    );

    if (
      currentNodesKey === prevNodesRef.current &&
      currentEdgesKey === prevEdgesRef.current
    ) {
      return;
    }

    // Debounce
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);

    syncTimerRef.current = setTimeout(() => {
      const latestState = useBoardStore.getState();
      const serializedNodes = latestState.getSerializedNodes();
      const serializedEdges = latestState.getSerializedEdges();

      socket.emit("update_nodes", {
        boardId,
        nodes: serializedNodes,
        edges: serializedEdges,
      });

      prevNodesRef.current = currentNodesKey;
      prevEdgesRef.current = currentEdgesKey;
    }, NODE_SYNC_DEBOUNCE_MS);

    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [nodes, edges, boardId]);

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
