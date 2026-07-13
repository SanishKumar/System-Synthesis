/**
 * Board Repository — unified data access layer.
 * 
 * Strategy:
 *   READ:  Redis (hot cache) → PostgreSQL (durable) → in-memory (fallback)
 *   WRITE: Always write to PostgreSQL first (if available), then update Redis cache.
 *          If Postgres is unavailable, falls back to Redis/memory only.
 * 
 * Snapshots:
 *   Every save creates a new versioned snapshot in board_snapshots.
 *   This enables full version history and rollback.
 */

import type {
  BoardState,
  SerializedNode,
  SerializedEdge,
} from "@system-synthesis/shared";
import { getPool, isDbAvailable } from "./db.js";
import {
  diffArchitectureGraphs,
  type SemanticGraphDiff,
} from "./graphDiff.js";

export interface SnapshotSaveOptions {
  createdBy?: string;
  createdByName?: string;
  name?: string;
  sourceBoardId?: string;
  sourceVersion?: number;
}

export interface SnapshotSummary {
  version: number;
  name: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  parentVersion: number | null;
  sourceBoardId: string | null;
  sourceVersion: number | null;
  nodeCount: number;
  edgeCount: number;
  changeSummary: SemanticGraphDiff;
}

export interface BoardVersion extends SnapshotSummary {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
}

// ============================================================
// Redis + Memory layer (imported from existing service)
// ============================================================
import {
  getBoardState as redisGetBoard,
  saveBoardState as redisSaveBoard,
  createBoard as redisCreateBoard,
  updateBoardMeta as redisUpdateBoardMeta,
  deleteBoard as redisDeleteBoard,
  listBoards as redisListBoards,
  getMetrics as redisGetMetrics,
  toggleBoardVisibility as redisToggleVisibility,
} from "./redis.js";

// ============================================================
// PostgreSQL Operations
// ============================================================

/**
 * Upsert board metadata and current_data into Postgres.
 */
async function pgUpsertBoard(board: BoardState): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO boards (id, name, description, owner_id, owner_name, is_public, created_at, updated_at, current_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         owner_id = EXCLUDED.owner_id,
         owner_name = EXCLUDED.owner_name,
         is_public = EXCLUDED.is_public,
         updated_at = EXCLUDED.updated_at,
         current_data = EXCLUDED.current_data`,
      [
        board.id,
        board.name,
        board.description || "",
        board.ownerId,
        board.ownerName,
        board.isPublic,
        board.createdAt,
        board.updatedAt,
        JSON.stringify({ nodes: board.nodes, edges: board.edges })
      ]
    );
  } catch (err: any) {
    console.error("  ⚠ pgUpsertBoard error:", err.message);
  }
}

/**
 * Save a new snapshot version to Postgres.
 * Returns the new version number.
 */
export async function pgSaveSnapshot(
  boardId: string,
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: SnapshotSaveOptions = {}
): Promise<SnapshotSummary | null> {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Allocate the version and calculate its diff while holding the same
    // per-board transaction lock. Concurrent writers cannot race MAX + 1.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [boardId]);
    const latestResult = await client.query(
      `SELECT version, data FROM board_snapshots
       WHERE board_id = $1 ORDER BY version DESC LIMIT 1`,
      [boardId]
    );
    const latest = latestResult.rows[0];
    const nextVersion = Number(latest?.version || 0) + 1;
    const previousData = latest?.data || { nodes: [], edges: [] };
    const changeSummary = diffArchitectureGraphs(
      previousData.nodes || [],
      previousData.edges || [],
      nodes,
      edges
    );
    const inserted = await client.query(
      `INSERT INTO board_snapshots (
         board_id, version, data, created_by, created_by_name, name,
         parent_version, source_board_id, source_version, change_summary
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING created_at`,
      [
        boardId,
        nextVersion,
        JSON.stringify({ nodes, edges }),
        options.createdBy || null,
        options.createdByName || null,
        options.name?.trim() || null,
        latest?.version || null,
        options.sourceBoardId || null,
        options.sourceVersion || null,
        JSON.stringify(changeSummary),
      ]
    );
    await client.query("COMMIT");
    const createdAt = inserted.rows[0]?.created_at;
    return {
      version: nextVersion,
      name: options.name?.trim() || null,
      createdAt: createdAt instanceof Date
        ? createdAt.toISOString()
        : String(createdAt || new Date().toISOString()),
      createdBy: options.createdBy || null,
      createdByName: options.createdByName || null,
      parentVersion: latest?.version || null,
      sourceBoardId: options.sourceBoardId || null,
      sourceVersion: options.sourceVersion || null,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      changeSummary,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get the latest snapshot from Postgres for a board.
 */
async function pgGetLatestSnapshot(
  boardId: string
): Promise<{ nodes: SerializedNode[]; edges: SerializedEdge[]; version: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT version, data FROM board_snapshots 
       WHERE board_id = $1 
       ORDER BY version DESC LIMIT 1`,
      [boardId]
    );
    if (result.rows.length === 0) return null;

    const data = result.rows[0].data;
    return {
      nodes: data.nodes || [],
      edges: data.edges || [],
      version: result.rows[0].version,
    };
  } catch (err: any) {
    console.error("  ⚠ pgGetLatestSnapshot error:", err.message);
    return null;
  }
}

