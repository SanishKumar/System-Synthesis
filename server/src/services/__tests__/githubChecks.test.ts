import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DECISION_CHECK_NAME, writeDecisionCheck } from "../githubChecks.js";
import { decisionCheckState, reviewDecisionSubject } from "../decisionState.js";
import { resetGitHubAppCacheForTests, type HttpTransport } from "../githubApp.js";
import type { ArchitectureReviewRecord } from "../reviewRepository.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const env = { GITHUB_APP_ID: "1234", GITHUB_APP_PRIVATE_KEY: privateKey };
const HEAD = "b".repeat(40);

function review(overrides: Partial<ArchitectureReviewRecord> = {}): ArchitectureReviewRecord {
  return {
    id: "8f2a1c00-0000-4000-8000-000000000001",
    headRevision: HEAD,
    decision: "pending",
    decisionNote: null,
    externalSource: {
      provider: "github",
      repository: "acme/shop",
      changeNumber: 7,
      changeUrl: "https://github.com/acme/shop/pull/7",
      changeVersion: 1,
      workflowRunId: null,
      workflowRunUrl: null,
    },
    report: { blockingFindings: [{ id: "f1" }] },
    ...overrides,
  } as unknown as ArchitectureReviewRecord;
}

interface Recorded {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const REVIEW_ID = "8f2a1c00-0000-4000-8000-000000000001";

/**
 * Enforces the parts of GitHub's contract this service depends on, rather than
 * accepting any payload. `head_sha` identifies the commit a run is created
 * against and is not an update parameter; a transport that accepts it anyway
 * lets a request that production would reject pass here.
 */
function transportFor(existing: Array<{ id: number; external_id?: string }> = []): {
  transport: HttpTransport;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const transport: HttpTransport = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    recorded.push({ method: init.method, url, body });
    if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
    if (url.includes("/access_tokens")) {
      return {
        status: 201,
        json: async () => ({ token: "ghs_x", expires_at: "2999-01-01T00:00:00Z" }),
      };
    }
    if (url.includes("/check-runs?check_name=")) {
      return { status: 200, json: async () => ({ check_runs: existing }) };
    }
    if (init.method === "PATCH") {
      if (body && "head_sha" in body) {
        return {
          status: 422,
          json: async () => ({ message: 'Invalid request. "head_sha" is not a permitted key.' }),
        };
      }
      return { status: 200, json: async () => ({ id: 99 }) };
    }
    if (!body || typeof body.head_sha !== "string") {
      return { status: 422, json: async () => ({ message: "head_sha is required" }) };
    }
    return { status: 201, json: async () => ({ id: 99 }) };
  };
  return { transport, recorded };
}

describe("decision check state", () => {
  const stateOf = (overrides: Partial<ArchitectureReviewRecord> = {}) =>
    decisionCheckState(reviewDecisionSubject(review(overrides)));

  it("asks for a person when a blocking change has not been ruled on", () => {
    expect(stateOf()).toMatchObject({
      conclusion: "action_required",
      title: "1 blocking change awaiting a decision",
    });
  });

  it("does not wait for a reviewer when nothing is blocking", () => {
    expect(stateOf({ report: { blockingFindings: [] } as never })).toMatchObject({
      conclusion: "success",
      title: "No decision required",
    });
  });

  it("passes once a reviewer accepts the exception", () => {
    const state = stateOf({ decision: "approved" });
    expect(state.conclusion).toBe("success");
    expect(state.title).toBe("Accepted with a justified exception");
  });

  it("fails on rejection and carries the reviewer's reason", () => {
    const state = stateOf({ decision: "rejected", decisionNote: "Use the API instead." });
    expect(state.conclusion).toBe("failure");
    expect(state.summary).toContain("Use the API instead.");
  });
});

