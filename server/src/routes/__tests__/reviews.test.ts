import express from "express";
import type { Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/db.js", () => ({ getPool: () => null }));

/**
 * Answers GitHub for the whole route, since the routes construct their own
 * publish calls and cannot be handed a transport. `writeStatus` decides what
 * the check-run write returns; `onWrite` runs while the attempt is in flight,
 * which is how a refresh landing mid-request is reproduced.
 */
const github = {
  writeStatus: 201,
  installed: true,
  calls: 0,
  onWrite: null as null | (() => Promise<void>),
};

vi.mock("../../services/githubApp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/githubApp.js")>();
  return {
    ...actual,
    getInstallationToken: async () =>
      github.installed
        ? { status: "ok", token: "ghs_test", expiresAt: "2999-01-01T00:00:00Z" }
        : { status: "not_installed" },
  };
});

const originalFetch = globalThis.fetch;

import { signToken } from "../../middleware/auth.js";
import reviewsRouter from "../reviews.js";
import reviewIngestionsRouter from "../reviewIngestions.js";
import {
  createOrRotateReviewIntegration,
  resetMemoryReviewIntegrationsForTests,
} from "../../services/reviewIntegrationRepository.js";
import {
  getArchitectureReview,
  resetMemoryReviewsForTests,
} from "../../services/reviewRepository.js";
import { resetGitHubAppCacheForTests } from "../../services/githubApp.js";
import { dockerComposeAdapter } from "@system-synthesis/architecture-core";

const OWNER = { userId: "owner-1", userName: "owner", isGuest: false };
const OTHER = { userId: "owner-2", userName: "intruder", isGuest: false };
const REPOSITORY = "acme/shop";
const SOURCE_PATH = "compose.yaml";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NEXT_SHA = "c".repeat(40);
const BASE_SOURCE = `services:
  web:
    image: web:1
    ports: ["3000:3000"]
  db:
    image: postgres:16
`;
/** Head publishes the database to every interface: a blocking finding, so a
 *  decision is genuinely owed and the gate is `action_required`. */
const HEAD_SOURCE = `services:
  web:
    image: web:1
    ports: ["3000:3000"]
  db:
    image: postgres:16
    ports: ["0.0.0.0:5432:5432"]
`;

let server: Server | null = null;

function graph(content: string, revision: string) {
  return dockerComposeAdapter.import(
    [{ path: SOURCE_PATH, content }],
    { repository: REPOSITORY, revision }
  ).graph;
}

