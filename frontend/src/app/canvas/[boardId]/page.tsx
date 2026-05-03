"use client";

import React, { useState, useCallback, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useParams, useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import BottomToolbar from "@/components/BottomToolbar";
import CanvasBoard from "@/components/canvas/CanvasBoard";
import NodeInspector from "@/components/sidebar/NodeInspector";
import ArchitectureAssist from "@/components/sidebar/ArchitectureAssist";
import { useBoardStore } from "@/store/boardStore";
import { useMultiplayer } from "@/hooks/useMultiplayer";
import { useUser } from "@/hooks/useUser";
import { autoLayoutNodes } from "@/lib/layout";
import {
  Share2,
  Globe,
  Lock,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { ArchNodeData } from "@system-synthesis/shared";
import type { Node } from "@xyflow/react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

export default function CanvasBoardPage() {
  const params = useParams();
  const router = useRouter();
  const boardId = (params.boardId as string) || "demo-ecommerce";
  const { userId, userName, authHeaders, isReady } = useUser();

  const [activeTool, setActiveTool] = useState<
    "select" | "draw" | "shapes" | "text" | "undo"
  >("select");
  const [pendingNodeType, setPendingNodeType] = useState<string | null>(null);
  const [isMessCleanupActive, setIsMessCleanupActive] = useState(false);

  // Board access state
  const [boardOwnerId, setBoardOwnerId] = useState<string>("");
  const [boardOwnerName, setBoardOwnerName] = useState<string>("");
  const [isPublic, setIsPublic] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [togglingVisibility, setTogglingVisibility] = useState(false);

  const isOwner = userId === boardOwnerId || boardOwnerId === "system";

  // Remember last visited board
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("ss_last_board", boardId);
    }
  }, [boardId]);

  // Fetch board metadata to check access
  useEffect(() => {
    if (!isReady) return;

    async function checkAccess() {
      try {
        const res = await fetch(`${API_URL}/api/boards/${boardId}`, {
          headers: authHeaders,
        });
        if (res.status === 403) {
          setAccessDenied(true);
          return;
        }
        if (res.ok) {
          const board = await res.json();
          setBoardOwnerId(board.ownerId);
          setBoardOwnerName(board.ownerName);
          setIsPublic(board.isPublic);
        }
      } catch {
        // Server might be down — let socket handle it
      }
    }
    checkAccess();
  }, [boardId, isReady, userId]);

  const {
    sidebarMode,
    setSidebarMode,
    getSerializedNodes,
    getSerializedEdges,
    isConnected,
  } = useBoardStore();

  // Active ejection callback
  const handleAccessRevoked = useCallback(() => {
    alert("Access revoked — the board owner made this board private.");
    router.push("/");
  }, [router]);

  // Multiplayer (pass identityId + ejection callback)
  const { emitCursor } = useMultiplayer(
    boardId,
    userName,
    userId,
    handleAccessRevoked
  );

  // Toggle board visibility
  const handleToggleVisibility = async () => {
    setTogglingVisibility(true);
    try {
      const res = await fetch(`${API_URL}/api/boards/${boardId}/visibility`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        setIsPublic(data.isPublic);
      }
    } catch {}
    setTogglingVisibility(false);
  };

  // Copy share link
  const handleCopyLink = () => {
    const url = `${window.location.origin}/canvas/${boardId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Animated Mess Cleanup
  const handleMessCleanup = useCallback(() => {
    const serializedNodes = getSerializedNodes();
    const serializedEdges = getSerializedEdges();
    const layoutedNodes = autoLayoutNodes(serializedNodes, serializedEdges);
    const currentNodes = useBoardStore.getState().nodes;

    const DURATION = 500;
    const startTime = performance.now();

    const startPositions = currentNodes.map((n) => ({
      id: n.id, x: n.position.x, y: n.position.y,
    }));
    const endPositions = layoutedNodes.map((n) => ({
      id: n.id, x: n.position.x, y: n.position.y,
    }));

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / DURATION, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      const interpolatedNodes: Node<ArchNodeData>[] = currentNodes.map((node) => {
        const start = startPositions.find((s) => s.id === node.id);
        const end = endPositions.find((e) => e.id === node.id);
        if (!start || !end) return node;
        return {
          ...node,
          position: {
            x: start.x + (end.x - start.x) * eased,
            y: start.y + (end.y - start.y) * eased,
          },
        };
      });

      useBoardStore.getState().setNodes(interpolatedNodes);
      if (progress < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  }, [getSerializedNodes, getSerializedEdges]);

  const handleToggleMessCleanup = (active: boolean) => {
    setIsMessCleanupActive(active);
  };

  const handleToggleAiAssist = () => {
    setSidebarMode(sidebarMode === "ai-assist" ? "none" : "ai-assist");
  };

  const handleCursorMove = useCallback(
    (x: number, y: number) => { emitCursor(x, y); },
    [emitCursor]
  );

  const handleShapeSelected = (nodeType: string) => {
    setPendingNodeType(nodeType);
    setActiveTool("shapes");
  };

  const handleNodePlaced = () => {
    setPendingNodeType(null);
    setActiveTool("select");
  };

  const handleUndo = useCallback(() => {
    const store = useBoardStore.getState();
    const nodes = store.nodes;
    if (nodes.length > 0) {
      store.setNodes(nodes.slice(0, -1));
    }
  }, []);

  // --- Access Denied Screen ---
  if (accessDenied) {
    return (
      <div className="h-screen w-screen bg-canvas flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-md bg-status-error/10 border border-status-error/30 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-status-error" />
          </div>
          <h1 className="font-display text-xl font-bold text-text-primary mb-2">
            Access Denied
          </h1>
          <p className="text-sm text-text-muted mb-6">
            This board is private. Only the owner can access it.
          </p>
          <button
            onClick={() => router.push("/")}
            className="btn-primary"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen overflow-hidden bg-canvas flex flex-col">
        <TopNav
          onMessCleanup={handleMessCleanup}
          isMessCleanupActive={isMessCleanupActive}
          onToggleMessCleanup={handleToggleMessCleanup}
        />

        <main
          className={`flex-1 mt-14 relative transition-all duration-300 ${
            sidebarMode !== "none" ? "mr-80" : ""
          }`}
        >
          <CanvasBoard
            onCursorMove={handleCursorMove}
            activeTool={activeTool}
            pendingNodeType={pendingNodeType}
            onNodePlaced={handleNodePlaced}
          />
        </main>

        <BottomToolbar
          activeTool={activeTool}
          onToolChange={setActiveTool}
          onShapeSelected={handleShapeSelected}
          onUndo={handleUndo}
        />

        {sidebarMode === "inspector" && <NodeInspector />}
        {sidebarMode === "ai-assist" && <ArchitectureAssist />}

        {/* Top-right controls: AI Assist + Share */}
        <div 
          className={`fixed top-16 z-40 flex items-center gap-2 transition-all duration-300 ${
            sidebarMode !== "none" ? "right-[336px]" : "right-4"
          }`}
        >
          {/* Share button (owners only, or show shared indicator) */}
          {isOwner ? (
            <div className="relative">
              <button
                id="share-board-btn"
                onClick={() => setShowShareMenu(!showShareMenu)}
                className={`flex items-center gap-2 px-3 py-2
                  bg-surface border rounded-md text-xs font-display
                  hover:border-accent-cyan hover:shadow-glow-cyan transition-all ${
                    isPublic
                      ? "border-status-active/40 text-status-active"
                      : "border-border text-text-secondary"
                  }`}
              >
                {isPublic ? (
                  <Globe className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isPublic ? "Public" : "Private"}
                <Share2 className="w-3.5 h-3.5 ml-1" />
              </button>

              {/* Share Dropdown */}
              {showShareMenu && (
                <div className="absolute top-11 right-0 w-72 bg-surface border border-border rounded-md shadow-card-hover z-50 p-4 space-y-3 animate-fade-in">
                  <h4 className="text-xs font-display font-semibold text-text-primary uppercase tracking-wider">
                    Share Settings
                  </h4>

                  {/* Visibility Toggle */}
                  <button
                    onClick={handleToggleVisibility}
                    disabled={togglingVisibility}
                    className="w-full flex items-center gap-3 p-3 rounded-sm border border-border hover:border-accent-cyan transition-all"
                  >
                    <div className={`w-8 h-8 rounded-sm flex items-center justify-center ${
                      isPublic
                        ? "bg-status-active/10 border border-status-active/30"
                        : "bg-surface-lighter border border-border"
                    }`}>
                      {togglingVisibility ? (
                        <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                      ) : isPublic ? (
                        <Globe className="w-4 h-4 text-status-active" />
                      ) : (
                        <Lock className="w-4 h-4 text-text-muted" />
                      )}
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-display text-text-primary">
                        {isPublic ? "Public Board" : "Private Board"}
                      </p>
                      <p className="text-[10px] text-text-muted">
                        {isPublic
                          ? "Anyone with the link can view & edit"
                          : "Only you can access this board"}
                      </p>
                    </div>
                  </button>

                  {/* Copy Link (only when public) */}
                  {isPublic && (
                    <div className="space-y-2">
                      <label className="text-[10px] text-text-muted font-display uppercase tracking-wider">
                        Share Link
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={`${typeof window !== "undefined" ? window.location.origin : ""}/canvas/${boardId}`}
                          className="input flex-1 text-[10px] font-mono h-8 truncate"
                        />
                        <button
                          onClick={handleCopyLink}
                          className="btn-ghost p-2 rounded-sm text-accent-cyan shrink-0"
                        >
                          {copied ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : boardOwnerId && (
            <div className="flex items-center gap-2 px-3 py-2 bg-surface border border-border rounded-md text-[10px] font-mono text-text-muted">
              <Globe className="w-3 h-3 text-status-active" />
              Shared by {boardOwnerName}
            </div>
          )}

          {sidebarMode !== "ai-assist" && (
            <button
              id="ai-assist-toggle"
              onClick={handleToggleAiAssist}
              className="flex items-center gap-2 px-3 py-2
                         bg-surface border border-border rounded-md text-xs font-display
                         hover:border-accent-cyan hover:shadow-glow-cyan transition-all"
            >
              <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse-slow" />
              AI Assist
            </button>
          )}
        </div>

        {/* Connection Status */}
        <div
          className={`fixed bottom-4 left-4 z-50 flex items-center gap-2 px-3 py-1.5
                      rounded-sm text-[10px] font-mono border transition-all duration-300 ${
                        isConnected
                          ? "bg-status-active/10 border-status-active/30 text-status-active"
                          : "bg-surface border-border text-text-muted"
                      }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? "bg-status-active animate-pulse" : "bg-text-muted"
            }`}
          />
          {isConnected ? `Live · ${userName}` : "Offline"}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
