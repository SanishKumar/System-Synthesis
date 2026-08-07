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

export type InstallationTokenResult =
  | { status: "ok"; token: string; expiresAt: string }
  | { status: "not_configured" }
  | { status: "not_installed" }
  | { status: "error"; reason: string };

/** Injectable so tests never reach the network. */
export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

export function resetGitHubAppCacheForTests(): void {
  tokenCache.clear();
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
  } = {}
): Promise<InstallationTokenResult> {
  const config = readGitHubAppConfig(options.env);
  if (!config) return { status: "not_configured" };

  const now = options.now ?? new Date();
  const cached = tokenCache.get(repository);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now.getTime()) {
    return {
      status: "ok",
      token: cached.token,
      expiresAt: new Date(cached.expiresAtMs).toISOString(),
    };
  }

  const transport: HttpTransport =
    options.transport ??
    (async (url, init) => {
      const response = await fetch(url, init);
      return { status: response.status, json: () => response.json() };
    });

  const appJwt = createAppJwt(config, now);
  const headers = {
    Authorization: `Bearer ${appJwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "system-synthesis",
  };

  try {
    const installation = await transport(
      `${GITHUB_API}/repos/${repository}/installation`,
      { method: "GET", headers }
    );
    if (installation.status === 404) return { status: "not_installed" };
    if (installation.status !== 200) {
      return { status: "error", reason: `installation lookup returned ${installation.status}` };
    }
    const installationId = (await readJson(installation)).id;
    if (typeof installationId !== "number") {
      return { status: "error", reason: "installation response omitted an id" };
    }

    const minted = await transport(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers }
    );
    if (minted.status !== 201) {
      return { status: "error", reason: `token request returned ${minted.status}` };
    }
    const body = await readJson(minted);
    const token = body.token;
    const expiresAt = body.expires_at;
    if (typeof token !== "string" || typeof expiresAt !== "string") {
      return { status: "error", reason: "token response was incomplete" };
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return { status: "error", reason: "token expiry was not a valid time" };
    }

    tokenCache.set(repository, { token, expiresAtMs });
    return { status: "ok", token, expiresAt };
  } catch (error) {
    // Never surface the underlying request, which carries the signed assertion.
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "installation token request failed",
    };
  }
}
