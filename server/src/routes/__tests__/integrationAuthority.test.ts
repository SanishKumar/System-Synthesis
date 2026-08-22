import express from "express";
import type { Server } from "node:http";
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

/**
 * GitHub, as far as this server can see it.
 *
 * `installed` decides whether the App can mint a token for the repository, and
 * `permission` is what GitHub says the linked account holds on it. The attacker
 * cases leave `permission` at none: an account with no standing on a repository
 * it is nonetheless trying to connect.
 */
const github = {
  installed: true,
  permission: "admin" as string,
  resolvedId: 9002 as number | null,
  resolvedLogin: "octo-admin",
  permissionStatus: 200,
  permissionHeaders: undefined as Record<string, string> | undefined,
  /** Every check-run write the server attempted. */
  checkWrites: [] as string[],
  /** How many times the server asked GitHub about repository permission. */
  collaboratorLookups: 0,
  /** What the installation is granted for checks. */
  checksPermission: "write" as string,
  /**
   * How long a collaborator lookup takes.
   *
   * Zero everywhere except the burst test. Without a real delay the first
   * delivery finishes and writes fresh proof before the others reach the
   * staleness check, so they never revalidate and the test would pass whether
   * or not the lookup is shared — which is exactly what it is there to prove.
   */
  collaboratorDelayMs: 0,
};

vi.mock("../../services/githubApp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/githubApp.js")>();
  return {
    ...actual,
    getInstallationToken: async () =>
      github.installed
        ? {
            status: "ok",
            token: "ghs_test",
            expiresAt: "2999-01-01T00:00:00Z",
            permissions: {
              checks: github.checksPermission,
              metadata: "read",
              pull_requests: "read",
            },
          }
        : { status: "not_installed" },
  };
});

import { dockerComposeAdapter } from "@system-synthesis/architecture-core";
import reviewIntegrationsRouter from "../reviewIntegrations.js";
import reviewIngestionsRouter from "../reviewIngestions.js";
import {
  ageVerificationForTests,
  createOrRotateReviewIntegration,
  downgradeVerificationForTests,
  resetMemoryReviewIntegrationsForTests,
  stripVerificationForTests,
} from "../../services/reviewIntegrationRepository.js";
import {
  AUTHORITY_FAILURE_BACKOFF_MS,
  AUTHORITY_REVALIDATION_INTERVAL_MS,
  resetAuthorityRevalidationForTests,
} from "../../middleware/reviewIntegrationAuth.js";
import { resetMemoryReviewsForTests } from "../../services/reviewRepository.js";
import { resetGitHubAppCacheForTests } from "../../services/githubApp.js";

const VICTIM = "victim/repository";
const SOURCE_PATH = "compose.yaml";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

/** A graph with nothing in it: the shape a fabricated "all clear" would take. */
const EMPTY_SOURCE = `services:
  api:
    image: api:1
`;

let server: Server | null = null;
const originalFetch = globalThis.fetch;

function graph(content: string, revision: string) {
  return dockerComposeAdapter.import(
    [{ path: SOURCE_PATH, content }],
    { repository: VICTIM, revision }
  ).graph;
}

