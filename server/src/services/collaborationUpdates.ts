import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { getPool } from "./db.js";
import { redis } from "./redis.js";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import {
  initializeGraphDoc,
  upsertSharedRecord,
  type SharedRecord,
} from "./yjsGraph.js";

const PUBSUB_CHANNEL = "system-synthesis:collaboration-updates";
const STREAM_PREFIX = "system-synthesis:board-updates:";

export const collaborationInstanceId = randomUUID();

export interface CollaborationUpdate {
  boardId: string;
  update: Uint8Array;
  actorId: string;
  instanceId: string;
}

const memoryUpdates = new Map<string, Uint8Array[]>();
const memorySnapshots = new Map<string, Uint8Array>();
let subscriber: any = null;

function hashUpdate(update: Uint8Array): string {
  return createHash("sha256").update(update).digest("hex");
}

function streamKey(boardId: string): string {
  return `${STREAM_PREFIX}${boardId}`;
}

function snapshotKey(boardId: string): string {
  return `system-synthesis:board-snapshot:${boardId}`;
}

/** Establish one canonical Yjs base before any client update is accepted. */
export async function ensureCollaborationSnapshot(
  boardId: string,
  fallbackDoc: Y.Doc
): Promise<Uint8Array> {
  const fallback = Y.encodeStateAsUpdate(fallbackDoc);
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [boardId]);
      const existing = await client.query(
        `SELECT state_data FROM board_document_snapshots WHERE board_id = $1`,
        [boardId]
      );
      if (existing.rows[0]?.state_data) {
        await client.query("COMMIT");
        return new Uint8Array(existing.rows[0].state_data);
      }
      await client.query(
        `INSERT INTO board_document_snapshots (board_id, state_data, last_sequence)
         VALUES ($1, $2, 0)`,
        [boardId, Buffer.from(fallback)]
      );
      await client.query("COMMIT");
      return fallback;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (redis) {
    const encoded = Buffer.from(fallback).toString("base64");
    await redis.set(snapshotKey(boardId), encoded, "NX");
    const canonical = await redis.get(snapshotKey(boardId));
    return new Uint8Array(Buffer.from(canonical || encoded, "base64"));
  }

  if (!memorySnapshots.has(boardId)) memorySnapshots.set(boardId, fallback.slice());
  return memorySnapshots.get(boardId)!.slice();
}

export async function appendCollaborationUpdate(
  boardId: string,
  update: Uint8Array,
  actorId: string
): Promise<void> {
  const pool = getPool();
  let durablyStored = false;
  const updateHash = hashUpdate(update);

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [boardId]);
      await client.query(
        `INSERT INTO board_updates (board_id, update_hash, update_data, actor_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (board_id, update_hash) DO NOTHING`,
        [boardId, updateHash, Buffer.from(update), actorId]
      );
      await client.query("COMMIT");
      durablyStored = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const message: CollaborationUpdate = {
    boardId,
    update,
    actorId,
    instanceId: collaborationInstanceId,
  };
  const serialized = JSON.stringify({
    ...message,
    update: Buffer.from(update).toString("base64"),
  });

  if (redis) {
    try {
      await redis
        .multi()
        .xadd(
          streamKey(boardId),
          "*",
          "update",
          Buffer.from(update).toString("base64"),
          "actorId",
          actorId
        )
        .publish(PUBSUB_CHANNEL, serialized)
        .exec();
      durablyStored = true;
    } catch (error) {
      if (!durablyStored) throw error;
    }
  }

  if (!redis && !pool) {
    const updates = memoryUpdates.get(boardId) || [];
    if (!updates.some((item) => hashUpdate(item) === updateHash)) updates.push(update.slice());
    memoryUpdates.set(boardId, updates);
    durablyStored = true;
  }

  if (!durablyStored) throw new Error("No durable collaboration update store is available");
}

export async function loadCollaborationUpdates(boardId: string): Promise<Uint8Array[]> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const snapshot = await client.query(
        `SELECT state_data, last_sequence FROM board_document_snapshots WHERE board_id = $1`,
        [boardId]
      );
      const lastSequence = snapshot.rows[0]?.last_sequence || 0;
      const result = await client.query(
        `SELECT update_data FROM board_updates
         WHERE board_id = $1 AND sequence > $2 ORDER BY sequence ASC`,
        [boardId, lastSequence]
      );
      await client.query("COMMIT");
      return [
        ...(snapshot.rows[0]?.state_data
          ? [new Uint8Array(snapshot.rows[0].state_data)]
          : []),
        ...result.rows.map((row) => new Uint8Array(row.update_data)),
      ];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (redis) {
    const snapshot = await redis.get(snapshotKey(boardId));
    const entries = await redis.xrange(streamKey(boardId), "-", "+");
    const updates = entries.flatMap((entry: any[]) => {
      const fields = entry[1] as string[];
      const updateIndex = fields.indexOf("update");
      return updateIndex >= 0
        ? [new Uint8Array(Buffer.from(fields[updateIndex + 1], "base64"))]
        : [];
    });
    return [
      ...(snapshot ? [new Uint8Array(Buffer.from(snapshot, "base64"))] : []),
      ...updates,
    ];
  }

  return [
    ...(memorySnapshots.has(boardId) ? [memorySnapshots.get(boardId)!.slice()] : []),
    ...(memoryUpdates.get(boardId) || []).map((update) => update.slice()),
  ];
}

