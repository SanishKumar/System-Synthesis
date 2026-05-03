"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";

const USER_ID_KEY = "ss_user_id";
const USER_NAME_KEY = "ss_username";

function generateDefaultName(): string {
  const adjectives = ["Swift", "Clever", "Bold", "Bright", "Sharp", "Keen"];
  const nouns = ["Architect", "Builder", "Designer", "Engineer", "Planner", "Mapper"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

/**
 * Persistent device-based user identity.
 * 
 * - Generates a UUID on first visit (stored in localStorage)
 * - Manages display name (also in localStorage)
 * - Provides headers for API calls
 */
export function useUser() {
  const [userId, setUserId] = useState<string>("");
  const [userName, setUserNameState] = useState<string>("User");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Get or create user ID
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = uuidv4();
      localStorage.setItem(USER_ID_KEY, id);
    }
    setUserId(id);

    // Get or create display name
    let name = localStorage.getItem(USER_NAME_KEY);
    if (!name) {
      name = generateDefaultName();
      localStorage.setItem(USER_NAME_KEY, name);
    }
    setUserNameState(name);

    setIsReady(true);
  }, []);

  const setUserName = useCallback((name: string) => {
    setUserNameState(name);
    localStorage.setItem(USER_NAME_KEY, name);
  }, []);

  /**
   * Standard headers to attach to all API calls.
   */
  const authHeaders = useMemo(() => ({
    "x-user-id": userId,
    "x-user-name": userName,
  }), [userId, userName]);

  return {
    userId,
    userName,
    setUserName,
    authHeaders,
    isReady,
  };
}
