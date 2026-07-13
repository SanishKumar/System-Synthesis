"use client";

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { useBoardStore } from "@/store/boardStore";
import {
  ChevronDown,
  Container,
  Download,
  FileCode,
  FileText,
  History,
  Image as ImageIcon,
  LogIn,
  LogOut,
  Moon,
  Pencil,
  Search,
  Sparkles,
  Sun,
  Workflow,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";
const AuthModal = dynamic(() => import("@/components/AuthModal"), { ssr: false });

interface TopNavProps {
  onMessCleanup?: () => void;
  isMessCleanupActive?: boolean;
  onToggleMessCleanup?: (active: boolean) => void;
  onExportPng?: () => void;
}

interface SearchResult {
  id: string;
  name: string;
  nodeCount: number;
}

export default function TopNav({
  onMessCleanup,
  isMessCleanupActive = false,
  onToggleMessCleanup,
  onExportPng,
}: TopNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isCanvas = pathname.startsWith("/canvas");
  const { userId, userName, authHeaders, isGuest, logout } = useUser();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [exportLoading, setExportLoading] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [lastBoard, setLastBoard] = useState<string | null>(null);

  const [isEditingBoardName, setIsEditingBoardName] = useState(false);
  const [editBoardName, setEditBoardName] = useState("");
  const boardNameInputRef = useRef<HTMLInputElement>(null);
  const storeBoardName = useBoardStore((state) => state.boardName);
  const storeBoardId = useBoardStore((state) => state.boardId);
  const storeBoardRole = useBoardStore((state) => state.boardRole);

  const searchRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const storedTheme = localStorage.getItem("ss_theme") as "dark" | "light" | null;
    const initialTheme = storedTheme || "light";
    setTheme(initialTheme);
    document.documentElement.setAttribute("data-theme", initialTheme);
    setLastBoard(localStorage.getItem("ss_last_board"));
  }, []);

  useEffect(() => {
    function closeMenus(event: MouseEvent) {
      const target = event.target as Node;
      if (searchRef.current && !searchRef.current.contains(target)) setShowSearch(false);
      if (userRef.current && !userRef.current.contains(target)) setShowUserMenu(false);
      if (exportRef.current && !exportRef.current.contains(target)) setShowExportMenu(false);
    }
    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${API_URL}/api/boards`, { headers: authHeaders });
        if (!response.ok) return;
        const data = await response.json();
        const query = searchQuery.toLowerCase();
        setSearchResults(
          (data.boards || [])
            .filter((board: SearchResult) => board.name.toLowerCase().includes(query))
            .map((board: SearchResult) => ({
              id: board.id,
              name: board.name,
              nodeCount: board.nodeCount,
            }))
        );
        setShowSearch(true);
      } catch {
        setSearchResults([]);
      }
    }, 220);

    return () => clearTimeout(timer);
  }, [searchQuery, authHeaders]);

  const navLinks = [
    { href: "/", label: "Workspaces" },
    { href: lastBoard ? `/canvas/${lastBoard}` : "/canvas", label: "Canvas" },
    { href: "/history", label: "Versions" },
  ];

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localStorage.setItem("ss_theme", nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  };

  const handleAutoLayout = () => {
    if (isMessCleanupActive) return;
    onToggleMessCleanup?.(true);
    onMessCleanup?.();
  };

  const saveBoardName = async () => {
    setIsEditingBoardName(false);
    const nextName = editBoardName.trim();
    if (!nextName || nextName === storeBoardName) return;
    try {
      await fetch(`${API_URL}/api/boards/${storeBoardId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ name: nextName }),
      });
      useBoardStore.setState({ boardName: nextName });
    } catch {
      setEditBoardName(storeBoardName);
    }
  };

  const downloadText = (content: string, type: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportJson = () => {
    const store = useBoardStore.getState();
    downloadText(
      JSON.stringify(
        {
          boardId: store.boardId,
          boardName: store.boardName,
          nodes: store.getSerializedNodes(),
          edges: store.getSerializedEdges(),
        },
        null,
        2
      ),
      "application/json",
      `${store.boardName || "architecture"}.json`
    );
    setShowExportMenu(false);
  };

  const exportFromServer = async (kind: "docker" | "terraform" | "report") => {
    setExportLoading(kind);
    const store = useBoardStore.getState();
    try {
      const endpoint = kind === "docker" ? "docker-compose" : kind;
      const response = await fetch(`${API_URL}/api/export/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          boardId: store.boardId,
          nodes: store.getSerializedNodes(),
          edges: store.getSerializedEdges(),
          boardName: store.boardName,
        }),
      });

      if (response.ok && kind === "terraform") {
        const bundle = await response.json();
        for (const [filename, content] of Object.entries(bundle)) {
          downloadText(content as string, "text/plain", filename);
        }
      } else if (response.ok) {
        const text = await response.text();
        downloadText(
          text,
          kind === "docker" ? "text/yaml" : "text/markdown",
          kind === "docker"
            ? "docker-compose.yml"
            : `${store.boardName || "architecture"}-report.md`
        );
      }
    } finally {
      setExportLoading(null);
      setShowExportMenu(false);
    }
  };

  return (
    <>
      <nav
        id="top-nav"
        className="fixed inset-x-0 top-0 z-50 flex h-16 items-center gap-3 border-b border-border bg-surface/95 px-3 backdrop-blur-xl sm:px-5"
      >
        <Link href="/" id="nav-logo" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-cyan text-white shadow-[0_7px_18px_rgba(108,79,247,0.22)]">
            <Workflow className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </span>
          <span className="hidden font-display text-[15px] font-bold tracking-[-0.02em] text-text-primary sm:block">
            System Synthesis
          </span>
        </Link>

        <div className="hidden items-center gap-1 rounded-lg bg-canvas-50 p-1 md:flex">
          {navLinks.map((link) => {
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href.split("/").slice(0, 2).join("/"));
            return (
              <Link
                key={link.label}
                href={link.href}
                id={`nav-link-${link.label.toLowerCase()}`}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                  active
                    ? "bg-surface text-text-primary shadow-[0_1px_3px_rgba(29,33,53,0.08)]"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        {isCanvas && storeBoardName && (
          <div className="hidden min-w-0 items-center gap-2 border-l border-border pl-3 lg:flex">
            <span className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-text-muted">
              Board
            </span>
            {isEditingBoardName && storeBoardRole === "owner" ? (
              <input
                ref={boardNameInputRef}
                value={editBoardName}
                onChange={(event) => setEditBoardName(event.target.value)}
                onBlur={saveBoardName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  if (event.key === "Escape") {
                    setEditBoardName(storeBoardName);
                    setIsEditingBoardName(false);
                  }
                }}
                className="max-w-[210px] border-b border-accent-cyan bg-transparent px-0.5 text-sm font-semibold text-text-primary outline-none"
                autoFocus
              />
            ) : (
              <button
                onClick={() => {
                  if (storeBoardRole !== "owner") return;
                  setEditBoardName(storeBoardName);
                  setIsEditingBoardName(true);
                  setTimeout(() => boardNameInputRef.current?.focus(), 40);
                }}
                className="group flex max-w-[210px] items-center gap-1.5 truncate text-sm font-semibold text-text-primary"
                title={storeBoardRole === "owner" ? "Rename board" : "Only the owner can rename this board"}
              >
                <span className="truncate">{storeBoardName}</span>
                {storeBoardRole === "owner" && (
                  <Pencil className="h-3 w-3 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                )}
              </button>
            )}
          </div>
        )}

        <div className="flex-1" />

        {!isCanvas && (
          <div ref={searchRef} className="relative hidden lg:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              id="nav-search"
              type="search"
              placeholder="Search workspaces"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => searchQuery && setShowSearch(true)}
              className="input h-9 w-60 bg-canvas-50 pl-9 text-xs"
            />
            {showSearch && (
              <div className="absolute right-0 top-11 w-72 overflow-hidden rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-float)]">
                {searchResults.length ? (
                  searchResults.map((result) => (
                    <button
                      key={result.id}
                      onClick={() => {
                        router.push(`/canvas/${result.id}`);
                        setShowSearch(false);
                        setSearchQuery("");
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-surface-light"
                    >
                      <span className="truncate text-xs font-semibold text-text-primary">{result.name}</span>
                      <span className="ml-3 shrink-0 text-[10px] font-mono text-text-muted">{result.nodeCount} nodes</span>
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-text-muted">No matching workspaces</p>
                )}
              </div>
            )}
          </div>
        )}

        {isCanvas && (
          <>
            <button
              id="mess-cleanup-toggle"
              onClick={handleAutoLayout}
              className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-all ${
                isMessCleanupActive
                  ? "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
                  : "border-border bg-surface text-text-secondary hover:border-border-light hover:text-text-primary"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Auto layout</span>
            </button>

            <div ref={exportRef} className="relative">
              <button
                id="export-dropdown-btn"
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-xs font-semibold text-text-secondary transition-all hover:border-border-light hover:text-text-primary"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Export</span>
                <ChevronDown className={`hidden h-3 w-3 transition-transform sm:block ${showExportMenu ? "rotate-180" : ""}`} />
              </button>

              {showExportMenu && (
                <div className="absolute right-0 top-11 w-64 overflow-hidden rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-float)] animate-fade-in">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-text-muted">
                    Deterministic exports
                  </p>
                  <ExportItem icon={<ImageIcon className="h-4 w-4" />} label="Canvas image" detail="PNG snapshot" onClick={() => { onExportPng?.(); setShowExportMenu(false); }} />
                  <ExportItem icon={<FileCode className="h-4 w-4" />} label="Graph data" detail="Canonical JSON" onClick={exportJson} />
                  <ExportItem icon={<Container className="h-4 w-4" />} label="Docker Compose" detail="Supported resource subset" loading={exportLoading === "docker"} onClick={() => exportFromServer("docker")} />
                  <ExportItem icon={<FileCode className="h-4 w-4" />} label="Terraform" detail="Pinned provider files" loading={exportLoading === "terraform"} onClick={() => exportFromServer("terraform")} />
                  <ExportItem icon={<FileText className="h-4 w-4" />} label="Design document" detail="Markdown report" loading={exportLoading === "report"} onClick={() => exportFromServer("report")} />
                </div>
              )}
            </div>
          </>
        )}

        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-light hover:text-text-primary"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <div ref={userRef} className="relative">
          <button
            id="nav-avatar"
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-accent-cyan/20 bg-accent-cyan/10 text-[11px] font-bold text-accent-cyan"
            aria-label="Open account menu"
          >
            {userName.slice(0, 2).toUpperCase()}
          </button>
          {showUserMenu && (
            <div className="absolute right-0 top-11 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-float)] animate-fade-in">
              <div className="border-b border-border px-3 py-2.5">
                <p className="text-sm font-semibold text-text-primary">{userName}</p>
                <p className="mt-0.5 text-[10px] font-mono text-text-muted">
                  {isGuest ? "Guest workspace" : `Account ${userId.slice(0, 8)}`}
                </p>
              </div>
              <Link href="/history" onClick={() => setShowUserMenu(false)} className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-light hover:text-text-primary">
                <History className="h-3.5 w-3.5" /> Version history
              </Link>
              {isGuest ? (
                <button onClick={() => { setShowAuthModal(true); setShowUserMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-accent-cyan hover:bg-accent-cyan/10">
                  <LogIn className="h-3.5 w-3.5" /> Sign in or register
                </button>
              ) : (
                <button onClick={() => { logout(); setShowUserMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-status-error hover:bg-status-error/10">
                  <LogOut className="h-3.5 w-3.5" /> Log out
                </button>
              )}
            </div>
          )}
        </div>
      </nav>

      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
    </>
  );
}

function ExportItem({
  icon,
  label,
  detail,
  loading = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-text-secondary transition-colors hover:bg-surface-light hover:text-text-primary disabled:opacity-50"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-canvas-50 text-accent-cyan">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{loading ? "Preparing…" : label}</span>
        <span className="block truncate text-[10px] text-text-muted">{detail}</span>
      </span>
    </button>
  );
}
