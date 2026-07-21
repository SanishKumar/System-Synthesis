"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import { toast } from "sonner";
import {
  Activity,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  FileCode2,
  GitBranch,
  Globe2,
  History,
  Layers3,
  Loader2,
  LockKeyhole,
  Plus,
  ScanSearch,
  Trash2,
  Users,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

interface BoardSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  isPublic: boolean;
  role: "owner" | "editor" | "viewer" | null;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Metrics {
  totalBoards: number;
  totalNodes: number;
  totalEdges: number;
  uptimeSeconds: number;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function getTag(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("k8s") || lower.includes("cluster")) return "CLUSTER";
  if (lower.includes("data") || lower.includes("db")) return "DATA";
  if (lower.includes("auth")) return "IDENTITY";
  if (lower.includes("api")) return "API";
  return "SYSTEM";
}

const workflow = [
  { icon: <GitBranch className="h-4 w-4" />, label: "Model a typed architecture graph" },
  { icon: <ScanSearch className="h-4 w-4" />, label: "Run deterministic lint rules" },
  { icon: <History className="h-4 w-4" />, label: "Restore durable graph versions" },
  { icon: <FileCode2 className="h-4 w-4" />, label: "Export the supported resource subset" },
];

export default function DashboardPage() {
  const router = useRouter();
  const { userId, authenticatedFetch, isReady } = useUser();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isReady) return;
    async function fetchData() {
      try {
        const response = await authenticatedFetch(`${API_URL}/api/boards`);
        if (response.ok) {
          const data = await response.json();
          setBoards(data.boards || []);
          setMetrics(data.metrics || null);
        }
      } catch {
        // The local workspace remains usable through the demo route.
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [isReady, userId, authenticatedFetch]);

  const handleCreateBoard = async () => {
    if (!isReady) return;
    setCreating(true);
    try {
      const response = await authenticatedFetch(`${API_URL}/api/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled architecture" }),
      });
      if (response.ok) {
        const board = await response.json();
        toast.success("Workspace created");
        router.push(`/canvas/${board.id}`);
        return;
      }
      throw new Error("create failed");
    } catch {
      toast.info("Opening the local demo workspace");
      router.push("/canvas/demo-ecommerce");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBoard = async (boardId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm("Delete this architecture? This cannot be undone.")) return;
    try {
      const response = await authenticatedFetch(`${API_URL}/api/boards/${boardId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Delete failed with status ${response.status}`);
      }
      setBoards((current) => current.filter((board) => board.id !== boardId));
      toast.success("Workspace deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the workspace");
    }
  };

  const statCards = [
    { label: "Architectures", value: metrics?.totalBoards ?? boards.length, icon: <Layers3 className="h-4 w-4" /> },
    { label: "Components", value: metrics?.totalNodes ?? "—", icon: <Boxes className="h-4 w-4" /> },
    { label: "Connections", value: metrics?.totalEdges ?? "—", icon: <GitBranch className="h-4 w-4" /> },
    { label: "Process uptime", value: metrics ? formatUptime(metrics.uptimeSeconds) : "—", icon: <Activity className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />
      <main className="pt-16">
        <div className="mx-auto max-w-[1280px] px-4 pb-16 pt-8 sm:px-6 lg:px-8 lg:pt-12">
          <section className="mb-9 grid gap-7 border-b border-border pb-9 lg:grid-cols-[minmax(0,1fr)_390px] lg:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-[10px] font-mono font-semibold uppercase tracking-[0.17em] text-accent-cyan">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />
                Collaborative graph workspace
              </div>
              <h1 className="max-w-3xl font-display text-3xl font-bold leading-[1.12] tracking-[-0.04em] text-text-primary sm:text-4xl lg:text-[44px]">
                Architecture is a model,
                <br className="hidden sm:block" /> not a static picture.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-text-secondary sm:text-[15px]">
                Build a shared system graph, inspect rule-based findings, track versions, and export only what the model can represent faithfully.
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 lg:items-end">
              <button onClick={handleCreateBoard} disabled={creating} id="new-project-btn" className="btn-primary gap-2 px-5 py-2.5 text-sm">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                New architecture
              </button>
              <p className="text-[11px] text-text-muted">Start blank or continue with the demo when the service is offline.</p>
            </div>
          </section>

          <section className="mb-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {statCards.map((stat) => (
              <div key={stat.label} className="rounded-xl border border-border bg-surface px-4 py-4 shadow-[0_1px_2px_rgba(29,33,53,0.025)] sm:px-5">
                <div className="mb-4 flex items-center justify-between text-text-muted">
                  <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.13em]">{stat.label}</span>
                  <span className="text-accent-cyan">{stat.icon}</span>
                </div>
                <p className="font-display text-2xl font-bold tracking-[-0.03em] text-text-primary">
                  {loading ? <span className="inline-block h-7 w-14 animate-pulse rounded-md bg-surface-lighter" /> : stat.value}
                </p>
              </div>
            ))}
          </section>

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_310px]">
            <section className="min-w-0">
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-text-primary">
                    {boards.length ? "Recent workspaces" : "Start modeling"}
                  </h2>
                  <p className="mt-1 text-xs text-text-muted">Your latest architecture graphs and access state.</p>
                </div>
                {boards.length > 3 && (
                  <Link href="/history" className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary hover:text-accent-cyan">
                    View all <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>

              {loading ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <div key={index} className="h-[246px] animate-pulse rounded-[14px] border border-border bg-surface" />
                  ))}
                </div>
              ) : boards.length === 0 ? (
                <div className="relative overflow-hidden rounded-2xl border border-dashed border-border-light bg-surface px-6 py-14 text-center">
                  <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(circle_at_1px_1px,var(--color-grid)_1px,transparent_1px)] [background-size:22px_22px]" />
                  <div className="relative mx-auto flex max-w-md flex-col items-center">
                    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-accent-cyan/20 bg-accent-cyan/10 text-accent-cyan">
                      <GitBranch className="h-5 w-5" />
                    </div>
                    <h3 className="font-display text-xl font-bold tracking-[-0.02em] text-text-primary">No graph yet</h3>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">Create a blank architecture or inspect the local commerce example before connecting a backend.</p>
                    <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                      <button onClick={handleCreateBoard} className="btn-primary gap-2 text-sm"><Plus className="h-4 w-4" /> Blank architecture</button>
                      <Link href="/canvas/demo-ecommerce" className="btn-secondary gap-2 text-sm"><Globe2 className="h-4 w-4" /> Open demo</Link>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {boards.map((board, boardIndex) => (
                    <Link key={board.id} href={`/canvas/${board.id}`} id={`board-card-${board.id}`} className="card group overflow-hidden">
                      <div className="relative h-32 overflow-hidden border-b border-border bg-canvas-50">
                        <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(circle_at_1px_1px,var(--color-grid)_1px,transparent_1px)] [background-size:20px_20px]" />
                        <div className="absolute inset-x-5 top-5 h-px bg-border" />
                        {Array.from({ length: Math.max(1, Math.min(board.nodeCount, 4)) }).map((_, nodeIndex) => (
                          <div
                            key={nodeIndex}
                            className="absolute h-7 rounded-md border border-border bg-surface shadow-[0_2px_5px_rgba(29,33,53,0.05)]"
                            style={{
                              width: 48 + ((boardIndex + nodeIndex) % 3) * 10,
                              left: 20 + (nodeIndex % 2) * 82,
                              top: 31 + Math.floor(nodeIndex / 2) * 46,
                            }}
                          />
                        ))}
                        <span className="absolute right-3 top-3 rounded-full border border-accent-cyan/15 bg-surface/90 px-2 py-1 text-[9px] font-mono font-semibold tracking-[0.1em] text-accent-cyan backdrop-blur">
                          {getTag(board.name)}
                        </span>
                      </div>
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="truncate text-sm font-bold text-text-primary transition-colors group-hover:text-accent-cyan">{board.name}</h3>
                            <p className="mt-1 line-clamp-2 min-h-[34px] text-[11px] leading-[17px] text-text-muted">
                              {board.description || `${board.nodeCount} components connected by ${board.edgeCount} relationships`}
                            </p>
                          </div>
                          {board.role === "owner" && board.ownerId === userId && (
                            <button onClick={(event) => handleDeleteBoard(board.id, event)} className="-mr-1 rounded-md p-1.5 text-text-muted opacity-0 hover:bg-status-error/10 hover:text-status-error group-hover:opacity-100" aria-label={`Delete ${board.name}`}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[10px] text-text-muted">
                          <span className="flex items-center gap-1.5"><Clock3 className="h-3 w-3" /> {timeAgo(board.updatedAt)}</span>
                          <span className="flex items-center gap-1.5">
                            {board.isPublic ? <Globe2 className="h-3 w-3 text-status-active" /> : <LockKeyhole className="h-3 w-3" />}
                            {board.isPublic ? "Shared" : "Private"}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}

                  <button onClick={handleCreateBoard} disabled={creating} id="blank-canvas-card" className="group flex min-h-[246px] flex-col items-center justify-center rounded-[14px] border border-dashed border-border-light bg-transparent p-6 text-center transition-all hover:border-accent-cyan/40 hover:bg-accent-cyan/[0.025]">
                    <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface text-text-muted transition-colors group-hover:border-accent-cyan/25 group-hover:text-accent-cyan">
                      {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </span>
                    <span className="text-sm font-bold text-text-primary">New architecture</span>
                    <span className="mt-1 text-[11px] text-text-muted">Begin with an empty graph</span>
                  </button>
                </div>
              )}
            </section>

            <aside className="space-y-4">
              <div className="rounded-[14px] border border-border bg-surface p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-display text-sm font-bold text-text-primary">Core workflow</h2>
                  <CheckCircle2 className="h-4 w-4 text-status-active" />
                </div>
                <ul className="space-y-3.5">
                  {workflow.map((item, index) => (
                    <li key={item.label} className="flex items-start gap-3 text-xs leading-5 text-text-secondary">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-canvas-50 text-accent-cyan">{item.icon}</span>
                      <span><span className="mr-1 font-mono text-[9px] text-text-muted">0{index + 1}</span>{item.label}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-[14px] border border-accent-cyan/15 bg-accent-cyan/[0.045] p-5">
                <div className="mb-2 flex items-center gap-2 text-accent-cyan">
                  <Users className="h-4 w-4" />
                  <h2 className="font-display text-sm font-bold">AI is optional</h2>
                </div>
                <p className="text-xs leading-5 text-text-secondary">Rule findings come from the graph linter. The assistant can explain them, but it does not decide whether an architecture is correct.</p>
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
