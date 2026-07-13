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

const CURSOR_THROTTLE_MS = 100;
import * as Y from "yjs";

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
 * Granular nested Yjs maps merge independent node-field changes. Only Yjs
 * binary updates cross the socket boundary.
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

  // Keep a reference to the Y.js update handler so we can clean it up
  const handleYjsUpdateRef = useRef<((update: Uint8Array, origin: any) => void) | undefined>(undefined);

  // --- Socket connection + room lifecycle ---
  useEffect(() => {
    // Don't connect until user identity is resolved
    if (!isReady) return;

    mountedRef.current = true;
    const socket = getSocket();

    const subscribeToLocalUpdates = (doc: Y.Doc) => {
      handleYjsUpdateRef.current = (update: Uint8Array, origin: any) => {
        if (!mountedRef.current || isRemoteUpdateRef.current || origin === "remote") return;
        if (socket.connected && currentBoardRef.current) {
          socket.emit("yjs_update", {
            boardId: currentBoardRef.current,
            update: Array.from(update),
          });
        }
      };
      doc.on("update", handleYjsUpdateRef.current);
    };

    // ——— Event handlers ———
    const onConnect = () => {
      if (!mountedRef.current) return;
      console.log("[Multiplayer] Connected to server");
      useBoardStore.getState().setIsConnected(true);

      // Join the current board room
      if (currentBoardRef.current) {
        socket.emit("join_board", { boardId: currentBoardRef.current });
      }
    };

    const onDisconnect = () => {
      if (!mountedRef.current) return;
      console.log("[Multiplayer] Disconnected from server");
      useBoardStore.getState().setIsConnected(false);
    };

    const onBoardState = (state: Partial<BoardState>) => {
      if (!mountedRef.current) return;
      console.log(`[Multiplayer] Received board metadata: ${state.name}`);
      
      if (state.name && state.id) {
        useBoardStore.setState({
          boardName: state.name,
          boardId: state.id,
          boardRole: state.role ?? null,
        });
      }
    };

    // --- Yjs Sync ---
    const onYjsFullState = (stateUpdate: Uint8Array) => {
      if (!mountedRef.current) return;
      const doc = useBoardStore.getState().yDoc;
      if (!doc) return;
      isRemoteUpdateRef.current = true;
      Y.applyUpdate(doc, new Uint8Array(stateUpdate), "remote");
      useBoardStore.getState().applyYjsToLocal();
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
    };

    const onYjsUpdate = (payload: { update: Uint8Array; userId: string }) => {
      if (!mountedRef.current) return;
      if (payload.userId === socket.id) return;
      const doc = useBoardStore.getState().yDoc;
      if (!doc) return;
      isRemoteUpdateRef.current = true;
      Y.applyUpdate(doc, new Uint8Array(payload.update), "remote");
      useBoardStore.getState().applyYjsToLocal();
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
    };

    const onYjsStateReplaced = (payload: { state: Uint8Array; restoredVersion: number }) => {
      if (!mountedRef.current) return;
      const previous = useBoardStore.getState().yDoc;
      if (previous && handleYjsUpdateRef.current) {
        previous.off("update", handleYjsUpdateRef.current);
      }
      useBoardStore.getState().initYjs();
      const next = useBoardStore.getState().yDoc;
      if (!next) return;
      isRemoteUpdateRef.current = true;
      Y.applyUpdate(next, new Uint8Array(payload.state), "remote");
      useBoardStore.getState().applyYjsToLocal();
      subscribeToLocalUpdates(next);
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
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
      socket.on("yjs_full_state", onYjsFullState);
      socket.on("yjs_update", onYjsUpdate);
      socket.on("yjs_state_replaced", onYjsStateReplaced);
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
      socket.emit("join_board", { boardId });
    }

    // Always re-initialize Y.js doc to prevent state bleed between boards
    useBoardStore.getState().initYjs();

    // Subscribe to local Y.js updates to send over socket
    const doc = useBoardStore.getState().yDoc;
    if (doc) {
      if (handleYjsUpdateRef.current) {
        doc.off("update", handleYjsUpdateRef.current);
      }
      subscribeToLocalUpdates(doc);
    }

    // ——— Cleanup: leave room, but DON'T disconnect socket ———
    return () => {
      mountedRef.current = false;

      // Unsubscribe from Y.js updates
      const currentDoc = useBoardStore.getState().yDoc;
      if (currentDoc && handleYjsUpdateRef.current) {
        currentDoc.off("update", handleYjsUpdateRef.current);
        handleYjsUpdateRef.current = undefined;
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
      socket.off("yjs_full_state", onYjsFullState);
      socket.off("yjs_update", onYjsUpdate);
      socket.off("yjs_state_replaced", onYjsStateReplaced);
      socket.off("cursor_moved", onCursorMoved);
      socket.off("user_joined", onUserJoined);
      socket.off("user_left", onUserLeft);
      socket.off("ai_analysis_result", onAiResult);
      socket.off("board_access_revoked", onBoardAccessRevoked as any);
      socket.off("error", onError);
      listenersRegisteredRef.current = false;
    };
  }, [boardId, userName, identityId, isReady, onAccessRevokedCallback]);

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
        },
      });
    },
    [boardId]
  );

  return { emitCursor };
}
