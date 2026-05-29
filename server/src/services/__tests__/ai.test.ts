import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { analyzeArchitecture } from "../../services/ai.js";

describe("AI Service (Mock Generation)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LOCAL_LLM_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates structured actions for a recognizable mock scenario", async () => {
    // A mock graph with no DB and no cache, but has a service
    const nodes = [
      { id: "s1", type: "architectureNode", position: {x:0, y:0}, data: { label: "checkout microservice", nodeType: "service", status: "active", metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] } } }
    ];
    
    const analysis = await analyzeArchitecture(nodes as any, []);
    
    expect(analysis.missingComponents).toBeInstanceOf(Array);
    
    // It should notice cache, queue, gateway, lb are missing
    expect(analysis.missingComponents.length).toBeGreaterThan(0);
    
    // Validate schema of actions
    const firstMissing = analysis.missingComponents[0];
    expect(firstMissing).toHaveProperty("actions");
    expect(firstMissing.actions?.length).toBeGreaterThan(0);
    expect(firstMissing.actions?.[0]).toHaveProperty("type");
    expect(firstMissing.actions?.[0]).toHaveProperty("nodeType");
  });

  it("handles empty architecture gracefully", async () => {
    const analysis = await analyzeArchitecture([], []);
    
    expect(analysis.missingComponents).toBeInstanceOf(Array);
    expect(analysis.missingComponents.length).toBeGreaterThan(0);
  });
});
