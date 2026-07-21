import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BoardRole, BoardState } from "@system-synthesis/shared";
import { getPool } from "./db.js";

export type { BoardRole } from "@system-synthesis/shared";

export interface AuditRecord {
  id: string;
  boardId: string | null;
  actorId: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const ROLE_WEIGHT: Record<BoardRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const memoryMembers = new Map<string, Map<string, BoardRole>>();
const memoryInvitations = new Map<
  string,
  {
    id: string;
    boardId: string;
    role: Exclude<BoardRole, "owner">;
    createdBy: string;
    expiresAt: Date;
    usedBy: string | null;
    usedAt: Date | null;
  }
>();
const memoryAudit: AuditRecord[] = [];

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function roleAllows(role: BoardRole | null, required: BoardRole): boolean {
  return !!role && ROLE_WEIGHT[role] >= ROLE_WEIGHT[required];
}

export async function resolveBoardRole(
  board: BoardState,
  userId: string
): Promise<BoardRole | null> {
  if (board.ownerId === userId) return "owner";

  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2`,
      [board.id, userId]
    );
    if (result.rows[0]?.role) return result.rows[0].role as BoardRole;
  } else {
    const role = memoryMembers.get(board.id)?.get(userId);
    if (role) return role;
  }

  return board.isPublic ? "viewer" : null;
}

export async function listMemberBoardIds(userId: string): Promise<string[]> {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT board_id FROM board_members WHERE user_id = $1`,
      [userId]
    );
    return result.rows.map((row) => row.board_id as string);
  }

  const ids: string[] = [];
  for (const [boardId, members] of memoryMembers) {
    if (members.has(userId)) ids.push(boardId);
  }
  return ids;
}

export async function setBoardMemberRole(
  boardId: string,
  userId: string,
  role: Exclude<BoardRole, "owner">,
  invitedBy: string
): Promise<void> {
  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO board_members (board_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, updated_at = NOW()`,
      [boardId, userId, role, invitedBy]
    );
    return;
  }

  if (!memoryMembers.has(boardId)) memoryMembers.set(boardId, new Map());
  memoryMembers.get(boardId)!.set(userId, role);
}

export async function removeBoardMember(boardId: string, userId: string): Promise<void> {
  const pool = getPool();
  if (pool) {
    await pool.query(
      `DELETE FROM board_members WHERE board_id = $1 AND user_id = $2`,
      [boardId, userId]
    );
    return;
  }
  memoryMembers.get(boardId)?.delete(userId);
}

export async function listBoardMembers(
  board: BoardState
): Promise<Array<{ userId: string; userName: string; role: BoardRole }>> {
  const members: Array<{ userId: string; userName: string; role: BoardRole }> = [
    { userId: board.ownerId, userName: board.ownerName, role: "owner" },
  ];
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT bm.user_id, COALESCE(u.user_name, 'Unknown') AS user_name, bm.role
       FROM board_members bm
       LEFT JOIN users u ON u.id = bm.user_id
       WHERE bm.board_id = $1
       ORDER BY bm.created_at ASC`,
      [board.id]
    );
    members.push(
      ...result.rows.map((row) => ({
        userId: row.user_id as string,
        userName: row.user_name as string,
        role: row.role as BoardRole,
      }))
    );
    return members;
  }

  for (const [userId, role] of memoryMembers.get(board.id) || []) {
    members.push({ userId, userName: userId, role });
  }
  return members;
}

export async function createBoardInvitation(
  boardId: string,
  role: Exclude<BoardRole, "owner">,
  createdBy: string,
  expiresInHours: number
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  const id = randomUUID();
  const pool = getPool();

  if (pool) {
    await pool.query(
      `INSERT INTO board_invitations
       (id, board_id, token_hash, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, boardId, tokenHash, role, createdBy, expiresAt]
    );
  } else {
    memoryInvitations.set(tokenHash, {
      id,
      boardId,
      role,
      createdBy,
      expiresAt,
      usedBy: null,
      usedAt: null,
    });
  }

  return { token, expiresAt: expiresAt.toISOString() };
}

export async function acceptBoardInvitation(
  token: string,
  userId: string
): Promise<{ boardId: string; role: Exclude<BoardRole, "owner"> } | null> {
  const tokenHash = hashToken(token);
  const pool = getPool();

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT id, board_id, role, expires_at, used_at
         FROM board_invitations
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash]
      );
      const invite = result.rows[0];
      if (!invite || invite.used_at || new Date(invite.expires_at).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `INSERT INTO board_members (board_id, user_id, role, invited_by)
         SELECT board_id, $2, role, created_by FROM board_invitations WHERE id = $1
         ON CONFLICT (board_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, updated_at = NOW()`,
        [invite.id, userId]
      );
      await client.query(
        `UPDATE board_invitations SET used_by = $2, used_at = NOW() WHERE id = $1`,
        [invite.id, userId]
      );
      await client.query("COMMIT");
      return { boardId: invite.board_id, role: invite.role };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const invite = memoryInvitations.get(tokenHash);
  if (!invite || invite.usedAt || invite.expiresAt.getTime() <= Date.now()) return null;
  invite.usedAt = new Date();
  invite.usedBy = userId;
  await setBoardMemberRole(invite.boardId, userId, invite.role, invite.createdBy);
  return { boardId: invite.boardId, role: invite.role };
}

export async function recordAudit(
  boardId: string | null,
  actorId: string,
  action: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO audit_logs (id, board_id, actor_id, action, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, boardId, actorId, action, JSON.stringify(metadata), createdAt]
    );
    return;
  }
  memoryAudit.push({ id, boardId, actorId, action, metadata, createdAt });
  if (memoryAudit.length > 2000) memoryAudit.splice(0, memoryAudit.length - 2000);
}

export async function listAuditRecords(boardId: string, limit = 100): Promise<AuditRecord[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 250));
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT id, board_id, actor_id, action, metadata, created_at
       FROM audit_logs WHERE board_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [boardId, boundedLimit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      actorId: row.actor_id,
      action: row.action,
      metadata: row.metadata || {},
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
  return memoryAudit
    .filter((entry) => entry.boardId === boardId)
    .slice(-boundedLimit)
    .reverse();
}
