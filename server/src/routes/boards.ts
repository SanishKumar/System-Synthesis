import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { BoardRole, BoardState } from "@system-synthesis/shared";
import {
  listBoards,
  getBoardState,
  createBoard,
  updateBoardMeta,
  deleteBoard,
  getMetrics,
  toggleBoardVisibility,
  listBoardVersions,
  getBoardVersion,
  restoreBoardVersion,
  saveBoardSnapshot,
  saveBoardState,
  renameBoardVersion,
  duplicateBoardVersion,
} from "../services/boardRepository.js";
import { validateArchitecture, validationToSarif } from "../services/validation.js";
import { boardCreateLimiter } from "../middleware/rateLimit.js";
import {
  acceptBoardInvitation,
  createBoardInvitation,
  listAuditRecords,
  listBoardMembers,
  listMemberBoardIds,
  recordAudit,
  removeBoardMember,
  resolveBoardRole,
  roleAllows,
  setBoardMemberRole,
} from "../services/accessControl.js";
import { replaceCollaborationState } from "../services/collaborationUpdates.js";

const router = Router();

const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const boardInputSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Untitled Board"),
  description: z.string().trim().max(1000).default(""),
});
const boardUpdateSchema = boardInputSchema.partial().refine(
  (value) => value.name !== undefined || value.description !== undefined,
  "At least one field is required"
);
const memberSchema = z.object({ role: z.enum(["editor", "viewer"]) });
const invitationSchema = z.object({
  role: z.enum(["editor", "viewer"]).default("viewer"),
  expiresInHours: z.number().int().min(1).max(168).default(24),
});
const checkpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
const duplicateVersionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});
const validationOptionsSchema = z.object({
  enabledRuleIds: z.array(z.string().min(1).max(100)).max(100).optional(),
  disabledRuleIds: z.array(z.string().min(1).max(100)).max(100).optional(),
  severityOverrides: z.record(z.enum(["critical", "warning", "info"])).optional(),
  suppressions: z.array(z.object({
    ruleId: z.string().min(1).max(100),
    nodeId: z.string().min(1).max(128).optional(),
    edgeId: z.string().min(1).max(128).optional(),
    justification: z.string().trim().min(3).max(500),
  })).max(250).optional(),
}).optional();
const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(100),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    data: z.record(z.unknown()),
  }).passthrough()).max(2_000),
  edges: z.array(z.object({
    id: z.string().min(1).max(128),
    source: z.string().min(1).max(128),
    target: z.string().min(1).max(128),
  }).passthrough()).max(5_000),
  options: validationOptionsSchema,
});

function badRequest(res: Response, parsed: { error: z.ZodError }): Response {
  return res.status(400).json({ error: "Invalid request payload", details: parsed.error.flatten() });
}

async function authorizedBoard(
  req: Request,
  res: Response,
  requiredRole: BoardRole
): Promise<{ board: BoardState; role: BoardRole } | null> {
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: "Invalid board identifier" });
    return null;
  }
  const board = await getBoardState(parsedId.data);
  if (!board) {
    res.status(404).json({ error: "Board not found" });
    return null;
  }
  const role = await resolveBoardRole(board, req.user!.userId);
  if (!roleAllows(role, requiredRole)) {
    await recordAudit(board.id, req.user!.userId, "authorization.denied", {
      requiredRole,
      actualRole: role,
      method: req.method,
      path: req.path,
    });
    res.status(403).json({ error: `${requiredRole} role required` });
    return null;
  }
  return { board, role: role! };
}

async function ejectUnauthorizedSockets(req: Request, board: BoardState): Promise<void> {
  const io = req.app.get("io");
  if (!io) return;
  const sockets = await io.in(board.id).fetchSockets();
  for (const roomSocket of sockets) {
    const socketUserId = roomSocket.data?.userId;
    if (!socketUserId) continue;
    const role = await resolveBoardRole(board, socketUserId);
    if (!role) {
      roomSocket.emit("board_access_revoked", { boardId: board.id, ownerId: board.ownerId });
      await roomSocket.leave(board.id);
    }
  }
}

