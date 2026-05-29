"use client";

import { io, Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from "@system-synthesis/shared";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";
const AUTH_TOKEN_KEY = "ss_auth_token";

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

/**
 * Returns the singleton Socket.io client.
 * The socket stays alive for the entire app session — 
 * individual boards join/leave rooms without disconnecting.
 *
 * JWT token is attached in the auth handshake for server-side verification.
 */
export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (!socket) {
    // Read token at connection time
    const token = typeof window !== "undefined"
      ? localStorage.getItem(AUTH_TOKEN_KEY)
      : null;

    socket = io(SOCKET_URL, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      auth: token ? { token } : {},
    });
  }
  return socket;
}

/**
 * Force-reconnect with a new token (called after login/register).
 */
export function reconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  // Next call to getSocket() will create a new connection with the new token
}
