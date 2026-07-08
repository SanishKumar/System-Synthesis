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
async function pgSaveSnapshot(
  boardId: string,
  nodes: SerializedNode[],
  edges: SerializedEdge[],
  createdBy?: string
): Promise<number | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Get next version number
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 as next_version 
       FROM board_snapshots WHERE board_id = $1`,
      [boardId]
    );
    const nextVersion = versionResult.rows[0].next_version;

    // Insert snapshot
    await pool.query(
      `INSERT INTO board_snapshots (board_id, version, data, created_by)
       VALUES ($1, $2, $3, $4)`,
      [boardId, nextVersion, JSON.stringify({ nodes, edges }), createdBy]
    );

    // Enforce retention policy (max 10 snapshots)
    await pool.query(
      `DELETE FROM board_snapshots
       WHERE board_id = $1 AND version NOT IN (
         SELECT version FROM board_snapshots
         WHERE board_id = $1
         ORDER BY version DESC
         LIMIT 10
       )`,
      [boardId]
    );

    return nextVersion;
  } catch (err: any) {
    console.error("  ⚠ pgSaveSnapshot error:", err.message);
    return null;
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
async function pgListBoards(requesterId?: string): Promise<BoardState[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    let result;
    if (requesterId) {
      result = await pool.query(
        `SELECT id, name, description, owner_id, owner_name, is_public, created_at, updated_at, current_data
         FROM boards 
         WHERE deleted_at IS NULL AND (owner_id = $1 OR is_public = true)
         ORDER BY updated_at DESC`,
        [requesterId]
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
  savedBy?: string
): Promise<void> {
  if (isDbAvailable()) {
    const version = await pgSaveSnapshot(boardId, nodes, edges, savedBy);
    if (version !== null) {
      console.log(`  📸 Snapshot v${version} saved for "${boardId}"`);
    }
  }
}

/**
 * Create a new board.
 */
export async function createBoard(
  name: string,
  description: string | undefined,
  ownerId: string,
  ownerName: string
): Promise<BoardState> {
  // Create in Redis/memory first (gets an ID)
  const board = await redisCreateBoard(name, description, ownerId, ownerName);

  // Persist to Postgres
  if (isDbAvailable()) {
    await pgUpsertBoard(board);
    await pgSaveSnapshot(board.id, board.nodes, board.edges, ownerId);
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
export async function listBoards(requesterId?: string): Promise<BoardState[]> {
  // 1. Try Redis/memory (fast path)
  const cachedBoards = await redisListBoards(requesterId);
  if (cachedBoards && cachedBoards.length > 0) {
    return cachedBoards;
  }

  // 2. Try Postgres (durable path) if cache is empty
  if (isDbAvailable()) {
    return await pgListBoards(requesterId);
  }

  return [];
}

/**
 * Get metrics.
 */
export async function getMetrics(requesterId?: string) {
  // Always compute from the listing (which uses Postgres if available)
  const boards = await listBoards(requesterId);
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

export interface SnapshotSummary {
  version: number;
  createdAt: string;
  createdBy: string | null;
  nodeCount: number;
  edgeCount: number;
}

/**
 * List all snapshots (versions) for a board.
 */
export async function listBoardVersions(boardId: string): Promise<SnapshotSummary[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT version, created_at, created_by, data
       FROM board_snapshots
       WHERE board_id = $1
       ORDER BY version DESC
       LIMIT 50`,
      [boardId]
    );

    return result.rows.map((row) => ({
      version: row.version,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
      nodeCount: row.data?.nodes?.length || 0,
      edgeCount: row.data?.edges?.length || 0,
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
): Promise<{ nodes: SerializedNode[]; edges: SerializedEdge[]; version: number; createdAt: string } | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT version, data, created_at
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
      createdAt: row.created_at.toISOString(),
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
  restoredBy?: string
): Promise<BoardState | null> {
  const snapshot = await getBoardVersion(boardId, version);
  if (!snapshot) return null;

  // Save as a new version (creates a new snapshot)
  await saveBoardState(boardId, snapshot.nodes, snapshot.edges, restoredBy);
  await saveBoardSnapshot(boardId, snapshot.nodes, snapshot.edges, restoredBy);

  // Return the updated board
  return getBoardState(boardId);
}
