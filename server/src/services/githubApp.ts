import jwt from "jsonwebtoken";

/**
 * GitHub App credentials.
 *
 * A GitHub App is used rather than a personal access token so that access is
 * scoped to the repositories an owner installs it on, granted per-installation,
 * and carried by a token that expires in an hour. Nothing here is long-lived:
 * the private key signs a short assertion, and the assertion buys a short token.
 */
const APP_JWT_LIFETIME_SECONDS = 540; // GitHub rejects anything over 10 minutes.
const APP_JWT_BACKDATE_SECONDS = 60; // Absorbs clock skew against GitHub.
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const GITHUB_API = "https://api.github.com";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

/**
 * Why a credential could not be obtained, as a fixed vocabulary.
 *
 * These are stored on the review and shown to a reviewer, so they must be
 * stable enough to write an explanation against and safe to display. An
 * exception message is neither: it varies with the runtime, and it can carry a
 * path, a hostname or a fragment of a request that nobody outside the server
 * should read. The message itself is logged for whoever operates the service.
 */
export type CredentialFailureCode =
  | "credential_unusable"
  | "credential_rejected"
  | "installation_lookup_failed"
  | "token_request_failed"
  | "github_unreachable";

/**
 * What an installation is actually allowed to do, as GitHub reports it when it
 * mints the token.
 *
 * Keys are GitHub's own permission names (`checks`, `pull_requests`,
 * `metadata`) and values are `read` or `write`. Carried so a caller can tell a
 * permission that was never granted from a request that failed, which are
 * different problems with different remedies: one needs an operator to change
 * the App, the other needs waiting.
 *
 * Absent when the response did not describe them, which is not the same as an
 * empty set and must not be read as one.
 */
export type InstallationPermissions = Record<string, string>;

export type InstallationTokenResult =
  | {
      status: "ok";
      token: string;
      expiresAt: string;
      permissions?: InstallationPermissions;
      /**
       * Whether this came from the cache rather than from GitHub just now. A
       * token minted during this call already describes the current grant, so
       * there is nothing a second look could discover.
       */
      fromCache?: boolean;
    }
  | { status: "not_configured" }
  | { status: "not_installed" }
  | { status: "error"; code: CredentialFailureCode; detail: string };

/**
 * Response headers a caller may act on, lower-cased.
 *
 * Deliberately an allow-list rather than the whole response. A caller needs to
 * tell a refusal about permission from a refusal about rate, and nothing else
 * about the response is any of its business — keeping the rest out means a
 * header that later carries something sensitive cannot leak through here.
 */
export type SafeResponseHeaders = Partial<
  Record<"x-ratelimit-remaining" | "retry-after" | "x-accepted-github-permissions", string>
>;

export const SAFE_RESPONSE_HEADERS = [
  "x-ratelimit-remaining",
  "retry-after",
  "x-accepted-github-permissions",
] as const;

/** The allow-listed headers from a real response, and nothing else. */
export function readSafeHeaders(source: {
  get(name: string): string | null;
}): SafeResponseHeaders {
  const headers: SafeResponseHeaders = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = source.get(name);
    if (typeof value === "string" && value.length) headers[name] = value;
  }
  return headers;
}

/**
 * Injectable so tests never reach the network.
 *
 * `headers` is optional: a transport that does not report them leaves a caller
 * with no evidence, which must resolve to the conservative answer rather than a
 * confident one.
 */
export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  headers?: SafeResponseHeaders;
}>;

interface CachedToken {
  token: string;
  expiresAtMs: number;
  permissions?: InstallationPermissions;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * How often a caller may discard a cached token to pick up a changed grant.
 *
 * A token lives about an hour and carries the permissions granted when it was
 * minted, so an installation that accepts a new permission would otherwise
 * stay locked out until the token expired. Discarding on demand fixes that and
 * would let a stream of refused decisions mint a token per request, so it is
 * allowed once per repository per interval and is a no-op in between.
 */
export const FORCED_REFRESH_INTERVAL_MS = 60_000;
const forcedRefreshAt = new Map<string, number>();

/**
 * Mints in progress, so concurrent callers share one request.
 *
 * Without this the cache is empty for every caller that arrives before the
 * first response lands, and each mints its own token. That is the burst the
 * interval was meant to prevent and does not, because the interval only decides
 * whether to discard the cache, not who is already asking.
 *
 * Both the bound and this map live in this process. A deployment running
 * several instances bounds each of them separately, so the worst case is one
 * mint per instance per interval rather than one overall.
 */
const inFlight = new Map<string, Promise<InstallationTokenResult>>();

export function resetGitHubAppCacheForTests(): void {
  tokenCache.clear();
  forcedRefreshAt.clear();
  inFlight.clear();
}

/**
 * A PEM supplied through an environment variable usually arrives with literal
 * "\n" rather than newlines, which silently breaks signing.
 */
function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export function readGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env
): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return null;
  return { appId, privateKey: normalizePrivateKey(privateKey) };
}

export function isGitHubAppConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGitHubAppConfig(env) !== null;
}

/**
 * Short-lived assertion proving control of the App's private key. It authorizes
 * discovering installations and minting installation tokens — never repository
 * content itself.
 */
