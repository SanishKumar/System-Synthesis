import * as core from "@actions/core";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createActionReview } from "./review.js";

const EMPTY_COMPOSE = "services: {}\n";
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

function verifyRevision(revision: string): void {
  execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    stdio: "ignore",
  });
}

function revisionFile(
  revision: string,
  repositoryPath: string
): string | undefined {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${repositoryPath}`], {
      stdio: "ignore",
    });
  } catch {
    return undefined;
  }
  return execFileSync("git", ["show", `${revision}:${repositoryPath}`], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_FILE_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
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
  verifyRevision(baseRevision);
  verifyRevision(headRevision);

  const reports = createActionReview({
    baseContent: revisionFile(baseRevision, composePath) || EMPTY_COMPOSE,
    headContent: revisionFile(headRevision, composePath) || EMPTY_COMPOSE,
    sourcePath: composePath,
    repository: process.env.GITHUB_REPOSITORY,
    baseRevision,
    headRevision,
    // The base branch policy governs the PR, so a PR cannot disable its own
    // required checks. Policy changes take effect after they are merged.
    policyContent: policyPath
      ? revisionFile(baseRevision, policyPath)
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
  core.setOutput(
    "blocking-findings",
    String(reports.review.blockingFindings.length)
  );
  core.summary.addRaw(reports.markdown);
  await core.summary.write();

  if (reports.exitCode === 1) {
    core.setFailed(
      `${reports.review.blockingFindings.length} blocking architecture finding(s) introduced.`
    );
  }
}

run().catch((error: unknown) => {
  core.setOutput("exit-code", "2");
  core.setOutput("status", "error");
  core.setFailed(error instanceof Error ? error.message : "Architecture review failed.");
});
