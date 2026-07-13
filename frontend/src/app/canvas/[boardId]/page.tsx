"use client";

import React, { useState, useCallback, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import BottomToolbar from "@/components/BottomToolbar";
import CanvasBoard from "@/components/canvas/CanvasBoard";
import { useBoardStore } from "@/store/boardStore";
import { useMultiplayer } from "@/hooks/useMultiplayer";
import { useUser } from "@/hooks/useUser";
import { toast } from "sonner";
import {
  Share2,
  Globe,
  Lock,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  History,
  ScanSearch,
  UserMinus,
} from "lucide-react";
import type { ArchNodeData, BoardRole, SerializedNode } from "@system-synthesis/shared";
import type { Node } from "@xyflow/react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

const NodeInspector = dynamic(() => import("@/components/sidebar/NodeInspector"), { ssr: false });
const ArchitectureAssist = dynamic(() => import("@/components/sidebar/ArchitectureAssist"), { ssr: false });
const VersionHistory = dynamic(() => import("@/components/sidebar/VersionHistory"), { ssr: false });

type BoardMember = {
  userId: string;
  userName: string;
  role: BoardRole;
};

export default function CanvasBoardPage() {
  const params = useParams();
  const router = useRouter();
  const boardId = (params.boardId as string) || "demo-ecommerce";
  const { userId, userName, authHeaders, isReady } = useUser();

  const [activeTool, setActiveTool] = useState<
    "select" | "draw" | "shapes" | "text" | "undo" | "redo"
  >("select");
  const [pendingNodeType, setPendingNodeType] = useState<string | null>(null);
  const [isMessCleanupActive, setIsMessCleanupActive] = useState(false);
  const [fitViewRequest, setFitViewRequest] = useState(0);

  // Board access state
  const [boardOwnerId, setBoardOwnerId] = useState<string>("");
  const [boardOwnerName, setBoardOwnerName] = useState<string>("");
  const [isPublic, setIsPublic] = useState(false);
  const [boardRole, setBoardRole] = useState<BoardRole | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [togglingVisibility, setTogglingVisibility] = useState(false);
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);

  const isOwner = boardRole === "owner";

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
          setBoardRole(board.role);
          // Hydrate Zustand store so TopNav breadcrumb + VersionHistory can read boardId/boardName
          useBoardStore.setState({ boardId, boardName: board.name, boardRole: board.role });
        }
      } catch {
        // Server might be down — let socket handle it
      }
    }
    checkAccess();
  }, [boardId, isReady, userId, authHeaders]);

  const {
    sidebarMode,
    setSidebarMode,
    getSerializedNodes,
    getSerializedEdges,
    isConnected,
  } = useBoardStore();
  // This editor is deliberately not offline-first. Prevent mutations while
  // disconnected so unsent local changes cannot diverge from durable state.
  const readOnly = boardRole === "viewer" || !isConnected;

  // Active ejection callback
  const handleAccessRevoked = useCallback(() => {
    toast.error("Access revoked — the board owner made this board private.");
    router.push("/");
  }, [router]);

  // Multiplayer (pass identityId + isReady + ejection callback)
  const { emitCursor } = useMultiplayer(
    boardId,
    userName,
    userId,
    isReady,
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
        toast.success(`Board is now ${data.isPublic ? "public" : "private"}`);
      } else {
        toast.error("Failed to update visibility");
      }
    } catch {
      toast.error("Failed to update visibility");
    }
    setTogglingVisibility(false);
  };

  // Copy share link
  const handleCopyLink = () => {
    const url = `${window.location.origin}/canvas/${boardId}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const loadMembers = useCallback(async () => {
    if (!isOwner) return;
    const response = await fetch(`${API_URL}/api/boards/${boardId}/members`, {
      headers: authHeaders,
    });
    if (response.ok) {
      const data = await response.json();
      setMembers(data.members || []);
    }
  }, [authHeaders, boardId, isOwner]);

  useEffect(() => {
    if (showShareMenu && isOwner) void loadMembers();
  }, [showShareMenu, isOwner, loadMembers]);

  const handleCreateInvitation = async () => {
    setInviteLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/boards/${boardId}/invitations`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ role: inviteRole, expiresInHours: 24 }),
      });
      if (!response.ok) throw new Error();
      const invitation = await response.json();
      const url = `${window.location.origin}/invite/${invitation.token}`;
      setInviteUrl(url);
      await navigator.clipboard.writeText(url);
      toast.success("24-hour invitation copied");
    } catch {
      toast.error("Could not create invitation");
    } finally {
      setInviteLoading(false);
    }
  };

  const handleMemberRole = async (memberId: string, role: "editor" | "viewer") => {
    const response = await fetch(`${API_URL}/api/boards/${boardId}/members/${memberId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (response.ok) {
      setMembers((current) => current.map((member) => member.userId === memberId ? { ...member, role } : member));
      toast.success("Member role updated");
    } else {
      toast.error("Could not update member role");
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    const response = await fetch(`${API_URL}/api/boards/${boardId}/members/${memberId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (response.ok) {
      setMembers((current) => current.filter((member) => member.userId !== memberId));
      toast.success("Member removed");
    } else {
      toast.error("Could not remove member");
    }
  };

  // Animated Mess Cleanup
  const handleMessCleanup = useCallback(async () => {
    if (readOnly) {
      setIsMessCleanupActive(false);
      return;
    }
    const serializedNodes = getSerializedNodes();
    const serializedEdges = getSerializedEdges();
    if (serializedNodes.length === 0) {
      setIsMessCleanupActive(false);
      toast.info("Add a component before running auto layout");
      return;
    }
    let layoutedNodes: SerializedNode[];
    try {
      const { autoLayoutNodes } = await import("@/lib/layout");
      layoutedNodes = autoLayoutNodes(serializedNodes, serializedEdges);
    } catch {
      setIsMessCleanupActive(false);
      toast.error("Auto layout could not be loaded");
      return;
    }
    const currentNodes = useBoardStore.getState().nodes;

    // Build a lookup of layout results
    const layoutMap = new Map(layoutedNodes.map((n) => [n.id, n]));

    const DURATION = 500;
    const startTime = performance.now();

    // Record start positions for each non-group node
    const startPositions = new Map(
      currentNodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }])
    );
    const endPositions = new Map(
      layoutedNodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }])
    );

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / DURATION, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      const interpolatedNodes: Node<ArchNodeData>[] = currentNodes.map((node) => {
        const layoutResult = layoutMap.get(node.id);

        if (node.type === "groupNode" && layoutResult?.style) {
          node = { ...node, style: layoutResult.style, zIndex: -1 } as any;
        }

        const start = startPositions.get(node.id);
        const end = endPositions.get(node.id);
        if (!start || !end) return node;

        const result: any = {
          ...node,
          position: {
            x: start.x + (end.x - start.x) * eased,
            y: start.y + (end.y - start.y) * eased,
          },
        };

        // Apply group containment from layout
        if (layoutResult) {
          if (layoutResult.parentId) {
            result.parentId = layoutResult.parentId;
          }
        }

        return result;
      });

      useBoardStore.getState().setNodes(interpolatedNodes);
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // Final sync
        const store = useBoardStore.getState();
        store.applyToYjs({
          op: "bulk_sync",
          nodes: store.getSerializedNodes(),
          edges: store.getSerializedEdges()
        });
        setFitViewRequest((request) => request + 1);
        setIsMessCleanupActive(false);
      }
    }

    requestAnimationFrame(animate);
  }, [getSerializedNodes, getSerializedEdges, readOnly]);

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
    useBoardStore.getState().undo();
  }, []);

  const handleRedo = useCallback(() => {
    useBoardStore.getState().redo();
  }, []);

  const handleToolReset = useCallback(() => {
    setActiveTool("select");
    setPendingNodeType(null);
  }, []);

  // --- Access Denied Screen ---
  if (accessDenied) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-canvas px-6">
        <div className="max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-[var(--shadow-soft)]">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-status-error/20 bg-status-error/10">
            <AlertTriangle className="w-8 h-8 text-status-error" />
          </div>
          <h1 className="mb-2 font-display text-xl font-bold tracking-[-0.02em] text-text-primary">
            Access Denied
          </h1>
          <p className="mb-6 text-sm leading-6 text-text-secondary">
            This workspace is private and your current identity is not authorized to open it.
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
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas">
        <TopNav
          onMessCleanup={handleMessCleanup}
          isMessCleanupActive={isMessCleanupActive}
          onToggleMessCleanup={handleToggleMessCleanup}
          onExportPng={() => window.dispatchEvent(new CustomEvent("export-png"))}
        />

        <main
          className={`relative mt-16 flex-1 transition-[margin] duration-200 ${
            sidebarMode !== "none" ? "md:mr-[23.5rem]" : ""
          }`}
        >
          <CanvasBoard
            onCursorMove={handleCursorMove}
            activeTool={activeTool}
            pendingNodeType={pendingNodeType}
            onNodePlaced={handleNodePlaced}
            onToolReset={handleToolReset}
            readOnly={readOnly}
            fitViewRequest={fitViewRequest}
          />
        </main>

        {!readOnly && (
          <BottomToolbar
            activeTool={activeTool}
            onToolChange={setActiveTool}
            onShapeSelected={handleShapeSelected}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        )}

        {!readOnly && sidebarMode === "inspector" && <NodeInspector />}
        {sidebarMode === "ai-assist" && <ArchitectureAssist />}
        {sidebarMode === "version-history" && <VersionHistory />}

        {/* Board actions */}
        <div 
          className={`fixed top-[76px] z-40 flex items-center gap-2 transition-all duration-200 ${
            sidebarMode !== "none" ? "right-3 md:right-[380px]" : "right-3"
          }`}
        >
          {/* Share button (owners only, or show shared indicator) */}
          {isOwner ? (
            <div className="relative">
              <button
                id="share-board-btn"
                onClick={() => setShowShareMenu(!showShareMenu)}
                className={`flex h-9 items-center gap-2 rounded-lg border bg-surface/95 px-3 text-xs font-semibold shadow-[0_2px_8px_rgba(29,33,53,0.06)] backdrop-blur transition-all hover:border-accent-cyan/35 ${
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
                <span className="hidden sm:inline">{isPublic ? "Shared" : "Private"}</span>
                <Share2 className="w-3.5 h-3.5 ml-1" />
              </button>

              {/* Share Dropdown */}
              {showShareMenu && (
                <div className="absolute right-0 top-11 z-50 w-72 space-y-3 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-float)] animate-fade-in">
                  <h4 className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-text-muted">
                    Workspace access
                  </h4>

                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <select
                        value={inviteRole}
                        onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}
                        className="input h-8 flex-1 text-xs"
                      >
                        <option value="viewer">Viewer · read only</option>
                        <option value="editor">Editor · can mutate</option>
                      </select>
                      <button
                        onClick={handleCreateInvitation}
                        disabled={inviteLoading}
                        className="btn-primary h-8 px-3 text-[11px]"
                      >
                        {inviteLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Invite"}
                      </button>
                    </div>
                    <p className="text-[10px] leading-4 text-text-muted">
                      Creates a single-use link that expires in 24 hours.
                    </p>
                    {inviteUrl && (
                      <button
                        onClick={() => navigator.clipboard.writeText(inviteUrl).then(() => toast.success("Invitation copied"))}
                        className="w-full truncate rounded-md bg-surface-lighter px-2 py-1.5 text-left text-[10px] text-accent-purple"
                      >
                        {inviteUrl}
                      </button>
                    )}
                  </div>

                  {members.length > 0 && (
                    <div className="max-h-36 space-y-1 overflow-y-auto">
                      {members.map((member) => (
                        <div key={member.userId} className="flex items-center gap-2 rounded-md px-1 py-1.5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[11px] font-semibold text-text-primary">{member.userName}</p>
                            <p className="truncate text-[9px] text-text-muted">{member.userId}</p>
                          </div>
                          {member.role === "owner" ? (
                            <span className="text-[9px] font-semibold uppercase text-accent-purple">Owner</span>
                          ) : (
                            <>
                              <select
                                value={member.role}
                                onChange={(event) => handleMemberRole(member.userId, event.target.value as "editor" | "viewer")}
                                className="h-7 rounded-md border border-border bg-surface px-1 text-[10px] text-text-secondary"
                              >
                                <option value="viewer">Viewer</option>
                                <option value="editor">Editor</option>
                              </select>
                              <button
                                onClick={() => handleRemoveMember(member.userId)}
                                className="rounded-md p-1.5 text-text-muted hover:bg-status-error/10 hover:text-status-error"
                                title="Remove member"
                              >
                                <UserMinus className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Visibility Toggle */}
                  <button
                    onClick={handleToggleVisibility}
                    disabled={togglingVisibility}
                    className="flex w-full items-center gap-3 rounded-lg border border-border p-3 transition-all hover:border-accent-cyan/35"
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
                        ? "Link access is enabled"
                          : "Access is limited to the owner"}
                      </p>
                    </div>
                  </button>

                  {/* Copy Link (only when public) */}
                  {isPublic && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                        Workspace link
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
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 text-[10px] font-mono text-text-muted shadow-[0_2px_8px_rgba(29,33,53,0.06)]">
              <Globe className="w-3 h-3 text-status-active" />
              {boardRole === "viewer" ? "Read only" : "Editor"} · Shared by {boardOwnerName}
            </div>
          )}

          {sidebarMode !== "ai-assist" && sidebarMode !== "version-history" && (
            <>
              <button
                id="version-history-toggle"
                onClick={() => setSidebarMode("version-history")}
                className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 text-xs font-semibold text-text-secondary shadow-[0_2px_8px_rgba(29,33,53,0.06)] transition-all hover:border-accent-purple/35 hover:text-text-primary"
              >
                <History className="w-3.5 h-3.5 text-accent-purple" />
                <span className="hidden sm:inline">Versions</span>
              </button>
              <button
                id="ai-assist-toggle"
                onClick={handleToggleAiAssist}
                className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 text-xs font-semibold text-text-secondary shadow-[0_2px_8px_rgba(29,33,53,0.06)] transition-all hover:border-accent-cyan/35 hover:text-text-primary"
              >
                <ScanSearch className="h-3.5 w-3.5 text-accent-cyan" />
                <span className="hidden sm:inline">Analysis</span>
              </button>
            </>
          )}
        </div>

        {/* Connection Status */}
        <div
          className={`fixed bottom-4 left-3 z-40 flex items-center gap-2 rounded-full border px-3 py-1.5
                      text-[10px] font-mono shadow-[0_2px_8px_rgba(29,33,53,0.06)] transition-all duration-300 ${
                        isConnected
                          ? "border-status-active/20 bg-surface text-status-active"
                          : "border-border bg-surface text-text-muted"
                      }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? "bg-status-active animate-pulse" : "bg-text-muted"
            }`}
          />
          {isConnected ? `Synced · ${userName}` : "Disconnected · editing paused"}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
