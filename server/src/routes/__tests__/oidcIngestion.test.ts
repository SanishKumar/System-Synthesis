import express from "express";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/db.js", () => ({ getPool: () => null }));

/** What the linked-identity lookup answers for the signed-in user. */
const identity = {
  linked: { githubUserId: null as string | null, githubLogin: null as string | null },
};

vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth.js")>();
  return { ...actual, linkedGitHubIdentity: async () => identity.linked };
});

vi.mock("../../services/githubApp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/githubApp.js")>();
  return {
    ...actual,
    getInstallationToken: async () => ({
      status: "ok",
      token: "ghs_test",
      expiresAt: "2999-01-01T00:00:00Z",
      fromCache: false,
      permissions: { checks: "write", metadata: "read", pull_requests: "read" },
    }),
  };
});

import { dockerComposeAdapter } from "@system-synthesis/architecture-core";
import reviewIntegrationsRouter from "../reviewIntegrations.js";
import reviewIngestionsRouter from "../reviewIngestions.js";
import {
  ageVerificationForTests,
  forceAuthModeForTests,
  resetMemoryReviewIntegrationsForTests,
  stripVerificationForTests,
} from "../../services/reviewIntegrationRepository.js";
import {
  AUTHORITY_REVALIDATION_INTERVAL_MS,
  resetAuthorityRevalidationForTests,
} from "../../middleware/reviewIntegrationAuth.js";
import {
  getArchitectureReview,
  resetMemoryReviewsForTests,
} from "../../services/reviewRepository.js";
import { ownerScope } from "../../services/reviewAccess.js";
import { resetGitHubAppCacheForTests } from "../../services/githubApp.js";
import {
  GITHUB_OIDC_ISSUER,
  resetGitHubOidcKeysForTests,
} from "../../services/githubOidc.js";

const REPOSITORY = "acme/shop";
const REPOSITORY_ID = 5001;
const AUDIENCE = "https://reviews.example.test";
const SOURCE_PATH = "compose.yaml";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const PULL_REQUEST = 7;
const RUN_ID = "9001";

const SOURCE = `services:
  api:
    image: api:1
`;

const githubKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** Somebody else's key: a token signed with it was not issued by GitHub. */
const strangerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

/**
 * GitHub, as far as this server can see it.
 *
 * `repository` is what GitHub says the connected name refers to, `permission`
 * what the linked account holds on it, and `keysStatus` whether the key set a
 * token is checked against can be read at all.
 */
const github = {
  permission: "admin" as string,
  resolvedId: 9002 as number,
  resolvedLogin: "octo-admin",
  repository: {
    status: 200,
    id: REPOSITORY_ID as number,
    fullName: "Acme/Shop",
  },
  keysStatus: 200,
  keyRequests: 0,
  repositoryLookups: 0,
  collaboratorLookups: 0,
  checkWrites: [] as string[],
};

let server: Server | null = null;
const originalFetch = globalThis.fetch;