router.get("/metrics", async (req, res) => {
  try {
    const memberBoardIds = await listMemberBoardIds(req.user!.userId);
    res.json(await getMetrics(req.user!.userId, memberBoardIds));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/validate", async (req, res) => {
  const parsed = graphSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  try {
    res.json(validateArchitecture(parsed.data.nodes as any[], parsed.data.edges as any[], parsed.data.options));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/validate/sarif", async (req, res) => {
  const parsed = graphSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const result = validateArchitecture(parsed.data.nodes as any[], parsed.data.edges as any[], parsed.data.options);
  res.json(validationToSarif(result));
});

router.post("/invitations/:token/accept", async (req, res) => {
  const token = z.string().min(20).max(128).safeParse(req.params.token);
  if (!token.success) return res.status(400).json({ error: "Invalid invitation token" });
  try {
    const accepted = await acceptBoardInvitation(token.data, req.user!.userId);
    if (!accepted) return res.status(410).json({ error: "Invitation is invalid, expired, or already used" });
    await recordAudit(accepted.boardId, req.user!.userId, "invitation.accepted", { role: accepted.role });
    res.json(accepted);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const memberBoardIds = await listMemberBoardIds(req.user!.userId);
    const boards = await listBoards(req.user!.userId, memberBoardIds);
    const summaries = await Promise.all(
      boards.map(async (board) => ({
        id: board.id,
        name: board.name,
        description: board.description,
        ownerId: board.ownerId,
        ownerName: board.ownerName,
        isPublic: board.isPublic,
        role: await resolveBoardRole(board, req.user!.userId),
        nodeCount: board.nodes.length,
        edgeCount: board.edges.length,
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
      }))
    );
    const sortedBoards = summaries.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    res.json({
      boards: sortedBoards,
      metrics: {
        totalBoards: sortedBoards.length,
        totalNodes: sortedBoards.reduce((total, board) => total + board.nodeCount, 0),
        totalEdges: sortedBoards.reduce((total, board) => total + board.edgeCount, 0),
        uptimeSeconds: Math.floor(process.uptime()),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/", boardCreateLimiter, async (req, res) => {
  const parsed = boardInputSchema.safeParse(req.body || {});
  if (!parsed.success) return badRequest(res, parsed);
  try {
    const board = await createBoard(
      parsed.data.name,
      parsed.data.description,
      req.user!.userId,
      req.user!.userName
    );
    await recordAudit(board.id, req.user!.userId, "board.created");
    res.status(201).json({ ...board, role: "owner" as const });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    res.json({ ...access.board, role: access.role });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/:id", async (req, res) => {
  const parsed = boardUpdateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    const board = await updateBoardMeta(req.params.id, parsed.data.name, parsed.data.description);
    await recordAudit(req.params.id, req.user!.userId, "board.metadata.updated", parsed.data);
    res.json({ ...board, role: "owner" as const });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/visibility", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    const result = await toggleBoardVisibility(req.params.id, req.user!.userId);
    if (!result?.changed) return res.status(409).json({ error: "Visibility was not changed" });
    await recordAudit(result.board.id, req.user!.userId, "board.visibility.changed", {
      isPublic: result.board.isPublic,
    });
    if (!result.board.isPublic) await ejectUnauthorizedSockets(req, result.board);
    res.json({ id: result.board.id, isPublic: result.board.isPublic });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id/members", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    res.json({ members: await listBoardMembers(access.board) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/members/:userId", async (req, res) => {
  const memberId = idSchema.safeParse(req.params.userId);
  const parsed = memberSchema.safeParse(req.body);
  if (!memberId.success || !parsed.success) return res.status(400).json({ error: "Invalid member update" });
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    if (memberId.data === access.board.ownerId) return res.status(400).json({ error: "Owner role cannot be changed" });
    await setBoardMemberRole(access.board.id, memberId.data, parsed.data.role, req.user!.userId);
    await recordAudit(access.board.id, req.user!.userId, "board.member.role_changed", {
      memberId: memberId.data,
      role: parsed.data.role,
    });
    res.json({ userId: memberId.data, role: parsed.data.role });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id/members/:userId", async (req, res) => {
  const memberId = idSchema.safeParse(req.params.userId);
  if (!memberId.success) return res.status(400).json({ error: "Invalid member identifier" });
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    if (memberId.data === access.board.ownerId) return res.status(400).json({ error: "Owner cannot be removed" });
    await removeBoardMember(access.board.id, memberId.data);
    await recordAudit(access.board.id, req.user!.userId, "board.member.removed", { memberId: memberId.data });
    await ejectUnauthorizedSockets(req, access.board);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/invitations", async (req, res) => {
  const parsed = invitationSchema.safeParse(req.body || {});
  if (!parsed.success) return badRequest(res, parsed);
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    const invitation = await createBoardInvitation(
      access.board.id,
      parsed.data.role,
      req.user!.userId,
      parsed.data.expiresInHours
    );
    await recordAudit(access.board.id, req.user!.userId, "invitation.created", {
      role: parsed.data.role,
      expiresAt: invitation.expiresAt,
    });
    res.status(201).json(invitation);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id/audit", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    const limit = z.coerce.number().int().min(1).max(250).catch(100).parse(req.query.limit);
    res.json({ records: await listAuditRecords(access.board.id, limit) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    await recordAudit(access.board.id, req.user!.userId, "board.deleted");
    const deleted = await deleteBoard(access.board.id, req.user!.userId);
    if (!deleted) return res.status(409).json({ error: "Board could not be deleted" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/versions", async (req, res) => {
  const parsed = checkpointSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  try {
    const access = await authorizedBoard(req, res, "editor");
    if (!access) return;
    const getLiveState = req.app.get("getCollaborationState") as
      | ((boardId: string) => { nodes: any[]; edges: any[] } | null)
      | undefined;
    const state = getLiveState?.(access.board.id) || access.board;
    await saveBoardState(access.board.id, state.nodes, state.edges, req.user!.userId);
    const snapshot = await saveBoardSnapshot(access.board.id, state.nodes, state.edges, {
      createdBy: req.user!.userId,
      createdByName: req.user!.userName,
      name: parsed.data.name,
    });
    if (!snapshot) {
      return res.status(503).json({ error: "Durable version history requires PostgreSQL" });
    }
    await recordAudit(access.board.id, req.user!.userId, "board.version.created", {
      version: snapshot.version,
      name: snapshot.name,
    });
    res.status(201).json(snapshot);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id/versions", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    res.json({ versions: await listBoardVersions(access.board.id) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id/versions/:version", async (req, res) => {
  const version = z.coerce.number().int().positive().safeParse(req.params.version);
  if (!version.success) return res.status(400).json({ error: "Invalid version number" });
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    const snapshot = await getBoardVersion(access.board.id, version.data);
    if (!snapshot) return res.status(404).json({ error: "Version not found" });
    res.json(snapshot);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id/versions/:version/diff", async (req, res) => {
  const version = z.coerce.number().int().positive().safeParse(req.params.version);
  if (!version.success) return res.status(400).json({ error: "Invalid version number" });
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    const snapshot = await getBoardVersion(access.board.id, version.data);
    if (!snapshot) return res.status(404).json({ error: "Version not found" });
    res.json({
      version: snapshot.version,
      parentVersion: snapshot.parentVersion,
      sourceBoardId: snapshot.sourceBoardId,
      sourceVersion: snapshot.sourceVersion,
      ...snapshot.changeSummary,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/versions/:version", async (req, res) => {
  const version = z.coerce.number().int().positive().safeParse(req.params.version);
  const parsed = checkpointSchema.safeParse(req.body);
  if (!version.success || !parsed.success) return res.status(400).json({ error: "Invalid version update" });
  try {
    const access = await authorizedBoard(req, res, "editor");
    if (!access) return;
    const renamed = await renameBoardVersion(access.board.id, version.data, parsed.data.name);
    if (!renamed) return res.status(404).json({ error: "Version not found" });
    await recordAudit(access.board.id, req.user!.userId, "board.version.renamed", {
      version: version.data,
      name: parsed.data.name,
    });
    res.json({ version: version.data, name: parsed.data.name });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/versions/:version/duplicate", async (req, res) => {
  const version = z.coerce.number().int().positive().safeParse(req.params.version);
  const parsed = duplicateVersionSchema.safeParse(req.body || {});
  if (!version.success || !parsed.success) return res.status(400).json({ error: "Invalid duplicate request" });
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    const duplicate = await duplicateBoardVersion(
      access.board,
      version.data,
      { userId: req.user!.userId, userName: req.user!.userName },
      parsed.data.name
    );
    if (!duplicate) return res.status(404).json({ error: "Version not found" });
    await recordAudit(access.board.id, req.user!.userId, "board.version.duplicated", {
      version: version.data,
      duplicateBoardId: duplicate.id,
    });
    await recordAudit(duplicate.id, req.user!.userId, "board.created_from_version", {
      sourceBoardId: access.board.id,
      sourceVersion: version.data,
    });
    res.status(201).json({ ...duplicate, role: "owner" as const });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/versions/:version/restore", async (req, res) => {
  const version = z.coerce.number().int().positive().safeParse(req.params.version);
  if (!version.success) return res.status(400).json({ error: "Invalid version number" });
  try {
    const access = await authorizedBoard(req, res, "owner");
    if (!access) return;
    const target = await getBoardVersion(access.board.id, version.data);
    if (!target) return res.status(404).json({ error: "Version not found" });
    const getLiveState = req.app.get("getCollaborationState") as
      | ((boardId: string) => { nodes: any[]; edges: any[] } | null)
      | undefined;
    const current = getLiveState?.(access.board.id) || access.board;
    const replacement = await replaceCollaborationState(
      access.board.id,
      { nodes: current.nodes, edges: current.edges },
      { nodes: target.nodes, edges: target.edges },
      req.user!.userId
    );
    const restored = await restoreBoardVersion(access.board.id, version.data, {
      userId: req.user!.userId,
      userName: req.user!.userName,
    });
    if (!restored) return res.status(404).json({ error: "Version not found" });
    await recordAudit(access.board.id, req.user!.userId, "board.version.restored", { version: version.data });
    const applyLocal = req.app.get("applyCollaborationUpdate") as
      | ((boardId: string, update: Uint8Array, actorId: string) => boolean)
      | undefined;
    applyLocal?.(access.board.id, replacement.update, req.user!.userId);
    const io = req.app.get("io");
    io?.to(access.board.id).emit("yjs_state_replaced", {
      state: replacement.fullState,
      restoredVersion: version.data,
    });
    io?.to(access.board.id).emit("board_state", { ...restored, role: undefined });
    res.json({ success: true, board: { ...restored, role: "owner" as const } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/validate", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    const options = validationOptionsSchema.safeParse(req.body?.options);
    if (!options.success) return res.status(400).json({ error: "Invalid validation options" });
    res.json(validateArchitecture(access.board.nodes, access.board.edges, options.data));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/validate/sarif", async (req, res) => {
  try {
    const access = await authorizedBoard(req, res, "viewer");
    if (!access) return;
    const options = validationOptionsSchema.safeParse(req.body?.options);
    if (!options.success) return res.status(400).json({ error: "Invalid validation options" });
    res.json(validationToSarif(validateArchitecture(access.board.nodes, access.board.edges, options.data)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
