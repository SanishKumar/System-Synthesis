"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { v4 as uuidv4 } from "uuid";
import { reconnectSocket } from "@/lib/socket";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

const USER_ID_KEY = "ss_user_id";
const USER_NAME_KEY = "ss_username";
const AUTH_TOKEN_KEY = "ss_auth_token";
const AUTH_GUEST_KEY = "ss_auth_is_guest";

interface AuthSnapshot {
  userId: string;
  userName: string;
  token: string | null;
  isGuest: boolean;
  isReady: boolean;
}

interface TokenClaims {
  userId: string;
  userName: string;
  exp?: number;
}

const INITIAL_AUTH_SNAPSHOT: AuthSnapshot = {
  userId: "",
  userName: "User",
  token: null,
  isGuest: true,
  isReady: false,
};

let authSnapshot = INITIAL_AUTH_SNAPSHOT;
let initializationPromise: Promise<void> | null = null;
const authListeners = new Set<() => void>();

function generateDefaultName(): string {
  const adjectives = ["Swift", "Clever", "Bold", "Bright", "Sharp", "Keen"];
  const nouns = ["Architect", "Builder", "Designer", "Engineer", "Planner", "Mapper"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

function subscribe(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function publishAuth(next: AuthSnapshot): void {
  authSnapshot = next;
  authListeners.forEach((listener) => listener());
}

function updateAuth(patch: Partial<AuthSnapshot>): void {
  publishAuth({ ...authSnapshot, ...patch });
}

function decodeTokenClaims(token: string): TokenClaims | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as Partial<TokenClaims>;
    if (typeof claims.userId !== "string" || typeof claims.userName !== "string") return null;
    if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
    return claims as TokenClaims;
  } catch {
    return null;
  }
}

function persistSession(
  token: string,
  user: { userId: string; userName: string },
  isGuest: boolean
): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(USER_ID_KEY, user.userId);
  localStorage.setItem(USER_NAME_KEY, user.userName);
  localStorage.setItem(AUTH_GUEST_KEY, String(isGuest));
  publishAuth({
    userId: user.userId,
    userName: user.userName,
    token,
    isGuest,
    isReady: true,
  });
}

async function initializeAuth(): Promise<void> {
  if (typeof window === "undefined") return;

  // A valid-looking stored JWT is enough for the client to become interactive.
  // Every API and socket request still verifies its signature on the server.
  const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
  if (storedToken) {
    const claims = decodeTokenClaims(storedToken);
    if (claims) {
      const storedGuest = localStorage.getItem(AUTH_GUEST_KEY);
      persistSession(
        storedToken,
        { userId: claims.userId, userName: claims.userName },
        storedGuest === null ? claims.userId.startsWith("guest-") : storedGuest === "true"
      );
      return;
    }
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }

  const localId = localStorage.getItem(USER_ID_KEY) || uuidv4();
  const localName = localStorage.getItem(USER_NAME_KEY) || generateDefaultName();

  try {
    const response = await fetch(`${API_URL}/api/auth/guest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: localName }),
    });
    if (response.ok) {
      const data = await response.json();
      persistSession(data.token, data.user, true);
      return;
    }
  } catch {
    // The canvas demo remains available without a running API.
  }

  localStorage.setItem(USER_ID_KEY, localId);
  localStorage.setItem(USER_NAME_KEY, localName);
  publishAuth({
    userId: localId,
    userName: localName,
    token: null,
    isGuest: true,
    isReady: true,
  });
}

function ensureAuthInitialized(): Promise<void> {
  if (!initializationPromise) initializationPromise = initializeAuth();
  return initializationPromise;
}

/**
 * Shared JWT identity for the whole client application. All hook consumers
 * subscribe to one snapshot, so mounting navigation and pages cannot repeat
 * guest provisioning or profile verification work.
 */
export function useUser() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => authSnapshot,
    () => INITIAL_AUTH_SNAPSHOT
  );

  useEffect(() => {
    void ensureAuthInitialized();
  }, []);

  const setUserName = useCallback(async (name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    updateAuth({ userName: trimmedName });
    localStorage.setItem(USER_NAME_KEY, trimmedName);
    const currentToken = authSnapshot.token;
    if (!currentToken) return;

    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({ userName: trimmedName }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.token) {
          persistSession(
            data.token,
            { userId: authSnapshot.userId, userName: data.userName || trimmedName },
            authSnapshot.isGuest
          );
          reconnectSocket();
        }
      }
    } catch {
      // Best-effort display-name update while offline.
    }
  }, []);

  const register = useCallback(async (
    userName: string,
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName, email, password }),
      });
      const data = await response.json();
      if (response.ok) {
        persistSession(data.token, data.user, false);
        reconnectSocket();
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: "Server not reachable" };
    }
  }, []);

  const upgradeGuest = useCallback(async (
    userName: string,
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const currentToken = authSnapshot.token;
      const response = await fetch(`${API_URL}/api/auth/upgrade`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
        },
        body: JSON.stringify({ userName, email, password }),
      });
      const data = await response.json();
      if (response.ok) {
        persistSession(data.token, data.user, false);
        reconnectSocket();
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: "Server not reachable" };
    }
  }, []);

  const login = useCallback(async (
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (response.ok) {
        persistSession(data.token, data.user, false);
        reconnectSocket();
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: "Server not reachable" };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_GUEST_KEY);
    initializationPromise = null;
    publishAuth(INITIAL_AUTH_SNAPSHOT);
    reconnectSocket();
    void ensureAuthInitialized();
  }, []);

  const authHeaders = useMemo((): Record<string, string> => {
    return snapshot.token ? { Authorization: `Bearer ${snapshot.token}` } : {};
  }, [snapshot.token]);

  return {
    ...snapshot,
    setUserName,
    authHeaders,
    register,
    upgradeGuest,
    login,
    logout,
  };
}
