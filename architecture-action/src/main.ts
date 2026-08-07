import * as core from "@actions/core";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { COMPOSE_FILE_NAMES } from "@system-synthesis/architecture-core";
import { composeReviewComment } from "./comment.js";
import { resolveComposeSources } from "./composeSources.js";
import { createActionReview } from "./review.js";
import {
  createIngestionPayload,
  ingestionMode,
  readPullRequestContext,
  uploadArchitectureReview,
} from "./ingestion.js";

const MAX_GIT_FILE_BYTES = 1_100_000;

function safeRepositoryPath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  return normalized;
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

function verifyRevision(revision: string, cwd: string): void {
  execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd,
    stdio: "ignore",
  });
}

function revisionFile(
  revision: string,
  repositoryPath: string,
  cwd: string
): string | undefined {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${repositoryPath}`], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    return undefined;
  }
  return execFileSync("git", ["show", `${revision}:${repositoryPath}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_FILE_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Root-level Compose files present at a revision, used only to turn a
 * misconfigured `compose-path` into an actionable message. Probing the known
 * names directly keeps this to a few cheap lookups instead of listing the tree.
 */
function composeCandidates(revision: string, cwd: string): string[] {
  return COMPOSE_FILE_NAMES.filter((name) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${revision}:${name}`], {
        cwd,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
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
  const composePath = safeRepositoryPath(
    core.getInput("compose-path", { required: true }),
    "compose-path"
  );
  const policyInput = core.getInput("policy-path");
  const policyPath = policyInput
    ? safeRepositoryPath(policyInput, "policy-path")
    : undefined;
  const baseRevision = core.getInput("base-revision", { required: true });
  const headRevision = core.getInput("head-revision", { required: true });
  verifyRevision(baseRevision, sourceDirectory);
  verifyRevision(headRevision, sourceDirectory);

  const sources = resolveComposeSources({
    composePath,
    baseRevision,
    headRevision,
    baseFile: revisionFile(baseRevision, composePath, sourceDirectory),
    headFile: revisionFile(headRevision, composePath, sourceDirectory),
    findCandidates: () => composeCandidates(headRevision, sourceDirectory),
  });

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
      ? revisionFile(baseRevision, policyPath, sourceDirectory)
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
  if (ingestionUrl && ingestionToken) {
    const context = readPullRequestContext();
    if (ingestionMode(ingestionUrl, ingestionToken, context.isFork) === "skip") {
      core.notice("Browser review ingestion skipped for a fork pull request.");
    } else {
      const ingestion = await uploadArchitectureReview({
        endpoint: ingestionUrl,
        token: ingestionToken,
        payload: createIngestionPayload({
          context,
          sourcePath: composePath,
          baseGraph: reports.baseGraph,
          headGraph: reports.headGraph,
          policy: reports.policy,
        }),
      });
      reviewUrl = ingestion.reviewUrl;
      core.setOutput("ingestion-status", ingestion.status);
      core.setOutput("review-id", ingestion.reviewId);
      core.setOutput("review-url", ingestion.reviewUrl);
      await writeJobSummary(
        `\n\n[Open the persisted architecture review](${ingestion.reviewUrl})\n`
      );
    }
  } else {
    ingestionMode(ingestionUrl, ingestionToken, false);
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
});
