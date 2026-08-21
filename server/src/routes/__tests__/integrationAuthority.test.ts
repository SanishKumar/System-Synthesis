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
            permissions: { checks: "write", metadata: "read", pull_requests: "read" },
          }
        : { status: "not_installed" },
  };
});

import { dockerComposeAdapter } from "@system-synthesis/architecture-core";
import reviewIntegrationsRouter from "../reviewIntegrations.js";
import reviewIngestionsRouter from "../reviewIngestions.js";
import { resetMemoryReviewIntegrationsForTests } from "../../services/reviewIntegrationRepository.js";
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

async function ingest(baseUrl: string, token: string) {
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
    github.installed = true;
    github.permission = "admin";
    github.resolvedId = 9002;
    github.resolvedLogin = "octo-admin";
    github.permissionStatus = 200;
    github.permissionHeaders = undefined;
    github.checkWrites = [];
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
