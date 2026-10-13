import { beforeEach, describe, expect, it, vi } from "vitest";

/** Authority is proved at the route; storage tests state it directly. */
const VERIFIED_AUTHORITY = {
  githubUserId: "9002",
  githubLogin: "octo-admin",
  permission: "admin",
  // Current, so the credential is inside its revalidation window and these
  // tests stay about what they are about.
  verifiedAt: new Date().toISOString(),
};

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  authenticateReviewIntegrationToken,
  connectReviewIntegrationForOidc,
  createOrRotateReviewIntegration,
  findOidcReviewIntegration,
  forceAuthModeForTests,
  listReviewIntegrations,
  recordIntegrationAuthority,
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

/**
 * The same contract the PostgreSQL suite holds identity-token connections to,
 * held here against memory storage.
 *
 * In SQL this is a partial unique index, an upsert and two WHERE clauses; in
 * memory it is a handful of comparisons. Each is right on its own terms, and
 * only the same expectations run against both show whether they agree.
 */
describe("identity-token connections in memory storage", () => {
  beforeEach(() => resetMemoryReviewIntegrationsForTests());

  const IDENTIFIED = { ...VERIFIED_AUTHORITY, repositoryId: "5001" };
  const connect = (ownerId: string, repository = "acme/shop", repositoryId = "5001") =>
    connectReviewIntegrationForOidc({
      ownerId,
      provider: "github",
      repository,
      verified: { ...IDENTIFIED, repositoryId },
    });
  const issue = (ownerId: string, repository = "acme/shop") =>
    createOrRotateReviewIntegration({
      ownerId,
      provider: "github",
      repository,
      verified: VERIFIED_AUTHORITY,
    });

  it("stores the mode and the repository id, and no usable token", async () => {
    const connected = await connect("owner-1", "ACME/Shop");

    expect(connected.status).toBe("connected");
    if (connected.status !== "connected") return;
    expect(connected.integration).toMatchObject({
      ownerId: "owner-1",
      repository: "acme/shop",
      authMode: "oidc",
      tokenPrefix: "",
      verifiedRepositoryId: "5001",
      verifiedGithubUserId: "9002",
    });
    expect(connected.integration).not.toHaveProperty("tokenHash");
    const listed = await listReviewIntegrations("owner-1");
    expect(listed).toHaveLength(1);
    expect(listed[0].authMode).toBe("oidc");
  });

  it("finds the one connection waiting for a repository, whatever case it is asked in", async () => {
    await connect("owner-1");

    const found = await findOidcReviewIntegration("github", "ACME/SHOP");

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.integration).toMatchObject({ ownerId: "owner-1", authMode: "oidc" });
    expect(found.integration.lastUsedAt).toBeTruthy();
    await expect(findOidcReviewIntegration("github", "acme/absent")).resolves.toEqual({
      status: "none",
    });
  });

  it("refuses a second account for the same repository", async () => {
    await connect("owner-1");

    await expect(connect("owner-2")).resolves.toEqual({ status: "conflict" });

    await expect(listReviewIntegrations("owner-2")).resolves.toEqual([]);
    await expect(findOidcReviewIntegration("github", "acme/shop")).resolves.toMatchObject({
      status: "found",
      integration: { ownerId: "owner-1" },
    });
  });

  it("lets exactly one of two simultaneous connections through", async () => {
    const outcomes = await Promise.all([connect("owner-a"), connect("owner-b")]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["conflict", "connected"]);
    await expect(findOidcReviewIntegration("github", "acme/shop")).resolves.toMatchObject({
      status: "found",
    });
  });

  it("keeps one row when the same account connects again", async () => {
    const first = await connect("owner-1");
    const again = await connect("owner-1", "acme/shop", "5002");

    expect(first.status).toBe("connected");
    expect(again.status).toBe("connected");
    if (first.status !== "connected" || again.status !== "connected") return;
    expect(again.integration.id).toBe(first.integration.id);
    expect(again.integration.verifiedRepositoryId).toBe("5002");
    await expect(listReviewIntegrations("owner-1")).resolves.toHaveLength(1);
  });

  it("does not count a stored-token connection, or a revoked one, as waiting", async () => {
    // Another account holding a stored token for the repository is no conflict.
    await issue("holder");
    const connected = await connect("other");
    expect(connected.status).toBe("connected");
    if (connected.status !== "connected") return;

    // Revoking frees the repository, and takes the connection out of reach.
    await revokeReviewIntegration(connected.integration.id, "other");
    await expect(findOidcReviewIntegration("github", "acme/shop")).resolves.toEqual({
      status: "none",
    });
    await expect(connect("holder")).resolves.toMatchObject({ status: "connected" });

    // And the account that revoked cannot take it back while it is held.
    await expect(connect("other")).resolves.toEqual({ status: "conflict" });
  });

  it("ends the stored token when a connection is switched, and the reverse", async () => {
    const issued = await issue("owner-1");
    expect(issued.integration.authMode).toBe("token");
    await expect(findOidcReviewIntegration("github", "acme/shop")).resolves.toEqual({
      status: "none",
    });

    await expect(connect("owner-1")).resolves.toMatchObject({
      status: "connected",
      integration: { id: issued.integration.id, authMode: "oidc" },
    });
    await expect(authenticateReviewIntegrationToken(issued.ingestionToken)).resolves.toBeNull();

    const back = await issue("owner-1");
    expect(back.integration.authMode).toBe("token");
    await expect(findOidcReviewIntegration("github", "acme/shop")).resolves.toEqual({
      status: "none",
    });
    await expect(authenticateReviewIntegrationToken(back.ingestionToken)).resolves.toMatchObject({
      id: issued.integration.id,
    });
  });

  it("refuses a stored token by the connection's mode, not by its digest", async () => {
    // Switching replaces the digest, so the state is written directly: a row
    // that accepts identity tokens while an issued token's digest is still on it.
    const issued = await issue("owner-1");
    forceAuthModeForTests(issued.integration.id, "oidc");

    await expect(authenticateReviewIntegrationToken(issued.ingestionToken)).resolves.toBeNull();
  });

  it("reports two waiting connections rather than choosing between them", async () => {
    // PostgreSQL refuses to hold this state at all. Memory storage has no
    // index to refuse with, so what it is held to is never picking one.
    await connect("owner-1");
    const second = await issue("owner-2");
    forceAuthModeForTests(second.integration.id, "oidc");

    await expect(findOidcReviewIntegration("github", "acme/shop")).resolves.toEqual({
      status: "ambiguous",
    });
  });

  it("writes the repository id with each fresh proof, including its absence", async () => {
    const connected = await connect("owner-1");
    if (connected.status !== "connected") throw new Error("not connected");
    const id = connected.integration.id;

    const next = new Date(Date.now() + 1000).toISOString();
    await expect(
      recordIntegrationAuthority(
        id,
        { ...VERIFIED_AUTHORITY, repositoryId: "7777", verifiedAt: next },
        { previousVerifiedAt: connected.integration.verifiedAt }
      )
    ).resolves.toBe(true);
    expect((await listReviewIntegrations("owner-1"))[0].verifiedRepositoryId).toBe("7777");

    // A proof that did not establish the id does not keep the old one.
    await expect(
      recordIntegrationAuthority(
        id,
        { ...VERIFIED_AUTHORITY, verifiedAt: new Date(Date.now() + 2000).toISOString() },
        { previousVerifiedAt: next }
      )
    ).resolves.toBe(true);
    expect((await listReviewIntegrations("owner-1"))[0].verifiedRepositoryId).toBeNull();
  });
});
