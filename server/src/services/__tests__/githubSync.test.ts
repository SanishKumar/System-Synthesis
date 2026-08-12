import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  dockerComposeAdapter,
  reviewArchitectureChange,
} from "@system-synthesis/architecture-core";
import { publishDecisionCheck } from "../githubChecks.js";
import { resetGitHubAppCacheForTests, type HttpTransport } from "../githubApp.js";
import {
  getArchitectureReview,
  ingestArchitectureReview,
  createArchitectureReview,
  recordGitHubSyncOutcome,
  resetMemoryReviewsForTests,
  updateArchitectureReviewDecision,
} from "../reviewRepository.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const env = { GITHUB_APP_ID: "1234", GITHUB_APP_PRIVATE_KEY: privateKey };
const OWNER = "owner-1";
const HEAD = "b".repeat(40);
const BASE_SOURCE = `services:\n  web:\n    image: web:1\n    ports: ["3000:3000"]\n  db:\n    image: postgres:16\n`;
/** Head gives a publicly published service a direct dependency on persistence,
 *  so the review carries a blocking finding and a decision is genuinely owed. */
const HEAD_SOURCE = `services:\n  web:\n    image: web:1\n    ports: ["3000:3000"]\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n`;

function graph(revision: string, content = HEAD_SOURCE) {
  return dockerComposeAdapter.import(
    [{ path: "compose.yaml", content }],
    { repository: "acme/shop", revision }
  ).graph;
}
const baseGraph = () => graph("a".repeat(40), BASE_SOURCE);

async function ingest(headRevision = HEAD, changeVersion = 1_000) {
  const built = graph(headRevision);
  return ingestArchitectureReview({
    ownerId: OWNER,
    title: "Gate",
    repository: "acme/shop",
    sourcePath: "compose.yaml",
    baseRevision: "a".repeat(40),
    headRevision,
    baseGraph: baseGraph(),
    headGraph: built,
    policy: {},
    report: reviewArchitectureChange(baseGraph(), built, {}, "2026-08-12T00:00:00.000Z"),
    externalSource: {
      provider: "github",
      repository: "acme/shop",
      changeNumber: 9,
      changeUrl: "https://github.com/acme/shop/pull/9",
      changeVersion,
      workflowRunId: null,
      workflowRunUrl: null,
    },
  });
}

/** Succeeds unless told to refuse the check-run write. */
function transport(options: { writeStatus?: number; throwOnWrite?: boolean } = {}): HttpTransport {
  return async (url, init) => {
    if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
    if (url.includes("/access_tokens")) {
      return { status: 201, json: async () => ({ token: "ghs_x", expires_at: "2999-01-01T00:00:00Z" }) };
    }
    if (init.method === "GET") return { status: 200, json: async () => ({ check_runs: [] }) };
    if (options.throwOnWrite) throw new Error("socket hang up");
    return { status: options.writeStatus ?? 201, json: async () => ({ id: 99 }) };
  };
}

