"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useUser } from "@/hooks/useUser";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

export default function AcceptInvitationPage() {
  const params = useParams();
  const router = useRouter();
  const { authHeaders, isReady } = useUser();
  const attempted = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isReady || attempted.current) return;
    attempted.current = true;
    const token = params.token as string;

    async function accept() {
      try {
        const response = await fetch(`${API_URL}/api/boards/invitations/${encodeURIComponent(token)}/accept`, {
          method: "POST",
          headers: authHeaders,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setError(data.error || "This invitation cannot be used.");
          return;
        }
        const membership = await response.json();
        router.replace(`/canvas/${membership.boardId}`);
      } catch {
        setError("The server could not be reached.");
      }
    }

    void accept();
  }, [authHeaders, isReady, params.token, router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 text-center shadow-[var(--shadow-soft)]">
        {error ? (
          <>
            <TriangleAlert className="mx-auto mb-4 h-9 w-9 text-status-error" />
            <h1 className="font-display text-xl font-bold text-text-primary">Invitation unavailable</h1>
            <p className="mt-2 text-sm leading-6 text-text-secondary">{error}</p>
            <button onClick={() => router.replace("/")} className="btn-primary mt-6">Back to workspaces</button>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-purple/10 text-accent-purple">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h1 className="font-display text-xl font-bold text-text-primary">Joining workspace</h1>
            <p className="mt-2 text-sm text-text-secondary">Validating the single-use invitation and your signed identity.</p>
            <Loader2 className="mx-auto mt-5 h-5 w-5 animate-spin text-accent-purple" />
          </>
        )}
      </section>
    </main>
  );
}
