"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useBoardStore } from "@/store/boardStore";
import { useUser } from "@/hooks/useUser";
import {
  History,
  Clock,
  RotateCcw,
  Eye,
  X,
  Loader2,
  GitBranch,
  Layers,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

interface SnapshotSummary {
  version: number;
  createdAt: string;
  createdBy: string | null;
  nodeCount: number;
  edgeCount: number;
}

interface PreviewData {
  version: number;
  nodes: any[];
  edges: any[];
  createdAt: string;
}

export default function VersionHistory() {
  const { boardId, setSidebarMode, setNodes, setEdges } = useBoardStore();
  const { authHeaders } = useUser();

  const [versions, setVersions] = useState<SnapshotSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Fetch version list
  const fetchVersions = useCallback(async () => {
    if (!boardId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/boards/${boardId}/versions`, {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions || []);
      } else if (res.status === 404) {
        setError("No version history available. Versions are saved when PostgreSQL is configured.");
      } else {
        setError("Failed to load version history");
      }
    } catch {
      setError("Version history requires PostgreSQL. Configure DATABASE_URL to enable.");
    }
    setLoading(false);
  }, [boardId, authHeaders]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  // Preview a version
  const handlePreview = async (version: number) => {
    if (previewVersion === version) {
      setPreviewVersion(null);
      setPreviewData(null);
      return;
    }

    setLoadingPreview(true);
    setPreviewVersion(version);

    try {
      const res = await fetch(
        `${API_URL}/api/boards/${boardId}/versions/${version}`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json();
        setPreviewData(data);
      }
    } catch {
      // silently fail
    }
    setLoadingPreview(false);
  };

  // Restore a version
  const handleRestore = async (version: number) => {
    if (!confirm(`Restore to version ${version}? This will create a new snapshot with the restored state.`)) {
      return;
    }

    setRestoring(version);
    try {
      const res = await fetch(
        `${API_URL}/api/boards/${boardId}/versions/${version}/restore`,
        {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
        }
      );
      if (res.ok) {
        const data = await res.json();
        // Board state will be broadcast via socket, but also update locally
        if (data.board) {
          const newNodes = data.board.nodes.map((n: any) => ({
            id: n.id,
            type: n.type || "architectureNode",
            position: n.position,
            data: n.data,
          }));
          const newEdges = data.board.edges.map((e: any) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
            type: "smoothstep" as const,
            style: { stroke: "#444" },
            data: e.data,
          }));
          setNodes(newNodes);
          setEdges(newEdges);
        }
        // Refresh version list
        await fetchVersions();
        setPreviewVersion(null);
        setPreviewData(null);
      }
    } catch {
      // silently fail
    }
    setRestoring(null);
  };

  // Format relative time
  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="sidebar" id="version-history">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-accent-purple/15 border border-accent-purple/30 flex items-center justify-center">
            <History className="w-5 h-5 text-accent-purple" />
          </div>
          <div>
            <h3 className="font-display font-bold text-sm text-accent-purple">
              Version History
            </h3>
            <p className="text-xs text-text-muted">
              {versions.length} snapshot{versions.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <button
          onClick={() => setSidebarMode("none")}
          className="btn-ghost p-1.5 rounded-sm"
          id="close-version-history"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
            <p className="text-xs text-text-muted">Loading versions...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <div className="w-12 h-12 rounded-sm bg-status-warning/10 border border-status-warning/30 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-status-warning" />
            </div>
            <p className="text-xs text-text-muted leading-relaxed max-w-[200px]">
              {error}
            </p>
          </div>
        ) : versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <div className="w-12 h-12 rounded-sm bg-surface-lighter border border-border flex items-center justify-center">
              <GitBranch className="w-6 h-6 text-text-muted/40" />
            </div>
            <p className="text-xs text-text-muted">
              No snapshots yet. Versions are saved automatically as you edit.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {versions.map((v, index) => (
              <div
                key={v.version}
                className={`relative rounded-sm border transition-all duration-200 ${
                  previewVersion === v.version
                    ? "border-accent-purple/50 bg-accent-purple/5 shadow-sm"
                    : "border-border bg-canvas-50 hover:border-border-light"
                }`}
              >
                {/* Timeline connector */}
                {index < versions.length - 1 && (
                  <div className="absolute left-[17px] top-[44px] w-px h-[calc(100%+8px)] bg-border" />
                )}

                <div className="p-3">
                  {/* Version header */}
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-[10px] h-[10px] rounded-full shrink-0 z-10 ${
                        index === 0
                          ? "bg-accent-purple ring-2 ring-accent-purple/30"
                          : "bg-text-muted/40 border border-border"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-display font-bold text-text-primary">
                          v{v.version}
                        </span>
                        {index === 0 && (
                          <span className="text-[9px] font-display font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-purple/15 text-accent-purple">
                            Latest
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Clock className="w-3 h-3 text-text-muted shrink-0" />
                        <span className="text-[10px] text-text-muted">
                          {formatTime(v.createdAt)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="flex items-center gap-1 text-[10px] text-text-muted font-mono">
                        <Layers className="w-3 h-3" />
                        {v.nodeCount}n · {v.edgeCount}e
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 mt-2.5 ml-[22px]">
                    <button
                      onClick={() => handlePreview(v.version)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-display font-semibold uppercase tracking-wider transition-colors ${
                        previewVersion === v.version
                          ? "bg-accent-purple/15 text-accent-purple border border-accent-purple/30"
                          : "bg-surface-light text-text-muted border border-border hover:text-text-primary hover:border-border-light"
                      }`}
                    >
                      {loadingPreview && previewVersion === v.version ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Eye className="w-3 h-3" />
                      )}
                      {previewVersion === v.version ? "Close" : "Preview"}
                    </button>
                    {index !== 0 && (
                      <button
                        onClick={() => handleRestore(v.version)}
                        disabled={restoring === v.version}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-display font-semibold uppercase tracking-wider bg-surface-light text-text-muted border border-border hover:text-accent-cyan hover:border-accent-cyan/30 transition-colors disabled:opacity-50"
                      >
                        {restoring === v.version ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3 h-3" />
                        )}
                        Restore
                      </button>
                    )}
                  </div>

                  {/* Preview detail */}
                  {previewVersion === v.version && previewData && (
                    <div className="mt-3 ml-[22px] p-2.5 rounded-sm bg-canvas border border-border">
                      <p className="text-[10px] text-text-muted font-mono mb-2">
                        Snapshot from {new Date(previewData.createdAt).toLocaleString()}
                      </p>
                      <div className="space-y-1">
                        {previewData.nodes.slice(0, 6).map((n: any) => (
                          <div
                            key={n.id}
                            className="flex items-center gap-1.5 text-[10px] text-text-secondary"
                          >
                            <ChevronRight className="w-2.5 h-2.5 text-text-muted shrink-0" />
                            <span className="font-mono text-accent-cyan/80">
                              [{n.data?.nodeType}]
                            </span>
                            <span className="truncate">{n.data?.label}</span>
                          </div>
                        ))}
                        {previewData.nodes.length > 6 && (
                          <p className="text-[10px] text-text-muted ml-4">
                            + {previewData.nodes.length - 6} more nodes
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <button
          onClick={fetchVersions}
          disabled={loading}
          className="btn-ghost w-full flex items-center justify-center gap-2 py-2 text-xs font-display"
        >
          <RotateCcw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh History
        </button>
      </div>
    </div>
  );
}
