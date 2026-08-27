"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Clipboard,
  Eye,
  EyeOff,
  Github,
  KeyRound,
  Link2,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import type {
  IssuedReviewIntegration,
  ReviewIntegration,
} from "@/types/integrations";

const API_URL = (process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000").replace(/\/$/, "");
const INGESTION_URL = `${API_URL}/api/review-ingestions/github`;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function relativeTime(value: string | null): string {
  if (!value) return "Never used";
  const milliseconds = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fallbackCopy(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyText(value: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else if (!fallbackCopy(value)) throw new Error("Copy unavailable");
    toast.success(`${label} copied`);
  } catch {
    if (fallbackCopy(value)) toast.success(`${label} copied`);
    else toast.error("Could not access the clipboard. Select and copy the value manually.");
  }
}

export default function IntegrationsPage() {
  const { authenticatedFetch, isGuest, isReady, userId } = useUser();
  const [integrations, setIntegrations] = useState<ReviewIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [repository, setRepository] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedReviewIntegration | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    action: "rotate" | "revoke";
    integration: ReviewIntegration;
  } | null>(null);

  const activeIntegrations = useMemo(
    () => integrations.filter((integration) => !integration.revokedAt),
    [integrations]
  );

  const loadIntegrations = useCallback(async () => {
    if (!isReady) return;
    if (isGuest) {
      setIntegrations([]);
      setLoading(false);
      return;
    }
    try {
      const response = await authenticatedFetch(`${API_URL}/api/review-integrations`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not load repository connections.");
      setIntegrations(body.integrations || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load repository connections.");
    } finally {
      setLoading(false);
    }
  }, [authenticatedFetch, isGuest, isReady]);

  useEffect(() => {
    setLoading(true);
    void loadIntegrations();
  }, [loadIntegrations, userId]);

  const issueCredential = async (repositoryName: string) => {
    setSubmitting(true);
    try {
      const response = await authenticatedFetch(`${API_URL}/api/review-integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "github", repository: repositoryName }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not connect the repository.");
      const next = body as IssuedReviewIntegration;
      setIssued(next);
      setShowToken(false);
      setRepository("");
      setIntegrations((current) => [
        next.integration,
        ...current.filter((integration) => integration.id !== next.integration.id),
      ]);
      toast.success("Repository credential issued");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect the repository.");
    } finally {
      setSubmitting(false);
      setBusyId(null);
      setConfirmation(null);
    }
  };

  const submitRepository = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = repository.trim().toLowerCase();
    if (!REPOSITORY_PATTERN.test(normalized)) {
      toast.error("Use the GitHub owner/repository format.");
      return;
    }
    const existing = integrations.find(
      (integration) => integration.repository === normalized && !integration.revokedAt
    );
    if (existing) {
      setConfirmation({ action: "rotate", integration: existing });
      return;
    }
    void issueCredential(normalized);
  };

  const revokeCredential = async (integration: ReviewIntegration) => {
    setBusyId(integration.id);
    try {
      const response = await authenticatedFetch(
        `${API_URL}/api/review-integrations/${integration.id}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Could not revoke the credential.");
      }
      const revokedAt = new Date().toISOString();
      setIntegrations((current) => current.map((item) =>
        item.id === integration.id ? { ...item, revokedAt, updatedAt: revokedAt } : item
      ));
      toast.success("Repository credential revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the credential.");
    } finally {
      setBusyId(null);
      setConfirmation(null);
    }
  };

  const workflowSnippet = `- name: Review architecture change
  uses: SanishKumar/System-Synthesis@v0.2.0
  with:
    compose-path: compose.yaml
    base-revision: \${{ github.event.pull_request.base.sha }}
    head-revision: \${{ github.event.pull_request.head.sha }}
    ingestion-url: \${{ vars.SYSTEM_SYNTHESIS_INGESTION_URL }}
    ingestion-token: \${{ secrets.SYSTEM_SYNTHESIS_INGESTION_TOKEN }}`;

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />
      <main className="pt-16">
        <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6 lg:px-8 lg:pt-12">
          <section className="mb-8 grid gap-6 border-b border-border pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-[10px] font-mono font-semibold uppercase tracking-[0.17em] text-accent-cyan">
                <Link2 className="h-3.5 w-3.5" />
                Repository connections
              </div>
              <h1 className="max-w-3xl font-display text-3xl font-bold tracking-[-0.04em] text-text-primary sm:text-4xl">
                Send pull-request impact to one durable review.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary">
                Issue a repository-scoped credential, add it to GitHub Actions, and keep every commit on the same pull request connected to one interactive architecture review.
              </p>
            </div>
            {!isGuest && (
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Connected" value={activeIntegrations.length} />
                <Metric label="Total" value={integrations.length} />
              </div>
            )}
          </section>

          {!isReady || loading ? (
            <div className="card flex min-h-72 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-accent-cyan" />
            </div>
          ) : isGuest ? (
            <section className="card overflow-hidden">
              <div className="grid gap-8 p-7 md:grid-cols-[auto_minmax(0,1fr)] md:p-10">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
                  <LockKeyhole className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-text-muted">Account required</p>
                  <h2 className="mt-2 font-display text-2xl font-bold tracking-[-0.03em] text-text-primary">
                    Repository credentials need a permanent owner.
                  </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
                    Guest sessions are temporary and cannot own a GitHub integration. Open the account menu in the top-right, then register or sign in before connecting a repository.
                  </p>
                </div>
              </div>
            </section>
          ) : (
            <>
              <ReviewerIdentityPanel />

              {issued && (
                <CredentialPanel
                  issued={issued}
                  showToken={showToken}
                  ingestionUrl={INGESTION_URL}
                  workflowSnippet={workflowSnippet}
                  onToggleToken={() => setShowToken((current) => !current)}
                  onDismiss={() => {
                    setIssued(null);
                    setShowToken(false);
                  }}
                />
              )}

              <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
                <section className="card h-fit p-5 sm:p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
                    <Github className="h-[18px] w-[18px]" />
                  </div>
                  <h2 className="mt-5 font-display text-xl font-bold tracking-[-0.025em] text-text-primary">
                    Connect a repository
                  </h2>
                  <p className="mt-2 text-xs leading-5 text-text-secondary">
                    Creating another credential for an active repository rotates its token immediately.
                  </p>
                  <form onSubmit={submitRepository} className="mt-5">
                    <label htmlFor="integration-repository" className="mb-2 block text-[11px] font-semibold text-text-secondary">
                      GitHub owner/repository
                    </label>
                    <input
                      id="integration-repository"
                      className="input font-mono text-xs"
                      value={repository}
                      onChange={(event) => setRepository(event.target.value)}
                      placeholder="your-org/your-repository"
                      autoComplete="off"
                    />
                    <button
                      id="connect-repository"
                      type="submit"
                      disabled={submitting || !repository.trim()}
                      className="btn-primary mt-3 h-10 w-full gap-2 text-xs"
                    >
                      {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                      Connect repository
                    </button>
                  </form>
                  <div className="mt-6 border-t border-border pt-5">
                    <div className="flex items-start gap-3">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-status-active" />
                      <p className="text-[11px] leading-5 text-text-muted">
                        Tokens are repository-scoped, shown once, stored as hashes, and never sent to fork pull requests.
                      </p>
                    </div>
                  </div>
                </section>

                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h2 className="font-display text-lg font-bold text-text-primary">Your repositories</h2>
                      <p className="mt-1 text-xs text-text-muted">Credential activity from persisted Action uploads.</p>
                    </div>
                    <button onClick={() => void loadIntegrations()} className="btn-ghost flex items-center gap-2 text-xs">
                      <RefreshCw className="h-3.5 w-3.5" /> Refresh
                    </button>
                  </div>
                  {integrations.length === 0 ? (
                    <div className="card flex min-h-56 flex-col items-center justify-center px-6 text-center">
                      <Github className="h-6 w-6 text-text-muted" />
                      <h3 className="mt-4 font-display text-base font-semibold text-text-primary">No repositories connected</h3>
                      <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">
                        Connect the first repository to create a credential and get exact GitHub Actions setup instructions.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {integrations.map((integration) => (
                        <IntegrationCard
                          key={integration.id}
                          integration={integration}
                          busy={busyId === integration.id || submitting}
                          onRotate={() => setConfirmation({ action: "rotate", integration })}
                          onReconnect={() => {
                            setBusyId(integration.id);
                            void issueCredential(integration.repository);
                          }}
                          onRevoke={() => setConfirmation({ action: "revoke", integration })}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </main>

      {confirmation && (
        <ConfirmationDialog
          action={confirmation.action}
          repository={confirmation.integration.repository}
          busy={busyId === confirmation.integration.id || submitting}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setBusyId(confirmation.integration.id);
            if (confirmation.action === "rotate") {
              void issueCredential(confirmation.integration.repository);
            } else {
              void revokeCredential(confirmation.integration);
            }
          }}
        />
      )}
    </div>
  );
}

/** Why a link attempt ended the way it did, in words rather than codes. */
const IDENTITY_RESULT: Record<string, { tone: "ok" | "bad"; message: string }> = {
  linked: { tone: "ok", message: "GitHub account linked." },
  state_invalid: { tone: "bad", message: "That authorization could not be matched to your account. Start again." },
  code_rejected: { tone: "bad", message: "GitHub rejected the authorization. Start again." },
  identity_lookup_failed: { tone: "bad", message: "GitHub did not return an account for that authorization." },
  github_unreachable: { tone: "bad", message: "GitHub could not be reached. Try again shortly." },
  already_linked: { tone: "bad", message: "That GitHub account is already linked to another account here." },
  not_configured: { tone: "bad", message: "This server has no GitHub identity configured." },
  unexpected_error: { tone: "bad", message: "The link failed unexpectedly. The server log records why." },
};

/**
 * Which GitHub account this reviewer is.
 *
 * A decision is currently attributed to whoever holds a session here, an
 * identity this product issued to itself. Linking a GitHub account is what lets
 * a decision name a person GitHub agrees exists — the step every entitlement
 * check has to be built on.
 */
function ReviewerIdentityPanel() {
  const { authenticatedFetch, isReady } = useUser();
  const [identity, setIdentity] = useState<{ login: string; linkedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_URL}/api/auth/me`);
      const body = await response.json();
      setIdentity(body?.github ? { login: body.github.login, linkedAt: body.github.linkedAt } : null);
    } catch {
      setIdentity(null);
    } finally {
      setLoading(false);
    }
  }, [authenticatedFetch]);

  useEffect(() => {
    if (isReady) void load();
  }, [isReady, load]);

  // The callback returns here with the outcome of the round trip.
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("github");
    if (!outcome) return;
    const result = IDENTITY_RESULT[outcome] || IDENTITY_RESULT.unexpected_error;
    if (result.tone === "ok") toast.success(result.message);
    else toast.error(result.message);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${API_URL}/api/auth/github/start`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Could not start the GitHub authorization.");
      window.location.href = body.url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the GitHub authorization.");
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${API_URL}/api/auth/github`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not unlink the GitHub account.");
      setIdentity(null);
      toast.success("GitHub account unlinked.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not unlink the GitHub account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mb-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-mono font-semibold uppercase tracking-[0.15em] text-text-muted">
            <Github className="h-3.5 w-3.5" />
            Reviewer identity
          </div>
          <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-text-primary">
            {loading ? "Checking…" : identity ? `Verified as ${identity.login}` : "This account is not linked to GitHub"}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
            {identity
              ? "Decisions made here can be attributed to a GitHub account, not only to a session on this server."
              : "A decision is currently recorded against this account alone, which GitHub knows nothing about. Linking proves who you are there; it does not yet grant or check permission on a repository."}
          </p>
        </div>
        {!loading && (
          <button
            onClick={() => void (identity ? unlink() : connect())}
            disabled={busy}
            className={identity ? "btn-secondary h-9 gap-2 text-xs" : "btn-primary h-9 gap-2 text-xs"}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />}
            {identity ? "Unlink" : "Link GitHub account"}
          </button>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-24 rounded-xl border border-border bg-surface px-4 py-3 text-right">
      <p className="font-display text-xl font-bold text-text-primary">{value}</p>
      <p className="mt-0.5 text-[9px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</p>
    </div>
  );
}

function CredentialPanel({
  issued,
  showToken,
  ingestionUrl,
  workflowSnippet,
  onToggleToken,
  onDismiss,
}: {
  issued: IssuedReviewIntegration;
  showToken: boolean;
  ingestionUrl: string;
  workflowSnippet: string;
  onToggleToken: () => void;
  onDismiss: () => void;
}) {
  const masked = `${issued.ingestionToken.slice(0, 10)}${"•".repeat(28)}${issued.ingestionToken.slice(-5)}`;
  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-accent-cyan/25 bg-surface shadow-[var(--shadow-soft)]">
      <div className="flex items-start justify-between gap-4 border-b border-border bg-accent-cyan/[0.045] px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-cyan text-white">
            <KeyRound className="h-4 w-4" />
          </span>
          <div>
            <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-accent-cyan">Shown once</p>
            <h2 className="mt-1 font-display text-lg font-bold text-text-primary">Save the credential for {issued.integration.repository}</h2>
          </div>
        </div>
        <button onClick={onDismiss} className="btn-ghost !p-2" aria-label="Dismiss credential instructions">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <p className="text-xs font-semibold text-text-primary">1. Add the repository secret</p>
          <p className="mt-1 text-[11px] leading-5 text-text-muted">Name it <code className="font-mono text-text-secondary">SYSTEM_SYNTHESIS_INGESTION_TOKEN</code>.</p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-canvas-50 p-2">
            <code className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-text-primary">{showToken ? issued.ingestionToken : masked}</code>
            <button onClick={onToggleToken} className="btn-ghost !p-2" aria-label={showToken ? "Hide token" : "Reveal token"}>
              {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => void copyText(issued.ingestionToken, "Token")} className="btn-secondary h-8 gap-1.5 !px-2.5 text-[10px]">
              <Clipboard className="h-3 w-3" /> Copy
            </button>
          </div>

          <p className="mt-5 text-xs font-semibold text-text-primary">2. Add the repository variable</p>
          <p className="mt-1 text-[11px] leading-5 text-text-muted">Name it <code className="font-mono text-text-secondary">SYSTEM_SYNTHESIS_INGESTION_URL</code>.</p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-canvas-50 p-2">
            <code className="min-w-0 flex-1 truncate px-1 font-mono text-[10px] text-text-primary">{ingestionUrl}</code>
            <button onClick={() => void copyText(ingestionUrl, "Endpoint")} className="btn-secondary h-8 gap-1.5 !px-2.5 text-[10px]">
              <Clipboard className="h-3 w-3" /> Copy
            </button>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-text-primary">3. Pin the Action in your workflow</p>
              <p className="mt-1 text-[11px] leading-5 text-text-muted">Use a reviewed full commit SHA, not a mutable branch.</p>
            </div>
            <button onClick={() => void copyText(workflowSnippet, "Workflow")} className="btn-secondary h-8 gap-1.5 !px-2.5 text-[10px]">
              <Clipboard className="h-3 w-3" /> Copy
            </button>
          </div>
          <pre className="mt-3 max-h-56 overflow-auto rounded-xl border border-border bg-[#171620] p-4 font-mono text-[10px] leading-5 text-[#d9d5e5]">
            {workflowSnippet}
          </pre>
          <button onClick={onDismiss} className="btn-primary mt-4 h-9 gap-2 text-xs">
            <Check className="h-3.5 w-3.5" /> I saved the credential
          </button>
        </div>
      </div>
    </section>
  );
}

function IntegrationCard({
  integration,
  busy,
  onRotate,
  onReconnect,
  onRevoke,
}: {
  integration: ReviewIntegration;
  busy: boolean;
  onRotate: () => void;
  onReconnect: () => void;
  onRevoke: () => void;
}) {
  const active = !integration.revokedAt;
  return (
    <article className="card !transform-none p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${active ? "bg-text-primary text-surface" : "bg-canvas-100 text-text-muted"}`}>
            <Github className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-display text-sm font-bold text-text-primary">{integration.repository}</h3>
              <span className={active ? "badge-green" : "badge"}>{active ? "Connected" : "Revoked"}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-text-muted">
              <span>{integration.tokenPrefix}…</span>
              <span>Last delivery: {relativeTime(integration.lastUsedAt)}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {active ? (
            <>
              <button disabled={busy} onClick={onRotate} className="btn-secondary h-9 gap-2 text-[11px]">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Rotate
              </button>
              <button disabled={busy} onClick={onRevoke} className="flex h-9 items-center gap-2 rounded-md border border-status-error/20 px-3 text-[11px] font-semibold text-status-error hover:bg-status-error/10 disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" /> Revoke
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={onReconnect} className="btn-secondary h-9 gap-2 text-[11px]">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Reconnect
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ConfirmationDialog({
  action,
  repository,
  busy,
  onCancel,
  onConfirm,
}: {
  action: "rotate" | "revoke";
  repository: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const rotating = action === "rotate";
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111019]/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-float)]">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${rotating ? "bg-status-warning/10 text-status-warning" : "bg-status-error/10 text-status-error"}`}>
          {rotating ? <KeyRound className="h-[18px] w-[18px]" /> : <Trash2 className="h-[18px] w-[18px]" />}
        </span>
        <h2 className="mt-5 font-display text-xl font-bold tracking-[-0.025em] text-text-primary">
          {rotating ? "Rotate repository token?" : "Revoke repository token?"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-text-secondary">
          {rotating
            ? `The current ${repository} secret will stop working immediately. You must replace it in GitHub Actions.`
            : `${repository} will stop sending browser reviews until you reconnect it.`}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button disabled={busy} onClick={onCancel} className="btn-secondary h-9 text-xs">Cancel</button>
          <button disabled={busy} onClick={onConfirm} className={rotating ? "btn-primary h-9 gap-2 text-xs" : "flex h-9 items-center gap-2 rounded-md bg-status-error px-4 text-xs font-semibold text-white disabled:opacity-50"}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {rotating ? "Rotate token" : "Revoke token"}
          </button>
        </div>
      </div>
    </div>
  );
}
