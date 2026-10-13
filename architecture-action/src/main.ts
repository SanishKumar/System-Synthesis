import * as core from "@actions/core";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { composeReviewComment } from "./comment.js";
import {
  composePairFromGit,
  readFileAtRevision,
  safeRepositoryPath,
} from "@system-synthesis/architecture-cli";
import { createActionReview } from "./review.js";
import { resolveActionRevisions } from "./inputs.js";
import {
  createIngestionPayload,
  ingestionAudience,
  planIngestion,
  readPullRequestContext,
  uploadArchitectureReview,
} from "./ingestion.js";

/**
 * Ask GitHub for this run's identity token, requested for one audience.
 *
 * The token is registered as a secret by the toolkit before it is returned,
 * so it is masked in the log from the moment it exists.
 */
async function requestIdentityToken(audience: string): Promise<string> {
  try {
    return await core.getIDToken(audience);
  } catch (error) {
    throw new Error(
      `GitHub did not issue an identity token for this run: ${
        error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "unknown error"
      }`
    );
  }
}

function repositoryDirectory(value: string): string {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const requested = resolve(workspace, value || ".");
  const distance = relative(workspace, requested);
  if (distance.startsWith("..") || isAbsolute(distance)) {
    throw new Error("repository-directory must stay within GITHUB_WORKSPACE.");
  }
  return requested;
}

/**
 * The job summary is a convenience; the reports, the policy verdict, and the
 * pull-request comment are the product. GitHub caps summaries at 1 MB and omits
 * the backing file in some environments, so a summary failure must not abort the
 * run and take the comment down with it.
 */
async function writeJobSummary(markdown: string): Promise<void> {
  try {
    core.summary.addRaw(markdown);
    await core.summary.write();
  } catch (error) {
    core.warning(
      `Job summary unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function outputDirectory(value: string): string {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const requested = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
  const distance = relative(workspace, requested);
  if (distance.startsWith("..") || isAbsolute(distance)) {
    throw new Error("output-directory must stay within GITHUB_WORKSPACE.");
  }
  return requested;
}

async function run(): Promise<void> {
  const sourceDirectory = repositoryDirectory(
    core.getInput("repository-directory") || "."
  );
  const policyInput = core.getInput("policy-path");
  const policyPath = policyInput
    ? safeRepositoryPath(policyInput, "policy-path")
    : undefined;
  const revisions = resolveActionRevisions({
    baseRevision: core.getInput("base-revision"),
    headRevision: core.getInput("head-revision"),
  });
  const sources = composePairFromGit({
    directory: sourceDirectory,
    composePath: core.getInput("compose-path") || undefined,
    ...revisions,
  });
  const { composePath, baseRevision, headRevision } = sources;
  core.setOutput("compose-path", composePath);
  core.setOutput("base-revision", baseRevision);
  core.setOutput("head-revision", headRevision);
  core.info(`Reviewing ${composePath}: ${baseRevision} -> ${headRevision}`);

  const reports = createActionReview({
    baseContent: sources.baseContent,
    headContent: sources.headContent,
    sourcePath: composePath,
    repository: process.env.GITHUB_REPOSITORY,
    baseRevision,
    headRevision,
    // The base branch policy governs the PR, so a PR cannot disable its own
    // required checks. Policy changes take effect after they are merged.
    policyContent: policyPath
      ? readFileAtRevision(baseRevision, policyPath, sourceDirectory)
      : undefined,
    reviewedAt: new Date(),
  });

  const directory = outputDirectory(
    core.getInput("output-directory") || ".system-synthesis/reports"
  );
  mkdirSync(directory, { recursive: true });
  const jsonPath = resolve(directory, "architecture-review.json");
  const markdownPath = resolve(directory, "architecture-review.md");
  const sarifPath = resolve(directory, "architecture-review.sarif");
  writeFileSync(jsonPath, reports.json, "utf8");
  writeFileSync(markdownPath, reports.markdown, "utf8");
  writeFileSync(sarifPath, reports.sarif, "utf8");

  core.setOutput("exit-code", String(reports.exitCode));
  core.setOutput("status", reports.review.status);
  core.setOutput("json-file", jsonPath);
  core.setOutput("markdown-file", markdownPath);
  core.setOutput("sarif-file", sarifPath);
  core.setOutput("ingestion-status", "skipped");
  core.setOutput("review-id", "");
  core.setOutput("review-url", "");
  core.setOutput(
    "blocking-findings",
    String(reports.review.blockingFindings.length)
  );
  await writeJobSummary(reports.markdown);

  let reviewUrl = "";
  const ingestionUrl = core.getInput("ingestion-url").trim();
  const ingestionToken = core.getInput("ingestion-token").trim();
  if (ingestionToken) core.setSecret(ingestionToken);
  // Read only when a delivery is configured. It needs a pull_request event,
  // and a review that stays local does not.
  const context = ingestionUrl ? readPullRequestContext() : null;
  const plan = planIngestion({
    endpoint: ingestionUrl,
    token: ingestionToken,
    isFork: context?.isFork ?? false,
    identityTokenAvailable: Boolean(
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    ),
    actor: process.env.GITHUB_ACTOR,
  });
  if (plan.action === "skip") core.notice(plan.reason);
  if (plan.action === "upload" && context) {
    const payload = createIngestionPayload({
      context,
      sourcePath: composePath,
      baseGraph: reports.baseGraph,
      headGraph: reports.headGraph,
      policy: reports.policy,
    });
    // Requested last, once there is something to send: an identity token is
    // only good for a few minutes.
    const token =
      plan.credential === "identity"
        ? await requestIdentityToken(ingestionAudience(ingestionUrl))
        : ingestionToken;
    const ingestion = await uploadArchitectureReview({
      endpoint: ingestionUrl,
      token,
      credential: plan.credential,
      payload,
    });
    reviewUrl = ingestion.reviewUrl;
    core.setOutput("ingestion-status", ingestion.status);
    core.setOutput("review-id", ingestion.reviewId);
    core.setOutput("review-url", ingestion.reviewUrl);
    await writeJobSummary(
      `\n\n[Open the persisted architecture review](${ingestion.reviewUrl})\n`
    );
  }

  // Written after ingestion so the comment can lead with the decision link.
  const commentPath = resolve(directory, "architecture-review-comment.md");
  writeFileSync(
    commentPath,
    composeReviewComment({
      markdown: reports.markdown,
      review: reports.review,
      reviewUrl: reviewUrl || undefined,
    }),
    "utf8"
  );
  core.setOutput("comment-file", commentPath);

  if (reports.exitCode === 1) {
    core.setFailed(
      `${reports.review.blockingFindings.length} blocking architecture finding(s) introduced.`
    );
  }
}

run().catch((error: unknown) => {
  core.setOutput("exit-code", "2");
  core.setOutput("status", "error");
  core.setOutput("ingestion-status", "error");
  core.setFailed(error instanceof Error ? error.message : "Architecture review failed.");
  // setFailed uses 1 for every failure; preserve the documented distinction
  // between blocking findings (1) and input/integration failures (2).
  process.exitCode = 2;
});
