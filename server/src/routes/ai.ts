import { Router } from "express";
import { analyzeArchitecture, generateArchitecture } from "../services/ai.js";

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

/**
 * POST /api/ai/generate — Generate a complete architecture from a text description
 * Body: { scenario: string }
 */
router.post("/generate", async (req, res) => {
  try {
    const { scenario } = req.body;

    if (!scenario || typeof scenario !== "string") {
      return res.status(400).json({ error: "scenario string is required" });
    }

    const result = await generateArchitecture(scenario);
    res.json(result);
  } catch (err: any) {
    console.error("AI generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
