import { getInstallationToken, type HttpTransport } from "./githubApp.js";
import type { ArchitectureReviewRecord } from "./reviewRepository.js";

const GITHUB_API = "https://api.github.com";
/**
 * Deliberately distinct from the Action's own check.
 *
 * The Action answers "what did deterministic analysis find", which is fixed for
 * a head commit, a policy and an analyzer. This answers "has a human accepted
 * the change", which is not fixed and belongs to a reviewer. Merging them would
 * make a verdict look revisable and a decision look computed.
 */
export const DECISION_CHECK_NAME = "Architecture Decision";
const COMMIT_SHA = /^[a-f0-9]{40}$/i;

export type DecisionCheckResult =
  | { status: "written"; conclusion: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

interface CheckState {
  conclusion: "success" | "failure" | "action_required";
  title: string;
  summary: string;
}

/**
 * How a stored decision reads as a merge gate.
 *
 * A change with nothing blocking needs no reviewer, so it must not sit waiting
 * for one. A blocking finding that nobody has ruled on is `action_required`
 * rather than a plain failure, because the resolution is a person opening the
 * review, not a code change.
 */
export function decisionCheckState(review: ArchitectureReviewRecord): CheckState {
  const blocking = review.report.blockingFindings.length;
  if (review.decision === "approved") {
    return {
      conclusion: "success",
      title: blocking > 0 ? "Accepted with a justified exception" : "Approved",
      summary: blocking > 0
        ? `A reviewer accepted this architecture change with ${blocking} blocking finding(s) outstanding.`
        : "A reviewer approved this architecture change.",
    };
  }
  if (review.decision === "rejected") {
    return {
      conclusion: "failure",
      title: "Rejected",
      summary: review.decisionNote
        ? `A reviewer rejected this architecture change: ${review.decisionNote}`
        : "A reviewer rejected this architecture change.",
    };
  }
  if (blocking === 0) {
    return {
      conclusion: "success",
      title: "No decision required",
      summary: "This change introduces no blocking architecture findings.",
    };
  }
  return {
    conclusion: "action_required",
    title: `${blocking} blocking change awaiting a decision`,
    summary:
      "Open the architecture review to resolve the finding, accept a justified exception, or reject the change.",
  };
}

function reviewUrl(review: ArchitectureReviewRecord): string {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  return new URL(`/reviews/${review.id}`, frontendUrl).toString();
}

function defaultTransport(): HttpTransport {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, json: () => response.json() };
  };
}

/**
 * Publish the decision as a check run on the pull request's head commit.
 *
 * Best effort by design: the decision is already durable and audited before
 * this runs, so a GitHub outage must not fail the reviewer's action. The caller
 * records the outcome rather than surfacing it as a request failure.
 *
 * An existing run for this commit is updated instead of duplicated, because a
 * reviewer who changes their mind should replace the gate, not add a second one.
 */
export async function writeDecisionCheck(
  review: ArchitectureReviewRecord,
  options: { transport?: HttpTransport; env?: NodeJS.ProcessEnv } = {}
): Promise<DecisionCheckResult> {
  const source = review.externalSource;
  if (!source) return { status: "skipped", reason: "not_external" };
  // Only a real commit can carry a check run; a manual review has a branch name.
  if (!COMMIT_SHA.test(review.headRevision)) {
    return { status: "skipped", reason: "not_a_commit" };
  }

  const credential = await getInstallationToken(source.repository, {
    env: options.env,
    transport: options.transport,
  });
  if (credential.status !== "ok") {
    return { status: "skipped", reason: credential.status };
  }

  const transport = options.transport ?? defaultTransport();
  const headers = {
    Authorization: `Bearer ${credential.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "system-synthesis",
  };
  const state = decisionCheckState(review);
  const body = {
    name: DECISION_CHECK_NAME,
    head_sha: review.headRevision,
    status: "completed",
    conclusion: state.conclusion,
    details_url: reviewUrl(review),
    external_id: review.id,
    output: { title: state.title, summary: state.summary },
  };

  try {
    const existing = await transport(
      `${GITHUB_API}/repos/${source.repository}/commits/${review.headRevision}/check-runs?check_name=${encodeURIComponent(DECISION_CHECK_NAME)}`,
      { method: "GET", headers }
    );
    let existingId: number | undefined;
    if (existing.status === 200) {
      const payload = (await existing.json().catch(() => null)) as
        | { check_runs?: Array<{ id?: unknown }> }
        | null;
      const candidate = payload?.check_runs?.[0]?.id;
      if (typeof candidate === "number") existingId = candidate;
    }

    const written = existingId
      ? await transport(
          `${GITHUB_API}/repos/${source.repository}/check-runs/${existingId}`,
          { method: "PATCH", headers, body: JSON.stringify(body) }
        )
      : await transport(`${GITHUB_API}/repos/${source.repository}/check-runs`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

    if (written.status !== 200 && written.status !== 201) {
      return { status: "error", reason: `check run write returned ${written.status}` };
    }
    return { status: "written", conclusion: state.conclusion };
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "check run write failed",
    };
  }
}
