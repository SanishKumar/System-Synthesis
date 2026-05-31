import type {
  AIAnalysisResult,
  AIGenerateResult,
  SerializedNode,
  SerializedEdge,
  ArchNodeType,
} from "@system-synthesis/shared";
import { z } from "zod";

// ---------- Mock Analysis ----------

function generateMockAnalysis(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): AIAnalysisResult {
  const nodeTypes = nodes.map((n) => n.data.nodeType);
  const hasDatabase = nodeTypes.includes("database");
  const hasCache = nodeTypes.includes("cache");
  const hasQueue = nodeTypes.includes("queue");
  const hasGateway = nodeTypes.includes("gateway");
  const hasLoadBalancer = nodeTypes.includes("loadbalancer");

  const missingComponents: AIAnalysisResult["missingComponents"] = [];

  if (!hasCache) {
    missingComponents.push({
      title: "No Cache Layer",
      description:
        "Architecture lacks a caching layer. Consider adding Redis or Memcached to reduce database load and improve response times.",
      severity: "warning",
      actions: [{ type: 'add_node', nodeType: 'cache', label: 'Redis Cache' }]
    });
  }

  if (!hasQueue) {
    missingComponents.push({
      title: "No Message Queue",
      description:
        "No asynchronous message processing found. Consider RabbitMQ or Kafka for decoupling services and handling background jobs.",
      severity: "warning",
      actions: [{ type: 'add_node', nodeType: 'queue', label: 'Kafka Event Bus' }]
    });
  }

  if (!hasGateway) {
    missingComponents.push({
      title: "Missing API Gateway",
      description:
        "No API Gateway detected. Consider Kong or Nginx for rate limiting, SSL termination, and request routing.",
      severity: "critical",
      actions: [{ type: 'add_node', nodeType: 'gateway', label: 'API Gateway' }]
    });
  }

  if (!hasLoadBalancer) {
    missingComponents.push({
      title: "No Load Balancer",
      description:
        "Architecture lacks load balancing. Consider adding a load balancer for high availability.",
      severity: "info",
      actions: [{ type: 'add_node', nodeType: 'loadbalancer', label: 'Load Balancer' }]
    });
  }

  // Check for disconnected nodes
  const connectedNodeIds = new Set<string>();
  edges.forEach((e) => {
    connectedNodeIds.add(e.source);
    connectedNodeIds.add(e.target);
  });

  nodes.forEach((n) => {
    if (!connectedNodeIds.has(n.id)) {
      missingComponents.push({
        title: "Disconnected Node",
        description: `"${n.data.label}" has no connections. This may indicate a missing dependency or an orphaned component.`,
        severity: "warning",
      });
    }
  });

  const suggestedStorage: AIAnalysisResult["suggestedStorage"] = [];
  if (hasDatabase) {
    suggestedStorage.push({ name: "PostgreSQL", type: "primary" });
  }
  if (hasCache) {
    suggestedStorage.push({ name: "Redis Cache", type: "cache" });
  } else {
    suggestedStorage.push({
      name: "Redis Cache",
      type: "cache",
      reason: "Recommended for session & query caching",
    });
  }
  suggestedStorage.push({
    name: "ElasticSearch",
    type: "search",
    reason: "For full-text search capabilities",
  });

  return {
    missingComponents,
    suggestedStorage,
    apiRecommendations: [
      {
        name: "RESTful API",
        description:
          "Best for broad client compatibility and standard CRUD operations.",
        badge: "Standard",
      },
      {
        name: "gRPC",
        description:
          "Recommended for internal microservice-to-microservice communication.",
        badge: "High-Perf",
      },
      {
        name: "GraphQL",
        description:
          "Consider for complex, nested data fetching from frontend clients.",
        badge: "Flexible",
      },
    ],
    scalabilityChecklist: [
      {
        label: "Horizontal Pod Autoscaling",
        checked: nodes.length > 3,
      },
      { label: "Rate Limiting Middleware", checked: hasGateway },
      { label: "Database Connection Pooling", checked: hasDatabase },
      { label: "CDN for Static Assets", checked: false },
      { label: "Circuit Breaker Pattern", checked: hasQueue },
      { label: "Health Check Endpoints", checked: true },
      { label: "Centralized Logging", checked: false },
    ],
    summary: `Analyzed architecture with ${nodes.length} nodes and ${edges.length} connections. Found ${missingComponents.length} potential improvements.`,
  };
}

// ---------- OpenAI Adapter ----------

