"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  FileDiff,
  FileUp,
  GitPullRequestArrow,
  Loader2,
  Plus,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import TopNav from "@/components/TopNav";
import { useUser } from "@/hooks/useUser";
import type { ReviewSummary } from "@/types/reviews";

const API_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

const SAMPLE_BASE = `services:
  storefront:
    image: ghcr.io/example/storefront:1.4.0
    ports: ["8080:3000"]
  checkout:
    image: ghcr.io/example/checkout:2.1.0
  database:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
`;

const SAMPLE_HEAD = `services:
  storefront:
    image: ghcr.io/example/storefront:1.4.0
    ports: ["8080:3000"]
  checkout:
    image: ghcr.io/example/checkout:2.2.0
    ports: ["8081:3000"]
    depends_on:
      database:
        condition: service_healthy
  database:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
`;

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 9) : value;
}

function relativeTime(value: string): string {
  const milliseconds = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ReviewsPage() {
  const router = useRouter();
  const { authenticatedFetch, isReady, userId } = useUser();
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("Checkout architecture change");
  const [repository, setRepository] = useState("example/commerce-platform");
  const [sourcePath, setSourcePath] = useState("compose.yaml");
  const [baseRevision, setBaseRevision] = useState("main");
  const [headRevision, setHeadRevision] = useState("feature/checkout-db");
  const [baseContent, setBaseContent] = useState(SAMPLE_BASE);
  const [headContent, setHeadContent] = useState(SAMPLE_HEAD);

  const loadReviews = useCallback(async () => {
    if (!isReady) return;
    try {
      const response = await authenticatedFetch(`${API_URL}/api/reviews`);
      if (!response.ok) throw new Error("Could not load architecture reviews.");
      const data = await response.json();
      setReviews(data.reviews || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load reviews.");
    } finally {
      setLoading(false);
    }
  }, [authenticatedFetch, isReady]);

  useEffect(() => {
    void loadReviews();
  }, [loadReviews, userId]);

  const loadFile = (
    event: React.ChangeEvent<HTMLInputElement>,
    setter: (value: string) => void
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 450_000) {
      toast.error("Compose files are limited to 450 KB in the browser review.");
      return;
    }
    file.text().then(setter).catch(() => toast.error("Could not read that file."));
  };

  const createReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isReady || creating) return;
    setCreating(true);
    try {
      const response = await authenticatedFetch(`${API_URL}/api/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          repository: repository || undefined,
          sourcePath,
          baseRevision,
          headRevision,
          baseContent,
          headContent,
          policy: {
            failOn: ["critical"],
            includeExistingFindings: false,
            rules: {
              "compose-public-service-to-persistence": {
                enabled: true,
                severity: "warning",
                blockMerge: true,
              },
            },
            suppressions: [],
          },
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const diagnostic = body?.diagnostics?.[0]?.message;
        throw new Error(diagnostic || body?.error || "Could not create the review.");
      }
      toast.success("Architecture change reviewed");
      router.push(`/reviews/${body.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the review.");
    } finally {
      setCreating(false);
    }
  };

  const counts = {
    pending: reviews.filter((review) => review.decision === "pending").length,
    blocked: reviews.filter((review) => review.analysisStatus === "fail").length,
    approved: reviews.filter((review) => review.decision === "approved").length,
  };

  return (
    <div className="min-h-screen bg-canvas">
      <TopNav />
      <main className="pt-16">
        <div className="mx-auto max-w-[1280px] px-4 pb-16 pt-8 sm:px-6 lg:px-8 lg:pt-12">
          <section className="mb-8 grid gap-7 border-b border-border pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-[10px] font-mono font-semibold uppercase tracking-[0.17em] text-accent-cyan">
                <GitPullRequestArrow className="h-3.5 w-3.5" />
                Architecture change intelligence
              </div>
              <h1 className="max-w-4xl font-display text-3xl font-bold tracking-[-0.04em] text-text-primary sm:text-4xl">
                Review system impact before merge.
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary">
                Compare Docker Compose revisions as architecture graphs. Formatting noise is ignored; new exposure, dependencies, trust crossings, redundancy, and blast radius remain visible.
              </p>
            </div>
            <button
              onClick={() => setShowCreate((current) => !current)}
              className={showCreate ? "btn-secondary gap-2" : "btn-primary gap-2"}
            >
              <Plus className="h-4 w-4" />
              {showCreate ? "Close importer" : "New review"}
            </button>
          </section>

          <section className="mb-8 grid grid-cols-3 gap-3">
            {[
              { label: "Pending decision", value: counts.pending, icon: <GitPullRequestArrow className="h-4 w-4" /> },
              { label: "Policy blocked", value: counts.blocked, icon: <ShieldAlert className="h-4 w-4" /> },
              { label: "Approved", value: counts.approved, icon: <CheckCircle2 className="h-4 w-4" /> },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-border bg-surface px-4 py-4 sm:px-5">
                <div className="flex items-center justify-between text-text-muted">
                  <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em]">{stat.label}</span>
                  <span className="text-accent-cyan">{stat.icon}</span>
                </div>
                <p className="mt-4 font-display text-2xl font-bold text-text-primary">{stat.value}</p>
              </div>
            ))}
          </section>

          {showCreate && (
            <form onSubmit={createReview} className="mb-10 overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-soft)]">
              <div className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-display text-lg font-bold text-text-primary">Import base and head</h2>
                  <p className="mt-1 text-xs text-text-muted">The included example deliberately introduces a public checkout-to-database dependency.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setBaseContent(SAMPLE_BASE);
                    setHeadContent(SAMPLE_HEAD);
                  }}
                  className="btn-ghost text-xs font-semibold"
                >
                  Reset example
                </button>
              </div>

              <div className="grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-5">
                <label className="lg:col-span-2">
                  <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Review title</span>
                  <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} />
                </label>
                <label>
                  <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Repository</span>
                  <input className="input" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/repository" />
                </label>
                <label>
                  <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Base revision</span>
                  <input className="input font-mono" value={baseRevision} onChange={(event) => setBaseRevision(event.target.value)} required />
                </label>
                <label>
                  <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Head revision</span>
                  <input className="input font-mono" value={headRevision} onChange={(event) => setHeadRevision(event.target.value)} required />
                </label>
                <label className="md:col-span-2 lg:col-span-5">
                  <span className="mb-1.5 block text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-text-muted">Repository path</span>
                  <input className="input font-mono" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} required />
                </label>
              </div>

              <div className="grid border-t border-border lg:grid-cols-2">
                {[
                  { label: "Base architecture", value: baseContent, setter: setBaseContent, side: "base" },
                  { label: "Proposed architecture", value: headContent, setter: setHeadContent, side: "head" },
                ].map((source, index) => (
                  <div key={source.side} className={index ? "border-t border-border lg:border-l lg:border-t-0" : ""}>
                    <div className="flex items-center justify-between border-b border-border bg-canvas-50 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileDiff className="h-4 w-4 text-accent-cyan" />
                        <span className="text-xs font-semibold text-text-primary">{source.label}</span>
                      </div>
                      <label className="cursor-pointer rounded-md border border-border bg-surface px-2.5 py-1.5 text-[10px] font-semibold text-text-secondary hover:border-accent-cyan/40 hover:text-accent-cyan">
                        <FileUp className="mr-1.5 inline h-3.5 w-3.5" />
                        Choose file
                        <input type="file" accept=".yml,.yaml,text/yaml" className="hidden" onChange={(event) => loadFile(event, source.setter)} />
                      </label>
                    </div>
                    <textarea
                      value={source.value}
                      onChange={(event) => source.setter(event.target.value)}
                      spellCheck={false}
                      className="min-h-[320px] w-full resize-y bg-surface p-4 font-mono text-xs leading-5 text-text-primary outline-none"
                      required
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="max-w-2xl text-xs leading-5 text-text-muted">
                  Findings are generated by deterministic graph rules. Source is parsed in memory; the persisted review stores canonical graphs, evidence, policy, and decisions.
                </p>
                <button type="submit" disabled={creating} className="btn-primary min-w-40 gap-2">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequestArrow className="h-4 w-4" />}
                  Run review
                </button>
              </div>
            </form>
          )}

          <section>
            <div className="mb-4 flex items-end justify-between">
              <div>
                <h2 className="font-display text-lg font-bold text-text-primary">Recent change reviews</h2>
                <p className="mt-1 text-xs text-text-muted">Decisions and accepted exceptions are versioned and auditable.</p>
              </div>
            </div>

            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="h-28 animate-pulse rounded-xl border border-border bg-surface" />
                ))}
              </div>
            ) : reviews.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-light bg-surface px-6 py-14 text-center">
                <FileDiff className="mx-auto h-8 w-8 text-accent-cyan" />
                <h3 className="mt-4 font-display text-lg font-bold text-text-primary">No architecture reviews yet</h3>
                <p className="mt-2 text-sm text-text-secondary">Open the importer to compare the included base and pull-request example.</p>
                <button onClick={() => setShowCreate(true)} className="btn-primary mt-5 gap-2"><Plus className="h-4 w-4" /> Create first review</button>
              </div>
            ) : (
              <div className="space-y-3">
                {reviews.map((review) => (
                  <Link
                    key={review.id}
                    href={`/reviews/${review.id}`}
                    className="group grid gap-4 rounded-xl border border-border bg-surface px-4 py-4 transition-all hover:-translate-y-px hover:border-border-light hover:shadow-[var(--shadow-soft)] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:px-5"
                  >
                    <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                      review.analysisStatus === "pass"
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-red-500/10 text-red-600"
                    }`}>
                      {review.analysisStatus === "pass" ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-display text-sm font-bold text-text-primary">{review.title}</span>
                        <span className={`badge ${review.decision === "approved" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600" : review.decision === "rejected" ? "border-red-500/20 bg-red-500/10 text-red-600" : "border-border bg-canvas-50 text-text-muted"}`}>
                          {review.decision}
                        </span>
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                        <span>{review.repository || "Local repository"}</span>
                        <span>•</span>
                        <span className="font-mono">{shortRevision(review.baseRevision)} → {shortRevision(review.headRevision)}</span>
                        <span>•</span>
                        <span>{review.semanticChanges} changes</span>
                        <span>•</span>
                        <span>{review.blockingFindings} blocking</span>
                        <span>•</span>
                        <span>{relativeTime(review.updatedAt)}</span>
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs font-semibold text-text-secondary group-hover:text-accent-cyan">
                      Inspect <ArrowRight className="h-4 w-4" />
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
