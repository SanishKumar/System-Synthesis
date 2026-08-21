import { beforeEach, describe, expect, it, vi } from "vitest";

/** Authority is proved at the route; storage tests state it directly. */
const VERIFIED_AUTHORITY = {
  githubUserId: "9002",
  githubLogin: "octo-admin",
  permission: "admin",
  verifiedAt: "2026-08-21T00:00:00.000Z",
};

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  authenticateReviewIntegrationToken,
  createOrRotateReviewIntegration,
  listReviewIntegrations,
  resetMemoryReviewIntegrationsForTests,
  revokeReviewIntegration,
} from "../reviewIntegrationRepository.js";

describe("review integration credentials", () => {
  beforeEach(() => resetMemoryReviewIntegrationsForTests());

  it("stores a repository-scoped credential without exposing its secret", async () => {
    const issued = await createOrRotateReviewIntegration({
      ownerId: "owner-1",
      provider: "github",
      repository: "Acme/Shop",
      verified: VERIFIED_AUTHORITY,
    });

    expect(issued.ingestionToken).toMatch(/^ssri_[A-Za-z0-9_-]{43}$/);
    expect(issued.integration).toMatchObject({
      ownerId: "owner-1",
      provider: "github",
      repository: "acme/shop",
    });
    expect(issued.integration).not.toHaveProperty("tokenHash");
    await expect(
      authenticateReviewIntegrationToken(issued.ingestionToken)
    ).resolves.toMatchObject({ id: issued.integration.id });
  });

  it("rotates the token and immediately invalidates the previous value", async () => {
    const first = await createOrRotateReviewIntegration({
      ownerId: "owner-1",
      provider: "github",
      repository: "acme/shop",
      verified: VERIFIED_AUTHORITY,
    });
    const rotated = await createOrRotateReviewIntegration({
      ownerId: "owner-1",
      provider: "github",
      repository: "ACME/SHOP",
      verified: VERIFIED_AUTHORITY,
    });

    expect(rotated.integration.id).toBe(first.integration.id);
    await expect(
      authenticateReviewIntegrationToken(first.ingestionToken)
    ).resolves.toBeNull();
    await expect(
      authenticateReviewIntegrationToken(rotated.ingestionToken)
    ).resolves.toMatchObject({ id: first.integration.id });
    await expect(listReviewIntegrations("owner-1")).resolves.toHaveLength(1);
  });

  it("supports owner-scoped revocation", async () => {
    const issued = await createOrRotateReviewIntegration({
      ownerId: "owner-1",
      provider: "github",
      repository: "acme/shop",
      verified: VERIFIED_AUTHORITY,
    });

    await expect(
      revokeReviewIntegration(issued.integration.id, "other-owner")
    ).resolves.toBe(false);
    await expect(
      revokeReviewIntegration(issued.integration.id, "owner-1")
    ).resolves.toBe(true);
    await expect(
      authenticateReviewIntegrationToken(issued.ingestionToken)
    ).resolves.toBeNull();
  });
});
