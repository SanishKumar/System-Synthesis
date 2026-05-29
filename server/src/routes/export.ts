import { Router } from "express";
import { getBoardState } from "../services/boardRepository.js";
import { generateDockerCompose } from "../services/export/docker-compose.js";
import { generateTerraform } from "../services/export/terraform.js";
import { generateReport } from "../services/export/report.js";

const router = Router();

/**
 * Helper: extract userId from headers (same as boards.ts)
 */
function getUserFromHeaders(req: any): { userId: string; userName: string } {
  return {
    userId: (req.headers["x-user-id"] as string) || "anonymous",
    userName: (req.headers["x-user-name"] as string) || "Anonymous",
  };
}

/**
 * POST /api/export/docker-compose
 * Body: { nodes, edges } or { boardId }
 * Returns: YAML string as text/plain
 */
router.post("/docker-compose", async (req, res) => {
  try {
    let { nodes, edges, boardId } = req.body;

    if (boardId && (!nodes || !edges)) {
      const board = await getBoardState(boardId);
      if (!board) return res.status(404).json({ error: "Board not found" });
      nodes = board.nodes;
      edges = board.edges;
    }

    if (!Array.isArray(nodes)) {
      return res.status(400).json({ error: "nodes array required" });
    }

    const yaml = generateDockerCompose(nodes, edges || []);

    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=docker-compose.yml");
    res.send(yaml);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/export/terraform
 * Body: { nodes, edges } or { boardId }
 * Returns: JSON with { "main.tf": string, "variables.tf": string, "outputs.tf": string }
 */
router.post("/terraform", async (req, res) => {
  try {
    let { nodes, edges, boardId } = req.body;

    if (boardId && (!nodes || !edges)) {
      const board = await getBoardState(boardId);
      if (!board) return res.status(404).json({ error: "Board not found" });
      nodes = board.nodes;
      edges = board.edges;
    }

    if (!Array.isArray(nodes)) {
      return res.status(400).json({ error: "nodes array required" });
    }

    const bundle = generateTerraform(nodes, edges || []);
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/export/report
 * Body: { nodes, edges, boardName? } or { boardId }
 * Returns: Markdown string as text/markdown
 */
router.post("/report", async (req, res) => {
  try {
    let { nodes, edges, boardId, boardName } = req.body;

    if (boardId && (!nodes || !edges)) {
      const board = await getBoardState(boardId);
      if (!board) return res.status(404).json({ error: "Board not found" });
      nodes = board.nodes;
      edges = board.edges;
      boardName = boardName || board.name;
    }

    if (!Array.isArray(nodes)) {
      return res.status(400).json({ error: "nodes array required" });
    }

    const markdown = generateReport(nodes, edges || [], boardName);

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${(boardName || "architecture").replace(/[^a-z0-9]/gi, "-")}-report.md`);
    res.send(markdown);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
