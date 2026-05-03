"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import {
  LayoutGrid,
  Boxes,
  Activity,
  Plus,
  ArrowRight,
  Clock,
  Users,
  Trash2,
  Loader2,
  Globe,
  Lock,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

interface BoardSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  isPublic: boolean;
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
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const TAG_MAP: Record<string, string> = {
  gateway: "GW",
  service: "SVC",
  database: "DB",
  queue: "MQ",
  cache: "CACHE",
  client: "APP",
};

function getTag(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("k8s") || lower.includes("cluster")) return "K8S";
  if (lower.includes("db") || lower.includes("database") || lower.includes("schema")) return "DB";
  if (lower.includes("auth") || lower.includes("oauth")) return "AUTH";
  if (lower.includes("api") || lower.includes("gateway")) return "API";
  if (lower.includes("flow")) return "FLOW";
  return "ARCH";
}

const COLLABORATOR_COLORS = ["#00dbe9", "#ebb2ff", "#22c55e", "#f59e0b", "#ef4444", "#60a5fa"];

export default function DashboardPage() {
  const router = useRouter();
  const { userId, userName, authHeaders, isReady } = useUser();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Fetch boards and metrics from backend (after user identity is ready)
  useEffect(() => {
    if (!isReady) return;

    async function fetchData() {
      try {
        const [boardsRes, metricsRes] = await Promise.all([
          fetch(`${API_URL}/api/boards`, { headers: authHeaders }),
          fetch(`${API_URL}/api/boards/metrics`, { headers: authHeaders }),
        ]);

        if (boardsRes.ok) {
          const data = await boardsRes.json();
          setBoards(data.boards || []);
        }
        if (metricsRes.ok) {
          setMetrics(await metricsRes.json());
        }
      } catch {
        // Backend unavailable — show empty state
      }
      setLoading(false);
    }
    fetchData();
  }, [isReady, userId]);

  const handleCreateBoard = async () => {
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/api/boards`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled Board" }),
      });
      if (res.ok) {
        const board = await res.json();
        router.push(`/canvas/${board.id}`);
        return;
      }
    } catch {}
    router.push("/canvas/demo-ecommerce");
    setCreating(false);
  };

  const handleDeleteBoard = async (boardId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this architecture? This cannot be undone.")) return;

    try {
      await fetch(`${API_URL}/api/boards/${boardId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      setBoards((prev) => prev.filter((b) => b.id !== boardId));
      const metricsRes = await fetch(`${API_URL}/api/boards/metrics`, {
        headers: authHeaders,
      });
      if (metricsRes.ok) setMetrics(await metricsRes.json());
    } catch {}
  };

  const metricsCards = [
    {
      id: "total-diagrams",
      label: "TOTAL DIAGRAMS",
      value: metrics ? metrics.totalBoards.toString() : "—",
      icon: <LayoutGrid className="w-5 h-5 text-accent-cyan/60" />,
      change: null,
    },
    {
      id: "total-components",
      label: "TOTAL COMPONENTS",
      value: metrics ? metrics.totalNodes.toString() : "—",
      icon: <Boxes className="w-5 h-5 text-accent-cyan/60" />,
      change: metrics && metrics.totalBoards > 0
        ? `avg ${Math.round(metrics.totalNodes / metrics.totalBoards)} per board · ${metrics.totalEdges} connections`
        : null,
    },
    {
      id: "system-uptime",
      label: "SERVER UPTIME",
      value: metrics ? formatUptime(metrics.uptimeSeconds) : "—",
      icon: null,
      live: !!metrics,
    },
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />

      <main className="pt-14">
        <div className="max-w-6xl mx-auto px-6 py-8">
          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div>
              <h1 className="font-display text-2xl font-bold text-text-primary mb-1">
                System Overview
              </h1>
              <p className="text-sm text-text-muted font-mono">
                {loading ? (
                  <span className="text-text-muted">Loading...</span>
                ) : boards.length > 0 ? (
                  <>
                    <span className="text-accent-cyan">{boards.length}</span>
                    {" "}architecture{boards.length !== 1 ? "s" : ""} ·{" "}
                    <span className="text-accent-cyan">{metrics?.totalNodes || 0}</span>
                    {" "}total nodes
                  </>
                ) : (
                  <span className="text-text-muted">No architectures yet</span>
                )}
              </p>
            </div>
            <button
              onClick={handleCreateBoard}
              disabled={creating}
              id="new-project-btn"
              className="btn-primary flex items-center gap-2 text-sm"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              New Project
            </button>
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
            {metricsCards.map((metric) => (
              <div
                key={metric.id}
                id={`metric-${metric.id}`}
                className="card p-5 flex flex-col justify-between min-h-[120px]"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-display text-text-muted uppercase tracking-wider">
                    {metric.label}
                  </span>
                  {metric.icon && metric.icon}
                  {metric.live && (
                    <span className="flex items-center gap-1.5 text-[11px] font-display text-status-active">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-active animate-pulse" />
                      Live
                    </span>
                  )}
                </div>
                <div className="flex items-end gap-2">
                  <span className="font-display text-3xl font-bold text-text-primary">
                    {loading ? (
                      <span className="w-16 h-8 bg-surface-light rounded animate-pulse inline-block" />
                    ) : (
                      metric.value
                    )}
                  </span>
                  {metric.change && (
                    <span className="text-xs text-accent-cyan mb-1 font-mono">
                      {metric.change}
                    </span>
                  )}
                </div>
                {metric.id === "system-uptime" && metrics && (
                  <div className="mt-3 h-1 w-full bg-surface-lighter rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-accent-cyan to-accent-cyan/70 rounded-full transition-all duration-1000"
                      style={{ width: "100%" }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Recent Architectures */}
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-lg font-semibold text-text-primary">
              {boards.length > 0 ? "Recent Architectures" : "Get Started"}
            </h2>
            {boards.length > 3 && (
              <Link
                href="/history"
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-accent-cyan transition-colors font-display"
              >
                View All
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Real board cards */}
            {boards.map((board, idx) => (
              <Link
                key={board.id}
                href={`/canvas/${board.id}`}
                id={`board-card-${board.id}`}
                className="card group flex flex-col overflow-hidden hover:border-accent-cyan/30 transition-all"
              >
                {/* Thumbnail area */}
                <div className="h-32 bg-canvas-50 border-b border-border relative overflow-hidden">
                  <div className="absolute inset-0 canvas-grid opacity-60" />
                  {/* Decorative nodes based on real count */}
                  {Array.from({ length: Math.min(board.nodeCount, 4) }).map(
                    (_, i) => (
                      <div
                        key={i}
                        className="absolute bg-surface-light border border-border rounded-sm opacity-40"
                        style={{
                          width: 40 + Math.random() * 30,
                          height: 24,
                          top: 12 + i * 25,
                          left: 12 + (i % 2) * 50 + Math.random() * 20,
                        }}
                      />
                    )
                  )}
                  {board.nodeCount === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-xs text-text-muted/40 font-mono">Empty</span>
                    </div>
                  )}
                  <span className="absolute top-2 right-2 flex items-center gap-1.5">
                    {board.isPublic ? (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-status-active/10 border border-status-active/20 text-status-active text-[9px] font-mono">
                        <Globe className="w-2.5 h-2.5" />
                        PUBLIC
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-surface border border-border text-text-muted text-[9px] font-mono">
                        <Lock className="w-2.5 h-2.5" />
                        PRIVATE
                      </span>
                    )}
                    <span className="badge-cyan text-[10px]">
                      {getTag(board.name)}
                    </span>
                  </span>
                </div>

                {/* Info */}
                <div className="p-3 flex-1 flex flex-col">
                  <h3 className="font-display font-semibold text-sm text-text-primary mb-0.5 group-hover:text-accent-cyan transition-colors">
                    {board.name}
                  </h3>
                  <p className="text-xs text-text-muted font-mono mb-3 line-clamp-2">
                    {board.description || `${board.nodeCount} nodes · ${board.edgeCount} edges`}
                  </p>
                  <div className="mt-auto flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 text-[11px] text-text-muted">
                          <Clock className="w-3 h-3" />
                          {timeAgo(board.updatedAt)}
                        </span>
                        {board.ownerId !== userId && board.ownerId !== "system" && (
                          <span className="text-[10px] font-mono text-accent-purple">
                            by {board.ownerName}
                          </span>
                        )}
                      </div>
                      {(board.ownerId === userId || board.ownerId === "system") && (
                        <button
                          onClick={(e) => handleDeleteBoard(board.id, e)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-sm hover:bg-status-error/20 transition-all"
                          title="Delete board"
                        >
                          <Trash2 className="w-3 h-3 text-status-error" />
                        </button>
                      )}
                    </div>
                </div>
              </Link>
            ))}

            {/* Blank Canvas Card */}
            <button
              onClick={handleCreateBoard}
              disabled={creating}
              id="blank-canvas-card"
              className="card group flex flex-col items-center justify-center min-h-[240px]
                         border-dashed hover:border-accent-cyan/40 hover:shadow-glow-cyan transition-all cursor-pointer"
            >
              <div className="w-12 h-12 rounded-md bg-surface-light border border-border flex items-center justify-center mb-3 group-hover:border-accent-cyan/30 transition-colors">
                {creating ? (
                  <Loader2 className="w-5 h-5 text-accent-cyan animate-spin" />
                ) : (
                  <Plus className="w-5 h-5 text-text-muted group-hover:text-accent-cyan transition-colors" />
                )}
              </div>
              <span className="font-display font-semibold text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                Blank Canvas
              </span>
              <span className="text-xs text-text-muted mt-1">
                Start a new architecture
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
