import { randomUUID } from "node:crypto";
import type {
  ArchitectureChangeReview,
  ArchitecturePolicy,
  CanonicalArchitectureGraph,
} from "@system-synthesis/architecture-core";
import {
  canonicalGraphFingerprint,
  currentAnalyzerVersion,
  stableStringify,
} from "@system-synthesis/architecture-core";
import { getPool } from "./db.js";

/**
 * Captured once per process. A stored review records the analyzer that produced
 * its verdict so a frozen report can be told apart from one today's rules would
 * still produce.
 */
export const CURRENT_ANALYZER_VERSION = currentAnalyzerVersion();

export interface AnalyzerStatus {
  analyzerVersion: string | null;
  currentAnalyzerVersion: string;
  analyzerOutdated: boolean;
}

/**
 * Derived at read time, never stored: "current" is a property of the running
 * deployment, not of the row.
 */
export function analyzerStatus(review: {
  analyzerVersion: string | null;
}): AnalyzerStatus {
  return {
    analyzerVersion: review.analyzerVersion,
    currentAnalyzerVersion: CURRENT_ANALYZER_VERSION,
    analyzerOutdated: review.analyzerVersion !== CURRENT_ANALYZER_VERSION,
  };
}

export type ReviewDecision = "pending" | "approved" | "rejected";

export interface ExternalReviewSource {
  provider: "github";
  repository: string;
  changeNumber: number;
  changeUrl: string;
  changeVersion: number;
  workflowRunId: string | null;
  workflowRunUrl: string | null;
}