export async function replayCollaborationUpdates(boardId: string, doc: Y.Doc): Promise<number> {
  const updates = await loadCollaborationUpdates(boardId);
  for (const update of updates) Y.applyUpdate(doc, update, "durable-replay");
  return updates.length;
}

/**
 * Create and durably append a graph replacement update for version restore.
 * The returned full state is sent as a document replacement so connected
 * clients discard stale local CRDT structures instead of merging a restore
 * into an older in-memory graph.
 */
export async function replaceCollaborationState(
  boardId: string,
  currentFallback: { nodes: SerializedNode[]; edges: SerializedEdge[] },
  target: { nodes: SerializedNode[]; edges: SerializedEdge[] },
  actorId: string
): Promise<{ update: Uint8Array; fullState: Uint8Array }> {
  const doc = new Y.Doc();
  try {
    const replayed = await replayCollaborationUpdates(boardId, doc);
    if (replayed === 0) {
      const fallback = new Y.Doc();
      initializeGraphDoc(fallback, currentFallback.nodes, currentFallback.edges);
      const canonical = await ensureCollaborationSnapshot(boardId, fallback);
      fallback.destroy();
      Y.applyUpdate(doc, canonical, "canonical-base");
    }

    let replacement: Uint8Array | null = null;
    const capture = (update: Uint8Array, origin: unknown) => {
      if (origin === "version-restore") replacement = update.slice();
    };
    doc.on("update", capture);
    doc.transact(() => {
      const nodes = doc.getMap<SharedRecord>("nodes");
      const edges = doc.getMap<SharedRecord>("edges");
      nodes.clear();
      edges.clear();
      for (const node of target.nodes) {
        upsertSharedRecord(nodes, node.id, node as unknown as Record<string, unknown>);
      }
      for (const edge of target.edges) {
        upsertSharedRecord(edges, edge.id, edge as unknown as Record<string, unknown>);
      }
    }, "version-restore");
    doc.off("update", capture);

    if (!replacement) throw new Error("Version restore did not produce a collaboration update");
    await appendCollaborationUpdate(boardId, replacement, actorId);
    await compactCollaborationDocument(boardId, doc);
    return { update: replacement, fullState: Y.encodeStateAsUpdate(doc) };
  } finally {
    doc.destroy();
  }
}

/**
 * Atomically replace the append-only tail with a Yjs snapshot. PostgreSQL
 * writers take the same per-board advisory lock, so no accepted update can be
 * deleted without first being folded into the snapshot.
 */
export async function compactCollaborationDocument(
  boardId: string,
  currentDoc: Y.Doc
): Promise<boolean> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    const compacted = new Y.Doc();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [boardId]);
      Y.applyUpdate(compacted, Y.encodeStateAsUpdate(currentDoc), "compaction-base");
      const pending = await client.query(
        `SELECT sequence, update_data FROM board_updates
         WHERE board_id = $1 ORDER BY sequence ASC`,
        [boardId]
      );
      for (const row of pending.rows) {
        Y.applyUpdate(compacted, new Uint8Array(row.update_data), "compaction-tail");
      }
      const previous = await client.query(
        `SELECT last_sequence FROM board_document_snapshots WHERE board_id = $1`,
        [boardId]
      );
      const lastSequence = pending.rows.length
        ? pending.rows[pending.rows.length - 1].sequence
        : previous.rows[0]?.last_sequence || 0;
      await client.query(
        `INSERT INTO board_document_snapshots (board_id, state_data, last_sequence, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (board_id) DO UPDATE
         SET state_data = EXCLUDED.state_data,
             last_sequence = EXCLUDED.last_sequence,
             created_at = NOW()`,
        [boardId, Buffer.from(Y.encodeStateAsUpdate(compacted)), lastSequence]
      );
      await client.query(
        `DELETE FROM board_updates WHERE board_id = $1 AND sequence <= $2`,
        [boardId, lastSequence]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      compacted.destroy();
      client.release();
    }
  }

  if (!redis) {
    memorySnapshots.set(boardId, Y.encodeStateAsUpdate(currentDoc));
    memoryUpdates.delete(boardId);
    return true;
  }

  // Redis-only deployments retain the ordered stream: trimming it safely
  // requires a distributed snapshot lease, which PostgreSQL mode provides.
  return false;
}

export async function initializeCollaborationSubscription(
  onUpdate: (message: CollaborationUpdate) => void | Promise<void>,
  onTransportRecovered?: () => void | Promise<void>
): Promise<boolean> {
  if (!redis || subscriber) return false;
  subscriber = redis.duplicate();
  await subscriber.subscribe(PUBSUB_CHANNEL);
  subscriber.on("message", async (channel: string, raw: string) => {
    if (channel !== PUBSUB_CHANNEL) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.instanceId === collaborationInstanceId) return;
      await onUpdate({
        boardId: parsed.boardId,
        actorId: parsed.actorId,
        instanceId: parsed.instanceId,
        update: new Uint8Array(Buffer.from(parsed.update, "base64")),
      });
    } catch {
      // Ignore malformed pub/sub messages. Durable replay remains authoritative.
    }
  });
  subscriber.on("ready", async () => {
    try {
      await onTransportRecovered?.();
    } catch {
      // The next reconnect or room join will retry durable replay.
    }
  });
  return true;
}
