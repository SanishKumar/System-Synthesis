import type {
  AIAnalysisResult,
  AIGenerateResult,
  SerializedEdge,
  SerializedNode,
  ValidationIssue,
} from "@system-synthesis/shared";
import { z } from "zod";
import { validateArchitecture } from "./validation.js";

const metadataSchema = z.object({
  notes: z.string().default(""),
  links: z.array(z.string()).default([]),
  codeSnippet: z.string().default(""),
  attachedFiles: z.array(z.unknown()).default([]),
});

const generatedNodeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.string().default("architectureNode"),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  data: z.object({
    label: z.string().min(1).max(120),
    subtitle: z.string().max(300).optional(),
    nodeType: z.enum([
      "service", "database", "gateway", "queue", "cache", "client",
      "loadbalancer", "storage", "cdn", "firewall", "dns", "proxy",
      "container", "function", "search", "warehouse", "stream", "broker",
      "auth", "vault", "monitor", "registry", "scheduler", "group",
    ]),
    status: z.enum(["active", "inactive", "analyzing"]).default("active"),
    tier: z.enum(["frontend", "backend", "data", "infrastructure", "external"]).optional(),
    zone: z.enum(["public", "private", "dmz", "restricted"]).optional(),
    tech: z.string().max(120).optional(),
    metadata: metadataSchema,
  }).passthrough(),
}).passthrough();

const generatedEdgeSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  target: z.string().min(1).max(128),
  data: z.object({
    label: z.string().max(120).optional(),
    protocol: z.string().max(80).optional(),
  }).passthrough().optional(),
}).passthrough();