/**
 * Get board metadata from Postgres.
 */
async function pgGetBoard(boardId: string): Promise<BoardState | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT id, name, description, owner_id, owner_name, is_public, created_at, updated_at, current_data
       FROM boards WHERE id = $1 AND deleted_at IS NULL`,
      [boardId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const data = row.current_data || { nodes: [], edges: [] };

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      isPublic: row.is_public,
      nodes: data.nodes || [],
      edges: data.edges || [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  } catch (err: any) {
    console.error("  ⚠ pgGetBoard error:", err.message);
    return null;
  }
}

/**
 * List all boards from Postgres (non-deleted).
 */
async function pgListBoards(
  requesterId?: string,
  memberBoardIds: string[] = []
): Promise<BoardState[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    let result;
    if (requesterId) {
      result = await pool.query(
        `SELECT id, name, description, owner_id, owner_name, is_public, created_at, updated_at, current_data
         FROM boards 
         WHERE deleted_at IS NULL AND (owner_id = $1 OR is_public = true OR id = ANY($2::text[]))
         ORDER BY updated_at DESC`,
        [requesterId, memberBoardIds]
      );
    } else {
      result = await pool.query(
        `SELECT id, name, description, owner_id, owner_name, is_public, created_at, updated_at, current_data
         FROM boards WHERE deleted_at IS NULL ORDER BY updated_at DESC`
      );
    }

    // We use current_data for node/edge counts
    const boards: BoardState[] = [];
    for (const row of result.rows) {
      const data = row.current_data || { nodes: [], edges: [] };
      boards.push({
        id: row.id,
        name: row.name,
        description: row.description,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        isPublic: row.is_public,
        nodes: data.nodes || [],
        edges: data.edges || [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      });
    }

    return boards;
  } catch (err: any) {
    console.error("  ⚠ pgListBoards error:", err.message);
    return [];
  }
}

// ============================================================
// Unified Public API — Redis-first with Postgres durability
// ============================================================

/**
 * Get board state. Checks Redis first, falls back to Postgres.
 */
export async function getBoardState(boardId: string): Promise<BoardState | null> {
  // 1. Try Redis/memory (fast path)
  const cached = await redisGetBoard(boardId);
  if (cached) return cached;

  // 2. Try Postgres (durable path)
  if (isDbAvailable()) {
    const pgBoard = await pgGetBoard(boardId);
    if (pgBoard) {
      // Warm the Redis cache
      await redisSaveBoard(boardId, pgBoard.nodes, pgBoard.edges);
      return pgBoard;
    }
  }

  return null;
}

/**
 * Save board state — writes to both Redis and Postgres.
 * Note: No longer creates a snapshot on every auto-save.
 */
export async function saveBoardState(
  boardId: string,
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  savedBy?: string
): Promise<void> {
  // 1. Always update Redis (fast real-time cache)
  await redisSaveBoard(boardId, nodes, edges);

  // 2. Persist to Postgres (durable)
  if (isDbAvailable()) {
    // Ensure board row exists
    const board = await redisGetBoard(boardId);
    if (board) {
      board.nodes = nodes;
      board.edges = edges;
      await pgUpsertBoard(board);
    }
  }
}

/**
 * Manually save a snapshot version.
 */
export async function saveBoardSnapshot(
  boardId: string,
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  options: SnapshotSaveOptions = {}
): Promise<SnapshotSummary | null> {
  if (isDbAvailable()) {
    const snapshot = await pgSaveSnapshot(boardId, nodes, edges, options);
    if (snapshot !== null) {
      console.log(`  Snapshot v${snapshot.version} saved for "${boardId}"`);
    }
    return snapshot;
  }
  return null;
}

/**
 * Create a new board.
 */
export async function createBoard(
  name: string,
  description: string | undefined,
  ownerId: string,
  ownerName: string,
  initialState?: { nodes: SerializedNode[]; edges: SerializedEdge[] },
  initialVersionName = "Initial version",
  initialVersionSource?: { boardId: string; version: number }
): Promise<BoardState> {
  // Create in Redis/memory first (gets an ID)
  const board = await redisCreateBoard(name, description, ownerId, ownerName);
  if (initialState) {
    board.nodes = initialState.nodes;
    board.edges = initialState.edges;
    board.updatedAt = new Date().toISOString();
    await redisSaveBoard(board.id, board.nodes, board.edges);
  }

  // Persist to Postgres
  if (isDbAvailable()) {
    await pgUpsertBoard(board);
    await pgSaveSnapshot(board.id, board.nodes, board.edges, {
      createdBy: ownerId,
      createdByName: ownerName,
      name: initialVersionName,
      sourceBoardId: initialVersionSource?.boardId,
      sourceVersion: initialVersionSource?.version,
    });
  }

  return board;
}

/**
 * Update board metadata.
 */
export async function updateBoardMeta(
  boardId: string,
  name?: string,
  description?: string
): Promise<BoardState | null> {
  const board = await redisUpdateBoardMeta(boardId, name, description);
  if (!board) return null;

  // Sync to Postgres
  if (isDbAvailable()) {
    await pgUpsertBoard(board);
  }

  return board;
}

/**
 * Toggle board visibility.
 */
export async function toggleBoardVisibility(
  boardId: string,
  requesterId: string
): Promise<{ board: BoardState; changed: boolean } | null> {
  const result = await redisToggleVisibility(boardId, requesterId);
  if (!result) return null;

  // Sync to Postgres
  if (result.changed && isDbAvailable()) {
    await pgUpsertBoard(result.board);
  }

  return result;
}

/**
 * Delete a board.
 */
export async function deleteBoard(
  boardId: string,
  requesterId?: string
): Promise<boolean> {
  const deleted = await redisDeleteBoard(boardId, requesterId);

  // Soft-delete in Postgres
  if (deleted && isDbAvailable()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE boards SET deleted_at = NOW() WHERE id = $1`,
          [boardId]
        );
      } catch (err: any) {
        console.error("  ⚠ pgDeleteBoard error:", err.message);
      }
    }
  }

  return deleted;
}

