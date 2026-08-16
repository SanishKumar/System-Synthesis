import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { HttpTransport } from "./githubApp.js";

/**
 * Proving which GitHub account a reviewer is.
 *
 * The App proves the application. It says nothing about the person clicking
 * approve, so a decision is currently attributed to whoever holds a System
 * Synthesis session — an identity this service issued to itself. Nothing in
 * that chain reaches GitHub, which is why the gate cannot yet answer "was this
 * approver entitled to approve".
 *
 * This is the part that reaches GitHub: the reviewer authorises the App as
 * themselves, and GitHub tells us who they are. Entitlement — collaborator
 * permission, code ownership, not being the author of the change — is decided
 * afterwards, and needs this first.
 *
 * The access token is deliberately not kept. It is used once, to ask GitHub who
 * the bearer is, and discarded. Later checks read repository permissions
 * through the App's installation token, which the server already holds, so
 * storing a second long-lived credential per user would add exposure without
 * adding an answer.
 */
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

/** How long an authorisation may sit unfinished before it stops being valid. */
const STATE_LIFETIME_MS = 10 * 60 * 1000;

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Stable, safe reasons a link attempt failed, for the same reason the publish
 * path has them: a reviewer reads these, so they cannot be exception text.
 */
export type IdentityFailureCode =
  | "not_configured"
  | "state_invalid"
  | "code_rejected"
  | "identity_lookup_failed"
  | "github_unreachable"
  | "already_linked"
  | "unexpected_error";

export type GitHubIdentityResult =
  | { status: "ok"; githubUserId: string; login: string }
  | { status: "error"; code: IdentityFailureCode; detail: string };

export interface VerifiedGitHubIdentity {
  githubUserId: string;
  login: string;
}

export function readGitHubOAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): GitHubOAuthConfig | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGitHubIdentityConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGitHubOAuthConfig(env) !== null;
}

/**
 * A one-time value tying the authorisation that comes back to the account that
 * started it.
 *
 * Signed rather than stored, so it survives a restart and needs no cleanup, and
 * carries the account it belongs to: a callback cannot attach a GitHub identity
 * to anyone but the session that asked for it. It expires, because an
 * authorisation left open in a tab overnight is not evidence of anything.
 */
export function signLinkState(
  userId: string,
  secret: string,
  now: Date = new Date()
): string {
  const payload = `${userId}.${now.getTime()}.${randomBytes(12).toString("base64url")}`;
  const body = Buffer.from(payload).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifyLinkState(
  state: string,
  secret: string,
  now: Date = new Date()
): { userId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!matches(sign(body, secret), signature)) return null;

  const decoded = Buffer.from(body, "base64url").toString("utf8").split(".");
  if (decoded.length !== 3) return null;
  const [userId, issuedAt] = decoded;
  const issued = Number(issuedAt);
  if (!userId || !Number.isFinite(issued)) return null;
  if (now.getTime() - issued > STATE_LIFETIME_MS) return null;
  if (issued - now.getTime() > 60_000) return null; // issued in the future
  return { userId };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function matches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where the reviewer is sent to authorise, as themselves. */
export function authorizeUrl(
  config: GitHubOAuthConfig,
  state: string,
  redirectUri: string
): string {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

function defaultTransport(): HttpTransport {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, json: () => response.json() };
  };
}

/**
 * Turns an authorisation code into the identity behind it.
 *
 * The token never leaves this function. Nothing about the reviewer is taken
 * from the browser: the login and the account id come from GitHub's answer to a
 * request the server made itself.
 */
export async function exchangeCodeForIdentity(
  code: string,
  options: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; redirectUri?: string } = {}
): Promise<GitHubIdentityResult> {
  const config = readGitHubOAuthConfig(options.env);
  if (!config) {
    return { status: "error", code: "not_configured", detail: "GitHub identity is not configured" };
  }
  const transport = options.transport ?? defaultTransport();

  try {
    const exchanged = await transport(GITHUB_ACCESS_TOKEN, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "system-synthesis",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
      }),
    });

    if (exchanged.status !== 200) {
      return {
        status: "error",
        code: "code_rejected",
        detail: `token exchange returned ${exchanged.status}`,
      };
    }
    const body = (await exchanged.json().catch(() => null)) as
      | { access_token?: unknown; error?: unknown }
      | null;
    const token = body?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      // GitHub answers 200 with an error body for a spent or forged code.
      return {
        status: "error",
        code: "code_rejected",
        detail: typeof body?.error === "string" ? body.error : "token exchange returned no token",
      };
    }

    const identity = await transport(`${GITHUB_API}/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "system-synthesis",
      },
    });
    if (identity.status !== 200) {
      return {
        status: "error",
        code: "identity_lookup_failed",
        detail: `identity lookup returned ${identity.status}`,
      };
    }
    const user = (await identity.json().catch(() => null)) as
      | { id?: unknown; login?: unknown }
      | null;
    // Matching is on the numeric id, which GitHub does not reuse; the login is
    // held for display and can change under the same account.
    if (typeof user?.id !== "number" || typeof user?.login !== "string") {
      return {
        status: "error",
        code: "identity_lookup_failed",
        detail: "identity response was incomplete",
      };
    }
    return { status: "ok", githubUserId: String(user.id), login: user.login };
  } catch (error) {
    return {
      status: "error",
      code: "github_unreachable",
      // Never surface the request, which carries the client secret.
      detail: error instanceof Error ? error.message : "identity exchange failed",
    };
  }
}