function ingestionPayload(headRevision = HEAD_SHA, changeVersion = 1_000) {
  return {
    repository: REPOSITORY,
    pullRequest: {
      number: 42,
      url: `https://github.com/${REPOSITORY}/pull/42`,
      title: "Publish the database port",
      changeVersion,
    },
    sourcePath: SOURCE_PATH,
    baseRevision: BASE_SHA,
    headRevision,
    baseGraph: graph(BASE_SOURCE, BASE_SHA),
    headGraph: graph(HEAD_SOURCE, headRevision),
    policy: {},
  };
}

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "4mb", strict: true }));
  // Mirrors index.ts: the router itself assumes an authenticated request.
  app.use("/api/reviews", (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Authentication required" });
    try {
      req.user = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  }, reviewsRouter);
  app.use("/api/review-ingestions", reviewIngestionsRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function ingest(baseUrl: string, headRevision = HEAD_SHA, changeVersion = 1_000) {
  const token = (await createOrRotateReviewIntegration({
    ownerId: OWNER.userId,
    provider: "github",
    repository: REPOSITORY,
  })).ingestionToken;
  const response = await fetch(`${baseUrl}/api/review-ingestions/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(ingestionPayload(headRevision, changeVersion)),
  });
  return response.json();
}

async function asOwner(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  user = OWNER
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signToken(user)}`,
      ...(init.headers || {}),
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe("architecture review routes and the decision gate", () => {
  beforeEach(() => {
    resetMemoryReviewsForTests();
    resetMemoryReviewIntegrationsForTests();
    resetGitHubAppCacheForTests();
    github.writeStatus = 201;
    github.installed = true;
    github.calls = 0;
    github.onWrite = null;
    process.env.GITHUB_APP_ID = "1234";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("api.github.com")) return originalFetch(input, init);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/check-runs?check_name=")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (method === "POST" || method === "PATCH") {
        github.calls += 1;
        if (github.onWrite) await github.onWrite();
        return new Response(JSON.stringify({ id: 99 }), { status: github.writeStatus });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  it("records the publication made when a review is first ingested", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);

    expect(github.calls).toBe(1);
    // The gate exists on the pull request, so the review must not claim it has
    // never reached one. It stayed pending forever when ingestion wrote the
    // check without recording the outcome.
    const stored = await getArchitectureReview(ingested.reviewId, OWNER.userId);
    expect(stored?.githubSync).toMatchObject({
      status: "synced",
      conclusion: "action_required",
      headRevision: HEAD_SHA,
    });
  });

  it("records a refused publication at ingestion rather than dropping it", async () => {
    github.writeStatus = 500;
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);

    const stored = await getArchitectureReview(ingested.reviewId, OWNER.userId);
    expect(stored?.githubSync).toMatchObject({ status: "failed" });
    expect(stored?.githubSync.reason).toContain("500");
  });

  it("records a skip at ingestion when the App is not installed", async () => {
    github.installed = false;
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);

    const stored = await getArchitectureReview(ingested.reviewId, OWNER.userId);
    expect(stored?.githubSync).toMatchObject({
      status: "skipped",
      reason: "not_installed",
      headRevision: HEAD_SHA,
    });
  });

  it("answers a decision with the state that reached GitHub, not the pre-publish one", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);
    const before = await getArchitectureReview(ingested.reviewId, OWNER.userId);

    const decided = await asOwner(baseUrl, `/api/reviews/${ingested.reviewId}/decision`, {
      method: "PATCH",
      body: JSON.stringify({
        decision: "rejected",
        note: "Publishing the database to every interface is not acceptable.",
        expectedRevision: before!.revision,
      }),
    });

    expect(decided.status).toBe(200);
    expect(decided.body.decision).toBe("rejected");
    // The browser applies this response and then stops polling, because the
    // decision is no longer pending. A `pending` sync here would sit on screen
    // until the reader refreshed, describing a gate that had already landed.
    expect(decided.body.githubSync).toMatchObject({
      status: "synced",
      conclusion: "failure",
    });
  });

  it("answers a recompute with the state that reached GitHub", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);
    const before = await getArchitectureReview(ingested.reviewId, OWNER.userId);

    const recomputed = await asOwner(baseUrl, `/api/reviews/${ingested.reviewId}/recompute`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: before!.revision }),
    });

    expect(recomputed.status).toBe(200);
    expect(recomputed.body.githubSync).toMatchObject({ status: "synced" });
  });

  it("answers a retry with the review as it stands, not the one it started from", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);
    github.writeStatus = 500;
    await asOwner(baseUrl, `/api/reviews/${ingested.reviewId}/github-sync/retry`, { method: "POST" });

    // The Action refreshes the pull request while the retry is in flight.
    github.writeStatus = 201;
    github.onWrite = async () => {
      github.onWrite = null;
      await ingest(baseUrl, NEXT_SHA, 2_000);
    };

    const retried = await asOwner(baseUrl, `/api/reviews/${ingested.reviewId}/github-sync/retry`, {
      method: "POST",
    });

    expect(retried.status).toBe(200);
    // Returning the review resolved at the start of the request would walk the
    // reader's page back onto a commit that is no longer under review.
    expect(retried.body.headRevision).toBe(NEXT_SHA);
    expect(retried.body.githubSync.headRevision).toBe(NEXT_SHA);
  });

  it("refuses an unauthenticated retry", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);
    const response = await fetch(
      `${baseUrl}/api/reviews/${ingested.reviewId}/github-sync/retry`,
      { method: "POST" }
    );
    expect(response.status).toBe(401);
  });

  it("does not let another owner retry, or learn the review exists", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);
    const response = await asOwner(
      baseUrl,
      `/api/reviews/${ingested.reviewId}/github-sync/retry`,
      { method: "POST" },
      OTHER
    );
    expect(response.status).toBe(404);
    expect(github.calls).toBe(1); // only the ingestion publish
  });

  it("rate limits retries", async () => {
    const baseUrl = await startApp();
    const ingested = await ingest(baseUrl);
    const path = `/api/reviews/${ingested.reviewId}/github-sync/retry`;

    let limited = 0;
    // The limiter allows 20 review mutations per hour per user.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await asOwner(baseUrl, path, { method: "POST" });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
