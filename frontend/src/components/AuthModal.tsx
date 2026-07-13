"use client";

import React, { useState, useRef, useEffect } from "react";
import { useUser } from "@/hooks/useUser";
import { X, Loader2, Workflow, LogIn, UserPlus } from "lucide-react";

interface AuthModalProps {
  onClose: () => void;
}

export default function AuthModal({ onClose }: AuthModalProps) {
  const { register, login, isGuest, userName: currentName, upgradeGuest } = useUser();
  const [mode, setMode] = useState<"login" | "register">(isGuest ? "register" : "login");
  const [userName, setUserName] = useState(isGuest ? currentName : "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Focus email input on mount
  useEffect(() => {
    setTimeout(() => emailRef.current?.focus(), 100);
  }, [mode]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (mode === "register") {
      if (!userName.trim() || userName.trim().length < 2) {
        setError("Name must be at least 2 characters");
        setLoading(false);
        return;
      }
      if (!email.trim()) {
        setError("Email is required");
        setLoading(false);
        return;
      }
      if (!password || password.length < 8) {
        setError("Password must be at least 8 characters");
        setLoading(false);
        return;
      }
      let result;
      if (isGuest) {
        result = await upgradeGuest(userName.trim(), email.trim(), password);
      } else {
        result = await register(userName.trim(), email.trim(), password);
      }
      
      if (result.success) {
        onClose();
      } else {
        setError(result.error || "Registration failed");
      }
    } else {
      if (!email.trim() || !password) {
        setError("Email and password are required");
        setLoading(false);
        return;
      }
      const result = await login(email.trim(), password);
      if (result.success) {
        onClose();
      } else {
        setError(result.error || "Login failed");
      }
    }

    setLoading(false);
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[#1d2135]/25 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative mx-4 w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-float)] animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pb-5 pt-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan text-white shadow-[0_7px_18px_rgba(108,79,247,0.2)]">
              <Workflow className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold tracking-[-0.02em] text-text-primary">
                {mode === "login" ? "Welcome back" : isGuest ? "Keep this workspace" : "Create an account"}
              </h2>
              <p className="text-[11px] text-text-muted">
                {mode === "login"
                  ? "Continue to your architecture graphs"
                  : isGuest ? "Turn this guest identity into an account" : "Save and share your architecture graphs"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-ghost p-1.5 rounded-sm"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="mx-6 flex rounded-lg bg-canvas-50 p-1">
          <button
            onClick={() => { setMode("login"); setError(null); }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold transition-all ${
              mode === "login"
                ? "bg-surface text-text-primary shadow-[0_1px_3px_rgba(29,33,53,0.08)]"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <LogIn className="w-3.5 h-3.5" />
            Sign In
          </button>
          <button
            onClick={() => { setMode("register"); setError(null); }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold transition-all ${
              mode === "register"
                ? "bg-surface text-text-primary shadow-[0_1px_3px_rgba(29,33,53,0.08)]"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            {isGuest ? "Save Account" : "Register"}
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {mode === "register" && (
            <div>
              <label className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">
                Display Name
              </label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="input w-full text-sm h-10"
                placeholder="Your name"
                autoComplete="name"
              />
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">
              Email
            </label>
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input w-full text-sm h-10"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input w-full text-sm h-10"
              placeholder="••••••••"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-status-error/20 bg-status-error/10 p-2.5 text-xs text-status-error">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2 py-2.5 text-sm"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {mode === "login" ? "Signing in..." : isGuest ? "Saving account..." : "Creating account..."}
              </>
            ) : (
              <>
                {mode === "login" ? (
                  <LogIn className="w-4 h-4" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                {mode === "login" ? "Sign In" : isGuest ? "Save Account" : "Create Account"}
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <div className="px-6 pb-5 text-center">
          <p className="text-[11px] text-text-muted">
            {mode === "login" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  onClick={() => { setMode("register"); setError(null); }}
                  className="text-accent-cyan hover:underline font-display font-semibold"
                >
                  Register
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => { setMode("login"); setError(null); }}
                  className="text-accent-cyan hover:underline font-display font-semibold"
                >
                  Sign In
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
