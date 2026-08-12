import { getInstallationToken, type HttpTransport } from "./githubApp.js";
import { decisionCheckState, reviewDecisionSubject } from "./decisionState.js";
import {
  recordGitHubSyncOutcome,
  recordGitHubSyncSkipped,
  skippedSyncState,
  type ArchitectureReviewRecord,
  type GitHubSyncState,
} from "./reviewRepository.js";

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
  const state = decisionCheckState(reviewDecisionSubject(review));
  // Fields common to both writes. `head_sha` is deliberately absent: it
  // identifies the commit a run is created against and is not an update
  // parameter, so sending it on a PATCH risks a rejected request.
  const common = {
    name: DECISION_CHECK_NAME,
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
        | { check_runs?: Array<{ id?: unknown; external_id?: unknown }> }
        | null;
      // Match on the identifier this service set, not on position. Another
      // application may publish a check of the same name against the same
      // commit, and updating someone else's run would be worse than adding one.
      const mine = (payload?.check_runs || [])
        .filter((run) => run.external_id === review.id && typeof run.id === "number")
        .map((run) => run.id as number)
        .sort((left, right) => right - left);
      existingId = mine[0];
    }

    const written = existingId
      ? await transport(
          `${GITHUB_API}/repos/${source.repository}/check-runs/${existingId}`,
          { method: "PATCH", headers, body: JSON.stringify(common) }
        )
      : await transport(`${GITHUB_API}/repos/${source.repository}/check-runs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...common, head_sha: review.headRevision }),
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

/**
 * Publishes the gate and records what happened against the review.
 *
 * The outcome is only recorded if the review still holds the state that was
 * published, so a slow response cannot mark a newer revision synchronized. A
 * skip is a terminal state rather than a failure — nothing is wrong, there is
 * simply nothing to publish or nothing configured to publish with.
 */
export async function publishDecisionCheck(
  review: ArchitectureReviewRecord,
  options: { transport?: HttpTransport; env?: NodeJS.ProcessEnv } = {}
): Promise<GitHubSyncState> {
  const attempted = await writeDecisionCheck(review, options);
  if (attempted.status === "skipped") {
    const skipped = skippedSyncState(attempted.reason);
    await recordGitHubSyncSkipped(review.id, attempted.reason);
    return skipped;
  }

  const conclusion = decisionCheckState(reviewDecisionSubject(review)).conclusion;
  const recorded = await recordGitHubSyncOutcome(review.id, {
    revision: review.revision,
    headRevision: review.headRevision,
    conclusion,
    status: attempted.status === "written" ? "synced" : "failed",
    reason: attempted.status === "error" ? attempted.reason : null,
  });
  // A discarded record means the review moved on while this was in flight; the
  // newer state keeps its own pending marker and will be published for itself.
  return recorded ?? review.githubSync;
}
