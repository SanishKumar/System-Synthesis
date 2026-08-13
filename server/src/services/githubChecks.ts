import {
  getInstallationToken,
  type CredentialFailureCode,
  type HttpTransport,
} from "./githubApp.js";
import { logger } from "../middleware/logger.js";
import { decisionCheckState, reviewDecisionSubject } from "./decisionState.js";
import {
  getGitHubSyncState,
  recordGitHubSyncOutcome,
  recordGitHubSyncSkipped,
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

/**
 * Why a publish attempt failed, as a fixed vocabulary a reviewer can be shown.
 *
 * Stored on the review and rendered, so it must mean the same thing every time
 * and reveal nothing about the server's insides. The originating message is
 * logged instead.
 */
export type DecisionCheckFailureCode =
  | CredentialFailureCode
  | "check_write_forbidden"
  | "check_write_invalid"
  | "check_write_failed"
  | "configuration_invalid"
  | "unexpected_error";

export type DecisionCheckResult =
  | { status: "written"; conclusion: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; code: DecisionCheckFailureCode; detail: string };

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
  // Nothing in this function may throw. The caller records what it returns, so
  // an escaping exception is the one outcome that leaves a review claiming it
  // was never attempted while GitHub may well have been written to.
  try {
    return await attemptDecisionCheck(review, options);
  } catch (error) {
    return {
      status: "error",
      code: "unexpected_error",
      detail: error instanceof Error ? error.message : "decision check attempt failed",
    };
  }
}

async function attemptDecisionCheck(
  review: ArchitectureReviewRecord,
  options: { transport?: HttpTransport; env?: NodeJS.ProcessEnv }
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
  // An App that is unconfigured or uninstalled is a setup state: nothing is
  // wrong, there is simply nothing to publish with until someone acts. A
  // credential that failed for any other reason is a fault, and reporting it as
  // a skip would tell a reviewer their pull request needs no update while the
  // gate sits unpublished. Its own explanation is kept, because "GitHub is
  // unreachable" and "the App lost access" call for different responses.
  if (credential.status === "not_configured" || credential.status === "not_installed") {
    return { status: "skipped", reason: credential.status };
  }
  if (credential.status === "error") {
    return { status: "error", code: credential.code, detail: credential.detail };
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
  let detailsUrl: string;
  try {
    detailsUrl = reviewUrl(review);
  } catch {
    // A misconfigured FRONTEND_URL is the operator's mistake, not GitHub's, and
    // must be reported as such rather than thrown past the recording caller.
    return {
      status: "error",
      code: "configuration_invalid",
      detail: "FRONTEND_URL is not a valid URL",
    };
  }
  // Fields common to both writes. `head_sha` is deliberately absent: it
  // identifies the commit a run is created against and is not an update
  // parameter, so sending it on a PATCH risks a rejected request.
  const common = {
    name: DECISION_CHECK_NAME,
    status: "completed",
    conclusion: state.conclusion,
    details_url: detailsUrl,
    external_id: review.id,
    output: { title: state.title, summary: state.summary },
  };

  try {
    // Serialized on the run this writes to, because two attempts that interleave
    // here would both find no existing run and both create one, leaving the pull
    // request with two gates for the same decision. Concurrent duplicate
    // deliveries do happen.
    //
    // The key is the commit the run hangs off rather than the review, since that
    // is what can be duplicated — and keying it by review would make an attempt
    // for a newer commit wait behind one for a commit nobody is looking at.
    return await inSequenceFor(`${source.repository}@${review.headRevision}`, async () => {
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
        return {
          status: "error",
          code: writeFailureCode(written.status),
          detail: `check run write returned ${written.status}`,
        };
      }
      return { status: "written", conclusion: state.conclusion };
    });
  } catch (error) {
    return {
      status: "error",
      code: "github_unreachable",
      detail: error instanceof Error ? error.message : "check run write failed",
    };
  }
}

function writeFailureCode(status: number): DecisionCheckFailureCode {
  if (status === 401 || status === 403) return "check_write_forbidden";
  if (status === 422) return "check_write_invalid";
  return "check_write_failed";
}

/**
 * Runs work for one review at a time, in the order it arrives.
 *
 * Only serializes within this process, which is what the single-instance
 * deployment needs. Running several instances would need the lock to live in
 * the database instead; the duplicate it prevents is a second check run on the
 * same commit, not a corrupted record.
 */
const sequences = new Map<string, Promise<void>>();

function inSequenceFor<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = sequences.get(key) ?? Promise.resolve();
  // Runs after whatever is already queued, whether that settled or threw.
  const result = previous.then(work, work);
  // The queue marker never rejects, so one failed attempt cannot poison the
  // attempts behind it.
  const marker = result.then(() => undefined, () => undefined);
  sequences.set(key, marker);
  void marker.then(() => {
    // Forget the review once nothing is queued behind it, so the map does not
    // grow with every review this process ever publishes for.
    if (sequences.get(key) === marker) sequences.delete(key);
  });
  return result;
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
  const generation = {
    revision: review.revision,
    headRevision: review.headRevision,
  };

  if (attempted.status === "skipped") {
    const recorded = await recordGitHubSyncSkipped(review.id, {
      ...generation,
      // The conclusion this generation was marked pending with, which is what
      // the guard compares. A manual review carries none, and must still match.
      conclusion: review.githubSync.conclusion,
      reason: attempted.reason,
    });
    return recorded ?? (await currentState(review));
  }

  const conclusion = decisionCheckState(reviewDecisionSubject(review)).conclusion;
  if (attempted.status === "error") {
    // The stable code is what the review stores and a reviewer reads; the
    // originating message stays with the operator.
    logger.warn("Architecture decision check attempt failed", {
      reviewId: review.id,
      code: attempted.code,
      detail: attempted.detail,
    });
  }
  const recorded = await recordGitHubSyncOutcome(review.id, {
    ...generation,
    conclusion,
    status: attempted.status === "written" ? "synced" : "failed",
    reason: attempted.status === "error" ? attempted.code : null,
  });
  return recorded ?? (await currentState(review));
}

/**
 * What the review holds now, for an attempt whose record was refused.
 *
 * A refusal means the review moved on while the attempt was in flight, so the
 * snapshot this call started from is already history. Answering with it would
 * hand a caller — and through them a browser — the previous generation's state
 * as though it were current.
 */
async function currentState(review: ArchitectureReviewRecord): Promise<GitHubSyncState> {
  return (await getGitHubSyncState(review.id)) ?? review.githubSync;
}