const ANALYSIS_SYSTEM_PROMPT = `You are an expert software architect analyzer. Given a system architecture graph in JSON, analyze it and return a structured JSON response.

Your response MUST be valid JSON with this exact structure:
{
  "missingComponents": [
    {
      "title": "string",
      "description": "string",
      "severity": "critical|warning|info",
      "actions": [
        {"type": "add_node", "nodeType": "service|database|gateway|queue|cache|client|loadbalancer|storage", "label": "Component Name"},
        {"type": "add_edge", "sourceId": "existing-node-id", "targetId": "new-or-existing-node-id", "label": "optional edge label"}
      ]
    }
  ],
  "suggestedStorage": [{"name": "string", "type": "primary|cache|search|queue", "reason": "string"}],
  "apiRecommendations": [{"name": "string", "description": "string", "badge": "string"}],
  "scalabilityChecklist": [{"label": "string", "checked": boolean}],
  "summary": "string"
}

IMPORTANT: Each missingComponent MUST include an "actions" array with concrete actions to fix the issue.
For "add_node" actions: nodeType must be one of: service, database, gateway, queue, cache, client, loadbalancer, storage.
For "add_edge" actions: sourceId and targetId should reference existing node IDs from the input graph.

Analyze for: missing dependencies, single points of failure, scalability gaps, security concerns, and best practice violations.
Return ONLY the JSON, no markdown or explanation.`;

const AnalysisSchema = z.object({
  missingComponents: z.array(z.object({
    title: z.string(),
    description: z.string(),
    severity: z.enum(["critical", "warning", "info"]),
    actions: z.array(z.object({
      type: z.enum(["add_node", "add_edge", "update_node"]),
      nodeType: z.string().optional(),
      label: z.string().optional(),
      sourceId: z.string().optional(),
      targetId: z.string().optional()
    })).optional()
  })),
  suggestedStorage: z.array(z.object({
    name: z.string(),
    type: z.enum(["primary", "cache", "search", "queue"]),
    reason: z.string().optional()
  })),
  apiRecommendations: z.array(z.object({
    name: z.string(),
    description: z.string(),
    badge: z.string()
  })),
  scalabilityChecklist: z.array(z.object({
    label: z.string(),
    checked: z.boolean()
  })),
  summary: z.string()
});

async function analyzeWithOpenAI(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): Promise<AIAnalysisResult> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const graphDescription = JSON.stringify(
    {
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.data.label,
        type: n.data.nodeType,
        subtitle: n.data.subtitle,
        tier: n.data.tier,
        zone: n.data.zone,
        tech: n.data.tech,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        from: e.source,
        to: e.target,
        label: e.data?.label,
      })),
    },
    null,
    2
  );

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this architecture:\n${graphDescription}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 2000,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI");

  const parsedJson = JSON.parse(content);
  // Strictly validate the structure with Zod
  return AnalysisSchema.parse(parsedJson) as AIAnalysisResult;
}

// ---------- Local LLM Adapter ----------

async function analyzeWithLocalLLM(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): Promise<AIAnalysisResult> {
  const url = process.env.LOCAL_LLM_URL || "http://localhost:11434/api/generate";
  const model = process.env.LOCAL_LLM_MODEL || "qwen2.5:7b";

  const graphDescription = JSON.stringify(
    {
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.data.label,
        type: n.data.nodeType,
      })),
      edges: edges.map((e) => ({ from: e.source, to: e.target })),
    },
    null,
    2
  );

  const prompt = `Analyze this system architecture and return ONLY valid JSON with these fields: missingComponents (array of {title, description, severity, actions}), suggestedStorage (array of {name, type, reason}), apiRecommendations (array of {name, description, badge}), scalabilityChecklist (array of {label, checked}), summary (string).

Each missingComponent must include "actions" array with objects like:
  {"type": "add_node", "nodeType": "service|database|gateway|queue|cache|loadbalancer|storage", "label": "Name"}

Architecture:
${graphDescription}

JSON response:`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
    }),
  });

  if (!response.ok) {
    throw new Error(`Local LLM error: ${response.statusText}`);
  }

  const data = (await response.json()) as { response: string };
  return JSON.parse(data.response) as AIAnalysisResult;
}

// ---------- Architecture Generation ----------