function fabricatedPayload() {
  return {
    repository: VICTIM,
    pullRequest: {
      number: 7,
      url: `https://github.com/${VICTIM}/pull/7`,
      title: "Innocuous change",
      changeVersion: 100,
    },
    sourcePath: SOURCE_PATH,
    baseRevision: BASE_SHA,
    headRevision: HEAD_SHA,
    baseGraph: graph(EMPTY_SOURCE, BASE_SHA),
    headGraph: graph(EMPTY_SOURCE, HEAD_SHA),
    policy: {},
  };
}

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use((req, _res, next) => {
    const userId = String(req.headers["x-test-user"] || "attacker-1");
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

/** Answers the GitHub calls the server makes, and records check writes. */
function installGitHubStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    // The suite drives the server over HTTP with this same global, so anything
    // aimed at the test server has to reach it rather than this stub.
    if (url.startsWith("http://127.0.0.1")) return originalFetch(input, init);
    if (url.includes("/collaborators/")) {
      github.collaboratorLookups += 1;
      if (github.collaboratorDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, github.collaboratorDelayMs));
      }
      return new Response(
        JSON.stringify({
          permission: github.permission,
          ...(github.resolvedId === null
            ? {}
            : { user: { id: github.resolvedId, login: github.resolvedLogin } }),
        }),
        {
          status: github.permissionStatus,
          headers: { "content-type": "application/json", ...(github.permissionHeaders || {}) },
        }
      );
    }
    if (url.includes("/check-runs")) {
      if ((init?.method || "GET") === "GET") {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      github.checkWrites.push(url);
      return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
}

async function connect(
  baseUrl: string,
  user: string,
  repository = VICTIM
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/review-integrations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": user },
    body: JSON.stringify({ repository }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function ingest(
  baseUrl: string,
  token: string
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/review-ingestions/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(fabricatedPayload()),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe("connecting a repository requires authority over it", () => {
  beforeEach(() => {
    resetMemoryReviewIntegrationsForTests();
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    github.installed = true;
    github.permission = "admin";
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    github.permissionStatus = 200;
    github.permissionHeaders = undefined;
    github.checkWrites = [];
    github.collaboratorLookups = 0;
    github.collaboratorDelayMs = 0;
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
    installGitHubStub();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("refuses an account with no standing on the repository, and publishes no check", async () => {
    // The confused deputy. A stranger names somebody else's repository, is
    // issued a credential for it, and the App — installed there for its owner —
    // publishes a gate on a real commit from a graph the stranger invented.
    // The credential is where this has to stop: everything downstream trusts it.
    github.permission = "none";
    github.resolvedId = 4242;
    github.resolvedLogin = "stranger";
    identity.linked = { githubUserId: "4242", githubLogin: "stranger" };

    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "attacker-1");

    expect(connected.status).toBe(403);
    expect(connected.body?.code).toBe("repository_permission_insufficient");
    expect(connected.body?.ingestionToken).toBeUndefined();

    // Nothing was issued, so nothing can be ingested and no check can be written.
    const ingested = await ingest(baseUrl, "ssri_forged_token_value");
    expect(ingested.status).toBe(401);
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses write and maintain, which cannot administer a connection", async () => {
    // This credential makes the App speak on the repository's behalf. Being
    // able to push to a repository is not the same as being able to decide what
    // may publish gates on it.
    for (const permission of ["write", "maintain"]) {
      github.permission = permission;
      const baseUrl = await startApp();
      const connected = await connect(baseUrl, "writer-1");
      expect(connected.status).toBe(403);
      expect(connected.body?.code).toBe("repository_permission_insufficient");
      expect(connected.body?.ingestionToken).toBeUndefined();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("allows a verified administrator to connect and to rotate", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(201);
    expect(typeof connected.body?.ingestionToken).toBe("string");

    const rotated = await connect(baseUrl, "admin-1");
    expect(rotated.status).toBe(201);
    expect(rotated.body?.ingestionToken).not.toBe(connected.body?.ingestionToken);
  });

  it("records what was verified, so the connection can be accounted for later", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.body?.integration).toMatchObject({
      verifiedGithubUserId: "9002",
      verifiedGithubLogin: "octo-admin",
      verifiedPermission: "admin",
    });
    expect(typeof connected.body?.integration?.verifiedAt).toBe("string");
  });

  it("refuses when the login resolves to a different account than the linked one", async () => {
    // The same discipline the decision gate uses: a login can be given away,
    // a numeric id cannot.
    github.resolvedId = 99999;
    github.resolvedLogin = "someone-else";
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(403);
    expect(connected.body?.code).toBe("identity_mismatch");
    expect(connected.body?.ingestionToken).toBeUndefined();
  });

  it("requires a linked GitHub identity before it can ask anything", async () => {
    identity.linked = { githubUserId: null, githubLogin: null };
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "unlinked-1");
    expect(connected.status).toBe(403);
    expect(connected.body?.code).toBe("identity_required");
    expect(connected.body?.ingestionToken).toBeUndefined();
  });

  it("fails closed when the App is not installed on the repository", async () => {
    github.installed = false;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(409);
    expect(connected.body?.code).toBe("app_not_installed");
    expect(connected.body?.ingestionToken).toBeUndefined();
  });

  it("fails closed when the App is not configured at all", async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(503);
    expect(connected.body?.code).toBe("app_not_configured");
    expect(connected.body?.ingestionToken).toBeUndefined();
  });

  it("calls a rate-limited refusal unavailable rather than insufficient", async () => {
    // Telling an administrator they lack permission when GitHub is rate
    // limiting sends them to fix something that is not broken.
    github.permissionStatus = 403;
    github.permissionHeaders = { "x-ratelimit-remaining": "0" };
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(503);
    expect(connected.body?.code).toBe("repository_verification_unavailable");
    expect(connected.body?.ingestionToken).toBeUndefined();
  });

  it("treats a 404 from the permission lookup as no standing", async () => {
    github.permissionStatus = 404;
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(403);
    expect(connected.body?.code).toBe("repository_permission_insufficient");
  });

  it("leaks no raw GitHub response in any refusal", async () => {
    github.permissionStatus = 403;
    github.permissionHeaders = { "retry-after": "60" };
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    const serialized = JSON.stringify(connected.body);
    expect(serialized).not.toContain("ghs_");
    expect(serialized).not.toContain("api.github.com");
  });

  it("leaves an authorized credential working exactly as before", async () => {
    // The fix is at issuance. Ingestion by an already-authorized credential is
    // untouched, including the check it publishes.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(201);

    const ingested = await ingest(baseUrl, connected.body.ingestionToken);
    expect(ingested.status).toBe(201);
    expect(github.checkWrites.length).toBeGreaterThan(0);
  });
});

describe("a credential issued before verification is no longer honoured", () => {
  beforeEach(() => {
    resetMemoryReviewIntegrationsForTests();
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    github.installed = true;
    github.permission = "admin";
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    github.permissionStatus = 200;
    github.permissionHeaders = undefined;
    github.checkWrites = [];
    github.collaboratorLookups = 0;
    github.collaboratorDelayMs = 0;
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
    installGitHubStub();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  /**
   * A row exactly as the vulnerable build wrote it: a real, unrevoked
   * credential with no proof of anything behind it.
   */
  async function legacyCredential(): Promise<string> {
    const issued = await createOrRotateReviewIntegration({
      ownerId: "legacy-owner",
      provider: "github",
      repository: VICTIM,
      verified: {
        githubUserId: "9002",
        githubLogin: "octo-admin",
        permission: "admin",
        verifiedAt: new Date().toISOString(),
      },
    });
    // Strip the proof, which is the state every row carried before the
    // authority check existed.
    stripVerificationForTests(issued.integration.id);
    return issued.ingestionToken;
  }

  it("refuses the credential and publishes no check", async () => {
    // Guarding only new issuance would leave every credential handed out
    // during the vulnerable window still able to drive the App.
    const baseUrl = await startApp();
    const token = await legacyCredential();

    const ingested = await ingest(baseUrl, token);

    expect(ingested.status).toBe(403);
    expect(ingested.body?.code).toBe("integration_unverified");
    expect(github.checkWrites).toEqual([]);
  });

  it("says that reconnecting is what fixes it", async () => {
    // The holder already has the token, so naming the remedy discloses
    // nothing and an opaque 401 would strand a legitimate user.
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl, await legacyCredential());
    expect(String(ingested.body?.error)).toContain("Reconnect the repository");
  });

  it("recovers when a verified administrator reconnects, and the old token stays dead", async () => {
    const baseUrl = await startApp();
    const legacyToken = await legacyCredential();
    expect((await ingest(baseUrl, legacyToken)).status).toBe(403);

    // The same owner reconnects, proving admin this time.
    const reconnected = await connect(baseUrl, "legacy-owner");
    expect(reconnected.status).toBe(201);

    expect((await ingest(baseUrl, legacyToken)).status).toBe(401);
    const accepted = await ingest(baseUrl, reconnected.body.ingestionToken);
    expect(accepted.status).toBe(201);
    expect(github.checkWrites.length).toBeGreaterThan(0);
  });
});

describe("authority is established again before it goes stale", () => {
  beforeEach(() => {
    resetMemoryReviewIntegrationsForTests();
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    github.installed = true;
    github.permission = "admin";
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    github.permissionStatus = 200;
    github.permissionHeaders = undefined;
    github.checkWrites = [];
    github.collaboratorLookups = 0;
    github.collaboratorDelayMs = 0;
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
    installGitHubStub();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  /** A verified connection whose proof is older than the interval. */
  async function staleConnection(baseUrl: string): Promise<string> {
    const connected = await connect(baseUrl, "admin-1");
    ageVerificationForTests(
      connected.body.integration.id,
      new Date(Date.now() - AUTHORITY_REVALIDATION_INTERVAL_MS - 1).toISOString()
    );
    return connected.body.ingestionToken;
  }

  it("keeps accepting a credential whose owner still administers the repository", async () => {
    const baseUrl = await startApp();
    const token = await staleConnection(baseUrl);
    const ingested = await ingest(baseUrl, token);
    expect(ingested.status).toBe(201);
    expect(github.checkWrites.length).toBeGreaterThan(0);
  });

  it("refuses once the owner has lost admin, and publishes nothing", async () => {
    // The window this closes: a credential outliving the access that
    // justified it.
    const baseUrl = await startApp();
    const token = await staleConnection(baseUrl);
    github.permission = "write";

    const ingested = await ingest(baseUrl, token);

    expect(ingested.status).toBe(403);
    expect(ingested.body?.code).toBe("repository_permission_insufficient");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses rather than publishing when GitHub cannot answer", async () => {
    // Fail closed. GitHub being unreachable does not make authority
    // established.
    const baseUrl = await startApp();
    const token = await staleConnection(baseUrl);
    github.permissionStatus = 403;
    github.permissionHeaders = { "x-ratelimit-remaining": "0" };

    const ingested = await ingest(baseUrl, token);

    expect(ingested.status).toBe(503);
    expect(ingested.body?.code).toBe("repository_verification_unavailable");
    expect(github.checkWrites).toEqual([]);
  });

  it("does not ask GitHub again while the proof is still current", async () => {
    // The interval is what keeps this off the hot path of every push.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    const before = github.collaboratorLookups;
    await ingest(baseUrl, connected.body.ingestionToken);
    expect(github.collaboratorLookups).toBe(before);
  });
});

describe("a burst of stale deliveries asks GitHub once", () => {
  beforeEach(() => {
    resetMemoryReviewIntegrationsForTests();
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    github.installed = true;
    github.permission = "admin";
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    github.permissionStatus = 200;
    github.permissionHeaders = undefined;
    github.checkWrites = [];
    github.collaboratorLookups = 0;
    github.collaboratorDelayMs = 0;
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
    installGitHubStub();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function staleConnection(baseUrl: string): Promise<string> {
    const connected = await connect(baseUrl, "admin-1");
    ageVerificationForTests(
      connected.body.integration.id,
      new Date(Date.now() - AUTHORITY_REVALIDATION_INTERVAL_MS - 1).toISOString()
    );
    return connected.body.ingestionToken;
  }

  it("shares one collaborator lookup across twenty concurrent deliveries", async () => {
    // Duplicate and concurrent deliveries are ordinary: a push, a retry and a
    // re-run arrive together. Without sharing, each finds the same stale proof
    // and asks GitHub separately, which is how a rate limit is reached.
    const baseUrl = await startApp();
    const token = await staleConnection(baseUrl);
    // Held long enough that all twenty are inside the middleware together.
    github.collaboratorDelayMs = 50;
    const before = github.collaboratorLookups;

    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => ingest(baseUrl, token))
    );

    expect(github.collaboratorLookups - before).toBe(1);
    // Every one of them is answered on that single lookup, not refused.
    expect(deliveries.filter((delivery) => delivery.status < 400).length).toBe(20);
  });

  it("does not retry a failed revalidation on every delivery", async () => {
    // A refusal leaves the proof stale, so without a backoff the next delivery
    // asks again, and a repository whose owner lost access generates a request
    // per push forever.
    const baseUrl = await startApp();
    const token = await staleConnection(baseUrl);
    github.permission = "write";

    const first = await ingest(baseUrl, token);
    expect(first.status).toBe(403);
    const afterFirst = github.collaboratorLookups;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const repeated = await ingest(baseUrl, token);
      expect(repeated.status).toBeGreaterThanOrEqual(400);
      expect(github.checkWrites).toEqual([]);
    }
    expect(github.collaboratorLookups).toBe(afterFirst);
  });

  it("holds the backoff for a bounded time rather than indefinitely", () => {
    // Stated, so restoring access is known to take effect rather than
    // requiring a restart.
    expect(AUTHORITY_FAILURE_BACKOFF_MS).toBeGreaterThan(0);
    expect(AUTHORITY_FAILURE_BACKOFF_MS).toBeLessThan(AUTHORITY_REVALIDATION_INTERVAL_MS);
  });

  it("refuses to write an answer about a credential that was rotated meanwhile", async () => {
    // The row this would write to is no longer the row the answer was about.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    const id = connected.body.integration.id;
    ageVerificationForTests(
      id,
      new Date(Date.now() - AUTHORITY_REVALIDATION_INTERVAL_MS - 1).toISOString()
    );

    // The rotation lands while the lookup is in flight.
    let released: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const base = globalThis.fetch;
    let held = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      // Only the delivery in flight waits. The rotation has to get through,
      // because it is the thing that has to land while the delivery is held.
      if (!held && String(input).includes("/collaborators/")) {
        held = true;
        await gate;
      }
      return base(input, init);
    }) as typeof fetch;

    const delivery = ingest(baseUrl, connected.body.ingestionToken);
    await connect(baseUrl, "admin-1");
    released!();

    const answered = await delivery;
    expect(answered.status).toBe(409);
    expect(answered.body?.code).toBe("integration_changed");
    expect(github.checkWrites).toEqual([]);
  });
});

describe("what counts as verified is the level, not the presence of a value", () => {
  beforeEach(() => {
    resetMemoryReviewIntegrationsForTests();
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    github.installed = true;
    github.permission = "admin";
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    github.permissionStatus = 200;
    github.permissionHeaders = undefined;
    github.checkWrites = [];
    github.collaboratorLookups = 0;
    github.collaboratorDelayMs = 0;
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
    installGitHubStub();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("refuses a stored permission below admin", async () => {
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    downgradeVerificationForTests(connected.body.integration.id, "write");

    const ingested = await ingest(baseUrl, connected.body.ingestionToken);

    expect(ingested.status).toBe(403);
    expect(ingested.body?.code).toBe("integration_unverified");
    expect(github.checkWrites).toEqual([]);
  });

  it("refuses a stored timestamp that is not a time", async () => {
    // Read as infinitely old, an unparseable timestamp would mean revalidate
    // rather than refuse — which is the wrong answer for a record that cannot
    // be read at all.
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    ageVerificationForTests(connected.body.integration.id, "whenever");

    const ingested = await ingest(baseUrl, connected.body.ingestionToken);

    expect(ingested.status).toBe(403);
    expect(ingested.body?.code).toBe("integration_unverified");
  });
});

describe("an installation that cannot write checks is not connected", () => {
  beforeEach(() => {
    resetMemoryReviewIntegrationsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    identity.linked = { githubUserId: "9002", githubLogin: "octo-admin" };
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("refuses rather than issuing a credential that could never publish", async () => {
    // Connecting successfully and then never publishing looks like the analysis
    // failing, not like the App being under-permitted.
    github.checksPermission = "read";
    installGitHubStub();
    const baseUrl = await startApp();
    const connected = await connect(baseUrl, "admin-1");
    expect(connected.status).toBe(409);
    expect(connected.body?.code).toBe("app_checks_permission_missing");
    expect(connected.body?.ingestionToken).toBeUndefined();
    github.checksPermission = "write";
  });
});
