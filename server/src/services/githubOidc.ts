import { createPublicKey, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import type { HttpTransport } from "./githubApp.js";

/**
 * Verifying the identity token a GitHub Actions run presents.
 *
 * A workflow run can ask GitHub for a short-lived signed statement of what it
 * is: which repository it belongs to, which event started it, which run it is.
 * Accepting that statement in place of a stored ingestion credential removes
 * the secret from the repository entirely — nothing to copy, rotate, or leak —
 * but only if the statement is checked as strictly as the secret was.
 *
 * Four things make a token worth believing, and all four are required:
 *
 * - it is signed by a key GitHub currently publishes, with the one algorithm
 *   GitHub uses, so a token cannot choose a weaker way to be verified;
 * - it names GitHub's issuer exactly;
 * - it was requested for this deployment. A run asks for a token per audience,
 *   and one minted for a cloud provider or another service is a perfectly
 *   valid GitHub token that must still mean nothing here;
 * - it has not expired.
 *
 * What a verified token establishes is where a request came from. It says
 * nothing about whether that repository was ever connected here, or by whom;
 * that is still decided by the connection and the authority behind it.
 */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_KEYS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

/** How long a fetched key set is used before it is fetched again. */
export const OIDC_KEYS_LIFETIME_MS = 60 * 60 * 1000;

/**
 * The least time between two fetches of the key set, whatever asks.
 *
 * A token names the key that signed it, and an unknown name is the normal sign
 * that GitHub rotated its keys. It is also something anybody can put in a
 * forged token. Without this bound every forged token would be a request to
 * GitHub made on a stranger's behalf, before any rate limit applies.
 */
export const OIDC_KEYS_REFRESH_INTERVAL_MS = 60 * 1000;

const CLOCK_TOLERANCE_SECONDS = 60;
/** Well above what GitHub issues, and small enough to refuse before parsing. */
const MAX_TOKEN_LENGTH = 8192;
const MAX_PUBLISHED_KEYS = 32;
const MINIMUM_RSA_BITS = 2048;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMERIC_ID_PATTERN = /^\d{1,20}$/;

/** What a verified token says about the run that presented it. */
export interface GitHubOidcClaims {
  /** `owner/name`, lower-cased. A name can be reused; `repositoryId` cannot. */
  repository: string;
  /** GitHub's immutable numeric id for the repository. */
  repositoryId: string;
  repositoryOwnerId: string;
  eventName: string;
  /** The ref that started the run, e.g. `refs/pull/42/merge`. */
  ref: string;
  runId: string;
  runAttempt: string | null;
  actorId: string | null;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export type GitHubOidcRefusal =
  | "oidc_not_configured"
  | "oidc_token_invalid"
  | "oidc_token_expired"
  | "oidc_audience_mismatch"
  | "oidc_keys_unavailable";

export type GitHubOidcVerdict =
  | { status: "verified"; claims: GitHubOidcClaims }
  | {
      status: "refused";
      code: GitHubOidcRefusal;
      message: string;
      httpStatus: number;
    };

interface KeySet {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

let keySet: KeySet | null = null;
let refreshing: Promise<KeySet | null> | null = null;
let lastRefresh: { at: number; succeeded: boolean } | null = null;

export function resetGitHubOidcKeysForTests(): void {
  keySet = null;
  refreshing = null;
  lastRefresh = null;
}

/**
 * The audience a token must have been requested for: this deployment's own
 * public origin.
 *
 * Taken from configuration and never from the request. A Host header is
 * whatever the caller sent, and an audience read from it would accept a token
 * minted for any name the caller chose to address this server by.
 */
export function gitHubOidcAudience(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PUBLIC_API_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultTransport(): HttpTransport {
  return async (url, init) => {
    const response = await fetch(url, {
      ...init,
      // Key material is only ever read from the address written above.
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, json: () => response.json() };
  };
}

function refuse(
  code: GitHubOidcRefusal,
  message: string,
  httpStatus: number
): GitHubOidcVerdict {
  return { status: "refused", code, message, httpStatus };
}

const invalid = () =>
  refuse(
    "oidc_token_invalid",
    "The GitHub Actions identity token was not accepted.",
    401
  );

async function fetchKeys(transport: HttpTransport, now: number): Promise<KeySet | null> {
  try {
    const response = await transport(GITHUB_OIDC_KEYS_URL, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "system-synthesis" },
    });
    if (response.status !== 200) return null;
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!Array.isArray(body?.keys)) return null;

    const keys = new Map<string, KeyObject>();
    for (const entry of body.keys.slice(0, MAX_PUBLISHED_KEYS)) {
      if (!entry || typeof entry !== "object") continue;
      const published = entry as Record<string, unknown>;
      if (
        published.kty !== "RSA" ||
        typeof published.kid !== "string" ||
        typeof published.n !== "string" ||
        typeof published.e !== "string" ||
        (published.alg !== undefined && published.alg !== "RS256") ||
        (published.use !== undefined && published.use !== "sig")
      ) {
        continue;
      }
      try {
        // Only the modulus and exponent are taken. Everything else a key
        // document can carry, certificate chains included, is ignored.
        const key = createPublicKey({
          key: { kty: "RSA", n: published.n, e: published.e },
          format: "jwk",
        });
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MINIMUM_RSA_BITS) continue;
        keys.set(published.kid, key);
      } catch {
        // One unusable entry does not discard the rest of the set.
      }
    }
    return keys.size ? { keys, fetchedAt: now } : null;
  } catch {
    return null;
  }
}

type KeyLookup =
  | { status: "found"; key: KeyObject }
  | { status: "unknown" }
  | { status: "unavailable" };

async function signingKey(
  keyId: string,
  now: number,
  transport: HttpTransport
): Promise<KeyLookup> {
  const usable = () =>
    keySet !== null && now - keySet.fetchedAt < OIDC_KEYS_LIFETIME_MS ? keySet : null;

  const held = usable()?.keys.get(keyId);
  if (held) return { status: "found", key: held };

  // Either nothing usable is held or this key is not in it. One fetch answers
  // both, and it is shared by everything that arrives while it is in flight.
  if (!refreshing) {
    if (lastRefresh && now - lastRefresh.at < OIDC_KEYS_REFRESH_INTERVAL_MS) {
      // Asked too recently to ask again. A set that was just fetched and does
      // not contain this key is an answer; a fetch that just failed is not.
      return usable() && lastRefresh.succeeded
        ? { status: "unknown" }
        : { status: "unavailable" };
    }
    refreshing = fetchKeys(transport, now).then((fetched) => {
      lastRefresh = { at: now, succeeded: fetched !== null };
      if (fetched) keySet = fetched;
      refreshing = null;
      return fetched;
    });
  }
  const fetched = await refreshing;
  if (!fetched) return { status: "unavailable" };
  const key = fetched.keys.get(keyId);
  return key ? { status: "found", key } : { status: "unknown" };
}

function numericId(value: unknown): string | null {
  if (typeof value === "string" && NUMERIC_ID_PATTERN.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function readClaims(payload: jwt.JwtPayload): GitHubOidcClaims | null {
  const repository = payload.repository;
  const repositoryId = numericId(payload.repository_id);
  const repositoryOwnerId = numericId(payload.repository_owner_id);
  const runId = numericId(payload.run_id);
  if (
    typeof repository !== "string" ||
    repository.length > 200 ||
    !REPOSITORY_PATTERN.test(repository) ||
    !repositoryId ||
    !repositoryOwnerId ||
    !runId ||
    typeof payload.event_name !== "string" ||
    payload.event_name.length > 64 ||
    typeof payload.ref !== "string" ||
    payload.ref.length > 300 ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  return {
    repository: repository.toLowerCase(),
    repositoryId,
    repositoryOwnerId,
    eventName: payload.event_name,
    ref: payload.ref,
    runId,
    runAttempt: numericId(payload.run_attempt),
    actorId: numericId(payload.actor_id),
    expiresAt: payload.exp,
  };
}

function audienceIncludes(claimed: unknown, expected: string): boolean {
  if (typeof claimed === "string") return claimed === expected;
  return Array.isArray(claimed) && claimed.includes(expected);
}

export async function verifyGitHubOidcToken(
  token: string,
  options: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date } = {}
): Promise<GitHubOidcVerdict> {
  const audience = gitHubOidcAudience(options.env ?? process.env);
  if (!audience) {
    return refuse(
      "oidc_not_configured",
      "This deployment does not accept GitHub Actions identity tokens: it has no public " +
        "address configured to require them for. Use a repository ingestion token instead.",
      501
    );
  }

  if (token.length > MAX_TOKEN_LENGTH) return invalid();
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded.payload !== "object" || decoded.payload === null) {
    return invalid();
  }
  const { header, payload } = decoded;

  // The algorithm is fixed here, before any key is looked up, and again by the
  // verification below. A token does not get to say how it should be checked:
  // "none" is no signature, and a symmetric algorithm would be verified with
  // the published public key as its secret.
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.kid.length > 200
  ) {
    return invalid();
  }

  // Read from a payload nothing has vouched for yet, purely so that a token
  // which could never be accepted does not cost a key lookup. They decide
  // nothing on their own: verification repeats every one of them once the
  // signature holds.
  const nowMs = (options.now ?? new Date()).getTime();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.iss !== GITHUB_OIDC_ISSUER) return invalid();
  if (!audienceIncludes(payload.aud, audience)) {
    return refuse(
      "oidc_audience_mismatch",
      `The GitHub Actions identity token was requested for a different audience. This ` +
        `deployment accepts tokens requested for ${audience}; point ingestion-url at ` +
        `that address.`,
      401
    );
  }
  if (typeof payload.exp !== "number") return invalid();
  if (payload.exp + CLOCK_TOLERANCE_SECONDS < nowSeconds) {
    return refuse(
      "oidc_token_expired",
      "The GitHub Actions identity token has expired. Re-run the workflow to mint a new one.",
      401
    );
  }

  const lookup = await signingKey(
    header.kid,
    nowMs,
    options.transport ?? defaultTransport()
  );
  if (lookup.status === "unavailable") {
    return refuse(
      "oidc_keys_unavailable",
      "GitHub's signing keys could not be retrieved, so the identity token could not be " +
        "verified. Nothing has been recorded; try again shortly.",
      503
    );
  }
  if (lookup.status === "unknown") return invalid();

  let verified: jwt.JwtPayload;
  try {
    const result = jwt.verify(token, lookup.key, {
      algorithms: ["RS256"],
      issuer: GITHUB_OIDC_ISSUER,
      audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      clockTimestamp: nowSeconds,
    });
    if (typeof result !== "object" || result === null) return invalid();
    verified = result;
  } catch {
    return invalid();
  }

  const claims = readClaims(verified);
  return claims ? { status: "verified", claims } : invalid();
}
