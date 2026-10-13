import { Router, type Response } from "express";
import { z } from "zod";
import {
  connectReviewIntegrationForOidc,
  createOrRotateReviewIntegration,
  listReviewIntegrations,
  revokeReviewIntegration,
} from "../services/reviewIntegrationRepository.js";
import { verifyRepositoryAuthority } from "../services/repositoryAuthority.js";
import { gitHubOidcAudience } from "../services/githubOidc.js";
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
  /**
   * The one credential this connection will accept. Defaults to the stored
   * token, so a client that says nothing gets exactly what it got before.
   */
  authentication: z.enum(["token", "oidc"]).default("token"),
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

/**
 * Connect a repository, or reconnect it. Either issues the one ingestion token
 * for this user and repository, or sets the connection to accept the identity
 * token GitHub issues to the repository's own runs, in which case there is no
 * token to issue and any earlier one stops working.
 */
router.post("/", async (req, res) => {
  const parsed = createIntegrationSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const usesIdentityToken = parsed.data.authentication === "oidc";
    // Checked before anything is written. A connection that this deployment
    // could never accept a token for would look connected and deliver nothing.
    const audience = gitHubOidcAudience();
    if (usesIdentityToken && !audience) {
      return res.status(409).json({
        error:
          "This deployment has no public address configured, so it cannot accept GitHub " +
          "Actions identity tokens. Its operator needs to set PUBLIC_API_URL; until then, " +
          "connect with an ingestion token.",
        code: "oidc_not_configured",
      });
    }

    // The credential is what makes the App publish a gate on somebody's pull
    // request, so authority over the repository is established before one
    // exists. A refusal writes nothing and reveals nothing: no row, no token,
    // and no part of GitHub's answer beyond a code this deployment chose.
    const authority = await verifyRepositoryAuthority(
      parsed.data.repository,
      await linkedGitHubIdentity(req.user!.userId),
      { requireRepositoryId: usesIdentityToken }
    );
    if (authority.status === "refused") {
      return res.status(authority.httpStatus).json({
        error: authority.message,
        code: authority.code,
      });
    }

    if (usesIdentityToken) {
      const repositoryId = authority.authority.repositoryId;
      if (!repositoryId) {
        // Asked for above, so this is not reachable through verification as it
        // stands. It is still refused rather than assumed, because a
        // connection without the id would match tokens against nothing.
        return res.status(503).json({
          error:
            "GitHub did not confirm which repository that name refers to. Nothing has " +
            "been connected; try again shortly.",
          code: "repository_verification_unavailable",
        });
      }
      const connected = await connectReviewIntegrationForOidc({
        ownerId: req.user!.userId,
        provider: parsed.data.provider,
        repository: parsed.data.repository,
        verified: { ...authority.authority, repositoryId },
      });
      if (connected.status === "conflict") {
        return res.status(409).json({
          error:
            "Another account already receives this repository's reviews through GitHub " +
            "OIDC, and an identity token can only be delivered to one. Ask that account " +
            "to revoke its connection, or connect with an ingestion token instead.",
          code: "repository_oidc_already_connected",
        });
      }
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({
        integration: connected.integration,
        // Nothing to store: the workflow asks GitHub for a token on each run.
        ingestionToken: null,
        audience,
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