export interface ArchitectureReviewRecord {
  id: string;
  ownerId: string;
  title: string;
  repository: string | null;
  sourcePath: string;
  baseRevision: string;
  headRevision: string;
  baseGraph: CanonicalArchitectureGraph;
  headGraph: CanonicalArchitectureGraph;
  policy: ArchitecturePolicy;
  report: ArchitectureChangeReview;
  externalSource: ExternalReviewSource | null;
  analyzerVersion: string | null;
  decision: ReviewDecision;
  decisionNote: string | null;
  decidedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureReviewSummary {
  id: string;
  title: string;
  repository: string | null;
  sourcePath: string;
  baseRevision: string;
  headRevision: string;
  analysisStatus: "pass" | "fail";
  decision: ReviewDecision;
  blockingFindings: number;
  semanticChanges: number;
  externalSource: ExternalReviewSource | null;
  analyzerVersion: string | null;
  analyzerOutdated: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureReviewEvent {
  id: string;
  reviewId: string;
  actorId: string;
  eventType:
    | "review.created"
    | "review.refreshed"
    | "review.recomputed"
    | "suppression.added"
    | "decision.changed";
  reviewRevision: number;
  data: Record<string, unknown>;
  createdAt: string;
}

export type ReviewMutationResult =
  | { status: "updated"; review: ArchitectureReviewRecord }
  | { status: "conflict" }
  | { status: "not_found" };

export type ReviewRecomputeResult =
  | { status: "updated" | "unchanged"; review: ArchitectureReviewRecord }
  | { status: "conflict" }
  | { status: "not_found" };

export type IngestReviewResult =
  | { status: "created" | "updated" | "unchanged" | "stale"; review: ArchitectureReviewRecord }
  | { status: "conflict"; review: ArchitectureReviewRecord };

const memoryReviews = new Map<string, ArchitectureReviewRecord>();
const memoryEvents = new Map<string, ArchitectureReviewEvent[]>();

interface IngestArchitectureReviewInput {
  ownerId: string;
  title: string;
  repository: string;
  sourcePath: string;
  baseRevision: string;
  headRevision: string;
  baseGraph: CanonicalArchitectureGraph;
  headGraph: CanonicalArchitectureGraph;
  policy: ArchitecturePolicy;
  report: ArchitectureChangeReview;
  externalSource: ExternalReviewSource;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToReview(row: any): ArchitectureReviewRecord {
  const externalSource: ExternalReviewSource | null = row.integration_provider
    ? {
        provider: row.integration_provider,
        repository: row.external_repository,
        changeNumber: Number(row.external_change_number),
        changeUrl: row.external_change_url,
        changeVersion: Number(row.external_change_version),
        workflowRunId: row.workflow_run_id || null,
        workflowRunUrl: row.workflow_run_url || null,
      }
    : null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    repository: row.repository,
    sourcePath: row.source_path,
    baseRevision: row.base_revision,
    headRevision: row.head_revision,
    baseGraph: row.base_graph,
    headGraph: row.head_graph,
    policy: row.policy || {},
    report: row.report,
    externalSource,
    analyzerVersion: row.analyzer_version || null,
    decision: row.decision,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at ? timestamp(row.decided_at) : null,
    revision: Number(row.revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function toSummary(review: ArchitectureReviewRecord): ArchitectureReviewSummary {
  return {
    id: review.id,
    title: review.title,
    repository: review.repository,
    sourcePath: review.sourcePath,
    baseRevision: review.baseRevision,
    headRevision: review.headRevision,
    analysisStatus: review.report.status,
    decision: review.decision,
    blockingFindings: review.report.blockingFindings.length,
    semanticChanges: review.report.diff.stats.total,
    externalSource: review.externalSource,
    analyzerVersion: review.analyzerVersion,
    analyzerOutdated: analyzerStatus(review).analyzerOutdated,
    revision: review.revision,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

function rowToEvent(row: any): ArchitectureReviewEvent {
  return {
    id: row.id,
    reviewId: row.review_id,
    actorId: row.actor_id,
    eventType: row.event_type,
    reviewRevision: Number(row.review_revision),
    data: row.data || {},
    createdAt: timestamp(row.created_at),
  };
}

function sameIngestionPayload(
  review: ArchitectureReviewRecord,
  input: IngestArchitectureReviewInput
): boolean {
  return (
    review.sourcePath === input.sourcePath &&
    review.baseRevision === input.baseRevision &&
    review.headRevision === input.headRevision &&
    canonicalGraphFingerprint(review.baseGraph) ===
      canonicalGraphFingerprint(input.baseGraph) &&
    canonicalGraphFingerprint(review.headGraph) ===
      canonicalGraphFingerprint(input.headGraph) &&
    stableStringify(review.policy) === stableStringify(input.policy)
  );
}

function externalReviewKey(source: ExternalReviewSource, ownerId: string): string {
  return [
    ownerId,
    source.provider,
    source.repository,
    String(source.changeNumber),
  ].join(":");
}

/**
 * Create or refresh the single review associated with a repository pull
 * request. The external changeVersion is a provider-supplied monotonic
 * watermark; older deliveries can never replace a newer head.
 */
export async function ingestArchitectureReview(
  input: IngestArchitectureReviewInput
): Promise<IngestReviewResult> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const key = externalReviewKey(input.externalSource, input.ownerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const selected = await client.query(
        `SELECT * FROM architecture_reviews
         WHERE owner_id = $1
           AND integration_provider = $2
           AND external_repository = $3
           AND external_change_number = $4
         FOR UPDATE`,
        [
          input.ownerId,
          input.externalSource.provider,
          input.externalSource.repository,
          input.externalSource.changeNumber,
        ]
      );
      const current = selected.rows[0] ? rowToReview(selected.rows[0]) : null;
      if (current?.externalSource) {
        if (input.externalSource.changeVersion < current.externalSource.changeVersion) {
          await client.query("COMMIT");
          return { status: "stale", review: current };
        }
        const samePayload = sameIngestionPayload(current, input);
        if (input.externalSource.changeVersion === current.externalSource.changeVersion) {
          await client.query("COMMIT");
          return {
            status: samePayload ? "unchanged" : "conflict",
            review: current,
          };
        }
        if (samePayload) {
          const refreshed = await client.query(
            `UPDATE architecture_reviews
             SET external_change_version = $2,
                 workflow_run_id = $3,
                 workflow_run_url = $4,
                 external_change_url = $5,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [
              current.id,
              input.externalSource.changeVersion,
              input.externalSource.workflowRunId,
              input.externalSource.workflowRunUrl,
              input.externalSource.changeUrl,
            ]
          );
          await client.query("COMMIT");
          return { status: "unchanged", review: rowToReview(refreshed.rows[0]) };
        }

        const updated = await client.query(
          `UPDATE architecture_reviews
           SET title = $2,
               repository = $3,
               source_path = $4,
               base_revision = $5,
               head_revision = $6,
               base_graph = $7,
               head_graph = $8,
               policy = $9,
               report = $10,
               decision = 'pending',
               decision_note = NULL,
               decided_at = NULL,
               external_change_url = $11,
               external_change_version = $12,
               workflow_run_id = $13,
               workflow_run_url = $14,
               analyzer_version = $15,
               revision = revision + 1,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            current.id,
            input.title,
            input.repository,
            input.sourcePath,
            input.baseRevision,
            input.headRevision,
            JSON.stringify(input.baseGraph),
            JSON.stringify(input.headGraph),
            JSON.stringify(input.policy),
            JSON.stringify(input.report),
            input.externalSource.changeUrl,
            input.externalSource.changeVersion,
            input.externalSource.workflowRunId,
            input.externalSource.workflowRunUrl,
            CURRENT_ANALYZER_VERSION,
          ]
        );
        const review = rowToReview(updated.rows[0]);
        await client.query(
          `INSERT INTO architecture_review_events (
             id, review_id, actor_id, event_type, review_revision, data
           ) VALUES ($1, $2, $3, 'review.refreshed', $4, $5)`,
          [
            randomUUID(),
            review.id,
            `integration:${input.externalSource.provider}`,
            review.revision,
            JSON.stringify({
              previousHeadRevision: current.headRevision,
              headRevision: input.headRevision,
              analysisStatus: input.report.status,
              blockingFindings: input.report.blockingFindings.length,
              workflowRunId: input.externalSource.workflowRunId,
            }),
          ]
        );
        await client.query("COMMIT");
        return { status: "updated", review };
      }

      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO architecture_reviews (
           id, owner_id, title, repository, source_path, base_revision,
           head_revision, base_graph, head_graph, policy, report,
           integration_provider, external_repository, external_change_number,
           external_change_url, external_change_version, workflow_run_id,
           workflow_run_url, analyzer_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17, $18, $19
         )
         RETURNING *`,
        [
          id,
          input.ownerId,
          input.title,
          input.repository,
          input.sourcePath,
          input.baseRevision,
          input.headRevision,
          JSON.stringify(input.baseGraph),
          JSON.stringify(input.headGraph),
          JSON.stringify(input.policy),
          JSON.stringify(input.report),
          input.externalSource.provider,
          input.externalSource.repository,
          input.externalSource.changeNumber,
          input.externalSource.changeUrl,
          input.externalSource.changeVersion,
          input.externalSource.workflowRunId,
          input.externalSource.workflowRunUrl,
          CURRENT_ANALYZER_VERSION,
        ]
      );
      const review = rowToReview(inserted.rows[0]);
      await client.query(
        `INSERT INTO architecture_review_events (
           id, review_id, actor_id, event_type, review_revision, data
         ) VALUES ($1, $2, $3, 'review.created', 1, $4)`,
        [
          randomUUID(),
          id,
          `integration:${input.externalSource.provider}`,
          JSON.stringify({
            origin: input.externalSource.provider,
            changeNumber: input.externalSource.changeNumber,
            headRevision: input.headRevision,
            analysisStatus: input.report.status,
            blockingFindings: input.report.blockingFindings.length,
            workflowRunId: input.externalSource.workflowRunId,
          }),
        ]
      );
      await client.query("COMMIT");
      return { status: "created", review };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const current = [...memoryReviews.values()].find(
    (review) =>
      review.ownerId === input.ownerId &&
      review.externalSource?.provider === input.externalSource.provider &&
      review.externalSource.repository === input.externalSource.repository &&
      review.externalSource.changeNumber === input.externalSource.changeNumber
  );
  if (current?.externalSource) {
    if (input.externalSource.changeVersion < current.externalSource.changeVersion) {
      return { status: "stale", review: structuredClone(current) };
    }
    const samePayload = sameIngestionPayload(current, input);
    if (input.externalSource.changeVersion === current.externalSource.changeVersion) {
      return {
        status: samePayload ? "unchanged" : "conflict",
        review: structuredClone(current),
      };
    }
    if (samePayload) {
      const unchanged: ArchitectureReviewRecord = {
        ...current,
        externalSource: structuredClone(input.externalSource),
        updatedAt: new Date().toISOString(),
      };
      memoryReviews.set(unchanged.id, unchanged);
      return { status: "unchanged", review: structuredClone(unchanged) };
    }
    const now = new Date().toISOString();
    const updated: ArchitectureReviewRecord = {
      ...current,
      ...input,
      analyzerVersion: CURRENT_ANALYZER_VERSION,
      decision: "pending",
      decisionNote: null,
      decidedAt: null,
      revision: current.revision + 1,
      updatedAt: now,
    };
    memoryReviews.set(updated.id, structuredClone(updated));
    memoryEvents.get(updated.id)!.push({
      id: randomUUID(),
      reviewId: updated.id,
      actorId: `integration:${input.externalSource.provider}`,
      eventType: "review.refreshed",
      reviewRevision: updated.revision,
      data: {
        previousHeadRevision: current.headRevision,
        headRevision: input.headRevision,
        analysisStatus: input.report.status,
        blockingFindings: input.report.blockingFindings.length,
        workflowRunId: input.externalSource.workflowRunId,
      },
      createdAt: now,
    });
    return { status: "updated", review: structuredClone(updated) };
  }

  const now = new Date().toISOString();
  const review: ArchitectureReviewRecord = {
    ...input,
    id: randomUUID(),
    analyzerVersion: CURRENT_ANALYZER_VERSION,
    decision: "pending",
    decisionNote: null,
    decidedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  memoryReviews.set(review.id, structuredClone(review));
  memoryEvents.set(review.id, [{
    id: randomUUID(),
    reviewId: review.id,
    actorId: `integration:${input.externalSource.provider}`,
    eventType: "review.created",
    reviewRevision: 1,
    data: {
      origin: input.externalSource.provider,
      changeNumber: input.externalSource.changeNumber,
      headRevision: input.headRevision,
      analysisStatus: input.report.status,
      blockingFindings: input.report.blockingFindings.length,
      workflowRunId: input.externalSource.workflowRunId,
    },
    createdAt: now,
  }]);
  return { status: "created", review: structuredClone(review) };
}

export async function createArchitectureReview(
  input: Omit<
    ArchitectureReviewRecord,
    | "id"
    | "externalSource"
    | "analyzerVersion"
    | "decision"
    | "decisionNote"
    | "decidedAt"
    | "revision"
    | "createdAt"
    | "updatedAt"
  >
): Promise<ArchitectureReviewRecord> {
  const id = randomUUID();
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO architecture_reviews (
           id, owner_id, title, repository, source_path, base_revision,
           head_revision, base_graph, head_graph, policy, report,
           analyzer_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          id,
          input.ownerId,
          input.title,
          input.repository,
          input.sourcePath,
          input.baseRevision,
          input.headRevision,
          JSON.stringify(input.baseGraph),
          JSON.stringify(input.headGraph),
          JSON.stringify(input.policy),
          JSON.stringify(input.report),
          CURRENT_ANALYZER_VERSION,
        ]
      );
      const review = rowToReview(inserted.rows[0]);
      await client.query(
        `INSERT INTO architecture_review_events (
           id, review_id, actor_id, event_type, review_revision, data
         ) VALUES ($1, $2, $3, 'review.created', 1, $4)`,
        [
          randomUUID(),
          id,
          input.ownerId,
          JSON.stringify({
            analysisStatus: input.report.status,
            blockingFindings: input.report.blockingFindings.length,
          }),
        ]
      );
      await client.query("COMMIT");
      return review;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const now = new Date().toISOString();
  const review: ArchitectureReviewRecord = {
    ...input,
    id,
    externalSource: null,
    analyzerVersion: CURRENT_ANALYZER_VERSION,
    decision: "pending",
    decisionNote: null,
    decidedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  memoryReviews.set(id, structuredClone(review));
  memoryEvents.set(id, [{
    id: randomUUID(),
    reviewId: id,
    actorId: input.ownerId,
    eventType: "review.created",
    reviewRevision: 1,
    data: {
      analysisStatus: input.report.status,
      blockingFindings: input.report.blockingFindings.length,
    },
    createdAt: now,
  }]);
  return structuredClone(review);
}

export async function listArchitectureReviews(
  ownerId: string,
  limit = 50
): Promise<ArchitectureReviewSummary[]> {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT * FROM architecture_reviews
       WHERE owner_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [ownerId, limit]
    );
    return result.rows.map(rowToReview).map(toSummary);
  }
  return [...memoryReviews.values()]
    .filter((review) => review.ownerId === ownerId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
    .map((review) => toSummary(structuredClone(review)));
}

export async function getArchitectureReview(
  id: string,
  ownerId: string
): Promise<ArchitectureReviewRecord | null> {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT * FROM architecture_reviews WHERE id = $1 AND owner_id = $2`,
      [id, ownerId]
    );
    return result.rows[0] ? rowToReview(result.rows[0]) : null;
  }
  const review = memoryReviews.get(id);
  return review?.ownerId === ownerId ? structuredClone(review) : null;
}

export async function listArchitectureReviewEvents(
  reviewId: string,
  ownerId: string
): Promise<ArchitectureReviewEvent[]> {
  const review = await getArchitectureReview(reviewId, ownerId);
  if (!review) return [];
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT e.* FROM architecture_review_events e
       JOIN architecture_reviews r ON r.id = e.review_id
       WHERE e.review_id = $1 AND r.owner_id = $2
       ORDER BY e.created_at ASC, e.id ASC`,
      [reviewId, ownerId]
    );
    return result.rows.map(rowToEvent);
  }
  return structuredClone(memoryEvents.get(reviewId) || []);
}

export async function updateArchitectureReviewAnalysis(
  id: string,
  ownerId: string,
  expectedRevision: number,
  policy: ArchitecturePolicy,
  report: ArchitectureChangeReview,
  eventData: Record<string, unknown>
): Promise<ReviewMutationResult> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE architecture_reviews
         SET policy = $4,
             report = $5,
             -- The caller recomputed this report with the running analyzer.
             analyzer_version = $6,
             decision = 'pending',
             decision_note = NULL,
             decided_at = NULL,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND revision = $3
         RETURNING *`,
        [
          id,
          ownerId,
          expectedRevision,
          JSON.stringify(policy),
          JSON.stringify(report),
          CURRENT_ANALYZER_VERSION,
        ]
      );
      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        const exists = await pool.query(
          `SELECT 1 FROM architecture_reviews WHERE id = $1 AND owner_id = $2`,
          [id, ownerId]
        );
        return exists.rows[0] ? { status: "conflict" } : { status: "not_found" };
      }
      const review = rowToReview(updated.rows[0]);
      await client.query(
        `INSERT INTO architecture_review_events (
           id, review_id, actor_id, event_type, review_revision, data
         ) VALUES ($1, $2, $3, 'suppression.added', $4, $5)`,
        [randomUUID(), id, ownerId, review.revision, JSON.stringify(eventData)]
      );
      await client.query("COMMIT");
      return { status: "updated", review };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const current = memoryReviews.get(id);
  if (!current || current.ownerId !== ownerId) return { status: "not_found" };
  if (current.revision !== expectedRevision) return { status: "conflict" };
  const now = new Date().toISOString();
  const review: ArchitectureReviewRecord = {
    ...current,
    policy: structuredClone(policy),
    report: structuredClone(report),
    analyzerVersion: CURRENT_ANALYZER_VERSION,
    decision: "pending",
    decisionNote: null,
    decidedAt: null,
    revision: current.revision + 1,
    updatedAt: now,
  };
  memoryReviews.set(id, review);
  memoryEvents.get(id)!.push({
    id: randomUUID(),
    reviewId: id,
    actorId: ownerId,
    eventType: "suppression.added",
    reviewRevision: review.revision,
    data: structuredClone(eventData),
    createdAt: now,
  });
  return { status: "updated", review: structuredClone(review) };
}

/**
 * Analysis stamps the review time and both validation timestamps with the
 * wall clock. Those move on every run by design, so comparing them would make
 * every recomputation look like a changed verdict and needlessly revoke
 * decisions. Everything else in the report is deterministic.
 */
function comparableReport(report: ArchitectureChangeReview): string {
  const { reviewedAt: _reviewedAt, baseValidation, headValidation, ...rest } = report;
  return stableStringify({
    ...rest,
    baseValidation: { ...baseValidation, timestamp: "" },
    headValidation: { ...headValidation, timestamp: "" },
  });
}

/**
 * Re-analyze a stored review against the running analyzer, reusing its
 * canonical graphs and policy. Raw source is never retained, but nothing here
 * needs it.
 *
 * A recomputation that produces the same verdict re-stamps the analyzer without
 * bumping the revision or discarding a decision: a rule change that does not
 * affect this review must not silently revoke its approval. A changed verdict
 * behaves like any other analysis update and returns the decision to pending.
 */
export async function recomputeArchitectureReviewAnalysis(
  id: string,
  ownerId: string,
  expectedRevision: number,
  report: ArchitectureChangeReview
): Promise<ReviewRecomputeResult> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT * FROM architecture_reviews
         WHERE id = $1 AND owner_id = $2
         FOR UPDATE`,
        [id, ownerId]
      );
      if (!existing.rows[0]) {
        await client.query("ROLLBACK");
        return { status: "not_found" };
      }
      const current = rowToReview(existing.rows[0]);
      if (current.revision !== expectedRevision) {
        await client.query("ROLLBACK");
        return { status: "conflict" };
      }
      const changed = comparableReport(current.report) !== comparableReport(report);
      const updated = changed
        ? await client.query(
            `UPDATE architecture_reviews
             SET report = $3,
                 analyzer_version = $4,
                 decision = 'pending',
                 decision_note = NULL,
                 decided_at = NULL,
                 revision = revision + 1,
                 updated_at = NOW()
             WHERE id = $1 AND owner_id = $2
             RETURNING *`,
            [id, ownerId, JSON.stringify(report), CURRENT_ANALYZER_VERSION]
          )
        : await client.query(
            `UPDATE architecture_reviews
             SET analyzer_version = $3, updated_at = NOW()
             WHERE id = $1 AND owner_id = $2
             RETURNING *`,
            [id, ownerId, CURRENT_ANALYZER_VERSION]
          );
      const review = rowToReview(updated.rows[0]);
      await client.query(
        `INSERT INTO architecture_review_events (
           id, review_id, actor_id, event_type, review_revision, data
         ) VALUES ($1, $2, $3, 'review.recomputed', $4, $5)`,
        [
          randomUUID(),
          id,
          ownerId,
          review.revision,
          JSON.stringify(recomputeEventData(current, review, changed)),
        ]
      );
      await client.query("COMMIT");
      return { status: changed ? "updated" : "unchanged", review };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const current = memoryReviews.get(id);
  if (!current || current.ownerId !== ownerId) return { status: "not_found" };
  if (current.revision !== expectedRevision) return { status: "conflict" };
  const changed = comparableReport(current.report) !== comparableReport(report);
  const now = new Date().toISOString();
  const review: ArchitectureReviewRecord = changed
    ? {
        ...current,
        report: structuredClone(report),
        analyzerVersion: CURRENT_ANALYZER_VERSION,
        decision: "pending",
        decisionNote: null,
        decidedAt: null,
        revision: current.revision + 1,
        updatedAt: now,
      }
    : {
        ...current,
        analyzerVersion: CURRENT_ANALYZER_VERSION,
        updatedAt: now,
      };
  memoryReviews.set(id, review);
  memoryEvents.get(id)!.push({
    id: randomUUID(),
    reviewId: id,
    actorId: ownerId,
    eventType: "review.recomputed",
    reviewRevision: review.revision,
    data: recomputeEventData(current, review, changed),
    createdAt: now,
  });
  return {
    status: changed ? "updated" : "unchanged",
    review: structuredClone(review),
  };
}

function recomputeEventData(
  before: ArchitectureReviewRecord,
  after: ArchitectureReviewRecord,
  changed: boolean
): Record<string, unknown> {
  return {
    changed,
    previousAnalyzerVersion: before.analyzerVersion,
    analyzerVersion: after.analyzerVersion,
    previousAnalysisStatus: before.report.status,
    analysisStatus: after.report.status,
    previousBlockingFindings: before.report.blockingFindings.length,
    blockingFindings: after.report.blockingFindings.length,
  };
}

export async function updateArchitectureReviewDecision(
  id: string,
  ownerId: string,
  expectedRevision: number,
  decision: Exclude<ReviewDecision, "pending">,
  note: string | null
): Promise<ReviewMutationResult> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE architecture_reviews
         SET decision = $4,
             decision_note = $5,
             decided_at = NOW(),
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND revision = $3
         RETURNING *`,
        [id, ownerId, expectedRevision, decision, note]
      );
      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        const exists = await pool.query(
          `SELECT 1 FROM architecture_reviews WHERE id = $1 AND owner_id = $2`,
          [id, ownerId]
        );
        return exists.rows[0] ? { status: "conflict" } : { status: "not_found" };
      }
      const review = rowToReview(updated.rows[0]);
      await client.query(
        `INSERT INTO architecture_review_events (
           id, review_id, actor_id, event_type, review_revision, data
         ) VALUES ($1, $2, $3, 'decision.changed', $4, $5)`,
        [
          randomUUID(),
          id,
          ownerId,
          review.revision,
          JSON.stringify({ decision, note }),
        ]
      );
      await client.query("COMMIT");
      return { status: "updated", review };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const current = memoryReviews.get(id);
  if (!current || current.ownerId !== ownerId) return { status: "not_found" };
  if (current.revision !== expectedRevision) return { status: "conflict" };
  const now = new Date().toISOString();
  const review: ArchitectureReviewRecord = {
    ...current,
    decision,
    decisionNote: note,
    decidedAt: now,
    revision: current.revision + 1,
    updatedAt: now,
  };
  memoryReviews.set(id, review);
  memoryEvents.get(id)!.push({
    id: randomUUID(),
    reviewId: id,
    actorId: ownerId,
    eventType: "decision.changed",
    reviewRevision: review.revision,
    data: { decision, note },
    createdAt: now,
  });
  return { status: "updated", review: structuredClone(review) };
}

export function resetMemoryReviewsForTests(): void {
  memoryReviews.clear();
  memoryEvents.clear();
}
