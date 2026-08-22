import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Authority is proved at the route; storage tests state it directly. */
const VERIFIED_AUTHORITY = {
  githubUserId: "9002",
  githubLogin: "octo-admin",
  permission: "admin",
  // Current, so the credential is inside its revalidation window and these
  // tests stay about what they are about.
  verifiedAt: new Date().toISOString(),
};

vi.mock("../../services/db.js", () => ({ getPool: () => null }));

import { dockerComposeAdapter } from "@system-synthesis/architecture-core";
import reviewIngestionsRouter from "../reviewIngestions.js";
import {
  createOrRotateReviewIntegration,
  resetMemoryReviewIntegrationsForTests,
} from "../../services/reviewIntegrationRepository.js";
import {
  listArchitectureReviewEvents,
  listArchitectureReviews,
  resetMemoryReviewsForTests,
} from "../../services/reviewRepository.js";

const REPOSITORY = "acme/shop";
const SOURCE_PATH = "compose.yaml";
const BASE_SHA = "a".repeat(40);
const FIRST_HEAD_SHA = "b".repeat(40);
const SECOND_HEAD_SHA = "c".repeat(40);
const THIRD_HEAD_SHA = "d".repeat(40);
const baseSource = `services:
  api:
    image: api:1.0.0
    ports: ["8080:3000"]
  database:
    image: postgres:16
`;
const firstHeadSource = `services:
  api:
    image: api:1.0.0
    ports: ["8080:3000"]
    depends_on: [database]
  database:
    image: postgres:16
`;
const secondHeadSource = `services:
  api:
    image: api:2.0.0
    ports: ["8080:3000"]
    depends_on: [cache]
  database:
    image: postgres:16
  cache:
    image: redis:7
`;
const thirdHeadSource = `services:
  api:
    image: api:3.0.0
    ports: ["8080:3000"]
  database:
    image: postgres:16
`;

let server: Server | null = null;

function graph(content: string, revision: string, repository = REPOSITORY) {
  return dockerComposeAdapter.import(
    [{ path: SOURCE_PATH, content }],
    { repository, revision }
  ).graph;
}

function payload(input: {
  headSource?: string;
  headRevision?: string;
  changeVersion?: number;
  repository?: string;
} = {}) {
  const repository = input.repository || REPOSITORY;
  const headRevision = input.headRevision || FIRST_HEAD_SHA;
  return {
    repository,
    pullRequest: {
      number: 42,
      url: `https://github.com/${repository}/pull/42`,
      title: "Connect checkout API to persistence",
      changeVersion: input.changeVersion || 100,
    },
    sourcePath: SOURCE_PATH,
    baseRevision: BASE_SHA,
    headRevision,
    workflowRun: {
      id: String((input.changeVersion || 100) + 1000),
      url: `https://github.com/${repository}/actions/runs/${(input.changeVersion || 100) + 1000}`,
    },
    baseGraph: graph(baseSource, BASE_SHA, repository),
    headGraph: graph(
      input.headSource || firstHeadSource,
      headRevision,
      repository
    ),
    policy: {},
  };
}

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: "1mb", strict: true }));
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

async function issueToken(repository = REPOSITORY): Promise<string> {
  return (await createOrRotateReviewIntegration({
    ownerId: "owner-1",
    provider: "github",
    repository,
    verified: VERIFIED_AUTHORITY,
  })).ingestionToken;
}

