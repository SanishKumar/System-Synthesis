import { Router } from "express";
import { z } from "zod";
import { getBoardState, getBoardVersion } from "../services/boardRepository.js";
import { generateDockerCompose } from "../services/export/docker-compose.js";
import { generateTerraform } from "../services/export/terraform.js";
import { generateReport } from "../services/export/report.js";
import { recordAudit, resolveBoardRole, roleAllows } from "../services/accessControl.js";
import {
  buildInfrastructureIR,
  diffInfrastructureIR,
  UnsupportedExportError,
} from "../services/export/ir.js";

const router = Router();
const requestSchema = z.object({
  boardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
const diffSchema = requestSchema.extend({
  target: z.enum(["docker-compose", "terraform"]),
  version: z.number().int().positive(),
});

function exportError(res: any, error: unknown) {
  if (error instanceof UnsupportedExportError) {
    return res.status(422).json({ error: error.message, unsupported: error.unsupported });
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : "Export failed" });
}

async function loadAuthorizedBoard(req: any, res: any) {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid boardId is required" });
    return null;
  }
  const board = await getBoardState(parsed.data.boardId);
  if (!board) {
    res.status(404).json({ error: "Board not found" });
    return null;
  }
  const role = await resolveBoardRole(board, req.user.userId);
  if (!roleAllows(role, "viewer")) {
    await recordAudit(board.id, req.user.userId, "board.export.denied");
    res.status(403).json({ error: "Board access required" });
    return null;
  }
  return board;
}

router.post("/docker-compose", async (req, res) => {
  try {
    const board = await loadAuthorizedBoard(req, res);
    if (!board) return;
    const yaml = generateDockerCompose(board.nodes, board.edges);
    await recordAudit(board.id, req.user!.userId, "board.export", { format: "docker-compose" });
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=docker-compose.yml");
    res.send(yaml);
  } catch (error: any) {
    exportError(res, error);
  }
});

router.post("/terraform", async (req, res) => {
  try {
    const board = await loadAuthorizedBoard(req, res);
    if (!board) return;
    const bundle = generateTerraform(board.nodes, board.edges);
    await recordAudit(board.id, req.user!.userId, "board.export", { format: "terraform" });
    res.json(bundle);
  } catch (error: any) {
    exportError(res, error);
  }
});

router.post("/report", async (req, res) => {
  try {
    const board = await loadAuthorizedBoard(req, res);
    if (!board) return;
    const markdown = generateReport(board.nodes, board.edges, board.name);
    await recordAudit(board.id, req.user!.userId, "board.export", { format: "report" });
    const safeName = board.name.replace(/[^a-z0-9]/gi, "-");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${safeName}-report.md`);
    res.send(markdown);
  } catch (error: any) {
    exportError(res, error);
  }
});

router.post("/diff", async (req, res) => {
  const parsed = diffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "boardId, target, and version are required" });
  try {
    const board = await loadAuthorizedBoard(req, res);
    if (!board) return;
    const snapshot = await getBoardVersion(board.id, parsed.data.version);
    if (!snapshot) return res.status(404).json({ error: "Version not found" });
    const before = buildInfrastructureIR(snapshot.nodes, snapshot.edges, parsed.data.target);
    const after = buildInfrastructureIR(board.nodes, board.edges, parsed.data.target);
    await recordAudit(board.id, req.user!.userId, "board.export.diff", {
      target: parsed.data.target,
      version: parsed.data.version,
    });
    res.json({ before: before.sourceHash, after: after.sourceHash, diff: diffInfrastructureIR(before, after) });
  } catch (error) {
    exportError(res, error);
  }
});

export default router;