const GENERATE_SYSTEM_PROMPT = `You are an expert cloud architect. Given a scenario description, generate a complete system architecture graph.

Return ONLY valid JSON with this structure:
{
  "nodes": [
    {
      "id": "unique-id",
      "type": "architectureNode",
      "position": {"x": number, "y": number},
      "data": {
        "label": "Component Name",
        "subtitle": "Technology\\nDetails",
        "nodeType": "service|database|gateway|queue|cache|client|loadbalancer|storage",
        "status": "active",
        "tier": "frontend|backend|data|infrastructure|external",
        "zone": "public|private|dmz|restricted",
        "tech": "technology name",
        "metadata": {"notes": "", "links": [], "codeSnippet": "", "attachedFiles": []}
      }
    }
  ],
  "edges": [
    {
      "id": "edge-id",
      "source": "source-node-id",
      "target": "target-node-id",
      "data": {"label": "connection description", "protocol": "HTTP|gRPC|TCP|AMQP|WebSocket"}
    }
  ],
  "summary": "Brief description of the generated architecture"
}

RULES:
- Generate between 4-12 nodes depending on complexity.
- Position nodes in a logical top-down flow layout (clients at top ~y:50, gateways ~y:200, services ~y:400, databases ~y:600).
- Space nodes horizontally with ~250px gaps. Center the layout around x:400.
- Use sensible IDs like "client-1", "gateway-1", "auth-service", "user-db", etc.
- Every edge must connect existing node IDs.
- Include appropriate tiers, zones, and technology names.
- Follow architecture best practices (no client→database, use gateways, etc).
Return ONLY the JSON.`;

/**
 * Generate a complete architecture from a text description.
 * Priority: OpenAI → Local LLM → Mock
 */
export async function generateArchitecture(
  scenario: string
): Promise<AIGenerateResult> {
  // Try OpenAI first
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log("  🤖 Generating architecture with OpenAI...");
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: GENERATE_SYSTEM_PROMPT },
          { role: "user", content: `Design an architecture for: ${scenario}` },
        ],
        temperature: 0.5,
        max_tokens: 3000,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from OpenAI");
      return JSON.parse(content) as AIGenerateResult;
    } catch (err: any) {
      console.error("  ⚠ OpenAI generation error:", err.message);
    }
  }

  // Try local LLM
  if (process.env.LOCAL_LLM_URL) {
    try {
      console.log("  🤖 Generating architecture with local LLM...");
      const url = process.env.LOCAL_LLM_URL || "http://localhost:11434/api/generate";
      const model = process.env.LOCAL_LLM_MODEL || "qwen2.5:7b";

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: `${GENERATE_SYSTEM_PROMPT}\n\nDesign an architecture for: ${scenario}\n\nJSON response:`,
          stream: false,
          format: "json",
        }),
      });

      if (!response.ok) throw new Error(`Local LLM error: ${response.statusText}`);
      const data = (await response.json()) as { response: string };
      return JSON.parse(data.response) as AIGenerateResult;
    } catch (err: any) {
      console.error("  ⚠ Local LLM generation error:", err.message);
    }
  }

  // Fallback: generate a mock architecture
  console.log("  🤖 Using mock generation (no AI provider configured)");
  return generateMockArchitecture(scenario);
}

/**
 * Generate a sensible mock architecture based on keywords in the scenario.
 */
