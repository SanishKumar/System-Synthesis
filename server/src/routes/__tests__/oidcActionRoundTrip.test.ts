import express from "express";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/db.js", () => ({ getPool: () => null }));

vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth.js")>();
  return {
    ...actual,
    linkedGitHubIdentity: async () => ({ githubUserId: "9002", githubLogin: "octo-admin" }),
  };
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

import reviewIntegrationsRouter from "../reviewIntegrations.js";
import reviewIngestionsRouter from "../reviewIngestions.js";
import { resetMemoryReviewIntegrationsForTests } from "../../services/reviewIntegrationRepository.js";
import { resetAuthorityRevalidationForTests } from "../../middleware/reviewIntegrationAuth.js";
import {
  getArchitectureReview,
  resetMemoryReviewsForTests,
} from "../../services/reviewRepository.js";
import { ownerScope } from "../../services/reviewAccess.js";
import { resetGitHubAppCacheForTests } from "../../services/githubApp.js";
import { GITHUB_OIDC_ISSUER, resetGitHubOidcKeysForTests } from "../../services/githubOidc.js";

/**
 * The shipped Action, delivering to these routes, with nothing in between.
 *
 * Each side has its own tests, and each of those builds the other side by
 * hand: the Action's against a server that accepts anything, the server's
 * against a delivery written to match. Two halves that agree with their own
 * idea of a contract are not thereby shown to agree with each other. Here the
 * built bundle runs as a workflow step would, asks a stand-in for GitHub's
 * token endpoint for its identity, and the real routes decide what to do with
 * what it sends.
 *
 * What stays outside this is GitHub itself: the token is signed by a key made
 * here, with the claims GitHub documents.
 */
const REPOSITORY = "acme/roundtrip";
const REPOSITORY_ID = 5001;
const PULL_REQUEST = 12;
const RUN_ID = "777001";
const BUNDLE = fileURLToPath(
  new URL("../../../../architecture-action/dist/index.js", import.meta.url)
);

const BASE_SOURCE = "services:\n  api:\n    image: api:1.0.0\n";
const HEAD_SOURCE = `${BASE_SOURCE}  cache:\n    image: redis:7\n`;

const githubKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

let directory = "";
let consumer = "";
let base = "";
let head = "";
let api: Server | null = null;
let tokenEndpoint: Server | null = null;
const originalFetch = globalThis.fetch;

/** What the stand-in token endpoint was asked, and what it should claim. */
const github = {
  tokenRequests: [] as Array<{ audience: string | null; authorization: string | undefined }>,
  /** Replaces claims in the token it issues; `aud` defaults to what was asked for. */
  claims: {} as Record<string, unknown>,
  checkWrites: [] as string[],
};

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "core.autocrlf=false",
      "-c", "commit.gpgSign=false",
      "-c", `core.hooksPath=${join(directory, "no-hooks")}`,
      ...args,
    ],
    {
      cwd: consumer,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Round Trip",
        GIT_AUTHOR_EMAIL: "roundtrip@example.invalid",
        GIT_COMMITTER_NAME: "Round Trip",
        GIT_COMMITTER_EMAIL: "roundtrip@example.invalid",
      },
    }
  ).trim();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Missing address"));
      else resolvePort(address.port);
    });
  });
}

function close(server: Server | null): Promise<void> {
  return new Promise((done) => (server ? server.close(() => done()) : done()));
}

