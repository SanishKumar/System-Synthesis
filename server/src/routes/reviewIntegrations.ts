import { Router, type Response } from "express";
import { z } from "zod";
import {
  createOrRotateReviewIntegration,
  listReviewIntegrations,
  revokeReviewIntegration,
} from "../services/reviewIntegrationRepository.js";
import { verifyRepositoryAuthority } from "../services/repositoryAuthority.js";
import { linkedGitHubIdentity } from "./auth.js";

const router = Router();
const integrationIdSchema = z.string().uuid();
const repositorySchema = z.string()
  .trim()
  .min(3)
  .max(200)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "repository must use the GitHub owner/name form"
  );
const createIntegrationSchema = z.object({
  provider: z.literal("github").default("github"),
  repository: repositorySchema,
}).strict();

router.use((req, res, next) => {
  const isGuest = req.user!.isGuest ?? req.user!.userId.startsWith("guest-");
  if (isGuest) {
    return res.status(403).json({
      error: "A permanent account is required to connect a repository",
    });
  }
  next();
});

function badRequest(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: "Invalid request payload",
    details: error.flatten(),
  });
}

router.get("/", async (req, res) => {
  try {
    res.json({
      integrations: await listReviewIntegrations(req.user!.userId),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Could not list integrations",
    });
  }
});

/** Create or rotate the one ingestion credential for this user + repository. */
router.post("/", async (req, res) => {
  const parsed = createIntegrationSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    // The credential is what makes the App publish a gate on somebody's pull
    // request, so authority over the repository is established before one
    // exists. A refusal writes nothing and reveals nothing: no row, no token,
    // and no part of GitHub's answer beyond a code this deployment chose.
    const authority = await verifyRepositoryAuthority(
      parsed.data.repository,
      await linkedGitHubIdentity(req.user!.userId)
    );
    if (authority.status === "refused") {
      return res.status(authority.httpStatus).json({
        error: authority.message,
        code: authority.code,
      });
    }

    const issued = await createOrRotateReviewIntegration({
      ownerId: req.user!.userId,
      provider: parsed.data.provider,
      repository: parsed.data.repository,
      verified: authority.authority,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      ...issued,
      warning: "Store this token now. It will not be shown again.",
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Could not create integration",
    });
  }
});

router.delete("/:id", async (req, res) => {
  const id = integrationIdSchema.safeParse(req.params.id);
  if (!id.success) {
    return res.status(400).json({ error: "Invalid integration identifier" });
  }
  try {
    const revoked = await revokeReviewIntegration(id.data, req.user!.userId);
    if (!revoked) return res.status(404).json({ error: "Integration not found" });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Could not revoke integration",
    });
  }
});

export default router;
