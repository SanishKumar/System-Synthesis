import { Router } from "express";
import { analyzeArchitecture } from "../services/ai.js";

const router = Router();

/**
 * POST /api/ai/analyze — Analyze architecture with AI
 */
router.post("/analyze", async (req, res) => {
  try {
    const { nodes, edges } = req.body;

    if (!nodes || !Array.isArray(nodes)) {
      return res.status(400).json({ error: "nodes array is required" });
    }

    const result = await analyzeArchitecture(nodes, edges || []);
    res.json(result);
  } catch (err: any) {
    console.error("AI analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
