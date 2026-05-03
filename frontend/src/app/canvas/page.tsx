"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

export default function NewCanvasRedirect() {
  const router = useRouter();
  const { authHeaders, isReady } = useUser();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) return;

    async function createAndRedirect() {
      try {
        const res = await fetch(`${API_URL}/api/boards`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Untitled Board" }),
        });
        if (res.ok) {
          const board = await res.json();
          router.replace(`/canvas/${board.id}`);
        } else {
          router.replace("/canvas/demo-ecommerce");
        }
      } catch {
        router.replace("/canvas/demo-ecommerce");
      }
    }
    createAndRedirect();
  }, [router, isReady]);

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-canvas">
      {error ? (
        <p className="text-status-error font-mono text-sm">{error}</p>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent-cyan border-t-transparent rounded-full animate-spin" />
          <p className="text-text-muted text-sm font-display">Creating new board...</p>
        </div>
      )}
    </div>
  );
}