describe("GitHub synchronization state", () => {
  beforeEach(() => {
    resetMemoryReviewsForTests();
    resetGitHubAppCacheForTests();
  });

  it("marks an ingested review pending before anything is published", async () => {
    const { review } = await ingest();
    // A crash here must leave a review that looks unpublished, not one that
    // claims a gate exists.
    expect(review.githubSync).toMatchObject({
      status: "pending",
      conclusion: "action_required",
      revision: review.revision,
      headRevision: HEAD,
      succeededAt: null,
    });
  });

  it("records synced against the revision, commit and conclusion published", async () => {
    const { review } = await ingest();
    const state = await publishDecisionCheck(review, { transport: transport(), env });

    expect(state).toMatchObject({
      status: "synced",
      conclusion: "action_required",
      revision: review.revision,
      headRevision: HEAD,
      reason: null,
    });
    expect(state.succeededAt).not.toBeNull();
  });

  it("keeps the decision durable when publication is refused", async () => {
    const { review } = await ingest();
    const decided = await updateArchitectureReviewDecision(
      review.id,
      OWNER,
      review.revision,
      "rejected",
      "Use the API."
    );
    expect(decided.status).toBe("updated");

    const state = await publishDecisionCheck(
      (decided as { review: typeof review }).review,
      { transport: transport({ writeStatus: 403 }), env }
    );
    expect(state).toMatchObject({ status: "failed" });
    expect(state.reason).toContain("403");

    // The decision itself is unaffected by GitHub being unreachable.
    const stored = await getArchitectureReview(review.id, OWNER);
    expect(stored).toMatchObject({ decision: "rejected", decisionNote: "Use the API." });
  });

  it("records a network failure as failed rather than losing it", async () => {
    const { review } = await ingest();
    const state = await publishDecisionCheck(review, {
      transport: transport({ throwOnWrite: true }),
      env,
    });
    expect(state).toMatchObject({ status: "failed" });
    expect(state.reason).toContain("socket hang up");
  });

  it("recovers on retry without moving the review revision", async () => {
    const { review } = await ingest();
    await publishDecisionCheck(review, { transport: transport({ writeStatus: 403 }), env });

    const current = (await getArchitectureReview(review.id, OWNER))!;
    expect(current.githubSync.status).toBe("failed");

    const retried = await publishDecisionCheck(current, { transport: transport(), env });
    expect(retried.status).toBe("synced");
    const after = (await getArchitectureReview(review.id, OWNER))!;
    expect(after.revision).toBe(review.revision);
  });

  it("refuses to mark a newer review synchronized from an older attempt", async () => {
    const { review } = await ingest();
    // A response arriving after a new commit already refreshed the review.
    const refreshed = await ingest("c".repeat(40), 2_000);
    expect(refreshed.review.revision).toBeGreaterThan(review.revision);

    const discarded = await recordGitHubSyncOutcome(review.id, {
      revision: review.revision,
      headRevision: review.headRevision,
      conclusion: "action_required",
      status: "synced",
      reason: null,
    });

    expect(discarded).toBeNull();
    const stored = await getArchitectureReview(review.id, OWNER);
    expect(stored?.githubSync.status).toBe("pending");
  });

  it("treats a manual review as skipped rather than failed", async () => {
    const built = graph("head");
    const review = await createArchitectureReview({
      ownerId: OWNER,
      title: "Manual",
      repository: null,
      sourcePath: "compose.yaml",
      baseRevision: "base",
      headRevision: "head",
      baseGraph: graph("base", BASE_SOURCE),
      headGraph: built,
      policy: {},
      report: reviewArchitectureChange(graph("base", BASE_SOURCE), built, {}, "2026-08-12T00:00:00.000Z"),
    });

    expect(review.githubSync).toMatchObject({ status: "skipped", reason: "not_external" });
    const state = await publishDecisionCheck(review, { transport: transport(), env });
    expect(state).toMatchObject({ status: "skipped", reason: "not_external" });
  });

  it("distinguishes an unconfigured App from a failure", async () => {
    const { review } = await ingest();
    const state = await publishDecisionCheck(review, { transport: transport(), env: {} });
    // Actionable setup guidance, not something a reviewer should retry blindly.
    expect(state).toMatchObject({ status: "skipped", reason: "not_configured" });
  });

  it("records an unreachable GitHub as a failure a reviewer can retry", async () => {
    const { review } = await ingest();
    const unreachable: HttpTransport = async (url) => {
      if (url.endsWith("/installation")) throw new TypeError("fetch failed");
      return { status: 200, json: async () => ({}) };
    };
    const state = await publishDecisionCheck(review, { transport: unreachable, env });
    expect(state).toMatchObject({
      status: "failed",
      reason: "fetch failed",
      revision: review.revision,
      headRevision: review.headRevision,
    });
    // The stored state has to agree, or a refresh would hide the stuck gate.
    const stored = await getArchitectureReview(review.id, OWNER);
    expect(stored?.githubSync).toMatchObject({ status: "failed", reason: "fetch failed" });
  });

  it("distinguishes an uninstalled App from a failure", async () => {
    const { review } = await ingest();
    const uninstalled: HttpTransport = async (url) =>
      url.endsWith("/installation")
        ? { status: 404, json: async () => ({ message: "Not Found" }) }
        : { status: 200, json: async () => ({}) };
    const state = await publishDecisionCheck(review, { transport: uninstalled, env });
    expect(state).toMatchObject({ status: "skipped", reason: "not_installed" });
  });
});