const GeneratedArchitectureSchema = z.object({
  nodes: z.array(generatedNodeSchema).min(1).max(50),
  edges: z.array(generatedEdgeSchema).max(150),
  summary: z.string().min(1).max(2_000),
}).superRefine((value, context) => {
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  const duplicateNodes = value.nodes.filter((node, index) =>
    value.nodes.findIndex((candidate) => candidate.id === node.id) !== index
  );
  if (duplicateNodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Generated node IDs must be unique" });
  }
  for (const edge of value.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Generated edge ${edge.id} references a missing node`,
      });
    }
  }
});

function parseGeneratedArchitecture(value: unknown): AIGenerateResult {
  return GeneratedArchitectureSchema.parse(value) as AIGenerateResult;
}

const GENERATE_SYSTEM_PROMPT = `Draft a system architecture graph for the supplied scenario.
Return only JSON with nodes, edges, and summary. Use 4-12 nodes, logical top-down positions,
unique stable IDs, and edges whose endpoints exist. Include an API/service boundary between
clients and persistence. This is a draft, not validated infrastructure or a correctness claim.`;

/** Optional drafting feature. Generated graphs remain untrusted suggestions. */
export async function generateArchitecture(scenario: string): Promise<AIGenerateResult> {
  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: GENERATE_SYSTEM_PROMPT },
          { role: "user", content: scenario },
        ],
        temperature: 0.4,
        max_tokens: 3_000,
        response_format: { type: "json_object" },
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty draft response from OpenAI");
      return parseGeneratedArchitecture(JSON.parse(content));
    } catch (error: any) {
      console.error("OpenAI draft generation failed validation:", error.message);
    }
  }

  if (process.env.LOCAL_LLM_URL) {
    try {
      const response = await fetch(process.env.LOCAL_LLM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.LOCAL_LLM_MODEL || "qwen2.5:7b",
          prompt: `${GENERATE_SYSTEM_PROMPT}\n\nScenario:\n${scenario}`,
          stream: false,
          format: "json",
        }),
      });
      if (!response.ok) throw new Error(`Local LLM error: ${response.statusText}`);
      const data = (await response.json()) as { response: string };
      return parseGeneratedArchitecture(JSON.parse(data.response));
    } catch (error: any) {
      console.error("Local LLM draft generation failed validation:", error.message);
    }
  }

  return generateDeterministicDraft(scenario);
}

function generateDeterministicDraft(scenario: string): AIGenerateResult {
  const lower = scenario.toLowerCase();
  const nodes: SerializedNode[] = [];
  const edges: SerializedEdge[] = [];
  const metadata = { notes: "", links: [], codeSnippet: "", attachedFiles: [] };

  nodes.push({
    id: "draft-client",
    type: "architectureNode",
    position: { x: 400, y: 50 },
    data: {
      label: "Web Client", subtitle: "Browser application", nodeType: "client",
      status: "active", tier: "frontend", zone: "public", tech: "Next.js", metadata,
    },
  });
  nodes.push({
    id: "draft-gateway",
    type: "architectureNode",
    position: { x: 400, y: 200 },
    data: {
      label: "API Gateway", subtitle: "Ingress and policy", nodeType: "gateway",
      status: "active", tier: "infrastructure", zone: "dmz", tech: "Kong", metadata,
    },
  });
  edges.push({
    id: "draft-client-gateway",
    source: "draft-client",
    target: "draft-gateway",
    data: { label: "HTTPS", protocol: "HTTP" },
  });

  const serviceName = lower.includes("chat")
    ? "Chat Service"
    : lower.includes("shop") || lower.includes("commerce")
      ? "Order Service"
      : lower.includes("analytics")
        ? "Analytics Service"
        : "Core API";
  nodes.push({
    id: "draft-service",
    type: "architectureNode",
    position: { x: 260, y: 380 },
    data: {
      label: serviceName, subtitle: "Application boundary", nodeType: "service",
      status: "active", tier: "backend", zone: "private", tech: "Node.js", metadata,
    },
  });
  nodes.push({
    id: "draft-auth",
    type: "architectureNode",
    position: { x: 540, y: 380 },
    data: {
      label: "Identity Service", subtitle: "Authentication and authorization", nodeType: "auth",
      status: "active", tier: "backend", zone: "private", tech: "OIDC", metadata,
    },
  });
  edges.push({ id: "draft-gateway-service", source: "draft-gateway", target: "draft-service", data: { label: "API", protocol: "HTTP" } });
  edges.push({ id: "draft-gateway-auth", source: "draft-gateway", target: "draft-auth", data: { label: "Authenticate", protocol: "HTTP" } });

  const database = lower.includes("mongo") ? "MongoDB" : lower.includes("mysql") ? "MySQL" : "PostgreSQL";
  nodes.push({
    id: "draft-database",
    type: "architectureNode",
    position: { x: 260, y: 560 },
    data: {
      label: database, subtitle: "Primary persistence", nodeType: "database",
      status: "active", tier: "data", zone: "restricted", tech: database, metadata,
    },
  });
  nodes.push({
    id: "draft-cache",
    type: "architectureNode",
    position: { x: 540, y: 560 },
    data: {
      label: "Redis Cache", subtitle: "Explicit cache boundary", nodeType: "cache",
      status: "active", tier: "data", zone: "private", tech: "Redis", metadata,
    },
  });
  edges.push({ id: "draft-service-database", source: "draft-service", target: "draft-database", data: { label: "Queries", protocol: "TCP" } });
  edges.push({ id: "draft-service-cache", source: "draft-service", target: "draft-cache", data: { label: "Cache", protocol: "TCP" } });

  if (["event", "queue", "async", "chat", "notification"].some((term) => lower.includes(term))) {
    nodes.push({
      id: "draft-queue",
      type: "architectureNode",
      position: { x: 60, y: 520 },
      data: {
        label: "Event Queue", subtitle: "Asynchronous work", nodeType: "queue",
        status: "active", tier: "infrastructure", zone: "private", tech: "Kafka", metadata,
      },
    });
    nodes.push({
      id: "draft-worker",
      type: "architectureNode",
      position: { x: 60, y: 680 },
      data: {
        label: "Worker", subtitle: "Background consumer", nodeType: "service",
        status: "active", tier: "backend", zone: "private", tech: "Node.js", metadata,
      },
    });
    edges.push({ id: "draft-service-queue", source: "draft-service", target: "draft-queue", data: { label: "Publish", protocol: "AMQP" } });
    edges.push({ id: "draft-queue-worker", source: "draft-queue", target: "draft-worker", data: { label: "Consume", protocol: "AMQP" } });
  }

  return parseGeneratedArchitecture({
    nodes,
    edges,
    summary: `Deterministic ${nodes.length}-component draft for “${scenario}”. Run architecture lint before treating it as a design recommendation.`,
  });
}

const FindingExplanationSchema = z.object({
  explanations: z.array(z.object({
    findingId: z.string(),
    explanation: z.string().min(1).max(1_500),
  })),
  summary: z.string().min(1).max(2_000),
});

type FindingExplanations = z.infer<typeof FindingExplanationSchema>;

const FINDING_EXPLANATION_PROMPT = `Explain findings produced by a deterministic architecture rule engine.
The supplied findings are authoritative. Do not add, remove, merge, reclassify, or contradict findings.
Return JSON exactly shaped as:
{"explanations":[{"findingId":"unchanged id","explanation":"concise explanation"}],"summary":"concise overall summary"}
Return one explanation for every supplied finding and preserve each findingId exactly.`;

async function explainFindingsWithOpenAI(findings: ValidationIssue[]): Promise<FindingExplanations> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: FINDING_EXPLANATION_PROMPT },
      { role: "user", content: JSON.stringify(findings) },
    ],
    temperature: 0.1,
    max_tokens: 1_500,
    response_format: { type: "json_object" },
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty explanation response from OpenAI");
  return FindingExplanationSchema.parse(JSON.parse(content));
}

async function explainFindingsWithLocalLLM(findings: ValidationIssue[]): Promise<FindingExplanations> {
  const response = await fetch(process.env.LOCAL_LLM_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.LOCAL_LLM_MODEL || "qwen2.5:7b",
      prompt: `${FINDING_EXPLANATION_PROMPT}\n\nFindings:\n${JSON.stringify(findings)}`,
      stream: false,
      format: "json",
    }),
  });
  if (!response.ok) throw new Error(`Local LLM error: ${response.statusText}`);
  const data = (await response.json()) as { response: string };
  return FindingExplanationSchema.parse(JSON.parse(data.response));
}

function findingsToAnalysis(
  findings: ValidationIssue[],
  explanations?: FindingExplanations
): AIAnalysisResult {
  const explanationById = new Map(
    (explanations?.explanations || []).map((item) => [item.findingId, item.explanation])
  );
  return {
    missingComponents: findings.map((finding) => ({
      findingId: finding.id,
      ruleId: finding.ruleId,
      title: finding.title,
      description: explanationById.get(finding.id) || finding.description,
      severity: finding.severity,
      actions: [],
    })),
    suggestedStorage: [],
    apiRecommendations: [],
    scalabilityChecklist: [],
    summary: explanations?.summary || `The deterministic rule engine produced ${findings.length} finding(s).`,
    analysisMode: explanations ? "deterministic-with-ai-explanation" : "deterministic",
    findingsGeneratedBy: "rule-engine",
  };
}

/** Deterministic findings first; an LLM may only explain their unchanged IDs. */
export async function analyzeArchitecture(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): Promise<AIAnalysisResult> {
  const findings = validateArchitecture(nodes, edges).issues;
  if (findings.length === 0) return findingsToAnalysis([]);

  if (process.env.OPENAI_API_KEY) {
    try {
      return findingsToAnalysis(findings, await explainFindingsWithOpenAI(findings));
    } catch (error: any) {
      console.error("OpenAI finding explanation failed validation:", error.message);
    }
  }
  if (process.env.LOCAL_LLM_URL) {
    try {
      return findingsToAnalysis(findings, await explainFindingsWithLocalLLM(findings));
    } catch (error: any) {
      console.error("Local LLM finding explanation failed validation:", error.message);
    }
  }
  return findingsToAnalysis(findings);
}