function installGitHubStub(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const url = String(input);
    // The suite drives the server over HTTP with this same global.
    if (url.startsWith("http://127.0.0.1")) return originalFetch(input, init);
    if (url === `${GITHUB_OIDC_ISSUER}/.well-known/jwks`) {
      github.keyRequests += 1;
      return new Response(
        JSON.stringify({
          keys: [
            {
              ...githubKey.publicKey.export({ format: "jwk" }),
              kid: "key-1",
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
        { status: github.keysStatus, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/collaborators/")) {
      github.collaboratorLookups += 1;
      return new Response(
        JSON.stringify({
          permission: github.permission,
          user: { id: github.resolvedId, login: github.resolvedLogin },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/check-runs")) {
      if ((init?.method || "GET") === "GET") {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      github.checkWrites.push(url);
      return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) {
      github.repositoryLookups += 1;
      return new Response(
        JSON.stringify({ id: github.repository.id, full_name: github.repository.fullName }),
        { status: github.repository.status, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
}

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use((req, _res, next) => {
    const userId = String(req.headers["x-test-user"] || "admin-1");
    req.user = { userId, userName: userId, isGuest: false };
    next();
  });
  app.use("/api/review-integrations", reviewIntegrationsRouter);
  app.use("/api/review-ingestions", reviewIngestionsRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function connect(
  baseUrl: string,
  user: string,
  authentication?: string,
  repository = REPOSITORY
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/review-integrations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": user },
    body: JSON.stringify({ repository, ...(authentication ? { authentication } : {}) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function connections(baseUrl: string, user: string): Promise<any[]> {
  const response = await fetch(`${baseUrl}/api/review-integrations`, {
    headers: { "x-test-user": user },
  });
  return ((await response.json()) as { integrations: any[] }).integrations;
}

async function revoke(baseUrl: string, user: string, id: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/review-integrations/${id}`, {
    method: "DELETE",
    headers: { "x-test-user": user },
  });
  return response.status;
}

/** The token GitHub would issue to a pull_request run of the repository. */
function identityToken(
  overrides: Record<string, unknown> = {},
  signer: KeyObject = githubKey.privateKey
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: GITHUB_OIDC_ISSUER,
      aud: AUDIENCE,
      sub: "repo:Acme/Shop:pull_request",
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
      repository: "Acme/Shop",
      repository_id: String(REPOSITORY_ID),
      repository_owner_id: "7001",
      event_name: "pull_request",
      ref: `refs/pull/${PULL_REQUEST}/merge`,
      run_id: RUN_ID,
      run_attempt: "1",
      actor_id: "88",
      ...overrides,
    },
    signer,
    { algorithm: "RS256", keyid: "key-1" }
  );
}

function graph(revision: string, repository = REPOSITORY) {
  return dockerComposeAdapter.import(
    [{ path: SOURCE_PATH, content: SOURCE }],
    { repository, revision }
  ).graph;
}

function delivery(overrides: {
  repository?: string;
  pullRequest?: number;
  runId?: string | null;
} = {}) {
  const repository = overrides.repository ?? REPOSITORY;
  const number = overrides.pullRequest ?? PULL_REQUEST;
  const runId = overrides.runId === undefined ? RUN_ID : overrides.runId;
  return {
    repository,
    pullRequest: {
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      title: "Add the cache",
      changeVersion: 100,
    },
    sourcePath: SOURCE_PATH,
    baseRevision: BASE_SHA,
    headRevision: HEAD_SHA,
    ...(runId === null
      ? {}
      : {
          workflowRun: {
            id: runId,
            url: `https://github.com/${repository}/actions/runs/${runId}`,
          },
        }),
    baseGraph: graph(BASE_SHA, repository),
    headGraph: graph(HEAD_SHA, repository),
    policy: {},
  };
}

async function ingest(
  baseUrl: string,
  token: string,
  body: unknown = delivery()
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/review-ingestions/github`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function resetWorld(): void {
  resetMemoryReviewIntegrationsForTests();
  resetMemoryReviewsForTests();
  resetGitHubAppCacheForTests();
  resetAuthorityRevalidationForTests();
  resetGitHubOidcKeysForTests();
  github.permission = "admin";
  github.resolvedId = 9002;
  github.resolvedLogin = "octo-admin";
  github.repository = { status: 200, id: REPOSITORY_ID, fullName: "Acme/Shop" };
  github.keysStatus = 200;
  github.keyRequests = 0;
  github.repositoryLookups = 0;
  github.collaboratorLookups = 0;
  github.checkWrites = [];
  identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY =
    "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
  process.env.PUBLIC_API_URL = `${AUDIENCE}/`;
  installGitHubStub();
}

async function stopWorld(): Promise<void> {
  globalThis.fetch = originalFetch;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.PUBLIC_API_URL;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

/** A second administrator, signed in as a different account. */
function actAsSecondAdministrator(): void {
  github.resolvedId = 9003;
  github.resolvedLogin = "octo-second";
  identity.linked = { githubUserId: "9003", githubLogin: "octo-second" };
}

describe("connecting a repository for GitHub OIDC", () => {
  beforeEach(resetWorld);
  afterEach(stopWorld);

  it("connects without issuing anything to store", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");

    expect(connected.status).toBe(201);
    expect(connected.body.ingestionToken).toBeNull();
    expect(connected.body.audience).toBe(AUDIENCE);
    expect(connected.body.integration).toMatchObject({
      repository: REPOSITORY,
      authMode: "oidc",
      tokenPrefix: "",
      verifiedRepositoryId: String(REPOSITORY_ID),
      verifiedGithubUserId: "9002",
      verifiedPermission: "admin",
    });
    expect(JSON.stringify(connected.body)).not.toContain("ssri_");
  });

  it("issues a stored token when nothing is said about how to authenticate", async () => {
    // What every existing client sends. It must get what it got before.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(201);
    expect(connected.body.ingestionToken).toMatch(/^ssri_/);
    expect(connected.body.integration.authMode).toBe("token");
  });

  it("rejects a way of authenticating it does not know", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "saml");
    expect(connected.status).toBe(400);
    expect(await connections(baseUrl, "admin-1")).toEqual([]);
  });

  it("requires the same authority over the repository as a token does", async () => {
    // No secret changes hands, but the connection still makes the App publish
    // on the repository for whoever holds it.
    github.permission = "write";
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "writer-1", "oidc");
    expect(connected.status).toBe(403);
    expect(connected.body.code).toBe("repository_permission_insufficient");
    expect(await connections(baseUrl, "writer-1")).toEqual([]);
  });

  it("refuses when the deployment has no address a token could be issued for", async () => {
    // A connection nothing could ever be delivered to would look connected.
    delete process.env.PUBLIC_API_URL;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");

    expect(connected.status).toBe(409);
    expect(connected.body.code).toBe("oidc_not_configured");
    expect(await connections(baseUrl, "admin-1")).toEqual([]);
    // Decided from configuration alone, before GitHub is asked anything.
    expect(github.collaboratorLookups).toBe(0);
  });

  it("still issues a stored token on a deployment with no public address", async () => {
    delete process.env.PUBLIC_API_URL;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");
    expect(connected.status).toBe(201);
    expect(connected.body.ingestionToken).toMatch(/^ssri_/);
  });

  it("refuses when GitHub does not confirm which repository the name refers to", async () => {
    github.repository.status = 500;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");

    expect(connected.status).toBe(503);
    expect(connected.body.code).toBe("repository_verification_unavailable");
    expect(await connections(baseUrl, "admin-1")).toEqual([]);
  });

  it("does not hold a token connection to an answer it does not depend on", async () => {
    github.repository.status = 500;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");

    expect(connected.status).toBe(201);
    expect(connected.body.integration.verifiedRepositoryId).toBeNull();
  });

  it("records the repository id on a token connection when GitHub gives it", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");
    expect(connected.body.integration.verifiedRepositoryId).toBe(String(REPOSITORY_ID));
  });

  it("refuses a name that is only an alias for a renamed repository", async () => {
    // GitHub keeps answering for an old name. Tokens are issued for the new
    // one, so a connection under the old name would never be matched.
    github.repository.fullName = "Acme/Storefront";
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");

    expect(connected.status).toBe(409);
    expect(connected.body.code).toBe("repository_name_changed");
    expect(connected.body.error).toContain("Acme/Storefront");
    expect(await connections(baseUrl, "admin-1")).toEqual([]);
  });

  it("refuses an answer that names no usable repository id", async () => {
    for (const id of [0, -4, 1.5, "5001" as unknown as number]) {
      github.repository.id = id;
      const baseUrl = await startApp();
      const connected = await connect(baseUrl, "admin-1", "oidc");
      expect(connected.status).toBe(503);
      expect(await connections(baseUrl, "admin-1")).toEqual([]);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("lets only one account receive a repository's identity tokens", async () => {
    // A token names a repository and no account. Two connections waiting for
    // it would leave nothing to say whose reviews these are.
    const baseUrl = await startApp();
    const first = await connect(baseUrl, "admin-1", "oidc");
    expect(first.status).toBe(201);

    actAsSecondAdministrator();
    const second = await connect(baseUrl, "admin-2", "oidc");

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("repository_oidc_already_connected");
    expect(await connections(baseUrl, "admin-2")).toEqual([]);
    // The first connection is exactly as it was.
    const kept = await connections(baseUrl, "admin-1");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: first.body.integration.id, authMode: "oidc" });
    expect(kept[0].revokedAt).toBeNull();
  });

  it("lets a second account connect the same repository with a stored token", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    actAsSecondAdministrator();
    const second = await connect(baseUrl, "admin-2", "token");
    expect(second.status).toBe(201);
    expect(second.body.ingestionToken).toMatch(/^ssri_/);
  });

  it("is not blocked by another account that holds a stored token for it", async () => {
    // Only a second connection waiting for the same identity token is a
    // conflict. A stored token names its own connection.
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "token");
    actAsSecondAdministrator();
    const second = await connect(baseUrl, "admin-2", "oidc");
    expect(second.status).toBe(201);
    expect(second.body.integration.authMode).toBe("oidc");
  });

  it("does not repeat a repository name GitHub would never give", async () => {
    // The current name is quoted back to whoever is connecting, so it is only
    // taken when it is a name.
    github.repository.fullName = "Acme/Store front <b>";
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");
    expect(connected.status).toBe(503);
    expect(connected.body.code).toBe("repository_verification_unavailable");
    expect(JSON.stringify(connected.body)).not.toContain("Store front");
  });

  it("frees the repository for another account once the first revokes", async () => {
    const baseUrl = await startApp();
    const first = await connect(baseUrl, "admin-1", "oidc");
    expect(await revoke(baseUrl, "admin-1", first.body.integration.id)).toBe(204);

    actAsSecondAdministrator();
    const second = await connect(baseUrl, "admin-2", "oidc");
    expect(second.status).toBe(201);

    // And the first cannot take it back while the second holds it.
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    const again = await connect(baseUrl, "admin-1", "oidc");
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("repository_oidc_already_connected");
  });

  it("keeps one connection when the same account connects again", async () => {
    const baseUrl = await startApp();
    const first = await connect(baseUrl, "admin-1", "oidc");
    const again = await connect(baseUrl, "admin-1", "oidc");
    expect(again.status).toBe(201);
    expect(again.body.integration.id).toBe(first.body.integration.id);
    expect(await connections(baseUrl, "admin-1")).toHaveLength(1);
  });
});

describe("ingesting with a GitHub Actions identity token", () => {
  beforeEach(resetWorld);
  afterEach(stopWorld);

  it("records the review for the account that connected the repository", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(201);
    expect(github.checkWrites.length).toBeGreaterThan(0);
    const stored = await getArchitectureReview(ingested.body.reviewId, ownerScope("admin-1"));
    expect(stored).toMatchObject({ repository: REPOSITORY, headRevision: HEAD_SHA });
    expect(stored?.externalSource).toMatchObject({
      changeNumber: PULL_REQUEST,
      workflowRunId: RUN_ID,
    });
  });

  it("accepts nothing a stranger signed", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    const ingested = await ingest(baseUrl, identityToken({}, strangerKey.privateKey));

    expect(ingested.status).toBe(401);
    expect(ingested.body.code).toBe("oidc_token_invalid");
    expect(github.checkWrites).toEqual([]);
  });

  it("accepts nothing requested for another service", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    const ingested = await ingest(baseUrl, identityToken({ aud: "https://github.com/acme" }));

    expect(ingested.status).toBe(401);
    expect(ingested.body.code).toBe("oidc_audience_mismatch");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses rather than accepting when GitHub's keys cannot be read", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    github.keysStatus = 503;

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(503);
    expect(ingested.body.code).toBe("oidc_keys_unavailable");
    expect(github.checkWrites).toEqual([]);
  });

  it("does not accept an identity token on a connection made for a stored token", async () => {
    // Whoever keeps that token behind an approval step has not agreed to a
    // second way in, and a genuine run of the repository is still not it.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_not_connected_for_oidc");
    expect(github.checkWrites).toEqual([]);
    // The stored token it was connected for still works.
    expect((await ingest(baseUrl, connected.body.ingestionToken)).status).toBe(201);
  });

  it("ends the stored token when its connection is switched to identity tokens", async () => {
    const baseUrl = await startApp();
    const before = await connect(baseUrl, "admin-1", "token");
    const switched = await connect(baseUrl, "admin-1", "oidc");
    expect(switched.body.integration.id).toBe(before.body.integration.id);

    expect((await ingest(baseUrl, before.body.ingestionToken)).status).toBe(401);
    expect(github.checkWrites).toEqual([]);
    expect((await ingest(baseUrl, identityToken())).status).toBe(201);
  });

  it("refuses a stored token on an identity-token connection even if its digest still matched", async () => {
    // Switching replaces the digest, so this is not a state connecting leaves
    // behind. What a connection accepts is still decided by its mode, not by
    // whether an old value happens to be lying in the row.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");
    forceAuthModeForTests(connected.body.integration.id, "oidc");

    const ingested = await ingest(baseUrl, connected.body.ingestionToken);

    expect(ingested.status).toBe(401);
    expect(github.checkWrites).toEqual([]);
  });

  it("stops accepting identity tokens when the connection is switched back", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    const switched = await connect(baseUrl, "admin-1", "token");

    const ingested = await ingest(baseUrl, identityToken());
    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_not_connected_for_oidc");
    expect(github.checkWrites).toEqual([]);
    expect((await ingest(baseUrl, switched.body.ingestionToken)).status).toBe(201);
  });

  it("stops accepting identity tokens once the connection is revoked", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");
    await revoke(baseUrl, "admin-1", connected.body.integration.id);

    const ingested = await ingest(baseUrl, identityToken());
    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_not_connected_for_oidc");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses a repository that was never connected", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl, identityToken());
    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_not_connected_for_oidc");
  });

  it("refuses a run started by anything other than a pull request", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    for (const eventName of ["push", "pull_request_target", "workflow_dispatch"]) {
      const ingested = await ingest(baseUrl, identityToken({ event_name: eventName }));
      expect(ingested.status).toBe(403);
      expect(ingested.body.code).toBe("oidc_event_unsupported");
    }
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses a token from whatever now holds the repository's name", async () => {
    // The name was released and registered again. GitHub signs a perfectly
    // good token for it, and the id is the only thing that tells them apart.
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    const ingested = await ingest(baseUrl, identityToken({ repository_id: "6666" }));

    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_identity_mismatch");
    expect(github.checkWrites).toEqual([]);
    // Whoever holds the name does not get to make this server ask about it.
    expect(github.repositoryLookups).toBe(1);
  });

  it("refuses a connection that has no repository id to match against", async () => {
    // Not a state connecting can produce. If storage ever holds one, a token
    // compared against nothing must not be read as matching.
    github.repository.status = 500;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");
    expect(connected.body.integration.verifiedRepositoryId).toBeNull();
    forceAuthModeForTests(connected.body.integration.id, "oidc");

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_identity_mismatch");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses a delivery about a different pull request than the run's own", async () => {
    // Otherwise a token minted while reviewing one pull request could rewrite
    // the review of another for as long as it stayed valid.
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    const ingested = await ingest(baseUrl, identityToken(), delivery({ pullRequest: 8 }));

    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("oidc_pull_request_mismatch");
    expect(github.checkWrites).toEqual([]);
  });

  it("does not read a pull request number out of a longer one", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    const token = identityToken({ ref: `refs/pull/${PULL_REQUEST}1/merge` });
    const ingested = await ingest(baseUrl, token);
    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("oidc_pull_request_mismatch");
  });

  it("refuses a delivery that names another run, or none", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    for (const runId of ["9002", null]) {
      const ingested = await ingest(baseUrl, identityToken(), delivery({ runId }));
      expect(ingested.status).toBe(403);
      expect(ingested.body.code).toBe("oidc_run_mismatch");
    }
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses a delivery about a repository other than the token's", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");

    const ingested = await ingest(
      baseUrl,
      identityToken(),
      delivery({ repository: "acme/other" })
    );

    expect(ingested.status).toBe(403);
    expect(github.checkWrites).toEqual([]);
  });

  it("matches the repository whatever case the token writes it in", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    const ingested = await ingest(baseUrl, identityToken({ repository: "ACME/Shop" }));
    expect(ingested.status).toBe(201);
  });

  it("refuses a connection whose proof of authority is gone", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "oidc");
    stripVerificationForTests(connected.body.integration.id);

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("integration_unverified");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses to choose when two connections wait for the same repository", async () => {
    // Storage keeps this to one. If it ever holds two, taking either would be
    // deciding whose account a repository's reviews belong to.
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    actAsSecondAdministrator();
    const second = await connect(baseUrl, "admin-2", "token");
    forceAuthModeForTests(second.body.integration.id, "oidc");

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(409);
    expect(ingested.body.code).toBe("repository_connection_ambiguous");
    expect(github.checkWrites).toEqual([]);
  });

  it("does not fetch GitHub's keys again for every delivery", async () => {
    const baseUrl = await startApp();
    await connect(baseUrl, "admin-1", "oidc");
    await ingest(baseUrl, identityToken());
    await ingest(baseUrl, identityToken());
    await ingest(baseUrl, identityToken({}, strangerKey.privateKey));
    expect(github.keyRequests).toBe(1);
  });
});

describe("an identity-token connection is confirmed again before it goes stale", () => {
  beforeEach(resetWorld);
  afterEach(stopWorld);

  async function staleConnection(baseUrl: string): Promise<string> {
    const connected = await connect(baseUrl, "admin-1", "oidc");
    ageVerificationForTests(
      connected.body.integration.id,
      new Date(Date.now() - AUTHORITY_REVALIDATION_INTERVAL_MS - 1).toISOString()
    );
    return connected.body.integration.id;
  }

  it("keeps accepting while its administrator still administers the repository", async () => {
    const baseUrl = await startApp();
    await staleConnection(baseUrl);
    const ingested = await ingest(baseUrl, identityToken());
    expect(ingested.status).toBe(201);
    expect(github.checkWrites.length).toBeGreaterThan(0);
  });

  it("refuses once its administrator has lost admin", async () => {
    // No secret to revoke does not mean nothing to revoke: the connection
    // still stands on somebody's authority, and that can end.
    const baseUrl = await startApp();
    await staleConnection(baseUrl);
    github.permission = "write";

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(403);
    expect(ingested.body.code).toBe("repository_permission_insufficient");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses when the repository can no longer be identified", async () => {
    const baseUrl = await startApp();
    await staleConnection(baseUrl);
    github.repository.status = 500;

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(503);
    expect(ingested.body.code).toBe("repository_verification_unavailable");
    expect(github.checkWrites).toEqual([]);
  });

  it("says so when the repository has since been renamed", async () => {
    const baseUrl = await startApp();
    await staleConnection(baseUrl);
    github.repository.fullName = "Acme/Storefront";

    const ingested = await ingest(baseUrl, identityToken());

    expect(ingested.status).toBe(409);
    expect(ingested.body.code).toBe("repository_name_changed");
    expect(github.checkWrites).toEqual([]);
  });

  it("follows the id GitHub confirms now, not the one it confirmed before", async () => {
    // The name now belongs to a different repository that the same
    // administrator administers. The old repository's tokens stop matching.
    const baseUrl = await startApp();
    await staleConnection(baseUrl);
    github.repository.id = 7777;

    const fromTheOld = await ingest(baseUrl, identityToken());
    expect(fromTheOld.status).toBe(403);
    expect(fromTheOld.body.code).toBe("repository_identity_mismatch");

    const fromTheNew = await ingest(baseUrl, identityToken({ repository_id: "7777" }));
    expect(fromTheNew.status).toBe(201);
  });

  it("leaves a stored-token connection working when the repository cannot be identified", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1", "token");
    ageVerificationForTests(
      connected.body.integration.id,
      new Date(Date.now() - AUTHORITY_REVALIDATION_INTERVAL_MS - 1).toISOString()
    );
    github.repository.status = 500;

    const ingested = await ingest(baseUrl, connected.body.ingestionToken);
    expect(ingested.status).toBe(201);
  });
});