/** GitHub's side of this server's own lookups: keys, authority, checks. */
function installGitHubStub(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return originalFetch(input, init);
    if (url === `${GITHUB_OIDC_ISSUER}/.well-known/jwks`) {
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
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/collaborators/")) {
      return new Response(
        JSON.stringify({ permission: "admin", user: { id: 9002, login: "octo-admin" } }),
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
      return new Response(JSON.stringify({ id: REPOSITORY_ID, full_name: "Acme/RoundTrip" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
}

function parseOutputs(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
    if (!match) continue;
    const value: string[] = [];
    while (++index < lines.length && lines[index] !== match[2]) value.push(lines[index]);
    values[match[1]] = value.join("\n");
  }
  return values;
}

/** Runs the built Action as a pull_request workflow step would. */
async function runAction(
  ingestionUrl: string,
  tokenUrl: string
): Promise<{ code: number | null; log: string; outputs: Record<string, string> }> {
  const runDirectory = mkdtempSync(join(directory, "run-"));
  const output = join(runDirectory, "outputs");
  const summary = join(runDirectory, "summary");
  const eventPath = join(runDirectory, "event.json");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  writeFileSync(
    eventPath,
    JSON.stringify({
      repository: { full_name: "Acme/RoundTrip" },
      pull_request: {
        number: PULL_REQUEST,
        title: "Add the cache",
        html_url: `https://github.com/Acme/RoundTrip/pull/${PULL_REQUEST}`,
        updated_at: "2026-10-13T00:00:00Z",
        base: { sha: base },
        head: { sha: head, repo: { full_name: "Acme/RoundTrip" } },
      },
    })
  );
  // Nothing of whatever workflow this suite may itself be running in.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GITHUB_|INPUT_|ACTIONS_ID_TOKEN_REQUEST_|NODE_OPTIONS$|NODE_PATH$|VITEST)/i.test(key)
    )
  );
  const result = await new Promise<{ code: number | null; log: string }>((done, reject) => {
    const child = spawn(process.execPath, [BUNDLE], {
      cwd: consumer,
      env: {
        ...inherited,
        GITHUB_WORKSPACE: consumer,
        GITHUB_REPOSITORY: "Acme/RoundTrip",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_RUN_ID: RUN_ID,
        GITHUB_ACTOR: "octo-admin",
        ACTIONS_ID_TOKEN_REQUEST_URL: tokenUrl,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token",
        "INPUT_OUTPUT-DIRECTORY": `.system-synthesis/${basename(runDirectory)}`,
        "INPUT_POLICY-PATH": ".system-synthesis/policy.json",
        "INPUT_INGESTION-URL": ingestionUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let log = "";
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    child.on("error", reject);
    child.on("close", (code) => done({ code, log }));
  });
  return { ...result, outputs: parseOutputs(readFileSync(output, "utf8")) };
}

describe("the built Action delivering to this server with GitHub OIDC", () => {
  let baseUrl = "";
  let tokenUrl = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "system-synthesis-roundtrip-"));
    consumer = join(directory, "consumer");
    mkdirSync(consumer);
    git("init", "--quiet");
    writeFileSync(join(consumer, "compose.yaml"), BASE_SOURCE);
    git("add", ".");
    git("commit", "--quiet", "-m", "Base architecture");
    base = git("rev-parse", "HEAD");
    writeFileSync(join(consumer, "compose.yaml"), HEAD_SOURCE);
    git("add", ".");
    git("commit", "--quiet", "-m", "Add a cache");
    head = git("rev-parse", "HEAD");
  });

  afterAll(() => {
    if (!directory) return;
    const target = resolve(directory);
    // Only ever the directory this suite made.
    if (
      dirname(target) === resolve(tmpdir()) &&
      basename(target).startsWith("system-synthesis-roundtrip-")
    ) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    resetMemoryReviewIntegrationsForTests();
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
    resetAuthorityRevalidationForTests();
    resetGitHubOidcKeysForTests();
    github.tokenRequests = [];
    github.claims = {};
    github.checkWrites = [];
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY =
      "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----";
    installGitHubStub();

    const app = express();
    app.use(express.json({ limit: "1mb", strict: true }));
    app.use((req, _res, next) => {
      req.user = { userId: "admin-1", userName: "admin-1", isGuest: false };
      next();
    });
    app.use("/api/review-integrations", reviewIntegrationsRouter);
    app.use("/api/review-ingestions", reviewIngestionsRouter);
    api = createServer(app);
    baseUrl = `http://127.0.0.1:${await listen(api)}`;
    // The address a workflow would be pointed at, which is therefore the
    // audience this deployment requires.
    process.env.PUBLIC_API_URL = baseUrl;

    // Where a run asks for its identity. It answers as GitHub does: a token
    // for exactly the audience requested, about the run that asked.
    tokenEndpoint = createServer((request, response) => {
      const audience = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("audience");
      github.tokenRequests.push({ audience, authorization: request.headers.authorization });
      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        {
          iss: GITHUB_OIDC_ISSUER,
          aud: audience,
          sub: `repo:Acme/RoundTrip:pull_request`,
          iat: now - 5,
          nbf: now - 5,
          exp: now + 300,
          repository: "Acme/RoundTrip",
          repository_id: String(REPOSITORY_ID),
          repository_owner_id: "7001",
          event_name: "pull_request",
          ref: `refs/pull/${PULL_REQUEST}/merge`,
          run_id: RUN_ID,
          run_attempt: "1",
          actor_id: "88",
          ...github.claims,
        },
        githubKey.privateKey,
        { algorithm: "RS256", keyid: "key-1" }
      );
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ value: token }));
    });
    tokenUrl = `http://127.0.0.1:${await listen(tokenEndpoint)}/token?api-version=2.0`;

    const connected = await fetch(`${baseUrl}/api/review-integrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: REPOSITORY, authentication: "oidc" }),
    });
    expect(connected.status).toBe(201);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.PUBLIC_API_URL;
    await close(api);
    await close(tokenEndpoint);
    api = null;
    tokenEndpoint = null;
  });

  it("stores the review the Action sent, for the account that connected the repository", async () => {
    const result = await runAction(`${baseUrl}/api/review-ingestions/github`, tokenUrl);

    expect(result.code, result.log).toBe(0);
    expect(result.outputs["ingestion-status"]).toBe("created");
    // The Action asked for a token for the address it was pointed at, which is
    // the audience this server requires. Neither side was told the other's.
    expect(github.tokenRequests).toEqual([
      { audience: baseUrl, authorization: "Bearer runtime-request-token" },
    ]);

    const stored = await getArchitectureReview(result.outputs["review-id"], ownerScope("admin-1"));
    expect(stored).toMatchObject({
      repository: REPOSITORY,
      baseRevision: base,
      headRevision: head,
      sourcePath: "compose.yaml",
    });
    expect(stored?.externalSource).toMatchObject({
      changeNumber: PULL_REQUEST,
      workflowRunId: RUN_ID,
    });
    // The graph the server kept is the one the Action derived from the commit.
    expect(stored?.headGraph.nodes.map((node) => node.data.label).sort()).toEqual(["api", "cache"]);
    expect(github.checkWrites.length).toBeGreaterThan(0);
  }, 60_000);

  it("refuses the Action's delivery when its token is for another pull request", async () => {
    github.claims = { ref: `refs/pull/${PULL_REQUEST + 1}/merge` };

    const result = await runAction(`${baseUrl}/api/review-ingestions/github`, tokenUrl);

    expect(result.code, result.log).toBe(2);
    expect(result.outputs["ingestion-status"]).toBe("error");
    expect(result.log).toContain("HTTP 403");
    expect(result.log).toContain("different pull request");
    expect(github.checkWrites).toEqual([]);
  }, 60_000);

  it("refuses the Action's delivery when its token is from another run", async () => {
    github.claims = { run_id: "777002" };

    const result = await runAction(`${baseUrl}/api/review-ingestions/github`, tokenUrl);

    expect(result.code, result.log).toBe(2);
    expect(result.log).toContain("HTTP 403");
    expect(result.log).toContain("workflow run");
    expect(github.checkWrites).toEqual([]);
  }, 60_000);

  it("refuses a token GitHub issued for somewhere else", async () => {
    github.claims = { aud: "https://github.com/acme" };

    const result = await runAction(`${baseUrl}/api/review-ingestions/github`, tokenUrl);

    expect(result.code, result.log).toBe(2);
    expect(result.log).toContain("HTTP 401");
    expect(result.log).toContain("different audience");
    expect(github.checkWrites).toEqual([]);
  }, 60_000);

  it("refuses a repository whose id is not the one that was connected", async () => {
    github.claims = { repository_id: "6666" };

    const result = await runAction(`${baseUrl}/api/review-ingestions/github`, tokenUrl);

    expect(result.code, result.log).toBe(2);
    expect(result.log).toContain("HTTP 403");
    expect(result.log).toContain("different repository");
    expect(github.checkWrites).toEqual([]);
  }, 60_000);
});