function generateMockArchitecture(scenario: string): AIGenerateResult {
  const lower = scenario.toLowerCase();
  const nodes: SerializedNode[] = [];
  const edges: SerializedEdge[] = [];
  const meta = { notes: "", links: [], codeSnippet: "", attachedFiles: [] };

  // Always start with a client
  nodes.push({
    id: "gen-client", type: "architectureNode",
    position: { x: 400, y: 50 },
    data: { label: "Web Client", subtitle: "React / Next.js", nodeType: "client", status: "active", tier: "frontend", zone: "public", tech: "React", metadata: meta },
  });

  // Gateway
  nodes.push({
    id: "gen-gateway", type: "architectureNode",
    position: { x: 400, y: 200 },
    data: { label: "API Gateway", subtitle: "Kong / Nginx", nodeType: "gateway", status: "active", tier: "infrastructure", zone: "dmz", tech: "Kong", metadata: meta },
  });
  edges.push({ id: "gen-e1", source: "gen-client", target: "gen-gateway", data: { label: "HTTPS", protocol: "HTTP" } });

  // Core service
  const serviceName = lower.includes("chat") ? "Chat Service"
    : lower.includes("ecommerce") || lower.includes("shop") ? "Order Service"
    : lower.includes("social") ? "Feed Service"
    : lower.includes("analytics") ? "Analytics Engine"
    : "Core API Service";

  nodes.push({
    id: "gen-service-1", type: "architectureNode",
    position: { x: 250, y: 380 },
    data: { label: serviceName, subtitle: "Node.js / Go", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Node.js", metadata: meta },
  });
  edges.push({ id: "gen-e2", source: "gen-gateway", target: "gen-service-1", data: { label: "REST", protocol: "HTTP" } });

  // Auth service
  nodes.push({
    id: "gen-auth", type: "architectureNode",
    position: { x: 550, y: 380 },
    data: { label: "Auth Service", subtitle: "JWT / OAuth2", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Go", metadata: meta },
  });
  edges.push({ id: "gen-e3", source: "gen-gateway", target: "gen-auth", data: { label: "Auth", protocol: "gRPC" } });

  // Primary database
  const dbName = lower.includes("nosql") || lower.includes("mongo") ? "MongoDB"
    : lower.includes("mysql") ? "MySQL"
    : "PostgreSQL";
  nodes.push({
    id: "gen-db", type: "architectureNode",
    position: { x: 250, y: 560 },
    data: { label: `${dbName} DB`, subtitle: dbName, nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: dbName, metadata: meta },
  });
  edges.push({ id: "gen-e4", source: "gen-service-1", target: "gen-db", data: { label: "Queries", protocol: "TCP" } });

  // Cache
  nodes.push({
    id: "gen-cache", type: "architectureNode",
    position: { x: 550, y: 560 },
    data: { label: "Redis Cache", subtitle: "Session + Query Cache", nodeType: "cache", status: "active", tier: "data", zone: "private", tech: "Redis", metadata: meta },
  });
  edges.push({ id: "gen-e5", source: "gen-service-1", target: "gen-cache", data: { label: "Cache R/W", protocol: "TCP" } });

  // Conditional: queue for event-driven scenarios
  if (lower.includes("event") || lower.includes("queue") || lower.includes("async") || lower.includes("real-time") || lower.includes("chat") || lower.includes("notification")) {
    nodes.push({
      id: "gen-queue", type: "architectureNode",
      position: { x: 100, y: 480 },
      data: { label: "Kafka Event Bus", subtitle: "Async Messaging", nodeType: "queue", status: "active", tier: "infrastructure", zone: "private", tech: "Kafka", metadata: meta },
    });
    edges.push({ id: "gen-e6", source: "gen-service-1", target: "gen-queue", data: { label: "Events", protocol: "TCP" } });

    nodes.push({
      id: "gen-worker", type: "architectureNode",
      position: { x: 100, y: 620 },
      data: { label: "Worker Service", subtitle: "Background Jobs", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Python", metadata: meta },
    });
    edges.push({ id: "gen-e7", source: "gen-queue", target: "gen-worker", data: { label: "Consume", protocol: "TCP" } });
  }

  // Conditional: storage for file-heavy scenarios
  if (lower.includes("storage") || lower.includes("file") || lower.includes("image") || lower.includes("upload") || lower.includes("media")) {
    nodes.push({
      id: "gen-storage", type: "architectureNode",
      position: { x: 700, y: 480 },
      data: { label: "S3 Object Storage", subtitle: "Files & Media", nodeType: "storage", status: "active", tier: "data", zone: "private", tech: "AWS S3", metadata: meta },
    });
    edges.push({ id: "gen-e-stor", source: "gen-service-1", target: "gen-storage", data: { label: "Upload", protocol: "HTTP" } });
  }

  return {
    nodes,
    edges,
    summary: `Generated ${nodes.length}-node architecture for: "${scenario}". Includes client, API gateway, ${serviceName.toLowerCase()}, auth, ${dbName} database, and Redis cache.`,
  };
}

// ---------- Main Analysis Service ----------

/**
 * Analyze architecture using the best available AI provider.
 * Priority: OpenAI → Local LLM → Mock
 */
export async function analyzeArchitecture(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): Promise<AIAnalysisResult> {
  // Try OpenAI first
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log("  🤖 Analyzing with OpenAI...");
      return await analyzeWithOpenAI(nodes, edges);
    } catch (err: any) {
      console.error("  ⚠ OpenAI error:", err.message);
    }
  }

  // Try local LLM
  if (process.env.LOCAL_LLM_URL) {
    try {
      console.log("  🤖 Analyzing with local LLM...");
      return await analyzeWithLocalLLM(nodes, edges);
    } catch (err: any) {
      console.error("  ⚠ Local LLM error:", err.message);
    }
  }

  // Fallback to intelligent mock
  console.log("  🤖 Using mock analysis (no AI provider configured)");
  return generateMockAnalysis(nodes, edges);
}