async function post(
  baseUrl: string,
  body: unknown,
  token?: string
): Promise<{ response: Response; json: any }> {
  const response = await fetch(`${baseUrl}/api/review-ingestions/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

describe("GitHub architecture review ingestion", () => {
  beforeEach(() => {
    resetMemoryReviewsForTests();
    resetMemoryReviewIntegrationsForTests();
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  });

  it("fails closed without a valid repository credential", async () => {
    const baseUrl = await startApp();
    const missing = await post(baseUrl, payload());
    expect(missing.response.status).toBe(401);

    const invalid = await post(baseUrl, payload(), "ssri_not-a-real-token-value-that-is-long-enough");
    expect(invalid.response.status).toBe(401);
  });

  it("still accepts a graph from an Action that predates structured port bindings", async () => {
    const baseUrl = await startApp();
    const token = await issueToken();
    const body = payload();
    // Reproduce what a pinned older importer sends: published ports as strings,
    // with no structured bindings at all. Rejecting this would break every
    // repository that pinned the Action, which is exactly what pinning prevents.
    for (const side of ["baseGraph", "headGraph"] as const) {
      for (const node of body[side].nodes) {
        const properties = node.data.sourceProperties as Record<string, unknown>;
        delete properties.publishedPortBindings;
      }
    }
    expect(
      JSON.stringify(body).includes("publishedPortBindings")
    ).toBe(false);

    const { response } = await post(baseUrl, body, token);
    expect(response.status).toBe(201);
  });

  it("rejects a repository identity not scoped to the credential", async () => {
    const baseUrl = await startApp();
    const token = await issueToken();
    const result = await post(
      baseUrl,
      payload({ repository: "other/project" }),
      token
    );

    expect(result.response.status).toBe(403);
    expect(result.json.error).toContain("does not match");
    await expect(listArchitectureReviews("owner-1")).resolves.toHaveLength(0);
  });

  it("creates one review, treats retries as idempotent, and refreshes a newer head", async () => {
    const baseUrl = await startApp();
    const token = await issueToken();
    const first = await post(baseUrl, payload(), token);
    expect(first.response.status).toBe(201);
    expect(first.json).toMatchObject({
      status: "created",
      revision: 1,
      analysisStatus: "fail",
      headRevision: FIRST_HEAD_SHA,
    });

    const retry = await post(baseUrl, payload(), token);
    expect(retry.response.status).toBe(200);
    expect(retry.json).toMatchObject({
      status: "unchanged",
      reviewId: first.json.reviewId,
      revision: 1,
    });

    const refreshed = await post(baseUrl, payload({
      headSource: secondHeadSource,
      headRevision: SECOND_HEAD_SHA,
      changeVersion: 200,
    }), token);
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.json).toMatchObject({
      status: "updated",
      reviewId: first.json.reviewId,
      revision: 2,
      headRevision: SECOND_HEAD_SHA,
    });
    const reviews = await listArchitectureReviews("owner-1");
    expect(reviews).toHaveLength(1);
    const events = await listArchitectureReviewEvents(first.json.reviewId, "owner-1");
    expect(events.map((event) => event.eventType)).toEqual([
      "review.created",
      "review.refreshed",
    ]);
  });

  it("refuses stale deliveries and same-version content conflicts", async () => {
    const baseUrl = await startApp();
    const token = await issueToken();
    const newest = await post(baseUrl, payload({
      headSource: secondHeadSource,
      headRevision: SECOND_HEAD_SHA,
      changeVersion: 200,
    }), token);
    expect(newest.response.status).toBe(201);

    const stale = await post(baseUrl, payload({ changeVersion: 100 }), token);
    expect(stale.response.status).toBe(202);
    expect(stale.json).toMatchObject({
      status: "stale",
      reviewId: newest.json.reviewId,
      revision: 1,
      headRevision: SECOND_HEAD_SHA,
    });

    const conflict = await post(baseUrl, payload({
      headSource: thirdHeadSource,
      headRevision: THIRD_HEAD_SHA,
      changeVersion: 200,
    }), token);
    expect(conflict.response.status).toBe(409);
    expect(conflict.json.status).toBe("conflict");
    expect(conflict.json.headRevision).toBe(SECOND_HEAD_SHA);
  });

  it("rejects malformed graph topology before analysis", async () => {
    const baseUrl = await startApp();
    const token = await issueToken();
    const invalid: any = payload();
    invalid.headGraph.edges[0].target = "missing-node";
    const result = await post(baseUrl, invalid, token);

    expect(result.response.status).toBe(400);
    expect(JSON.stringify(result.json.details)).toContain(
      "edge endpoints must reference nodes in the same graph"
    );
    await expect(listArchitectureReviews("owner-1")).resolves.toHaveLength(0);
  });

  it("rejects an oversized delivery before authentication or analysis", async () => {
    const baseUrl = await startApp();
    const token = await issueToken();
    const response = await fetch(`${baseUrl}/api/review-ingestions/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...payload(), padding: "x".repeat(1_100_000) }),
    });

    expect(response.status).toBe(413);
    await expect(listArchitectureReviews("owner-1")).resolves.toHaveLength(0);
  });
});
