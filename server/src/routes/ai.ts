import { Router } from "express";
import { z } from "zod";
import { analyzeArchitecture, generateArchitecture } from "../services/ai.js";
import { getBoardState } from "../services/boardRepository.js";
import { recordAudit, resolveBoardRole, roleAllows } from "../services/accessControl.js";

const router = Router();
const boardIdSchema = z.object({
  boardId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
const generationSchema = z.object({
  scenario: z.string().trim().min(3).max(2_000),
});

router.post("/analyze", async (req, res) => {
  const parsed = boardIdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A valid boardId is required" });
  try {
    const board = await getBoardState(parsed.data.boardId);
    if (!board) return res.status(404).json({ error: "Board not found" });
    const role = await resolveBoardRole(board, req.user!.userId);
    if (!roleAllows(role, "viewer")) {
      await recordAudit(board.id, req.user!.userId, "board.ai_explanation.denied");
      return res.status(403).json({ error: "Board access required" });
    }
    const result = await analyzeArchitecture(board.nodes, board.edges);
    await recordAudit(board.id, req.user!.userId, "board.ai_explanation");
    res.json(result);
  } catch (error: any) {
    console.error("AI analysis error:", error);
    res.status(500).json({ error: "AI analysis failed" });
  }
});

router.post("/generate", async (req, res) => {
  const parsed = generationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A scenario between 3 and 2000 characters is required" });
  try {
    const result = await generateArchitecture(parsed.data.scenario);
    await recordAudit(null, req.user!.userId, "ai.generation");
    res.json(result);
  } catch (error: any) {
    console.error("AI generation error:", error);
    res.status(500).json({ error: "AI generation failed" });
  }
});

export default router;
