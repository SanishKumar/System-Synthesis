import { readFileSync } from "node:fs";
import type {
  ArchitecturePolicy,
  CanonicalArchitectureGraph,
} from "@system-synthesis/architecture-core";

export interface PullRequestIngestionContext {
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestTitle: string;
  changeVersion: number;
  baseRevision: string;
  headRevision: string;
  isFork: boolean;
  workflowRunId?: string;
  workflowRunUrl?: string;
}

export interface ArchitectureIngestionPayload {
  repository: string;
  pullRequest: {
    number: number;
    url: string;
    title: string;
    changeVersion: number;
  };
  sourcePath: string;
  baseRevision: string;
  headRevision: string;
  workflowRun?: { id: string; url: string };
  baseGraph: CanonicalArchitectureGraph;
  headGraph: CanonicalArchitectureGraph;
  policy: ArchitecturePolicy;
}

export interface IngestionResponse {
  status: "created" | "updated" | "unchanged" | "stale";
  reviewId: string;
  reviewUrl: string;
  revision: number;
  analysisStatus: "pass" | "fail";
  blockingFindings: number;
  headRevision: string;
}

export function ingestionMode(
  endpoint: string,
  token: string,
  isFork: boolean
): "skip" | "upload" {
  if (Boolean(endpoint.trim()) !== Boolean(token.trim())) {
    throw new Error(
      "ingestion-url and ingestion-token must either both be configured or both be omitted."
    );
  }
  return !endpoint.trim() || isFork ? "skip" : "upload";
}

interface UploadOptions {
  endpoint: string;
  token: string;
  payload: ArchitectureIngestionPayload;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}

const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function record(value: unknown, label = "Value"): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as Record<string, any>;
}

function repositoryIdentity(value: unknown, label: string): string {
  const repository = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`${label} must use the GitHub owner/name form.`);
  }
  return repository;
}

function commit(value: unknown, label: string): string {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA_PATTERN.test(revision)) {
    throw new Error(`${label} must be a full Git commit SHA.`);
  }
  return revision;
}

function httpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 500) {
    throw new Error(`${label} is invalid.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new Error(`${label} must be HTTPS (or loopback HTTP) and contain no credentials.`);
  }
  return url.toString();
}

export function parsePullRequestContext(
  event: unknown,
  environment: NodeJS.ProcessEnv = process.env
): PullRequestIngestionContext {
  if (environment.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("Architecture review ingestion only supports pull_request events.");
  }
  const root = record(event, "GitHub event payload");
  const pullRequest = record(root.pull_request, "GitHub pull request");
  const repository = repositoryIdentity(
    record(root.repository, "GitHub repository").full_name,
    "event repository"
  );
  const environmentRepository = repositoryIdentity(
    environment.GITHUB_REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  if (repository !== environmentRepository) {
    throw new Error("GitHub event repository does not match GITHUB_REPOSITORY.");
  }
  const number = pullRequest.number;
  if (!Number.isInteger(number) || number < 1 || number > 1_000_000_000) {
    throw new Error("GitHub pull request number is invalid.");
  }
  const title = typeof pullRequest.title === "string" ? pullRequest.title.trim() : "";
  if (!title || title.length > 200) {
    throw new Error("GitHub pull request title is invalid.");
  }
  const updatedAt = Date.parse(String(pullRequest.updated_at || ""));
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
    throw new Error("GitHub pull request updated_at is invalid.");
  }
  const headRepository = repositoryIdentity(
    record(
      record(pullRequest.head, "pull request head").repo,
      "pull request head repository"
    ).full_name,
    "pull request head repository"
  );
  const serverUrl = httpUrl(
    environment.GITHUB_SERVER_URL || "https://github.com",
    "GITHUB_SERVER_URL"
  ).replace(/\/$/, "");
  const workflowRunId = environment.GITHUB_RUN_ID;
  if (workflowRunId && !/^\d{1,30}$/.test(workflowRunId)) {
    throw new Error("GITHUB_RUN_ID is invalid.");
  }
  return {
    repository,
    pullRequestNumber: number,
    pullRequestUrl: httpUrl(pullRequest.html_url, "pull request URL"),
    pullRequestTitle: title,
    changeVersion: updatedAt,
    baseRevision: commit(record(pullRequest.base, "pull request base").sha, "base revision"),
    headRevision: commit(record(pullRequest.head, "pull request head").sha, "head revision"),
    isFork: headRepository !== repository,
    ...(workflowRunId
      ? {
          workflowRunId,
          workflowRunUrl: `${serverUrl}/${repository}/actions/runs/${workflowRunId}`,
        }
      : {}),
  };
}

export function readPullRequestContext(
  environment: NodeJS.ProcessEnv = process.env
): PullRequestIngestionContext {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required for ingestion.");
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    throw new Error("GITHUB_EVENT_PATH did not contain valid JSON.");
  }
  return parsePullRequestContext(event, environment);
}

export function createIngestionPayload(input: {
  context: PullRequestIngestionContext;
  sourcePath: string;
  baseGraph: CanonicalArchitectureGraph;
  headGraph: CanonicalArchitectureGraph;
  policy: ArchitecturePolicy;
}): ArchitectureIngestionPayload {
  const baseRevision = input.baseGraph.source.revision?.toLowerCase();
  const headRevision = input.headGraph.source.revision?.toLowerCase();
  if (
    baseRevision !== input.context.baseRevision ||
    headRevision !== input.context.headRevision
  ) {
    throw new Error("Analyzed revisions do not match the pull request event.");
  }
  const graphRepositories = [
    input.baseGraph.source.repository,
    input.headGraph.source.repository,
  ].filter(Boolean).map((value) => value!.toLowerCase());
  if (graphRepositories.some((value) => value !== input.context.repository)) {
    throw new Error("Analyzed graph repository does not match the pull request event.");
  }
  return {
    repository: input.context.repository,
    pullRequest: {
      number: input.context.pullRequestNumber,
      url: input.context.pullRequestUrl,
      title: input.context.pullRequestTitle,
      changeVersion: input.context.changeVersion,
    },
    sourcePath: input.sourcePath,
    baseRevision: input.context.baseRevision,
    headRevision: input.context.headRevision,
    ...(input.context.workflowRunId && input.context.workflowRunUrl
      ? {
          workflowRun: {
            id: input.context.workflowRunId,
            url: input.context.workflowRunUrl,
          },
        }
      : {}),
    baseGraph: input.baseGraph,
    headGraph: input.headGraph,
    policy: input.policy,
  };
}

function ingestionEndpoint(value: string): string {
  const endpoint = new URL(httpUrl(value, "ingestion-url"));
  if (
    endpoint.pathname.replace(/\/$/, "") !== "/api/review-ingestions/github" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("ingestion-url must end exactly with /api/review-ingestions/github.");
  }
  return endpoint.toString();
}

function parseIngestionResponse(value: unknown): IngestionResponse {
  const body = record(value, "Ingestion response");
  if (!["created", "updated", "unchanged", "stale"].includes(body.status)) {
    throw new Error("Ingestion server returned an invalid status.");
  }
  if (typeof body.reviewId !== "string" || !UUID_PATTERN.test(body.reviewId)) {
    throw new Error("Ingestion server returned an invalid review identifier.");
  }
  const reviewUrl = httpUrl(body.reviewUrl, "ingestion review URL");
  if (!Number.isInteger(body.revision) || body.revision < 1) {
    throw new Error("Ingestion server returned an invalid review revision.");
  }
  if (!["pass", "fail"].includes(body.analysisStatus)) {
    throw new Error("Ingestion server returned an invalid analysis status.");
  }
  if (!Number.isInteger(body.blockingFindings) || body.blockingFindings < 0) {
    throw new Error("Ingestion server returned an invalid blocking finding count.");
  }
  const headRevision = commit(body.headRevision, "ingestion head revision");
  return {
    status: body.status,
    reviewId: body.reviewId,
    reviewUrl,
    revision: body.revision,
    analysisStatus: body.analysisStatus,
    blockingFindings: body.blockingFindings,
    headRevision,
  };
}

export async function uploadArchitectureReview(
  options: UploadOptions
): Promise<IngestionResponse> {
  const endpoint = ingestionEndpoint(options.endpoint);
  if (!/^ssri_[A-Za-z0-9_-]{43}$/.test(options.token)) {
    throw new Error("ingestion-token is malformed.");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, Math.min(options.attempts || 3, 3));
  const body = JSON.stringify(options.payload);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "User-Agent": "system-synthesis-architecture-action/0.1",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt < attempts) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(
        `Architecture review ingestion request failed: ${error instanceof Error ? error.message : "network error"}`
      );
    }

    const text = await response.text();
    let responseBody: unknown;
    try {
      responseBody = text ? JSON.parse(text) : {};
    } catch {
      responseBody = {};
    }
    if (response.ok) {
      const parsed = parseIngestionResponse(responseBody);
      if (
        parsed.status !== "stale" &&
        parsed.headRevision !== options.payload.headRevision
      ) {
        throw new Error("Ingestion server response referenced a different head revision.");
      }
      return parsed;
    }
    if (RETRYABLE_STATUSES.has(response.status) && attempt < attempts) {
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    const message = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      ? (responseBody as Record<string, unknown>).error
      : undefined;
    throw new Error(
      `Architecture review ingestion failed with HTTP ${response.status}${
        typeof message === "string" && message.length <= 300 ? `: ${message}` : ""
      }`
    );
  }
  throw new Error("Architecture review ingestion exhausted its retry budget.");
}
