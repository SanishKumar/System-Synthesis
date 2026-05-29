"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { reconnectSocket } from "@/lib/socket";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

const USER_ID_KEY = "ss_user_id";
const USER_NAME_KEY = "ss_username";
const AUTH_TOKEN_KEY = "ss_auth_token";

function generateDefaultName(): string {
  const adjectives = ["Swift", "Clever", "Bold", "Bright", "Sharp", "Keen"];
  const nouns = ["Architect", "Builder", "Designer", "Engineer", "Planner", "Mapper"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

/**
 * User identity hook with JWT authentication support.
 *
 * - On first load: checks for stored JWT token
 * - If no token: auto-provisions a guest JWT from the server
 * - Falls back to device-based UUID if server is unreachable
 * - Provides `authHeaders` for API calls (Bearer token or legacy x-user-id)
 * - Provides `token` for Socket.io auth handshake
 */
export function useUser() {
  const [userId, setUserId] = useState<string>("");
  const [userName, setUserNameState] = useState<string>("User");
  const [token, setTokenState] = useState<string | null>(null);
  const [isGuest, setIsGuest] = useState(true);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    initAuth();
  }, []);

  async function initAuth() {
    // 1. Check for existing JWT
    const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);

    if (storedToken) {
      // Verify token is still valid by calling /me
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${storedToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUserId(data.userId);
          setUserNameState(data.userName);
          setTokenState(storedToken);
          setIsGuest(data.isGuest ?? true);
          setIsReady(true);
          return;
        }
        // Token expired/invalid — fall through to guest
        localStorage.removeItem(AUTH_TOKEN_KEY);
      } catch {
        // Server unreachable — use local fallback
      }
    }

    // 2. Try to get a guest token from the server
    const localId = localStorage.getItem(USER_ID_KEY) || uuidv4();
    const localName = localStorage.getItem(USER_NAME_KEY) || generateDefaultName();

    try {
      const res = await fetch(`${API_URL}/api/auth/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName: localName }),
      });
      if (res.ok) {
        const data = await res.json();
        setUserId(data.user.userId);
        setUserNameState(data.user.userName);
        setTokenState(data.token);
        setIsGuest(true);
        localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        localStorage.setItem(USER_ID_KEY, data.user.userId);
        localStorage.setItem(USER_NAME_KEY, data.user.userName);
        setIsReady(true);
        return;
      }
    } catch {
      // Server unreachable — pure local fallback
    }

    // 3. Pure local fallback (no JWT)
    localStorage.setItem(USER_ID_KEY, localId);
    localStorage.setItem(USER_NAME_KEY, localName);
    setUserId(localId);
    setUserNameState(localName);
    setIsGuest(true);
    setIsReady(true);
  }

  const setUserName = useCallback((name: string) => {
    setUserNameState(name);
    localStorage.setItem(USER_NAME_KEY, name);
  }, []);

  /**
   * Register a new account. Returns true on success.
   */
  const register = useCallback(async (userName: string, email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName, email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserId(data.user.userId);
        setUserNameState(data.user.userName);
        setTokenState(data.token);
        setIsGuest(false);
        localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        localStorage.setItem(USER_ID_KEY, data.user.userId);
        localStorage.setItem(USER_NAME_KEY, data.user.userName);
        // Re-establish socket with new JWT
        reconnectSocket();
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: "Server not reachable" };
    }
  }, []);

  /**
   * Login with email + password. Returns true on success.
   */
  const login = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserId(data.user.userId);
        setUserNameState(data.user.userName);
        setTokenState(data.token);
        setIsGuest(false);
        localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        localStorage.setItem(USER_ID_KEY, data.user.userId);
        localStorage.setItem(USER_NAME_KEY, data.user.userName);
        // Re-establish socket with new JWT
        reconnectSocket();
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: "Server not reachable" };
    }
  }, []);

  /**
   * Logout — clears JWT and reverts to guest.
   */
  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setTokenState(null);
    setIsGuest(true);
    // Re-establish socket as guest
    reconnectSocket();
    // Re-init as guest
    initAuth();
  }, []);

  /**
   * Standard headers to attach to all API calls.
   * Uses Bearer token if available, falls back to legacy headers.
   */
  const authHeaders = useMemo((): Record<string, string> => {
    const headers: Record<string, string> = {
      "x-user-id": userId,
      "x-user-name": userName,
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }, [token, userId, userName]);

  return {
    userId,
    userName,
    setUserName,
    token,
    isGuest,
    authHeaders,
    isReady,
    register,
    login,
    logout,
  };
}
