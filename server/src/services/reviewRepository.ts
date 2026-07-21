import { randomUUID } from "node:crypto";
import type {
  ArchitectureChangeReview,
  ArchitecturePolicy,
  CanonicalArchitectureGraph,
} from "@system-synthesis/architecture-core";
import { getPool } from "./db.js";

export type ReviewDecision = "pending" | "approved" | "rejected";

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
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureReviewEvent {
  id: string;
  reviewId: string;
  actorId: string;
  eventType: "review.created" | "suppression.added" | "decision.changed";
  reviewRevision: number;
  data: Record<string, unknown>;
  createdAt: string;
}

export type ReviewMutationResult =
  | { status: "updated"; review: ArchitectureReviewRecord }
  | { status: "conflict" }
  | { status: "not_found" };

const memoryReviews = new Map<string, ArchitectureReviewRecord>();
const memoryEvents = new Map<string, ArchitectureReviewEvent[]>();

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToReview(row: any): ArchitectureReviewRecord {
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

export async function createArchitectureReview(
  input: Omit<
    ArchitectureReviewRecord,
    "id" | "decision" | "decisionNote" | "decidedAt" | "revision" | "createdAt" | "updatedAt"
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
           head_revision, base_graph, head_graph, policy, report
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
             decision = 'pending',
             decision_note = NULL,
             decided_at = NULL,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND revision = $3
         RETURNING *`,
        [id, ownerId, expectedRevision, JSON.stringify(policy), JSON.stringify(report)]
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