/**
 * List boards visible to a user.
 * Uses Postgres if available (canonical source), otherwise Redis.
 */
export async function listBoards(
  requesterId?: string,
  memberBoardIds: string[] = []
): Promise<BoardState[]> {
  // 1. Try Redis/memory (fast path)
  const cachedBoards = await redisListBoards(requesterId, memberBoardIds);
  if (cachedBoards && cachedBoards.length > 0) {
    return cachedBoards;
  }

  // 2. Try Postgres (durable path) if cache is empty
  if (isDbAvailable()) {
    return await pgListBoards(requesterId, memberBoardIds);
  }

  return [];
}

/**
 * Get metrics.
 */
export async function getMetrics(requesterId?: string, memberBoardIds: string[] = []) {
  // Always compute from the listing (which uses Postgres if available)
  const boards = await listBoards(requesterId, memberBoardIds);
  let totalNodes = 0;
  let totalEdges = 0;

  for (const board of boards) {
    totalNodes += board.nodes.length;
    totalEdges += board.edges.length;
  }

  return {
    totalBoards: boards.length,
    totalNodes,
    totalEdges,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

// ============================================================
// Version History API
// ============================================================

/**
 * List all snapshots (versions) for a board.
 */
export async function listBoardVersions(boardId: string): Promise<SnapshotSummary[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT version, name, created_at, created_by, created_by_name,
              parent_version, source_board_id, source_version, data, change_summary
       FROM board_snapshots
       WHERE board_id = $1
       ORDER BY version DESC
       LIMIT 50`,
      [boardId]
    );

    return result.rows.map((row) => ({
      version: row.version,
      name: row.name,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      parentVersion: row.parent_version,
      sourceBoardId: row.source_board_id,
      sourceVersion: row.source_version,
      nodeCount: row.data?.nodes?.length || 0,
      edgeCount: row.data?.edges?.length || 0,
      changeSummary: row.change_summary || { changes: [], stats: { added: 0, removed: 0, changed: 0, total: 0 } },
    }));
  } catch (err: any) {
    console.error("  ⚠ listBoardVersions error:", err.message);
    return [];
  }
}

/**
 * Get a specific version snapshot.
 */
export async function getBoardVersion(
  boardId: string,
  version: number
): Promise<BoardVersion | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT version, name, data, created_at, created_by, created_by_name,
              parent_version, source_board_id, source_version, change_summary
       FROM board_snapshots
       WHERE board_id = $1 AND version = $2`,
      [boardId, version]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      nodes: row.data?.nodes || [],
      edges: row.data?.edges || [],
      version: row.version,
      name: row.name,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      parentVersion: row.parent_version,
      sourceBoardId: row.source_board_id,
      sourceVersion: row.source_version,
      nodeCount: row.data?.nodes?.length || 0,
      edgeCount: row.data?.edges?.length || 0,
      changeSummary: row.change_summary || { changes: [], stats: { added: 0, removed: 0, changed: 0, total: 0 } },
    };
  } catch (err: any) {
    console.error("  ⚠ getBoardVersion error:", err.message);
    return null;
  }
}

