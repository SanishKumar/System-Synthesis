import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeArchitecture } from "../../services/ai.js";

describe("deterministic findings with optional AI explanation", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LOCAL_LLM_URL", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns only rule-engine findings when no LLM is configured", async () => {
    const nodes = [
      {
        id: "client",
        type: "architectureNode",
        position: { x: 0, y: 0 },
        data: {
          label: "Browser",
          nodeType: "client",
          status: "active",
          metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
        },
      },
      {
        id: "database",
        type: "architectureNode",
        position: { x: 100, y: 0 },
        data: {
          label: "PostgreSQL",
          nodeType: "database",
          status: "active",
          metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
        },
      },
    ];
    const edges = [{ id: "direct", source: "client", target: "database" }];

    const result = await analyzeArchitecture(nodes as any, edges as any);

    expect(result.analysisMode).toBe("deterministic");
    expect(result.findingsGeneratedBy).toBe("rule-engine");
    expect(result.missingComponents.map((finding) => finding.ruleId)).toContain("client-to-persistence");
    expect(result.missingComponents.every((finding) => finding.actions?.length === 0)).toBe(true);
  });

  it("does not invent findings for a graph that passes all applicable rules", async () => {
    const result = await analyzeArchitecture([], []);
    expect(result.missingComponents).toEqual([]);
    expect(result.analysisMode).toBe("deterministic");
  });
});
