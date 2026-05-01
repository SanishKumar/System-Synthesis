"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import {
  Clock,
  Trash2,
  Boxes,
  ArrowUpDown,
  Loader2,
  Plus,
  ArrowLeft,
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
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
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
        const res = await fetch(`${API_URL}/api/boards`, { headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          setBoards(data.boards || []);
        }
      } catch {}
      setLoading(false);
    }
    fetchBoards();
  }, [isReady, userId]);

  const handleDelete = async (boardId: string) => {
    if (!confirm("Delete this architecture? This cannot be undone.")) return;
    try {
      await fetch(`${API_URL}/api/boards/${boardId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      setBoards((prev) => prev.filter((b) => b.id !== boardId));
    } catch {}
  };

  const handleCreateBoard = async () => {
    try {
      const res = await fetch(`${API_URL}/api/boards`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled Board" }),
      });
      if (res.ok) {
        const board = await res.json();
        router.push(`/canvas/${board.id}`);
      }
    } catch {}
  };

  const sorted = [...boards].sort((a, b) => {
    const diff =
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return sortAsc ? -diff : diff;
  });

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />
      <main className="pt-14">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="btn-ghost p-2 rounded-sm hover:bg-surface-light"
              >
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div>
                <h1 className="font-display text-xl font-bold text-text-primary">
                  All Architectures
                </h1>
                <p className="text-xs text-text-muted font-mono mt-0.5">
                  {boards.length} board{boards.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSortAsc(!sortAsc)}
                className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-display"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                {sortAsc ? "Oldest first" : "Newest first"}
              </button>
              <button
                onClick={handleCreateBoard}
                className="btn-primary flex items-center gap-1.5 text-xs px-3 py-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                New Board
              </button>
            </div>
          </div>

          {/* Board List */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 text-accent-cyan animate-spin" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <Boxes className="w-10 h-10 text-text-muted/30 mb-3" />
              <p className="text-sm text-text-muted font-display mb-4">
                No architectures yet
              </p>
              <button
                onClick={handleCreateBoard}
                className="btn-primary flex items-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" />
                Create your first
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {sorted.map((board) => (
                <Link
                  key={board.id}
                  href={`/canvas/${board.id}`}
                  className="flex items-center gap-4 px-4 py-3 bg-surface border border-border rounded-sm hover:border-accent-cyan/30 transition-all group"
                >
                  {/* Icon */}
                  <div className="w-9 h-9 rounded-sm bg-accent-cyan/10 border border-accent-cyan/20 flex items-center justify-center shrink-0">
                    <Boxes className="w-4 h-4 text-accent-cyan" />
                  </div>

                  {/* Name + description */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-display font-semibold text-text-primary group-hover:text-accent-cyan transition-colors truncate">
                      {board.name}
                    </h3>
                    <p className="text-[11px] text-text-muted font-mono truncate">
                      {board.description || "No description"}
                    </p>
                  </div>

                  {/* Stats */}
                  <div className="hidden sm:flex items-center gap-4 text-[11px] text-text-muted font-mono shrink-0">
                    <span>{board.nodeCount} nodes</span>
                    <span>{board.edgeCount} edges</span>
                  </div>

                  {/* Time */}
                  <span className="flex items-center gap-1 text-[11px] text-text-muted shrink-0">
                    <Clock className="w-3 h-3" />
                    {timeAgo(board.updatedAt)}
                  </span>

                  {/* Delete */}
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDelete(board.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-sm hover:bg-status-error/20 transition-all shrink-0"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-status-error" />
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