describe("publishing the decision check", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  it("creates the gate on the pull request head commit", async () => {
    const { transport, recorded } = transportFor();
    const result = await writeDecisionCheck(review(), { transport, env });

    expect(result).toEqual({ status: "written", conclusion: "action_required" });
    const created = recorded.find((call) => call.method === "POST" && call.url.endsWith("/check-runs"));
    expect(created?.body).toMatchObject({
      name: DECISION_CHECK_NAME,
      head_sha: HEAD,
      status: "completed",
      conclusion: "action_required",
      external_id: "8f2a1c00-0000-4000-8000-000000000001",
    });
    // The reviewer has to be able to reach the review from the check itself.
    expect(String(created?.body?.details_url)).toContain("/reviews/8f2a1c00-0000-4000-8000-000000000001");
  });

  it("publishes from a checks-only installation, which is all publishing needs", async () => {
    // Verification needs pull-request read; publishing does not. An installation
    // that cannot authorise a browser decision must still be able to put the
    // gate on the pull request, or adding the permission would be the price of
    // any gate at all.
    const base = transportFor().transport;
    const transport: HttpTransport = async (url, init) => {
      if (url.includes("/access_tokens")) {
        return {
          status: 201,
          json: async () => ({
            token: "ghs_x",
            expires_at: "2999-01-01T00:00:00Z",
            permissions: { checks: "write", metadata: "read" },
          }),
        };
      }
      return base(url, init);
    };
    const result = await writeDecisionCheck(review(), { transport, env });
    expect(result).toEqual({ status: "written", conclusion: "action_required" });
  });

  it("replaces the existing gate instead of adding a second one", async () => {
    const { transport, recorded } = transportFor([{ id: 555, external_id: REVIEW_ID }]);
    const result = await writeDecisionCheck(review({ decision: "approved" }), { transport, env });

    expect(result).toEqual({ status: "written", conclusion: "success" });
    expect(recorded.some((call) => call.method === "POST" && call.url.endsWith("/check-runs"))).toBe(false);
    const patched = recorded.find((call) => call.method === "PATCH");
    expect(patched?.url).toContain("/check-runs/555");
    expect(patched?.body).toMatchObject({ conclusion: "success" });
  });

  it("never sends head_sha when updating, which GitHub refuses", async () => {
    const { transport, recorded } = transportFor([{ id: 555, external_id: REVIEW_ID }]);
    const result = await writeDecisionCheck(review({ decision: "approved" }), { transport, env });

    expect(result.status).toBe("written");
    expect(recorded.find((call) => call.method === "PATCH")?.body).not.toHaveProperty("head_sha");
  });

  it("adopts only the run it published, not another application's", async () => {
    const { transport, recorded } = transportFor([
      { id: 111, external_id: "someone-else" },
      { id: 222 },
    ]);
    await writeDecisionCheck(review({ decision: "approved" }), { transport, env });

    // Updating a run this service did not create would hijack another check.
    expect(recorded.some((call) => call.method === "PATCH")).toBe(false);
    expect(recorded.find((call) => call.method === "POST" && call.url.endsWith("/check-runs"))).toBeDefined();
  });

  it("leaves a manually imported review alone", async () => {
    const { transport, recorded } = transportFor();
    await expect(
      writeDecisionCheck(review({ externalSource: null }), { transport, env })
    ).resolves.toEqual({ status: "skipped", reason: "not_external" });
    expect(recorded).toEqual([]);
  });

  it("will not post a check against a branch name", async () => {
    const { transport } = transportFor();
    await expect(
      writeDecisionCheck(review({ headRevision: "feature/checkout" }), { transport, env })
    ).resolves.toEqual({ status: "skipped", reason: "not_a_commit" });
  });

  it("skips quietly when the App is not configured", async () => {
    const { transport } = transportFor();
    await expect(
      writeDecisionCheck(review(), { transport, env: {} })
    ).resolves.toEqual({ status: "skipped", reason: "not_configured" });
  });

  it("reports an unreachable GitHub as a failure rather than as nothing to do", async () => {
    // A lookup that fails is a transient fault, not a setup state. Reporting it
    // as a skip tells a reviewer their pull request needs no update, which is
    // the opposite of true: the gate is stuck and someone has to retry it.
    const unreachable: HttpTransport = async (url) => {
      if (url.endsWith("/installation")) throw new TypeError("fetch failed");
      return { status: 200, json: async () => ({}) };
    };
    await expect(writeDecisionCheck(review(), { transport: unreachable, env })).resolves.toEqual({
      status: "error",
      code: "github_unreachable",
      detail: "fetch failed",
    });
  });

  it("distinguishes credential failures a reviewer would respond to differently", async () => {
    const answering = (status: number): HttpTransport => async (url) =>
      url.endsWith("/installation")
        ? { status, json: async () => ({ message: "no" }) }
        : { status: 200, json: async () => ({}) };

    // A rejected credential needs the App's key replaced; a failing GitHub
    // needs waiting out. Collapsing both to "error" lost that.
    await expect(
      writeDecisionCheck(review(), { transport: answering(401), env })
    ).resolves.toMatchObject({ status: "error", code: "credential_rejected" });
    resetGitHubAppCacheForTests();
    await expect(
      writeDecisionCheck(review(), { transport: answering(500), env })
    ).resolves.toMatchObject({ status: "error", code: "installation_lookup_failed" });
  });

  it("reports an unusable private key rather than throwing past the caller", async () => {
    // Signing happens before any request. An exception escaping here left the
    // caller unable to record that publishing had failed at all.
    const { transport } = transportFor();
    await expect(
      writeDecisionCheck(review(), {
        transport,
        env: { GITHUB_APP_ID: "1234", GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----" },
      })
    ).resolves.toMatchObject({ status: "error", code: "credential_unusable" });
  });

  it("reports a misconfigured frontend URL rather than throwing past the caller", async () => {
    const { transport } = transportFor();
    const frontendUrl = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = "not-a-url";
    try {
      await expect(
        writeDecisionCheck(review(), { transport, env })
      ).resolves.toMatchObject({ status: "error", code: "configuration_invalid" });
    } finally {
      if (frontendUrl === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = frontendUrl;
    }
  });

  it("never lets an unexpected fault escape instead of being recorded", async () => {
    const exploding: HttpTransport = () => {
      throw new RangeError("something nobody predicted");
    };
    await expect(
      writeDecisionCheck(review(), { transport: exploding, env })
    ).resolves.toMatchObject({ status: "error" });
  });

  it("creates one check run when two attempts for the same commit overlap", async () => {
    const { transport, recorded } = transportFor();
    let created = 0;
    const slowCreate: HttpTransport = async (url, init) => {
      if (init.method === "POST" && url.endsWith("/check-runs")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        created += 1;
        return { status: 201, json: async () => ({ id: 100 + created }) };
      }
      if (url.includes("/check-runs?check_name=")) {
        // Reflects what GitHub would now report, so the second attempt can see
        // the first attempt's run rather than a stale empty list.
        return {
          status: 200,
          json: async () => ({
            check_runs: created
              ? [{ id: 101, external_id: REVIEW_ID }]
              : [],
          }),
        };
      }
      return transport(url, init);
    };

    await Promise.all([
      writeDecisionCheck(review(), { transport: slowCreate, env }),
      writeDecisionCheck(review(), { transport: slowCreate, env }),
    ]);

    // Two gates on one commit is worse than a slow one: a reviewer cannot tell
    // which is authoritative, and branch protection may wait on both.
    expect(created).toBe(1);
    expect(recorded.filter((call) => call.method === "POST" && call.url.endsWith("/check-runs")).length)
      .toBeLessThanOrEqual(1);
  });

  it("reports a refused write rather than pretending it published", async () => {
    const transport: HttpTransport = async (url, init) => {
      if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
      if (url.includes("/access_tokens")) {
        return { status: 201, json: async () => ({ token: "t", expires_at: "2999-01-01T00:00:00Z" }) };
      }
      if (init.method === "GET") return { status: 200, json: async () => ({ check_runs: [] }) };
      return { status: 403, json: async () => ({ message: "Resource not accessible" }) };
    };
    await expect(writeDecisionCheck(review(), { transport, env })).resolves.toMatchObject({
      status: "error",
    });
  });
});
