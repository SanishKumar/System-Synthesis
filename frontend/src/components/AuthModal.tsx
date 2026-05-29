"use client";

import React, { useState, useRef, useEffect } from "react";
import { useUser } from "@/hooks/useUser";
import { X, Loader2, Workflow, LogIn, UserPlus } from "lucide-react";

interface AuthModalProps {
  onClose: () => void;
}

export default function AuthModal({ onClose }: AuthModalProps) {
  const { register, login } = useUser();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [userName, setUserName] = useState("");
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
      if (!password || password.length < 6) {
        setError("Password must be at least 6 characters");
        setLoading(false);
        return;
      }
      const result = await register(userName.trim(), email.trim(), password);
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative w-full max-w-sm bg-surface border border-border rounded-lg shadow-2xl animate-fade-in overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-md bg-accent-cyan/15 border border-accent-cyan/30 flex items-center justify-center">
              <Workflow className="w-5 h-5 text-accent-cyan" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-text-primary">
                {mode === "login" ? "Welcome Back" : "Create Account"}
              </h2>
              <p className="text-[11px] text-text-muted">
                {mode === "login"
                  ? "Sign in to your account"
                  : "Join System Synthesis"}
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
        <div className="flex border-b border-border mx-6">
          <button
            onClick={() => { setMode("login"); setError(null); }}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-display font-semibold uppercase tracking-wider transition-all flex-1 justify-center ${
              mode === "login"
                ? "text-accent-cyan border-b-2 border-accent-cyan"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <LogIn className="w-3.5 h-3.5" />
            Sign In
          </button>
          <button
            onClick={() => { setMode("register"); setError(null); }}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-display font-semibold uppercase tracking-wider transition-all flex-1 justify-center ${
              mode === "register"
                ? "text-accent-cyan border-b-2 border-accent-cyan"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            Register
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {mode === "register" && (
            <div>
              <label className="text-[11px] text-text-muted font-display block mb-1.5 uppercase tracking-wider">
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
            <label className="text-[11px] text-text-muted font-display block mb-1.5 uppercase tracking-wider">
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
            <label className="text-[11px] text-text-muted font-display block mb-1.5 uppercase tracking-wider">
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
            <div className="p-2.5 rounded-sm bg-status-error/10 border border-status-error/30 text-status-error text-xs font-display">
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
                {mode === "login" ? "Signing in..." : "Creating account..."}
              </>
            ) : (
              <>
                {mode === "login" ? (
                  <LogIn className="w-4 h-4" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                {mode === "login" ? "Sign In" : "Create Account"}
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <div className="px-6 pb-5 text-center">
          <p className="text-[11px] text-text-muted">
            {mode === "login" ? (
              <>
                Don't have an account?{" "}
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
