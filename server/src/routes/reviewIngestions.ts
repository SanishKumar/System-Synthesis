import { Router, type Response } from "express";
import { z } from "zod";
import {
  canonicalizeGraph,
  reviewArchitectureChange,
  type ArchitecturePolicy,
  type CanonicalArchitectureGraph,
} from "@system-synthesis/architecture-core";
import type { SourceProvenance } from "@system-synthesis/shared";
import { requireReviewIntegration } from "../middleware/reviewIntegrationAuth.js";
import { reviewIngestionLimiter } from "../middleware/rateLimit.js";
import {
  ingestArchitectureReview,
  type IngestReviewResult,
} from "../services/reviewRepository.js";
import { normalizeRepositoryIdentity } from "../services/reviewIntegrationRepository.js";

const router = Router();
const severitySchema = z.enum(["critical", "warning", "info"]);
const sourcePathSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !/[\0\r\n]/.test(value),
    "sourcePath must be a repository-relative path"
  );
const repositorySchema = z.string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .transform(normalizeRepositoryIdentity);
const commitSchema = z.string().trim().regex(/^[a-fA-F0-9]{40,64}$/);
const suppressionSchema = z.object({
  id: z.string().uuid().optional(),
  ruleId: z.string().trim().min(1).max(100),
  findingId: z.string().trim().min(1).max(300).optional(),
  nodeId: z.string().trim().min(1).max(160).optional(),
  edgeId: z.string().trim().min(1).max(160).optional(),
  sourceAddress: z.string().trim().min(1).max(500).optional(),
  justification: z.string().trim().min(10).max(1000),
  createdBy: z.string().trim().min(1).max(160).optional(),
  createdAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  ticket: z.string().trim().min(1).max(120).optional(),
}).strict();
const policySchema = z.object({
  failOn: z.array(severitySchema).max(3).optional(),
  includeExistingFindings: z.boolean().optional(),
  rules: z.record(z.object({
    enabled: z.boolean().optional(),
    severity: severitySchema.optional(),
    blockMerge: z.boolean().optional(),
  }).strict()).optional(),
  suppressions: z.array(suppressionSchema).max(250).optional(),
}).strict();
const provenanceSchema = z.object({
  adapter: z.literal("docker-compose"),
  repository: repositorySchema.optional(),
  revision: commitSchema.optional(),
  file: sourcePathSchema,
  startLine: z.number().int().positive().max(1_000_000).optional(),
  endLine: z.number().int().positive().max(1_000_000).optional(),
  sourceAddress: z.string().trim().min(1).max(500),
  confidence: z.enum(["explicit", "static", "inferred", "user-declared"]),
}).strict();
const metadataSchema = z.object({
  notes: z.literal(""),
  links: z.array(z.never()).max(0),
  codeSnippet: z.literal(""),
  attachedFiles: z.array(z.never()).max(0),
}).strict();
const stringListSchema = z.array(z.string().max(500)).max(500);
const sourcePropertiesSchema = z.object({
  image: z.string().max(500).optional(),
  command: z.string().max(2_000).optional(),
  publishedPorts: stringListSchema.optional(),
  exposedPorts: stringListSchema.optional(),
  networks: stringListSchema.optional(),
  volumes: stringListSchema.optional(),
  secrets: stringListSchema.optional(),
  environmentKeys: stringListSchema.optional(),
  hasHealthcheck: z.boolean().optional(),
  hasBuild: z.boolean().optional(),
}).strict();
const nodeSchema = z.object({
  id: z.string().trim().min(1).max(160),
  type: z.literal("architecture"),
  position: z.object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  }).strict(),
  data: z.object({
    label: z.string().trim().min(1).max(160),
    subtitle: z.string().max(500).optional(),
    nodeType: z.enum([
      "service", "database", "gateway", "queue", "cache", "client",
      "loadbalancer", "storage", "cdn", "firewall", "dns", "proxy",
      "container", "function", "search", "warehouse", "stream", "broker",
      "auth", "vault", "monitor", "registry", "scheduler", "group",
    ]),
    status: z.enum(["active", "inactive", "analyzing"]),
    metadata: metadataSchema,
    icon: z.string().max(200).optional(),
    tier: z.enum(["frontend", "backend", "data", "infrastructure", "external"]).optional(),
    zone: z.enum(["public", "private", "dmz", "restricted"]).optional(),
    tech: z.string().max(200).optional(),
    environment: z.enum(["production", "staging", "development", "shared"]).optional(),
    region: z.string().max(100).optional(),
    instances: z.number().int().positive().max(100_000).optional(),
    sla: z.string().max(100).optional(),
    provenance: provenanceSchema.optional(),
    sourceProperties: sourcePropertiesSchema.optional(),
  }).strict(),
}).strict();
const edgeSchema = z.object({
  id: z.string().trim().min(1).max(160),
  source: z.string().trim().min(1).max(160),
  target: z.string().trim().min(1).max(160),
  sourceHandle: z.string().max(160).optional(),
  targetHandle: z.string().max(160).optional(),
  data: z.object({
    label: z.string().max(160).optional(),
    protocol: z.string().max(100).optional(),
    animated: z.boolean().optional(),
    direction: z.enum(["unidirectional", "bidirectional"]).optional(),
    provenance: z.array(provenanceSchema).max(20).optional(),
  }).strict().optional(),
  animated: z.boolean().optional(),
}).strict();
const graphSchema = z.object({
  nodes: z.array(nodeSchema).max(2_000),
  edges: z.array(edgeSchema).max(5_000),
  source: z.object({
    adapter: z.literal("docker-compose"),
    repository: repositorySchema.optional(),
    revision: commitSchema.optional(),
    files: z.array(sourcePathSchema).min(1).max(10),
  }).strict(),
}).strict();
const ingestionSchema = z.object({
  repository: repositorySchema,
  pullRequest: z.object({
    number: z.number().int().positive().max(1_000_000_000),
    url: z.string().url().max(500),
    title: z.string().trim().min(1).max(200),
    /** Monotonic provider version, e.g. Date.parse(pull_request.updated_at). */
    changeVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  sourcePath: sourcePathSchema,
  baseRevision: commitSchema,
  headRevision: commitSchema,
  workflowRun: z.object({
    id: z.string().trim().regex(/^\d{1,30}$/),
    url: z.string().url().max(500),
  }).strict().optional(),
  baseGraph: graphSchema,
  headGraph: graphSchema,
  policy: policySchema.default({}),
}).strict().superRefine((value, context) => {
  const expectedPullUrl = `https://github.com/${value.repository}/pull/${value.pullRequest.number}`;
  if (value.pullRequest.url.replace(/\/$/, "").toLowerCase() !== expectedPullUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pullRequest", "url"],
      message: "pullRequest.url must match repository and pull request number",
    });
  }
  if (value.workflowRun) {
    const expectedPrefix = `https://github.com/${value.repository}/actions/runs/`;
    if (!value.workflowRun.url.toLowerCase().startsWith(expectedPrefix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflowRun", "url"],
        message: "workflowRun.url must belong to the authenticated repository",
      });
    }
  }
  for (const [side, graph, revision] of [
    ["baseGraph", value.baseGraph, value.baseRevision],
    ["headGraph", value.headGraph, value.headRevision],
  ] as const) {
    if (graph.source.repository && graph.source.repository !== value.repository) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [side, "source", "repository"],
        message: "graph repository does not match ingestion repository",
      });
    }
    if (graph.source.revision && graph.source.revision.toLowerCase() !== revision.toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [side, "source", "revision"],
        message: "graph revision does not match ingestion revision",
      });
    }
    if (graph.source.files.length !== 1 || graph.source.files[0] !== value.sourcePath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [side, "source", "files"],
        message: "this release accepts exactly the configured Compose source path",
      });
    }
    const nodeIds = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [side, "nodes", index, "id"],
          message: "node identifiers must be unique",
        });
      }
      nodeIds.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const [index, edge] of graph.edges.entries()) {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [side, "edges", index, "id"],
          message: "edge identifiers must be unique",
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [side, "edges", index],
          message: "edge endpoints must reference nodes in the same graph",
        });
      }
    }
  }
});

