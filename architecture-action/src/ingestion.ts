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

/**
 * What a delivery proves its repository with: the ingestion token stored as a
 * repository secret, or the identity token GitHub issues to this run.
 */
export type IngestionCredentialKind = "token" | "identity";

export type IngestionPlan =
  /** Nothing is configured; the review stays local. */
  | { action: "none" }
  /** Configured, but this run is one that cannot deliver. Not a failure. */
  | { action: "skip"; reason: string }
  | { action: "upload"; credential: IngestionCredentialKind };

/**
 * Decide whether this run delivers a browser review, and what it proves
 * itself with.
 *
 * `ingestion-url` on its own means GitHub OIDC: the run asks GitHub for an
 * identity token, so the repository holds no secret. Adding `ingestion-token`
 * means that token and nothing else; a run never falls back from one to the
 * other, because the server accepts exactly one of them per repository.
 */
export function planIngestion(input: {
  endpoint: string;
  token: string;
  isFork: boolean;
  /** Whether GitHub gave this run somewhere to ask for an identity token. */
  identityTokenAvailable: boolean;
  actor?: string;
}): IngestionPlan {
  const endpoint = input.endpoint.trim();
  const token = input.token.trim();
  if (!endpoint) {
    if (token) {
      throw new Error(
        "ingestion-token is set but ingestion-url is not. Set ingestion-url as well, or " +
          "remove both to keep the review local."
      );
    }
    return { action: "none" };
  }
  // Before anything else: a fork's run is given neither a secret nor an
  // identity token, and its content is not the repository's to vouch for.
  if (input.isFork) {
    return {
      action: "skip",
      reason: "Browser review ingestion skipped for a fork pull request.",
    };
  }
  if (token) return { action: "upload", credential: "token" };
  if (input.identityTokenAvailable) return { action: "upload", credential: "identity" };
  // GitHub withholds repository secrets from Dependabot's pull requests and
  // runs them with reduced permissions, so a workflow that delivers every
  // other pull request can arrive here with no credential of either kind.
  // That is not a misconfiguration to fail every dependency update on; the
  // review stays local.
  if (input.actor === "dependabot[bot]") {
    return {
      action: "skip",
      reason:
        "Browser review ingestion skipped: this Dependabot run was given neither an " +
        "ingestion token nor an identity token.",
    };
  }
  throw new Error(
    "ingestion-url is set without ingestion-token, so this run authenticates with GitHub " +
      "OIDC, but the job cannot request an identity token. Add `id-token: write` to the " +
      "job's permissions. If a stored token was intended, ingestion-token reached the " +
      "Action empty."
  );
}

interface UploadOptions {
  endpoint: string;
  token: string;
  /** Which kind `token` is. A stored ingestion token unless said otherwise. */
  credential?: IngestionCredentialKind;
  payload: ArchitectureIngestionPayload;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
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
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new Error(`${label} must be HTTPS (or loopback HTTP) and contain no credentials.`);
  }
  return url.toString();
}

export function parsePullRequestRevisions(
  event: unknown,
  environment: NodeJS.ProcessEnv = process.env
): Pick<PullRequestIngestionContext, "repository" | "baseRevision" | "headRevision"> {
  if (environment.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("Architecture review context only supports pull_request events.");
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
  return {
    repository,
    baseRevision: commit(record(pullRequest.base, "pull request base").sha, "base revision"),
    headRevision: commit(record(pullRequest.head, "pull request head").sha, "head revision"),
  };
}

export function parsePullRequestContext(
  event: unknown,
  environment: NodeJS.ProcessEnv = process.env
): PullRequestIngestionContext {
  const revisions = parsePullRequestRevisions(event, environment);
  const { repository } = revisions;
  const pullRequest = record(record(event).pull_request, "GitHub pull request");
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
    baseRevision: revisions.baseRevision,
    headRevision: revisions.headRevision,
    isFork: headRepository !== repository,
    ...(workflowRunId
      ? {
          workflowRunId,
          workflowRunUrl: `${serverUrl}/${repository}/actions/runs/${workflowRunId}`,
        }
      : {}),
  };
}

export function readPullRequestEvent(
  environment: NodeJS.ProcessEnv = process.env
): unknown {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required to read pull request metadata.");
  try {
    return JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    throw new Error("GITHUB_EVENT_PATH did not contain valid JSON.");
  }
}

export function readPullRequestContext(
  environment: NodeJS.ProcessEnv = process.env
): PullRequestIngestionContext {
  return parsePullRequestContext(readPullRequestEvent(environment), environment);
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

/**
 * The audience an identity token is requested for: the origin the delivery is
 * about to be sent to.
 *
 * The endpoint is validated first, so a token is never minted for an address
 * this Action would then refuse to send to. Binding the token to the origin is
 * what makes it worthless anywhere else: a server that receives one can only
 * replay it to itself.
 */
export function ingestionAudience(endpoint: string): string {
  return new URL(ingestionEndpoint(endpoint)).origin;
}

/** Three base64url segments, bounded: a signed token and nothing else. */
const IDENTITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_IDENTITY_TOKEN_LENGTH = 8192;

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
  // Each kind is held to its own shape, so one is never sent in place of the
  // other and nothing unrecognisable is sent at all.
  if (options.credential === "identity") {
    if (
      options.token.length > MAX_IDENTITY_TOKEN_LENGTH ||
      !IDENTITY_TOKEN_PATTERN.test(options.token)
    ) {
      throw new Error("GitHub did not return a usable identity token.");
    }
  } else if (!/^ssri_[A-Za-z0-9_-]{43}$/.test(options.token)) {
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
        redirect: "manual",
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
