import { parsePullRequestRevisions, readPullRequestEvent } from "./ingestion.js";

/** Explicit inputs win; only a pull_request event can supply missing revisions. */
export function resolveActionRevisions(
  input: { baseRevision?: string; headRevision?: string },
  environment: NodeJS.ProcessEnv = process.env,
  readEvent: () => unknown = () => readPullRequestEvent(environment)
): { baseRevision: string; headRevision: string } {
  const baseRevision = input.baseRevision?.trim();
  const headRevision = input.headRevision?.trim();
  if (baseRevision && headRevision) return { baseRevision, headRevision };
  if (environment.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("Set base-revision and head-revision explicitly outside pull_request events; no branch or merge-commit default is guessed.");
  }
  const detected = parsePullRequestRevisions(readEvent(), environment);
  return {
    baseRevision: baseRevision || detected.baseRevision,
    headRevision: headRevision || detected.headRevision,
  };
}