function badRequest(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: "Invalid ingestion payload",
    details: error.flatten(),
  });
}

function bindProvenance(
  provenance: SourceProvenance,
  repository: string,
  revision: string,
  sourcePath: string
): SourceProvenance {
  return {
    ...provenance,
    adapter: "docker-compose",
    repository,
    revision,
    file: sourcePath,
  };
}

function bindGraph(
  graph: z.infer<typeof graphSchema>,
  repository: string,
  revision: string,
  sourcePath: string
): CanonicalArchitectureGraph {
  return canonicalizeGraph({
    source: {
      adapter: "docker-compose",
      repository,
      revision,
      files: [sourcePath],
    },
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        provenance: node.data.provenance
          ? bindProvenance(node.data.provenance, repository, revision, sourcePath)
          : undefined,
      },
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      data: edge.data
        ? {
            ...edge.data,
            provenance: edge.data.provenance?.map((provenance) =>
              bindProvenance(provenance, repository, revision, sourcePath)
            ),
          }
        : undefined,
    })),
  });
}

function responseFor(
  res: Response,
  result: IngestReviewResult
): Response {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const reviewUrl = new URL(`/reviews/${result.review.id}`, frontendUrl).toString();
  const body = {
    status: result.status,
    reviewId: result.review.id,
    reviewUrl,
    revision: result.review.revision,
    analysisStatus: result.review.report.status,
    blockingFindings: result.review.report.blockingFindings.length,
    headRevision: result.review.headRevision,
  };
  res.setHeader("Cache-Control", "no-store");
  if (result.status === "created") return res.status(201).json(body);
  if (result.status === "stale") return res.status(202).json(body);
  if (result.status === "conflict") {
    return res.status(409).json({
      ...body,
      error: "This change version was already ingested with different content.",
    });
  }
  return res.json(body);
}

