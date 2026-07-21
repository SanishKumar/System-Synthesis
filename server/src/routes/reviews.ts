import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import {
  SourceImportError,
  dockerComposeAdapter,
  reviewArchitectureChange,
  type ArchitecturePolicy,
  type RuleSuppression,
} from "@system-synthesis/architecture-core";
import { reviewCreateLimiter } from "../middleware/rateLimit.js";
import {
  createArchitectureReview,
  getArchitectureReview,
  listArchitectureReviewEvents,
  listArchitectureReviews,
  updateArchitectureReviewAnalysis,
  updateArchitectureReviewDecision,
  type ReviewMutationResult,
} from "../services/reviewRepository.js";

const router = Router();
const reviewIdSchema = z.string().uuid();
const severitySchema = z.enum(["critical", "warning", "info"]);
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
});
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
const createReviewSchema = z.object({
  title: z.string().trim().min(1).max(120),
  repository: z.string().trim().min(1).max(240).optional(),
  sourcePath: sourcePathSchema.default("compose.yaml"),
  baseRevision: z.string().trim().min(1).max(200).default("base"),
  headRevision: z.string().trim().min(1).max(200).default("head"),
  baseContent: z.string().min(1).max(450_000),
  headContent: z.string().min(1).max(450_000),
  policy: policySchema.default({}),
}).strict();
const addSuppressionSchema = suppressionSchema
  .omit({ id: true, createdBy: true, createdAt: true })
  .extend({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const decisionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && (!value.note || value.note.length < 3)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["note"],
      message: "A rejection requires a short explanation.",
    });
  }
});

function badRequest(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: "Invalid request payload",
    details: error.flatten(),
  });
}

function mutationResponse(
  res: Response,
  result: ReviewMutationResult
): Response {
  if (result.status === "not_found") {
    return res.status(404).json({ error: "Architecture review not found" });
  }
  if (result.status === "conflict") {
    return res.status(409).json({
      error: "This review changed in another session. Refresh before retrying.",
    });
  }
  return res.json(result.review);
}

router.get("/", async (req, res) => {
  try {
    res.json({
      reviews: await listArchitectureReviews(req.user!.userId),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/", reviewCreateLimiter, async (req, res) => {
  const parsed = createReviewSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const base = dockerComposeAdapter.import(
      [{ path: parsed.data.sourcePath, content: parsed.data.baseContent }],
      {
        repository: parsed.data.repository,
        revision: parsed.data.baseRevision,
      }
    );
    const head = dockerComposeAdapter.import(
      [{ path: parsed.data.sourcePath, content: parsed.data.headContent }],
      {
        repository: parsed.data.repository,
        revision: parsed.data.headRevision,
      }
    );
    const reviewedAt = new Date();
    const policy = parsed.data.policy as ArchitecturePolicy;
    const report = reviewArchitectureChange(
      base.graph,
      head.graph,
      policy,
      reviewedAt,
      {
        base: base.diagnostics,
        head: head.diagnostics,
      }
    );
    const review = await createArchitectureReview({
      ownerId: req.user!.userId,
      title: parsed.data.title,
      repository: parsed.data.repository || null,
      sourcePath: parsed.data.sourcePath,
      baseRevision: parsed.data.baseRevision,
      headRevision: parsed.data.headRevision,
      baseGraph: base.graph,
      headGraph: head.graph,
      policy,
      report,
    });
    res.status(201).json(review);
  } catch (error) {
    if (error instanceof SourceImportError) {
      return res.status(422).json({
        error: error.message,
        diagnostics: error.diagnostics,
      });
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Review creation failed",
    });
  }
});

router.get("/:id", async (req, res) => {
  const id = reviewIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid review identifier" });
  try {
    const review = await getArchitectureReview(id.data, req.user!.userId);
    if (!review) return res.status(404).json({ error: "Architecture review not found" });
    res.json(review);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id/events", async (req, res) => {
  const id = reviewIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid review identifier" });
  try {
    const review = await getArchitectureReview(id.data, req.user!.userId);
    if (!review) return res.status(404).json({ error: "Architecture review not found" });
    res.json({
      events: await listArchitectureReviewEvents(id.data, req.user!.userId),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:id/suppressions", async (req, res) => {
  const id = reviewIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid review identifier" });
  const parsed = addSuppressionSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const current = await getArchitectureReview(id.data, req.user!.userId);
    if (!current) return res.status(404).json({ error: "Architecture review not found" });
    const target = current.report.headValidation.issues.find(
      (finding) =>
        finding.ruleId === parsed.data.ruleId &&
        (!parsed.data.findingId || finding.id === parsed.data.findingId)
    );
    if (!target) {
      return res.status(400).json({
        error: "The requested finding is not active on this review.",
      });
    }
    if (
      parsed.data.expiresAt &&
      new Date(parsed.data.expiresAt).getTime() <= Date.now()
    ) {
      return res.status(400).json({ error: "Suppression expiry must be in the future." });
    }
    const suppression: RuleSuppression = {
      ...parsed.data,
      id: randomUUID(),
      findingId: parsed.data.findingId || target.id,
      createdBy: req.user!.userId,
      createdAt: new Date().toISOString(),
    };
    const policy: ArchitecturePolicy = {
      ...current.policy,
      suppressions: [
        ...(current.policy.suppressions || []),
        suppression,
      ],
    };
    const report = reviewArchitectureChange(
      current.baseGraph,
      current.headGraph,
      policy,
      new Date(),
      {
        base: current.report.baseDiagnostics,
        head: current.report.headDiagnostics,
      }
    );
    const result = await updateArchitectureReviewAnalysis(
      current.id,
      req.user!.userId,
      parsed.data.expectedRevision,
      policy,
      report,
      {
        suppressionId: suppression.id,
        ruleId: suppression.ruleId,
        findingId: suppression.findingId,
        justification: suppression.justification,
        ticket: suppression.ticket,
        expiresAt: suppression.expiresAt,
      }
    );
    return mutationResponse(res, result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/:id/decision", async (req, res) => {
  const id = reviewIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Invalid review identifier" });
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const current = await getArchitectureReview(id.data, req.user!.userId);
    if (!current) return res.status(404).json({ error: "Architecture review not found" });
    if (parsed.data.decision === "approved" && current.report.status === "fail") {
      return res.status(422).json({
        error: "Blocking findings must be resolved or explicitly suppressed before approval.",
      });
    }
    const result = await updateArchitectureReviewDecision(
      current.id,
      req.user!.userId,
      parsed.data.expectedRevision,
      parsed.data.decision,
      parsed.data.note || null
    );
    return mutationResponse(res, result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
