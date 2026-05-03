"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import {
  Search,
  Bell,
  Settings,
  Sparkles,
  User,
  Workflow,
  X,
  Check,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

interface TopNavProps {
  onMessCleanup?: () => void;
  isMessCleanupActive?: boolean;
  onToggleMessCleanup?: (active: boolean) => void;
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
}: TopNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const { userId, userName, setUserName: saveUserName, authHeaders } = useUser();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [notifications, setNotifications] = useState<string[]>([
    "System Synthesis server connected",
  ]);

  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  // Load theme from localStorage
  useEffect(() => {
    const storedTheme = localStorage.getItem("ss_theme") as "dark" | "light" | null;
    if (storedTheme) {
      setTheme(storedTheme);
      document.documentElement.setAttribute("data-theme", storedTheme);
    }
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node))
        setShowSearch(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node))
        setShowNotifications(false);
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node))
        setShowSettings(false);
      if (userRef.current && !userRef.current.contains(e.target as Node))
        setShowUserMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Live search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/api/boards`, {
          headers: authHeaders,
        });
        if (res.ok) {
          const data = await res.json();
          const filtered = (data.boards || []).filter((b: any) =>
            b.name.toLowerCase().includes(searchQuery.toLowerCase())
          );
          setSearchResults(
            filtered.map((b: any) => ({
              id: b.id,
              name: b.name,
              nodeCount: b.nodeCount,
            }))
          );
          setShowSearch(true);
        }
      } catch {}
    }, 200);

    return () => clearTimeout(timer);
  }, [searchQuery]);



  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    localStorage.setItem("ss_theme", newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
  };

  const [lastBoard, setLastBoard] = useState<string | null>(null);

  // Read last board from localStorage AFTER hydration to avoid mismatch
  useEffect(() => {
    const stored = localStorage.getItem("ss_last_board");
    if (stored) setLastBoard(stored);
  }, []);

  const navLinks = [
    { href: "/", label: "Files" },
    { href: lastBoard ? `/canvas/${lastBoard}` : "/canvas", label: "Canvas" },
    { href: "/history", label: "History" },
  ];

  const handleToggle = () => {
    const newState = !isMessCleanupActive;
    onToggleMessCleanup?.(newState);
    if (newState) {
      onMessCleanup?.();
    }
  };

  return (
    <nav
      id="top-nav"
      className="fixed top-0 left-0 right-0 h-14 bg-surface border-b border-border z-50 flex items-center px-4 gap-4"
    >
      {/* Logo */}
      <Link
        href="/"
        id="nav-logo"
        className="flex items-center gap-2 mr-2 shrink-0"
      >
        <Workflow className="w-5 h-5 text-accent-cyan" />
        <span className="font-display font-bold text-sm tracking-wider text-accent-cyan uppercase">
          System Synthesis
        </span>
      </Link>

      {/* Nav Links */}
      <div className="flex items-center gap-1">
        {navLinks.map((link) => {
          const isActive =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href.split("/").slice(0, 2).join("/")) &&
                link.href !== "/";
          return (
            <Link
              key={link.label}
              href={link.href}
              id={`nav-link-${link.label.toLowerCase()}`}
              className={`px-3 py-1.5 text-sm font-display transition-colors duration-150 rounded-sm ${
                isActive
                  ? "text-accent-cyan"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {link.label}
              {isActive && (
                <div className="h-0.5 bg-accent-cyan mt-1 rounded-full" />
              )}
            </Link>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* Search */}
      <div ref={searchRef} className="relative hidden md:flex items-center">
        <Search className="absolute left-3 w-4 h-4 text-text-muted z-10" />
        <input
          id="nav-search"
          type="text"
          placeholder="Search projects..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => searchQuery && setShowSearch(true)}
          className="input pl-9 w-56 text-xs h-8"
        />
        {showSearch && searchResults.length > 0 && (
          <div className="absolute top-10 left-0 w-72 bg-surface border border-border rounded-md shadow-card z-50 overflow-hidden">
            {searchResults.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  router.push(`/canvas/${r.id}`);
                  setShowSearch(false);
                  setSearchQuery("");
                }}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-surface-light transition-colors border-b border-border last:border-0"
              >
                <span className="text-xs font-display text-text-primary truncate">
                  {r.name}
                </span>
                <span className="text-[10px] text-text-muted font-mono shrink-0 ml-2">
                  {r.nodeCount} nodes
                </span>
              </button>
            ))}
          </div>
        )}
        {showSearch && searchQuery && searchResults.length === 0 && (
          <div className="absolute top-10 left-0 w-72 bg-surface border border-border rounded-md shadow-card z-50 p-3">
            <p className="text-xs text-text-muted text-center">No results found</p>
          </div>
        )}
      </div>

      {/* Mess Cleanup Toggle */}
      {pathname.startsWith("/canvas") && (
        <button
          id="mess-cleanup-toggle"
          onClick={handleToggle}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-sm text-xs font-display font-semibold transition-all duration-200 border ${
            isMessCleanupActive
              ? "bg-accent-cyan/15 border-accent-cyan text-accent-cyan shadow-glow-cyan"
              : "bg-surface-light border-border text-text-secondary hover:border-border-light hover:text-text-primary"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Mess Cleanup
          <div
            className="toggle-track ml-1 w-8 h-4"
            data-active={isMessCleanupActive.toString()}
          >
            <div className="toggle-thumb w-3 h-3" />
          </div>
        </button>
      )}

      {/* Right Icons */}
      <div className="flex items-center gap-2">
        {/* Notifications */}
        <div ref={notifRef} className="relative">
          <button
            id="nav-notifications"
            onClick={() => {
              setShowNotifications(!showNotifications);
              setShowSettings(false);
              setShowUserMenu(false);
            }}
            className="btn-ghost p-2 rounded-sm relative"
          >
            <Bell className="w-4 h-4" />
            {notifications.length > 0 && (
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-accent-cyan rounded-full" />
            )}
          </button>
          {showNotifications && (
            <div className="absolute top-10 right-0 w-72 bg-surface border border-border rounded-md shadow-card z-50">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-xs font-display font-semibold text-text-primary">
                  Notifications
                </span>
                {notifications.length > 0 && (
                  <button
                    onClick={() => setNotifications([])}
                    className="text-[10px] text-text-muted hover:text-accent-cyan transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="p-4 text-center">
                  <p className="text-xs text-text-muted">No notifications</p>
                </div>
              ) : (
                notifications.map((n, i) => (
                  <div
                    key={i}
                    className="px-3 py-2.5 text-xs text-text-secondary border-b border-border last:border-0 flex items-start gap-2"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan mt-1 shrink-0" />
                    {n}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Settings */}
        <div ref={settingsRef} className="relative">
          <button
            id="nav-settings"
            onClick={() => {
              setShowSettings(!showSettings);
              setShowNotifications(false);
              setShowUserMenu(false);
            }}
            className="btn-ghost p-2 rounded-sm"
          >
            <Settings className="w-4 h-4" />
          </button>
          {showSettings && (
            <div className="absolute top-10 right-0 w-64 bg-surface border border-border rounded-md shadow-card z-50 p-4 space-y-3">
              <h4 className="text-xs font-display font-semibold text-text-primary uppercase tracking-wider">
                Settings
              </h4>
              <div>
                <label className="text-[11px] text-text-muted font-display block mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => saveUserName(e.target.value)}
                  className="input w-full text-xs h-8"
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="text-[11px] text-text-muted font-display block mb-1">
                  Theme
                </label>
                <button
                  onClick={toggleTheme}
                  className="w-full flex items-center gap-2 px-3 py-2 bg-canvas rounded-sm border border-border text-xs text-text-muted hover:border-accent-cyan transition-all"
                >
                  <span className={`w-3 h-3 rounded-full border border-border ${theme === "dark" ? "bg-canvas" : "bg-white"}`} />
                  {theme === "dark" ? "Dark Mode" : "Light Mode"}
                  <span className="ml-auto text-[10px] text-accent-cyan">Switch</span>
                </button>
              </div>

            </div>
          )}
        </div>

        {/* User Avatar */}
        <div ref={userRef} className="relative">
          <button
            id="nav-avatar"
            onClick={() => {
              setShowUserMenu(!showUserMenu);
              setShowNotifications(false);
              setShowSettings(false);
            }}
            className="w-8 h-8 rounded-sm bg-accent-purple/20 border border-accent-purple/30 flex items-center justify-center"
          >
            <span className="text-[10px] font-display font-bold text-accent-purple">
              {userName.slice(0, 2).toUpperCase()}
            </span>
          </button>
          {showUserMenu && (
            <div className="absolute top-10 right-0 w-48 bg-surface border border-border rounded-md shadow-card z-50 overflow-hidden">
              <div className="px-3 py-3 border-b border-border">
                <p className="text-sm font-display font-semibold text-text-primary">
                  {userName}
                </p>
                <p className="text-[10px] text-text-muted font-mono mt-0.5">
                  ID: {userId.slice(0, 8)}…
                </p>
              </div>
              <button
                onClick={() => {
                  const name = prompt("Enter new display name:", userName);
                  if (name) saveUserName(name);
                  setShowUserMenu(false);
                }}
                className="w-full px-3 py-2 text-xs text-text-secondary text-left hover:bg-surface-light transition-colors"
              >
                Change Name
              </button>
              <Link
                href="/history"
                onClick={() => setShowUserMenu(false)}
                className="block px-3 py-2 text-xs text-text-secondary hover:bg-surface-light transition-colors"
              >
                View All Boards
              </Link>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
