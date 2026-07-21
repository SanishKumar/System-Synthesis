"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  ShieldCheck,
  ShieldX,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import {
  findingLocation,
  type ReviewEvent,
  type ReviewRecord,
} from "@/types/reviews";
import type { ValidationIssue, ValidationSeverity } from "@system-synthesis/shared";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

const severityStyle: Record<ValidationSeverity, string> = {
  critical: "border-red-500/25 bg-red-500/10 text-red-600",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-600",
  info: "border-blue-500/25 bg-blue-500/10 text-blue-600",
};

function shortRevision(value: string): string {
  return value.length > 14 ? value.slice(0, 10) : value;
}

function eventLabel(event: ReviewEvent): string {
  if (event.eventType === "review.created") return "Review created";
  if (event.eventType === "suppression.added") return "Exception accepted";
  return `Decision changed to ${String(event.data.decision || "pending")}`;
}

export default function ReviewDetailPage() {
  const params = useParams<{ reviewId: string }>();
  const reviewId = Array.isArray(params.reviewId) ? params.reviewId[0] : params.reviewId;
  const { authenticatedFetch, isReady, userId } = useUser();
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [selectedFinding, setSelectedFinding] = useState<ValidationIssue | null>(null);
  const [justification, setJustification] = useState("");
  const [ticket, setTicket] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [decisionNote, setDecisionNote] = useState("");

  const loadReview = useCallback(async () => {
    if (!isReady || !reviewId) return;
    try {
      const [reviewResponse, eventsResponse] = await Promise.all([
        authenticatedFetch(`${API_URL}/api/reviews/${reviewId}`),
        authenticatedFetch(`${API_URL}/api/reviews/${reviewId}/events`),
      ]);
      if (!reviewResponse.ok) {
        const body = await reviewResponse.json().catch(() => null);
        throw new Error(body?.error || "Architecture review not found.");
      }
      const record = await reviewResponse.json();
      const eventBody = eventsResponse.ok ? await eventsResponse.json() : { events: [] };
      setReview(record);
      setEvents(eventBody.events || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the review.");
    } finally {
      setLoading(false);
    }
  }, [authenticatedFetch, isReady, reviewId]);

  useEffect(() => {
    void loadReview();
  }, [loadReview, userId]);

  const nodeChanges = useMemo(() => {
    if (!review) return [];
    const changes = new Map(
      review.report.diff.changes
        .filter((change) => change.entity === "node")
        .map((change) => [change.entityId, change])
    );
    const headIds = new Set(review.headGraph.nodes.map((node) => node.id));
    return [
      ...review.headGraph.nodes.map((node) => ({
        node,
        change: changes.get(node.id),
      })),
      ...review.baseGraph.nodes
        .filter((node) => !headIds.has(node.id))
        .map((node) => ({ node, change: changes.get(node.id) })),
    ].sort((left, right) =>
      String(left.node.data.label).localeCompare(String(right.node.data.label))
    );
  }, [review]);

  const submitSuppression = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!review || !selectedFinding || mutating) return;
    setMutating(true);
    try {
      const response = await authenticatedFetch(
        `${API_URL}/api/reviews/${review.id}/suppressions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: review.revision,
            ruleId: selectedFinding.ruleId,
            findingId: selectedFinding.id,
            justification,
            ticket: ticket || undefined,
            expiresAt: expiresOn
              ? new Date(`${expiresOn}T23:59:59.000Z`).toISOString()
              : undefined,
          }),
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) void loadReview();
        throw new Error(body?.error || "Could not accept this exception.");
      }
      setReview(body);
      setSelectedFinding(null);
      setJustification("");
      setTicket("");
      setExpiresOn("");
      toast.success("Exception recorded with justification");
      const eventResponse = await authenticatedFetch(
        `${API_URL}/api/reviews/${review.id}/events`
      );
      if (eventResponse.ok) setEvents((await eventResponse.json()).events || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not accept this exception.");
    } finally {
      setMutating(false);
    }
  };

  const decide = async (decision: "approved" | "rejected") => {
    if (!review || mutating) return;
    if (decision === "rejected" && decisionNote.trim().length < 3) {
      toast.error("Add a short reason before rejecting this change.");
      return;
    }
    setMutating(true);
    try {
      const response = await authenticatedFetch(
        `${API_URL}/api/reviews/${review.id}/decision`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: review.revision,
            decision,
            note: decisionNote.trim() || undefined,
          }),
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) void loadReview();
        throw new Error(body?.error || "Could not save the decision.");
      }
      setReview(body);
      setDecisionNote("");
      toast.success(decision === "approved" ? "Architecture change approved" : "Architecture change rejected");
      const eventResponse = await authenticatedFetch(
        `${API_URL}/api/reviews/${review.id}/events`
      );
      if (eventResponse.ok) setEvents((await eventResponse.json()).events || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the decision.");
    } finally {
      setMutating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas">
        <TopNav />
        <div className="flex min-h-screen items-center justify-center pt-16 text-text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="min-h-screen bg-canvas">
        <TopNav />
        <main className="mx-auto max-w-2xl px-5 pt-32 text-center">
          <XCircle className="mx-auto h-9 w-9 text-red-500" />
          <h1 className="mt-4 font-display text-2xl font-bold text-text-primary">Review unavailable</h1>
          <p className="mt-2 text-sm text-text-secondary">It may not exist, or it belongs to another account.</p>
          <Link href="/reviews" className="btn-secondary mt-6 gap-2"><ArrowLeft className="h-4 w-4" /> Back to reviews</Link>
        </main>
      </div>
    );
  }

  const blockingIds = new Set(review.report.blockingFindings.map((finding) => finding.id));
  const otherFindings = review.report.newFindings.filter(
    (finding) => !blockingIds.has(finding.id)
  );

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />
      <main className="pt-16">
        <div className="mx-auto max-w-[1360px] px-4 pb-20 pt-7 sm:px-6 lg:px-8">
          <Link href="/reviews" className="mb-5 inline-flex items-center gap-2 text-xs font-semibold text-text-muted hover:text-accent-cyan">
            <ArrowLeft className="h-3.5 w-3.5" /> All reviews
          </Link>

          <section className="mb-7 rounded-2xl border border-border bg-surface px-5 py-5 shadow-[0_1px_2px_rgba(29,33,53,0.03)] sm:px-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`badge ${review.report.status === "pass" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600" : "border-red-500/20 bg-red-500/10 text-red-600"}`}>
                    {review.report.status === "pass" ? "Policy passed" : "Changes requested"}
                  </span>
                  <span className="badge border-border bg-canvas-50 text-text-muted">{review.decision}</span>
                  <span className="text-[10px] font-mono text-text-muted">revision {review.revision}</span>
                </div>
                <h1 className="mt-3 font-display text-2xl font-bold tracking-[-0.03em] text-text-primary sm:text-3xl">{review.title}</h1>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                  <span>{review.repository || "Local repository"}</span>
                  <span>•</span>
                  <span className="font-mono">{review.sourcePath}</span>
                  <span>•</span>
                  <span className="inline-flex items-center gap-1 font-mono">
                    {shortRevision(review.baseRevision)}
                    <GitCommitHorizontal className="h-3.5 w-3.5" />
                    {shortRevision(review.headRevision)}
                  </span>
                </div>
              </div>
              <div className="grid min-w-[320px] grid-cols-3 gap-2">
                {[
                  ["Changes", review.report.diff.stats.total],
                  ["New findings", review.report.newFindings.length],
                  ["Blocking", review.report.blockingFindings.length],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-border bg-canvas-50 px-3 py-3 text-center">
                    <p className="font-display text-xl font-bold text-text-primary">{value}</p>
                    <p className="mt-1 text-[9px] font-mono uppercase tracking-[0.1em] text-text-muted">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-6">
              <section className="overflow-hidden rounded-2xl border border-border bg-surface">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                  <div>
                    <h2 className="font-display text-base font-bold text-text-primary">Semantic architecture delta</h2>
                    <p className="mt-1 text-xs text-text-muted">Source order and line movement are excluded from this comparison.</p>
                  </div>
                  <GitBranch className="h-5 w-5 text-accent-cyan" />
                </div>
                <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
                  {nodeChanges.map(({ node, change }) => (
                    <div key={node.id} className="bg-surface p-4">
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-canvas-50 text-accent-cyan">
                          <CircleDot className="h-4 w-4" />
                        </span>
                        <span className={`badge ${
                          change?.kind === "added"
                            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
                            : change?.kind === "removed"
                              ? "border-red-500/20 bg-red-500/10 text-red-600"
                              : change?.kind === "changed"
                                ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
                                : "border-border bg-canvas-50 text-text-muted"
                        }`}>
                          {change?.kind || "unchanged"}
                        </span>
                      </div>
                      <p className="mt-3 truncate text-sm font-bold text-text-primary">{String(node.data.label)}</p>
                      <p className="mt-1 text-[10px] font-mono text-text-muted">{node.data.nodeType} · {node.data.zone || "unscoped"}</p>
                      {change?.fields?.length ? (
                        <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-text-secondary">
                          {change.fields.slice(0, 3).map((field) => field.field.replace(/^data\./, "")).join(", ")}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
                {review.report.diff.changes.length > 0 && (
                  <div className="border-t border-border px-5 py-4">
                    <h3 className="mb-2 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Change log</h3>
                    <div className="space-y-2">
                      {review.report.diff.changes.map((change) => (
                        <div key={change.id} className="flex items-start gap-2 text-xs text-text-secondary">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-cyan" />
                          {change.summary}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-border bg-surface">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="font-display text-base font-bold text-text-primary">Operational impact</h2>
                  <p className="mt-1 text-xs text-text-muted">Derived from topology and source properties, not generated prose.</p>
                </div>
                {review.report.impacts.length ? (
                  <div className="divide-y divide-border">
                    {review.report.impacts.map((impact) => (
                      <div key={impact.id} className="flex gap-3 px-5 py-4">
                        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${severityStyle[impact.severity]}`}>
                          {impact.severity === "critical" ? <ShieldX className="h-4 w-4" /> : impact.severity === "warning" ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-text-primary">{impact.summary}</p>
                          <p className="mt-1 text-xs leading-5 text-text-secondary">{impact.description}</p>
                          <p className="mt-1.5 font-mono text-[10px] text-text-muted">
                            {impact.locations[0]
                              ? `${impact.locations[0].file}${impact.locations[0].startLine ? `:${impact.locations[0].startLine}` : ""}`
                              : "Derived graph analysis"}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-5 py-10 text-center text-sm text-text-muted">No semantic impact detected.</p>
                )}
              </section>

              <section className="rounded-2xl border border-border bg-surface">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="font-display text-base font-bold text-text-primary">Deterministic findings</h2>
                  <p className="mt-1 text-xs text-text-muted">Only findings introduced by the head revision are candidates for this gate.</p>
                </div>
                <div className="space-y-3 p-4">
                  {review.report.blockingFindings.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      blocking
                      onSuppress={() => {
                        setSelectedFinding(finding);
                        setJustification("");
                        setTicket("");
                        setExpiresOn("");
                      }}
                    />
                  ))}
                  {otherFindings.map((finding) => (
                    <FindingCard key={finding.id} finding={finding} />
                  ))}
                  {!review.report.newFindings.length && (
                    <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-4 text-emerald-700">
                      <ShieldCheck className="h-5 w-5" />
                      <span className="text-sm font-semibold">No new policy findings.</span>
                    </div>
                  )}
                  {review.report.suppressedFindings.length > 0 && (
                    <div className="mt-5 border-t border-border pt-4">
                      <h3 className="mb-3 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Accepted exceptions</h3>
                      {review.report.suppressedFindings.map(({ finding, suppression }) => (
                        <div key={suppression.id || finding.id} className="mb-2 rounded-xl border border-border bg-canvas-50 px-4 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-semibold text-text-primary">{finding.title}</p>
                            {suppression.ticket && <span className="badge border-border bg-surface text-text-muted">{suppression.ticket}</span>}
                          </div>
                          <p className="mt-1.5 text-xs leading-5 text-text-secondary">{suppression.justification}</p>
                          {suppression.expiresAt && <p className="mt-1 font-mono text-[10px] text-text-muted">Expires {new Date(suppression.expiresAt).toLocaleDateString()}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            <aside className="space-y-5">
              <section className={`rounded-2xl border p-5 ${
                review.report.status === "pass"
                  ? "border-emerald-500/20 bg-emerald-500/10"
                  : "border-red-500/20 bg-red-500/10"
              }`}>
                <div className="flex items-center gap-3">
                  {review.report.status === "pass" ? <ShieldCheck className="h-6 w-6 text-emerald-600" /> : <ShieldX className="h-6 w-6 text-red-600" />}
                  <div>
                    <h2 className="font-display text-base font-bold text-text-primary">Review decision</h2>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {review.report.status === "pass"
                        ? "The change is eligible for approval."
                        : "Resolve or justify every blocking finding first."}
                    </p>
                  </div>
                </div>
                <textarea
                  value={decisionNote}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  placeholder="Decision note (required for rejection)"
                  className="input mt-4 min-h-24 resize-y bg-surface text-xs"
                  maxLength={1000}
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => void decide("rejected")}
                    disabled={mutating}
                    className="btn-secondary gap-2 border-red-500/20 text-red-600 hover:border-red-500/40 hover:text-red-600"
                  >
                    <X className="h-4 w-4" /> Reject
                  </button>
                  <button
                    onClick={() => void decide("approved")}
                    disabled={mutating || review.report.status === "fail"}
                    className="btn-primary gap-2"
                    title={review.report.status === "fail" ? "Blocking findings remain" : "Approve architecture change"}
                  >
                    {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Approve
                  </button>
                </div>
                {review.decision !== "pending" && (
                  <div className="mt-4 border-t border-current/10 pt-3 text-xs text-text-secondary">
                    Current decision: <strong className="text-text-primary">{review.decision}</strong>
                    {review.decisionNote && <p className="mt-1 leading-5">{review.decisionNote}</p>}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-border bg-surface p-5">
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-accent-cyan" />
                  <h2 className="font-display text-sm font-bold text-text-primary">Audit trail</h2>
                </div>
                <div className="mt-4 space-y-0">
                  {events.map((event, index) => (
                    <div key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                      {index < events.length - 1 && <span className="absolute left-[7px] top-4 h-full w-px bg-border" />}
                      <span className="relative z-10 mt-1 h-4 w-4 shrink-0 rounded-full border-4 border-surface bg-accent-cyan" />
                      <div>
                        <p className="text-xs font-semibold text-text-primary">{eventLabel(event)}</p>
                        <p className="mt-1 font-mono text-[10px] text-text-muted">
                          revision {event.reviewRevision} · {new Date(event.createdAt).toLocaleString()}
                        </p>
                        {typeof event.data.justification === "string" && (
                          <p className="mt-1.5 text-[11px] leading-4 text-text-secondary">{event.data.justification}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-2xl border border-border bg-surface p-5">
                <div className="flex items-center gap-2">
                  <FileCode2 className="h-4 w-4 text-accent-cyan" />
                  <h2 className="font-display text-sm font-bold text-text-primary">Policy authority</h2>
                </div>
                <p className="mt-3 text-xs leading-5 text-text-secondary">
                  Pull-request automation evaluates the policy from the base commit. A proposed change cannot disable the check that evaluates it.
                </p>
                <div className="mt-3 rounded-lg bg-canvas-50 px-3 py-2 font-mono text-[10px] leading-4 text-text-muted">
                  Critical findings block by severity.<br />
                  Public → persistence blocks by rule.<br />
                  Existing debt is reported but not newly gated.
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>

      {selectedFinding && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <form onSubmit={submitSuppression} className="w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-float)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-amber-600">Accept exception</p>
                <h2 className="mt-1 font-display text-lg font-bold text-text-primary">{selectedFinding.title}</h2>
                <p className="mt-2 text-xs leading-5 text-text-secondary">{selectedFinding.description}</p>
              </div>
              <button type="button" onClick={() => setSelectedFinding(null)} className="btn-ghost p-2"><X className="h-4 w-4" /></button>
            </div>
            <label className="mt-5 block">
              <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Justification</span>
              <textarea
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
                className="input min-h-28 resize-y text-xs"
                placeholder="Why is this safe here, and what compensating control exists?"
                minLength={10}
                maxLength={1000}
                required
              />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">ADR or ticket</span>
                <input value={ticket} onChange={(event) => setTicket(event.target.value)} className="input font-mono text-xs" placeholder="ADR-014" maxLength={120} />
              </label>
              <label>
                <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Expiry (recommended)</span>
                <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} className="input text-xs" />
              </label>
            </div>
            <p className="mt-3 text-[11px] leading-4 text-text-muted">This action is appended to the audit trail and resets any prior decision to pending.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setSelectedFinding(null)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={mutating} className="btn-primary gap-2">
                {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Record exception
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  blocking = false,
  onSuppress,
}: {
  finding: ValidationIssue;
  blocking?: boolean;
  onSuppress?: () => void;
}) {
  return (
    <div className={`rounded-xl border px-4 py-4 ${severityStyle[finding.severity]}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text-primary">{finding.title}</span>
            <span className="badge border-current/20 bg-surface/50 text-current">{finding.severity}</span>
            {blocking && <span className="badge border-red-500/20 bg-red-500/10 text-red-600">blocks merge</span>}
          </div>
          <p className="mt-2 text-xs leading-5 text-text-secondary">{finding.description}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-text-muted">
            <span>{finding.ruleId}</span>
            <span>{findingLocation(finding)}</span>
          </div>
        </div>
        {blocking && onSuppress && (
          <button onClick={onSuppress} className="btn-secondary shrink-0 text-xs">
            Justify exception
          </button>
        )}
      </div>
    </div>
  );
}
