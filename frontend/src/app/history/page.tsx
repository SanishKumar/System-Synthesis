"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import {
  ArrowLeft,
  ArrowUpDown,
  Boxes,
  Clock3,
  GitBranch,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

interface BoardSummary {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function HistoryPage() {
  const router = useRouter();
  const { userId, authHeaders, isReady } = useUser();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    if (!isReady) return;
    async function fetchBoards() {
      try {
        const response = await fetch(`${API_URL}/api/boards`, { headers: authHeaders });
        if (response.ok) {
          const data = await response.json();
          setBoards(data.boards || []);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchBoards();
  }, [isReady, userId, authHeaders]);

  const handleDelete = async (boardId: string) => {
    if (!confirm("Delete this architecture? This cannot be undone.")) return;
    try {
      await fetch(`${API_URL}/api/boards/${boardId}`, { method: "DELETE", headers: authHeaders });
      setBoards((current) => current.filter((board) => board.id !== boardId));
    } catch {}
  };

  const handleCreateBoard = async () => {
    try {
      const response = await fetch(`${API_URL}/api/boards`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled architecture" }),
      });
      if (response.ok) {
        const board = await response.json();
        router.push(`/canvas/${board.id}`);
        return;
      }
    } catch {}
    router.push("/canvas/demo-ecommerce");
  };

  const sorted = [...boards].sort((a, b) => {
    const difference = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return sortAsc ? -difference : difference;
  });

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />
      <main className="pt-16">
        <div className="mx-auto max-w-5xl px-4 py-9 sm:px-6 lg:px-8 lg:py-12">
          <header className="mb-8 flex flex-col gap-5 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-xs font-semibold text-text-muted hover:text-text-primary">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to workspaces
              </Link>
              <p className="mb-2 text-[10px] font-mono font-semibold uppercase tracking-[0.16em] text-accent-cyan">Graph archive</p>
              <h1 className="font-display text-3xl font-bold tracking-[-0.035em] text-text-primary">Architecture history</h1>
              <p className="mt-2 text-sm text-text-secondary">Open, sort, or remove saved architecture workspaces.</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setSortAsc(!sortAsc)} className="btn-secondary gap-2 text-xs">
                <ArrowUpDown className="h-3.5 w-3.5" /> {sortAsc ? "Oldest first" : "Newest first"}
              </button>
              <button onClick={handleCreateBoard} className="btn-primary gap-2 text-xs">
                <Plus className="h-3.5 w-3.5" /> New architecture
              </button>
            </div>
          </header>

          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary">All workspaces</h2>
            <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-[10px] font-mono text-text-muted">
              {boards.length} total
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center rounded-2xl border border-border bg-surface py-24">
              <Loader2 className="h-5 w-5 animate-spin text-accent-cyan" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-light bg-surface px-6 py-20 text-center">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-canvas-50 text-text-muted"><Boxes className="h-5 w-5" /></div>
              <h3 className="text-sm font-bold text-text-primary">No saved architecture yet</h3>
              <p className="mt-1 text-xs text-text-muted">Create a workspace to begin building its graph history.</p>
              <button onClick={handleCreateBoard} className="btn-primary mt-5 gap-2 text-xs"><Plus className="h-3.5 w-3.5" /> Create workspace</button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border bg-surface">
              {sorted.map((board) => (
                <Link key={board.id} href={`/canvas/${board.id}`} className="group flex items-center gap-4 border-b border-border px-4 py-4 transition-colors last:border-b-0 hover:bg-surface-light sm:px-5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.07] text-accent-cyan">
                    <GitBranch className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-bold text-text-primary transition-colors group-hover:text-accent-cyan">{board.name}</h3>
                    <p className="mt-0.5 truncate text-[11px] text-text-muted">{board.description || "No description"}</p>
                  </div>
                  <div className="hidden items-center gap-5 text-[10px] font-mono text-text-muted sm:flex">
                    <span>{board.nodeCount} components</span>
                    <span>{board.edgeCount} connections</span>
                  </div>
                  <span className="hidden items-center gap-1.5 text-[10px] text-text-muted md:flex"><Clock3 className="h-3 w-3" /> {timeAgo(board.updatedAt)}</span>
                  <button
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); handleDelete(board.id); }}
                    className="rounded-lg p-2 text-text-muted opacity-0 transition-all hover:bg-status-error/10 hover:text-status-error group-hover:opacity-100"
                    aria-label={`Delete ${board.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
