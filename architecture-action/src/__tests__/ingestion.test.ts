import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createActionReview } from "../review.js";
import {
  createIngestionPayload,
  ingestionAudience,
  parsePullRequestContext,
  planIngestion,
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

  describe("deciding whether a run delivers, and with what", () => {
    const plan = (overrides: Partial<Parameters<typeof planIngestion>[0]> = {}) =>
      planIngestion({
        endpoint: ENDPOINT,
        token: "",
        isFork: false,
        identityTokenAvailable: false,
        actor: "octo-admin",
        ...overrides,
      });

    it("keeps the review local when nothing is configured", () => {
      expect(plan({ endpoint: "" })).toEqual({ action: "none" });
      // Having an identity token to hand is not a reason to send anything.
      expect(plan({ endpoint: "  ", identityTokenAvailable: true })).toEqual({ action: "none" });
    });

    it("refuses a token with nowhere to send it", () => {
      expect(() => plan({ endpoint: "", token: TOKEN })).toThrow(
        "ingestion-token is set but ingestion-url is not"
      );
    });

    it("uses the stored token whenever one is configured", () => {
      expect(plan({ token: TOKEN })).toEqual({ action: "upload", credential: "token" });
      // Never both, and never the identity token in its place.
      expect(plan({ token: TOKEN, identityTokenAvailable: true })).toEqual({
        action: "upload",
        credential: "token",
      });
    });

    it("uses the run's identity token when only the endpoint is configured", () => {
      expect(plan({ identityTokenAvailable: true })).toEqual({
        action: "upload",
        credential: "identity",
      });
    });

    it("skips every fork, whichever credential the run could have used", () => {
      for (const overrides of [
        { token: TOKEN },
        { identityTokenAvailable: true },
        { token: TOKEN, identityTokenAvailable: true },
        {},
      ]) {
        expect(plan({ ...overrides, isFork: true })).toMatchObject({ action: "skip" });
      }
    });

    it("says what to add when the job cannot request an identity token", () => {
      expect(() => plan()).toThrow("id-token: write");
      // The other way to arrive here: a secret that reached the Action empty.
      expect(() => plan()).toThrow("ingestion-token reached the Action empty");
    });

    it("skips a Dependabot run that was given no credential of either kind, and only that", () => {
      // The usual way to arrive here is a workflow that passes a stored token:
      // GitHub withholds the secret from Dependabot, so only the endpoint
      // comes through. The reason has to be true of that case as well.
      const skipped = plan({ actor: "dependabot[bot]" });
      expect(skipped).toMatchObject({ action: "skip" });
      expect(skipped).toHaveProperty(
        "reason",
        expect.stringContaining("neither an ingestion token nor an identity token")
      );
      // With either credential to use it delivers like any other run.
      expect(plan({ actor: "dependabot[bot]", identityTokenAvailable: true })).toEqual({
        action: "upload",
        credential: "identity",
      });
      expect(plan({ actor: "dependabot[bot]", token: TOKEN })).toEqual({
        action: "upload",
        credential: "token",
      });
      // A name that merely resembles it is an ordinary misconfigured run.
      expect(() => plan({ actor: "dependabot" })).toThrow("id-token: write");
    });
  });

  it("requests an identity token for the origin it will be sent to, and nothing looser", () => {
    expect(ingestionAudience(ENDPOINT)).toBe("https://system-synthesis.example");
    expect(ingestionAudience("https://Reviews.Example.test:8443/api/review-ingestions/github/")).toBe(
      "https://reviews.example.test:8443"
    );
    // Not for an address a delivery would then be refused to.
    expect(() => ingestionAudience("http://attacker.example/api/review-ingestions/github")).toThrow(
      "must be HTTPS"
    );
    expect(() => ingestionAudience("https://system-synthesis.example/")).toThrow(
      "must end exactly with"
    );
    expect(() =>
      ingestionAudience("https://user:secret@system-synthesis.example/api/review-ingestions/github")
    ).toThrow("contain no credentials");
  });

  it("sends an identity token as the credential when that is what the run has", async () => {
    const identity = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${identity}` });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        workflowRun: { id: "987654" },
        pullRequest: { number: 42 },
      });
      return successResponse();
    });

    await expect(uploadArchitectureReview({
      endpoint: ENDPOINT,
      token: identity,
      credential: "identity",
      payload: payload(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "created" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds each kind of credential to its own shape before sending anything", async () => {
    const fetchMock = vi.fn(async () => successResponse());
    const send = (token: string, credential?: "token" | "identity") =>
      uploadArchitectureReview({
        endpoint: ENDPOINT,
        token,
        credential,
        payload: payload(),
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

    // An identity token is not sent where a stored token was expected.
    await expect(send("aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl")).rejects.toThrow("ingestion-token is malformed");
    await expect(send("aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl", "token")).rejects.toThrow("ingestion-token is malformed");
    // Nor a stored token where the run's identity was expected.
    for (const unusable of [
      TOKEN,
      "",
      "only.two",
      "aGVhZGVy.cGF5bG9hZA.",
      "aGVhZGVy.cGF5bG9hZA.c2ln bmF0dXJl",
      `${"a".repeat(8200)}.b.c`,
    ]) {
      await expect(send(unusable, "identity")).rejects.toThrow("usable identity token");
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("accepts the documented IPv6 loopback HTTP endpoint", async () => {
    const fetchMock = vi.fn(async () => successResponse());
    await expect(uploadArchitectureReview({
      endpoint: "http://[::1]:4000/api/review-ingestions/github",
      token: TOKEN, payload: payload(), fetchImpl: fetchMock,
    })).resolves.toMatchObject({ status: "created" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("does not forward the credential or private graph through an ingestion redirect", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url || "");
      request.resume();
      if (request.url === "/api/review-ingestions/github") {
        response.writeHead(307, { Location: "/unapproved-destination" });
        response.end();
      } else {
        response.writeHead(400);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      await expect(uploadArchitectureReview({
        endpoint: `http://127.0.0.1:${address.port}/api/review-ingestions/github`,
        token: TOKEN, payload: payload(), attempts: 1,
      })).rejects.toThrow("HTTP 307");
      expect(requests).toEqual(["/api/review-ingestions/github"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
