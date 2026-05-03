import type {
  AIAnalysisResult,
  SerializedNode,
  SerializedEdge,
} from "@system-synthesis/shared";

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
    });
  }

  if (!hasQueue) {
    missingComponents.push({
      title: "No Message Queue",
      description:
        "No asynchronous message processing found. Consider RabbitMQ or Kafka for decoupling services and handling background jobs.",
      severity: "warning",
    });
  }

  if (!hasGateway) {
    missingComponents.push({
      title: "Missing API Gateway",
      description:
        "No API Gateway detected. Consider Kong or Nginx for rate limiting, SSL termination, and request routing.",
      severity: "critical",
    });
  }

  if (!hasLoadBalancer) {
    missingComponents.push({
      title: "No Load Balancer",
      description:
        "Architecture lacks load balancing. Consider adding a load balancer for high availability.",
      severity: "info",
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
      })),
      edges: edges.map((e) => ({
        from: e.source,
        to: e.target,
      })),
    },
    null,
    2
  );

  const systemPrompt = `You are an expert software architect analyzer. Given a system architecture graph in JSON, analyze it and return a structured JSON response.

Your response MUST be valid JSON with this exact structure:
{
  "missingComponents": [{"title": "string", "description": "string", "severity": "critical|warning|info"}],
  "suggestedStorage": [{"name": "string", "type": "primary|cache|search|queue", "reason": "string"}],
  "apiRecommendations": [{"name": "string", "description": "string", "badge": "string"}],
  "scalabilityChecklist": [{"label": "string", "checked": boolean}],
  "summary": "string"
}

Analyze for: missing dependencies, single points of failure, scalability gaps, security concerns, and best practice violations.
Return ONLY the JSON, no markdown or explanation.`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
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

  return JSON.parse(content) as AIAnalysisResult;
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

  const prompt = `Analyze this system architecture and return ONLY valid JSON with these fields: missingComponents (array of {title, description, severity}), suggestedStorage (array of {name, type, reason}), apiRecommendations (array of {name, description, badge}), scalabilityChecklist (array of {label, checked}), summary (string).

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

// ---------- Main Service ----------

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