/**
 * Restore a board to a previous version.
 * Creates a NEW snapshot (so the restoration is itself a version).
 */
export async function restoreBoardVersion(
  boardId: string,
  version: number,
  restoredBy?: { userId: string; userName: string }
): Promise<BoardState | null> {
  const snapshot = await getBoardVersion(boardId, version);
  if (!snapshot) return null;

  // Save as a new version (creates a new snapshot)
  await saveBoardState(boardId, snapshot.nodes, snapshot.edges, restoredBy?.userId);
  await saveBoardSnapshot(boardId, snapshot.nodes, snapshot.edges, {
    createdBy: restoredBy?.userId,
    createdByName: restoredBy?.userName,
    name: `Restored v${version}`,
    sourceBoardId: boardId,
    sourceVersion: version,
  });

  // Return the updated board
  return getBoardState(boardId);
}

export async function renameBoardVersion(
  boardId: string,
  version: number,
  name: string
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE board_snapshots SET name = $3
     WHERE board_id = $1 AND version = $2`,
    [boardId, version, name.trim()]
  );
  return (result.rowCount || 0) > 0;
}

export async function duplicateBoardVersion(
  sourceBoard: BoardState,
  version: number,
  owner: { userId: string; userName: string },
  requestedName?: string
): Promise<BoardState | null> {
  const snapshot = await getBoardVersion(sourceBoard.id, version);
  if (!snapshot) return null;
  return createBoard(
    requestedName?.trim() || `${sourceBoard.name} — v${version} copy`,
    `Duplicated from ${sourceBoard.name}, version ${version}.`,
    owner.userId,
    owner.userName,
    { nodes: snapshot.nodes, edges: snapshot.edges },
    `Duplicated from ${sourceBoard.name} v${version}`,
    { boardId: sourceBoard.id, version }
  );
}
