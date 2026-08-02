import { describe, expect, it, vi } from "vitest";
import { createActionReview } from "../review.js";
import {
  createIngestionPayload,
  ingestionMode,
  parsePullRequestContext,
  uploadArchitectureReview,
} from "../ingestion.js";

const REPOSITORY = "acme/shop";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TOKEN = `ssri_${"x".repeat(43)}`;
const ENDPOINT = "https://system-synthesis.example/api/review-ingestions/github";
const baseSource = `services:
  api:
    image: api:1.0.0
`;
const headSource = `services:
  api:
    image: api:1.0.0
  cache:
    image: redis:7
`;

function event(headRepository = REPOSITORY) {
  return {
    repository: { full_name: REPOSITORY },
    pull_request: {
      number: 42,
      title: "Add a cache",
      html_url: `https://github.com/${REPOSITORY}/pull/42`,
      updated_at: "2026-08-02T10:15:30.000Z",
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { full_name: headRepository } },
    },
  };
}

function context(headRepository = REPOSITORY) {
  return parsePullRequestContext(event(headRepository), {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "987654",
  });
}

function payload() {
  const reports = createActionReview({
    baseContent: baseSource,
    headContent: headSource,
    sourcePath: "compose.yaml",
    repository: REPOSITORY,
    baseRevision: BASE_SHA,
    headRevision: HEAD_SHA,
    reviewedAt: new Date("2026-08-02T10:16:00.000Z"),
  });
  return createIngestionPayload({
    context: context(),
    sourcePath: "compose.yaml",
    baseGraph: reports.baseGraph,
    headGraph: reports.headGraph,
    policy: reports.policy,
  });
}

function successResponse(status = 201): Response {
  return new Response(JSON.stringify({
    status: "created",
    reviewId: "9f52ab9d-6897-4c57-b814-f0b89fd15886",
    reviewUrl: "https://system-synthesis.example/reviews/9f52ab9d-6897-4c57-b814-f0b89fd15886",
    revision: 1,
    analysisStatus: "pass",
    blockingFindings: 0,
    headRevision: HEAD_SHA,
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub Action browser-review ingestion", () => {
  it("derives bounded pull-request metadata from the trusted event", () => {
    expect(context()).toEqual({
      repository: REPOSITORY,
      pullRequestNumber: 42,
      pullRequestUrl: `https://github.com/${REPOSITORY}/pull/42`,
      pullRequestTitle: "Add a cache",
      changeVersion: Date.parse("2026-08-02T10:15:30.000Z"),
      baseRevision: BASE_SHA,
      headRevision: HEAD_SHA,
      isFork: false,
      workflowRunId: "987654",
      workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/987654`,
    });
    expect(context("contributor/shop").isFork).toBe(true);
  });

  it("rejects mismatched event identity and analyzed revisions", () => {
    expect(() => parsePullRequestContext(event(), {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "attacker/project",
    })).toThrow("does not match GITHUB_REPOSITORY");

    const reports = createActionReview({
      baseContent: baseSource,
      headContent: headSource,
      sourcePath: "compose.yaml",
      repository: REPOSITORY,
      baseRevision: BASE_SHA,
      headRevision: "c".repeat(40),
      reviewedAt: new Date(),
    });
    expect(() => createIngestionPayload({
      context: context(),
      sourcePath: "compose.yaml",
      baseGraph: reports.baseGraph,
      headGraph: reports.headGraph,
      policy: reports.policy,
    })).toThrow("Analyzed revisions do not match");
  });

  it("requires complete configuration and skips all fork uploads", () => {
    expect(ingestionMode("", "", false)).toBe("skip");
    expect(ingestionMode(ENDPOINT, TOKEN, false)).toBe("upload");
    expect(ingestionMode(ENDPOINT, TOKEN, true)).toBe("skip");
    expect(() => ingestionMode(ENDPOINT, "", false)).toThrow(
      "must either both be configured or both be omitted"
    );
  });

  it("uploads only the canonical payload with the repository credential", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        repository: REPOSITORY,
        baseRevision: BASE_SHA,
        headRevision: HEAD_SHA,
        pullRequest: { number: 42 },
      });
      expect(body).not.toHaveProperty("baseContent");
      expect(body).not.toHaveProperty("headContent");
      expect(body).not.toHaveProperty("report");
      return successResponse();
    });

    await expect(uploadArchitectureReview({
      endpoint: ENDPOINT,
      token: TOKEN,
      payload: payload(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
    })).resolves.toMatchObject({
      status: "created",
      reviewId: "9f52ab9d-6897-4c57-b814-f0b89fd15886",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with the exact same idempotent payload", async () => {
    const bodies: string[] = [];
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 })
        : successResponse(200);
    });

    await expect(uploadArchitectureReview({
      endpoint: ENDPOINT,
      token: TOKEN,
      payload: payload(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep,
    })).resolves.toMatchObject({ status: "created" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("fails closed without retrying credential or endpoint errors", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid credential" }), { status: 401 }));

    await expect(uploadArchitectureReview({
      endpoint: ENDPOINT,
      token: TOKEN,
      payload: payload(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
    })).rejects.toThrow("HTTP 401: invalid credential");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(uploadArchitectureReview({
      endpoint: "http://attacker.example/api/review-ingestions/github",
      token: TOKEN,
      payload: payload(),
    })).rejects.toThrow("must be HTTPS");
  });

  it("rejects a mismatched current response but accepts an explicitly stale delivery", async () => {
    const newerHead = "e".repeat(40);
    const response = (status: "created" | "stale") => new Response(JSON.stringify({
      status,
      reviewId: "9f52ab9d-6897-4c57-b814-f0b89fd15886",
      reviewUrl: "https://system-synthesis.example/reviews/9f52ab9d-6897-4c57-b814-f0b89fd15886",
      revision: 3,
      analysisStatus: "pass",
      blockingFindings: 0,
      headRevision: newerHead,
    }), { status: status === "stale" ? 202 : 201 });

    await expect(uploadArchitectureReview({
      endpoint: ENDPOINT,
      token: TOKEN,
      payload: payload(),
      fetchImpl: vi.fn(async () => response("created")) as unknown as typeof fetch,
    })).rejects.toThrow("different head revision");
    await expect(uploadArchitectureReview({
      endpoint: ENDPOINT,
      token: TOKEN,
      payload: payload(),
      fetchImpl: vi.fn(async () => response("stale")) as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "stale", headRevision: newerHead });
  });
});
