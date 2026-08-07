import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppJwt,
  getInstallationToken,
  isGitHubAppConfigured,
  readGitHubAppConfig,
  resetGitHubAppCacheForTests,
  type HttpTransport,
} from "../githubApp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const env = { GITHUB_APP_ID: "1234", GITHUB_APP_PRIVATE_KEY: privateKey };
const NOW = new Date("2026-08-07T12:00:00.000Z");

function transportFor(steps: Array<{ status: number; body: unknown }>): {
  transport: HttpTransport;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    transport: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      const step = steps[Math.min(index++, steps.length - 1)];
      return { status: step.status, json: async () => step.body };
    },
  };
}

/** Answers by endpoint, so it stays correct across repeated exchanges. */
function installedTransport(expiresAt: string, token = "ghs_installation") {
  const calls: string[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith("/installation")) {
      return { status: 200, json: async () => ({ id: 42 }) };
    }
    return { status: 201, json: async () => ({ token, expires_at: expiresAt }) };
  };
  return { transport, calls };
}

describe("GitHub App credentials", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  it("treats missing credentials as unconfigured rather than broken", () => {
    expect(readGitHubAppConfig({})).toBeNull();
    expect(isGitHubAppConfigured({})).toBe(false);
    expect(isGitHubAppConfigured({ GITHUB_APP_ID: "1234" })).toBe(false);
    expect(isGitHubAppConfigured(env)).toBe(true);
  });

  it("restores a PEM flattened by environment-variable escaping", () => {
    const flattened = privateKey.replace(/\n/g, "\\n");
    expect(
      readGitHubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: flattened })
        ?.privateKey
    ).toBe(privateKey);
  });

  it("signs an assertion GitHub will accept", () => {
    const token = createAppJwt(readGitHubAppConfig(env)!, NOW);
    // Verified against the same instant it was signed at, not the wall clock.
    const claims = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      clockTimestamp: Math.floor(NOW.getTime() / 1000),
    }) as { iss: string; iat: number; exp: number };
    const issuedSeconds = Math.floor(NOW.getTime() / 1000);

    expect(claims.iss).toBe("1234");
    // Backdated against clock skew, and inside the ten minutes GitHub allows.
    expect(claims.iat).toBeLessThan(issuedSeconds);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(issuedSeconds);
  });

  it("refuses to sign with the wrong key", () => {
    const token = createAppJwt(readGitHubAppConfig(env)!, NOW);
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).publicKey;
    expect(() =>
      jwt.verify(token, other, {
        algorithms: ["RS256"],
        clockTimestamp: Math.floor(NOW.getTime() / 1000),
      })
    ).toThrow(/signature/i);
  });
});

describe("installation tokens", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  it("reports an unconfigured deployment without attempting a request", async () => {
    const { transport, calls } = installedTransport("2026-08-07T13:00:00.000Z");
    await expect(
      getInstallationToken("acme/shop", { env: {}, transport, now: NOW })
    ).resolves.toEqual({ status: "not_configured" });
    expect(calls).toEqual([]);
  });

  it("separates a repository without the App installed from a failure", async () => {
    const { transport } = transportFor([{ status: 404, body: {} }]);
    await expect(
      getInstallationToken("acme/shop", { env, transport, now: NOW })
    ).resolves.toEqual({ status: "not_installed" });
  });

  it("exchanges the assertion for a short-lived installation token", async () => {
    const { transport, calls } = installedTransport("2026-08-07T13:00:00.000Z");
    const result = await getInstallationToken("acme/shop", { env, transport, now: NOW });

    expect(result).toMatchObject({ status: "ok", token: "ghs_installation" });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/acme/shop/installation",
      "POST https://api.github.com/app/installations/42/access_tokens",
    ]);
  });

  it("reuses a cached token instead of minting one per request", async () => {
    const { transport, calls } = installedTransport("2026-08-07T13:00:00.000Z");
    await getInstallationToken("acme/shop", { env, transport, now: NOW });
    await getInstallationToken("acme/shop", { env, transport, now: NOW });
    expect(calls).toHaveLength(2);
  });

  it("never lends one repository's token to another", async () => {
    const first = installedTransport("2026-08-07T13:00:00.000Z", "ghs_shop");
    const second = installedTransport("2026-08-07T13:00:00.000Z", "ghs_other");
    await getInstallationToken("acme/shop", { env, transport: first.transport, now: NOW });
    const other = await getInstallationToken("acme/other", {
      env,
      transport: second.transport,
      now: NOW,
    });
    expect(other).toMatchObject({ token: "ghs_other" });
  });

  it("mints again rather than presenting a token about to expire", async () => {
    const { transport, calls } = installedTransport("2026-08-07T12:00:30.000Z");
    await getInstallationToken("acme/shop", { env, transport, now: NOW });
    // 30s of life left is inside the refresh margin, so the cache must not serve it.
    await getInstallationToken("acme/shop", { env, transport, now: NOW });
    expect(calls).toHaveLength(4);
  });

  it("reports a refused exchange without echoing the signed assertion", async () => {
    const { transport } = transportFor([
      { status: 200, body: { id: 42 } },
      { status: 401, body: { message: "Bad credentials" } },
    ]);
    const result = await getInstallationToken("acme/shop", { env, transport, now: NOW });

    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });

  it("rejects a malformed token response instead of caching nonsense", async () => {
    const { transport } = transportFor([
      { status: 200, body: { id: 42 } },
      { status: 201, body: { token: "ghs_x", expires_at: "not-a-time" } },
    ]);
    await expect(
      getInstallationToken("acme/shop", { env, transport, now: NOW })
    ).resolves.toMatchObject({ status: "error" });
  });

  it("surfaces a transport failure as an error rather than throwing", async () => {
    const transport = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as HttpTransport;
    await expect(
      getInstallationToken("acme/shop", { env, transport, now: NOW })
    ).resolves.toEqual({ status: "error", reason: "socket hang up" });
  });
});