router.use(requireReviewIntegration, reviewIngestionLimiter);

router.post("/github", async (req, res) => {
  const parsed = ingestionSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const integration = req.reviewIntegration!;
  if (
    integration.provider !== "github" ||
    parsed.data.repository !== integration.repository
  ) {
    return res.status(403).json({
      error: "Repository does not match this ingestion credential",
    });
  }
  try {
    const baseGraph = bindGraph(
      parsed.data.baseGraph,
      integration.repository,
      parsed.data.baseRevision.toLowerCase(),
      parsed.data.sourcePath
    );
    const headGraph = bindGraph(
      parsed.data.headGraph,
      integration.repository,
      parsed.data.headRevision.toLowerCase(),
      parsed.data.sourcePath
    );
    const policy = parsed.data.policy as ArchitecturePolicy;
    const report = reviewArchitectureChange(
      baseGraph,
      headGraph,
      policy,
      new Date()
    );
    const result = await ingestArchitectureReview({
      ownerId: integration.ownerId,
      title: parsed.data.pullRequest.title,
      repository: integration.repository,
      sourcePath: parsed.data.sourcePath,
      baseRevision: parsed.data.baseRevision.toLowerCase(),
      headRevision: parsed.data.headRevision.toLowerCase(),
      baseGraph,
      headGraph,
      policy,
      report,
      externalSource: {
        provider: "github",
        repository: integration.repository,
        changeNumber: parsed.data.pullRequest.number,
        changeUrl: parsed.data.pullRequest.url,
        changeVersion: parsed.data.pullRequest.changeVersion,
        workflowRunId: parsed.data.workflowRun?.id || null,
        workflowRunUrl: parsed.data.workflowRun?.url || null,
      },
    });
    return responseFor(res, result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Review ingestion failed",
    });
  }
});

export default router;
