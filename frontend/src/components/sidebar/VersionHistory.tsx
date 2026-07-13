"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import { useBoardStore } from "@/store/boardStore";
import { useUser } from "@/hooks/useUser";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  GitBranch,
  History,
  Layers,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  UserRound,
  X,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

interface SemanticChange {
  id: string;
  kind: "added" | "removed" | "changed";
  summary: string;
}

interface ChangeSummary {
  changes: SemanticChange[];
  stats: { added: number; removed: number; changed: number; total: number };
}

interface SnapshotSummary {
  version: number;
  name: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  parentVersion: number | null;
  sourceBoardId: string | null;
  sourceVersion: number | null;
  nodeCount: number;
  edgeCount: number;
  changeSummary: ChangeSummary;
}

interface PreviewData extends SnapshotSummary {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export default function VersionHistory() {
  const router = useRouter();
  const { boardId, boardRole, setSidebarMode } = useBoardStore();
  const { authHeaders } = useUser();
  const canCheckpoint = boardRole === "owner" || boardRole === "editor";
  const canRestore = boardRole === "owner";

  const [versions, setVersions] = useState<SnapshotSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkpointName, setCheckpointName] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [duplicating, setDuplicating] = useState<number | null>(null);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const fetchVersions = useCallback(async () => {
    if (!boardId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/boards/${boardId}/versions`, {
        headers: authHeaders,
      });
      if (!response.ok) {
        setError(await responseError(response, "Version history could not be loaded."));
      } else {
        const data = await response.json();
        setVersions(data.versions || []);
      }
    } catch {
      setError("Version history is unavailable. Check the server and PostgreSQL connection.");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, boardId]);

  useEffect(() => {
    void fetchVersions();
  }, [fetchVersions]);

  const createCheckpoint = async () => {
    const name = checkpointName.trim();
    if (!name || !boardId) return;
    setCreating(true);
    setActionError(null);
    try {
      const response = await fetch(`${API_URL}/api/boards/${boardId}/versions`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Checkpoint could not be created."));
      setCheckpointName("");
      await fetchVersions();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Checkpoint could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const preview = async (version: number) => {
    if (previewVersion === version) {
      setPreviewVersion(null);
      setPreviewData(null);
      return;
    }
    setLoadingPreview(true);
    setPreviewVersion(version);
    setActionError(null);
    try {
      const response = await fetch(`${API_URL}/api/boards/${boardId}/versions/${version}`, {
        headers: authHeaders,
      });
      if (!response.ok) throw new Error(await responseError(response, "Version preview could not be loaded."));
      setPreviewData(await response.json());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Version preview could not be loaded.");
      setPreviewVersion(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const rename = async (version: number, currentName: string | null) => {
    const name = window.prompt("Name this checkpoint", currentName || `Version ${version}`)?.trim();
    if (!name) return;
    setActionError(null);
    const response = await fetch(`${API_URL}/api/boards/${boardId}/versions/${version}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      setActionError(await responseError(response, "Checkpoint could not be renamed."));
      return;
    }
    await fetchVersions();
  };

  const restore = async (version: number) => {
    if (!window.confirm(`Restore version ${version}? The current graph remains available as the previous checkpoint.`)) return;
    setRestoring(version);
    setActionError(null);
    try {
      const response = await fetch(`${API_URL}/api/boards/${boardId}/versions/${version}/restore`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(await responseError(response, "Version could not be restored."));
      // The server emits yjs_state_replaced. Applying a second local mutation
      // here would make the restore actor diverge from other collaborators.
      setPreviewVersion(null);
      setPreviewData(null);
      await fetchVersions();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Version could not be restored.");
    } finally {
      setRestoring(null);
    }
  };

  const duplicate = async (version: number) => {
    setDuplicating(version);
    setActionError(null);
    try {
      const response = await fetch(`${API_URL}/api/boards/${boardId}/versions/${version}/duplicate`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(await responseError(response, "Version could not be duplicated."));
      const board = await response.json();
      router.push(`/canvas/${board.id}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Version could not be duplicated.");
      setDuplicating(null);
    }
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
    if (minutes < 10_080) return `${Math.floor(minutes / 1_440)}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="sidebar" id="version-history">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent-purple/25 bg-accent-purple/10">
              <History className="h-4.5 w-4.5 text-accent-purple" />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold text-text-primary">Version history</h3>
              <p className="text-[11px] text-text-muted">Named, attributable graph checkpoints</p>
            </div>
          </div>
          <button onClick={() => setSidebarMode("none")} className="btn-ghost rounded-lg p-2" aria-label="Close version history">
            <X className="h-4 w-4" />
          </button>
        </div>

        {canCheckpoint && (
          <div className="mt-4 flex gap-2">
            <input
              value={checkpointName}
              onChange={(event) => setCheckpointName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void createCheckpoint()}
              maxLength={120}
              placeholder="Checkpoint name"
              className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-3 py-2 text-xs text-text-primary outline-none transition focus:border-accent-purple/60"
            />
            <button
              onClick={() => void createCheckpoint()}
              disabled={!checkpointName.trim() || creating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-purple px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
        )}

        {actionError && (
          <div className="mt-3 flex gap-2 rounded-lg border border-status-error/25 bg-status-error/5 px-3 py-2 text-[11px] leading-relaxed text-status-error">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {actionError}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-14 text-xs text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading checkpoints…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-status-warning/25 bg-status-warning/5 p-4 text-center">
            <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-status-warning" />
            <p className="text-xs leading-relaxed text-text-muted">{error}</p>
          </div>
        ) : versions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <GitBranch className="mx-auto mb-3 h-6 w-6 text-text-muted" />
            <p className="text-xs font-semibold text-text-primary">No durable checkpoints yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">Create one after a meaningful architecture change.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {versions.map((version, index) => {
              const open = previewVersion === version.version;
              const changes = version.changeSummary?.changes || [];
              const stats = version.changeSummary?.stats || { added: 0, removed: 0, changed: 0, total: 0 };
              return (
                <article
                  key={version.version}
                  className={`rounded-xl border bg-canvas-50 transition ${open ? "border-accent-purple/40 shadow-sm" : "border-border hover:border-border-light"}`}
                >
                  <div className="p-3.5">
                    <div className="flex items-start gap-3">
                      <div className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${index === 0 ? "bg-accent-purple text-white" : "bg-surface-light text-text-muted"}`}>
                        {index === 0 ? <Check className="h-3 w-3" /> : version.version}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="truncate text-xs font-bold text-text-primary">{version.name || `Version ${version.version}`}</h4>
                          <span className="rounded bg-surface-light px-1.5 py-0.5 font-mono text-[9px] text-text-muted">v{version.version}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-muted">
                          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatTime(version.createdAt)}</span>
                          <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" />{version.createdByName || version.createdBy || "System"}</span>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-text-muted">
                        <Layers className="h-3 w-3" />{version.nodeCount}n · {version.edgeCount}e
                      </span>
                    </div>

                    {version.sourceVersion && (
                      <p className="ml-9 mt-2 text-[10px] text-accent-purple">Based on v{version.sourceVersion}{version.sourceBoardId !== boardId ? " from another board" : ""}</p>
                    )}

                    <div className="ml-9 mt-2.5 flex items-center gap-1.5">
                      <span className="rounded-md bg-status-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-status-success">+{stats.added}</span>
                      <span className="rounded-md bg-status-error/10 px-1.5 py-0.5 text-[10px] font-semibold text-status-error">−{stats.removed}</span>
                      <span className="rounded-md bg-accent-purple/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent-purple">~{stats.changed}</span>
                      {stats.total === 0 && <span className="text-[10px] text-text-muted">No graph changes</span>}
                    </div>

                    {changes[0] && <p className="ml-9 mt-2 truncate text-[11px] text-text-secondary">{changes[0].summary}</p>}

                    <div className="ml-9 mt-3 flex flex-wrap gap-1.5">
                      <button onClick={() => void preview(version.version)} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[10px] font-semibold text-text-muted hover:text-text-primary">
                        {loadingPreview && open ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                        {open ? "Close" : "Details"}
                      </button>
                      {canCheckpoint && (
                        <button onClick={() => void rename(version.version, version.name)} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[10px] font-semibold text-text-muted hover:text-text-primary">
                          <Pencil className="h-3 w-3" />Rename
                        </button>
                      )}
                      <button onClick={() => void duplicate(version.version)} disabled={duplicating === version.version} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[10px] font-semibold text-text-muted hover:text-accent-purple disabled:opacity-50">
                        {duplicating === version.version ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
                        Duplicate
                      </button>
                      {canRestore && index !== 0 && (
                        <button onClick={() => void restore(version.version)} disabled={restoring === version.version} className="inline-flex items-center gap-1 rounded-md border border-accent-purple/25 bg-accent-purple/5 px-2 py-1 text-[10px] font-semibold text-accent-purple disabled:opacity-50">
                          {restoring === version.version ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                          Restore
                        </button>
                      )}
                    </div>

                    {open && previewData?.version === version.version && (
                      <div className="ml-9 mt-3 rounded-lg border border-border bg-canvas p-3">
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Semantic changes</p>
                        {previewData.changeSummary.changes.length ? (
                          <div className="space-y-1.5">
                            {previewData.changeSummary.changes.slice(0, 8).map((change) => (
                              <div key={change.id} className="flex gap-1.5 text-[10px] leading-relaxed text-text-secondary">
                                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-accent-purple" />
                                <span>{change.summary}</span>
                              </div>
                            ))}
                            {previewData.changeSummary.changes.length > 8 && (
                              <p className="pl-4 text-[10px] text-text-muted">+{previewData.changeSummary.changes.length - 8} more machine-readable changes</p>
                            )}
                          </div>
                        ) : (
                          <p className="text-[10px] text-text-muted">This checkpoint has the same graph state as its parent.</p>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <button onClick={() => void fetchVersions()} disabled={loading} className="btn-ghost flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs">
          <RotateCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh history
        </button>
      </div>
    </div>
  );
}