export function createAppJwt(
  config: GitHubAppConfig,
  now: Date = new Date()
): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - APP_JWT_BACKDATE_SECONDS;
  return jwt.sign(
    {
      iat: issuedAt,
      exp: issuedAt + APP_JWT_LIFETIME_SECONDS + APP_JWT_BACKDATE_SECONDS,
      iss: config.appId,
    },
    config.privateKey,
    { algorithm: "RS256" }
  );
}

/**
 * The permission map from a token response, or undefined when the response did
 * not carry one. A response that says nothing about permissions is not a
 * response saying none were granted.
 */
function readPermissions(value: unknown): InstallationPermissions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

async function readJson(response: {
  json: () => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * Installation token for one repository, cached until shortly before it expires.
 *
 * Repository identity comes from the caller's already-validated integration
 * record, and GitHub resolves it to an installation; an owner who has not
 * installed the App is reported as such rather than as a failure, because it is
 * a setup state rather than an error.
 */
export async function getInstallationToken(
  repository: string,
  options: {
    env?: NodeJS.ProcessEnv;
    transport?: HttpTransport;
    now?: Date;
    /**
     * Discard any cached token first, so a grant changed since it was minted is
     * seen. Rate-limited: ignored if this repository already forced one within
     * the interval, so a burst of callers cannot turn into a burst of tokens.
     */
    refresh?: boolean;
  } = {}
): Promise<InstallationTokenResult> {
  const config = readGitHubAppConfig(options.env);
  if (!config) return { status: "not_configured" };

  const now = options.now ?? new Date();
  if (options.refresh) {
    const last = forcedRefreshAt.get(repository) ?? 0;
    if (now.getTime() - last >= FORCED_REFRESH_INTERVAL_MS) {
      forcedRefreshAt.set(repository, now.getTime());
      tokenCache.delete(repository);
    }
  }
  const cached = tokenCache.get(repository);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now.getTime()) {
    return {
      status: "ok",
      token: cached.token,
      expiresAt: new Date(cached.expiresAtMs).toISOString(),
      permissions: cached.permissions,
      fromCache: true,
    };
  }

  // One request per repository at a time. Everybody who arrives while it is in
  // flight receives the same freshly minted token.
  const existing = inFlight.get(repository);
  if (existing) return existing;
  const attempt = mintInstallationToken(repository, config, now, options.transport);
  inFlight.set(repository, attempt);
  try {
    return await attempt;
  } finally {
    inFlight.delete(repository);
  }
}

async function mintInstallationToken(
  repository: string,
  config: GitHubAppConfig,
  now: Date,
  injected?: HttpTransport
): Promise<InstallationTokenResult> {
  const options = { transport: injected };
  const transport: HttpTransport =
    options.transport ??
    (async (url, init) => {
      const response = await fetch(url, init);
      return {
        status: response.status,
        json: () => response.json(),
        headers: readSafeHeaders(response.headers),
      };
    });

  try {
    // Inside the guard: a private key that cannot be parsed makes signing throw,
    // and an exception escaping here would leave the caller unable to record
    // that publishing failed at all.
    const appJwt = createAppJwt(config, now);
    const headers = {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "system-synthesis",
    };

    const installation = await transport(
      `${GITHUB_API}/repos/${repository}/installation`,
      { method: "GET", headers }
    );
    if (installation.status === 404) return { status: "not_installed" };
    if (installation.status === 401 || installation.status === 403) {
      return {
        status: "error",
        code: "credential_rejected",
        detail: `installation lookup returned ${installation.status}`,
      };
    }
    if (installation.status !== 200) {
      return {
        status: "error",
        code: "installation_lookup_failed",
        detail: `installation lookup returned ${installation.status}`,
      };
    }
    const installationId = (await readJson(installation)).id;
    if (typeof installationId !== "number") {
      return {
        status: "error",
        code: "installation_lookup_failed",
        detail: "installation response omitted an id",
      };
    }

    const minted = await transport(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers }
    );
    if (minted.status !== 201) {
      return {
        status: "error",
        code: minted.status === 401 || minted.status === 403
          ? "credential_rejected"
          : "token_request_failed",
        detail: `token request returned ${minted.status}`,
      };
    }
    const body = await readJson(minted);
    const token = body.token;
    const expiresAt = body.expires_at;
    if (typeof token !== "string" || typeof expiresAt !== "string") {
      return {
        status: "error",
        code: "token_request_failed",
        detail: "token response was incomplete",
      };
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return {
        status: "error",
        code: "token_request_failed",
        detail: "token expiry was not a valid time",
      };
    }

    const permissions = readPermissions(body.permissions);
    tokenCache.set(repository, { token, expiresAtMs, permissions });
    return { status: "ok", token, expiresAt, permissions, fromCache: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "installation token request failed";
    // Never surface the underlying request, which carries the signed assertion.
    return {
      status: "error",
      code: isSigningFailure(error) ? "credential_unusable" : "github_unreachable",
      detail,
    };
  }
}

/**
 * Whether the key itself is the problem rather than the network.
 *
 * A reviewer can do nothing about either, but an operator can: one needs the
 * App's private key replaced, the other needs waiting out.
 */
function isSigningFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "JsonWebTokenError" ||
    /secretOrPrivateKey|PEM|asn1|DECODER|unsupported/i.test(error.message)
  );
}
