import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  exchangeCodeForIdentity,
  isGitHubIdentityConfigured,
  readGitHubOAuthConfig,
  signLinkState,
  verifyLinkState,
} from "../githubIdentity.js";
import type { HttpTransport } from "../githubApp.js";

const SECRET = "a-signing-secret-for-tests-only";
const USER = "8f2a1c00-0000-4000-8000-000000000001";
const env = { GITHUB_APP_CLIENT_ID: "Iv1.abc", GITHUB_APP_CLIENT_SECRET: "shhh" };

describe("the value that ties an authorisation to the account that began it", () => {
  it("returns the account that started the link", () => {
    const state = signLinkState(USER, SECRET);
    expect(verifyLinkState(state, SECRET)).toEqual({ userId: USER });
  });

  it("refuses a state that was not signed by this deployment", () => {
    // Without this, anyone could mint a state naming any account and have the
    // callback attach their own GitHub identity to it.
    const state = signLinkState(USER, SECRET);
    expect(verifyLinkState(state, "a-different-secret")).toBeNull();
  });

  it("refuses a state whose account was edited after signing", () => {
    const state = signLinkState(USER, SECRET);
    const [body, signature] = state.split(".");
    const decoded = Buffer.from(body, "base64url").toString("utf8").split(".");
    const forged = Buffer.from(
      ["11111111-0000-4000-8000-000000000002", decoded[1], decoded[2]].join(".")
    ).toString("base64url");
    expect(verifyLinkState(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("refuses an authorisation left unfinished for too long", () => {
    const issued = new Date("2026-08-17T10:00:00.000Z");
    const state = signLinkState(USER, SECRET, issued);
    // Eleven minutes later: a tab opened and forgotten is not evidence.
    const later = new Date(issued.getTime() + 11 * 60 * 1000);
    expect(verifyLinkState(state, SECRET, later)).toBeNull();
    // Nine minutes is still the same act of authorising.
    expect(verifyLinkState(state, SECRET, new Date(issued.getTime() + 9 * 60 * 1000)))
      .toEqual({ userId: USER });
  });

  it("refuses a state that claims to come from the future", () => {
    const issued = new Date("2026-08-17T10:00:00.000Z");
    const state = signLinkState(USER, SECRET, issued);
    const before = new Date(issued.getTime() - 5 * 60 * 1000);
    expect(verifyLinkState(state, SECRET, before)).toBeNull();
  });

  it("refuses malformed input rather than throwing at the callback", () => {
    for (const bad of ["", "no-dot", "a.b.c.d", "!!!.???"]) {
      expect(verifyLinkState(bad, SECRET)).toBeNull();
    }
  });

  it("does not repeat a state for the same account", () => {
    expect(signLinkState(USER, SECRET)).not.toBe(signLinkState(USER, SECRET));
  });
});

describe("configuration", () => {
  it("is absent until both halves are supplied", () => {
    expect(isGitHubIdentityConfigured({})).toBe(false);
    expect(isGitHubIdentityConfigured({ GITHUB_APP_CLIENT_ID: "Iv1.abc" })).toBe(false);
    expect(isGitHubIdentityConfigured(env)).toBe(true);
    expect(readGitHubOAuthConfig(env)).toEqual({ clientId: "Iv1.abc", clientSecret: "shhh" });
  });

  it("sends the reviewer somewhere that carries the state and nothing secret", () => {
    const url = new URL(authorizeUrl(readGitHubOAuthConfig(env)!, "STATE", "https://api.test/cb"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.test/cb");
    // The secret authorises the exchange, and never belongs in a browser.
    expect(url.toString()).not.toContain("shhh");
  });
});

describe("turning an authorisation into an identity", () => {
  const ok: HttpTransport = async (url) =>
    url.includes("access_token")
      ? { status: 200, json: async () => ({ access_token: "gho_token" }) }
      : { status: 200, json: async () => ({ id: 4242, login: "octo-reviewer" }) };

  it("reports the account GitHub says it is", async () => {
    await expect(exchangeCodeForIdentity("code", { env, transport: ok })).resolves.toEqual({
      status: "ok",
      githubUserId: "4242",
      login: "octo-reviewer",
    });
  });

  it("never sends the token anywhere but GitHub", async () => {
    const seen: string[] = [];
    const recording: HttpTransport = async (url, init) => {
      seen.push(`${init.method} ${url}`);
      return ok(url, init);
    };
    await exchangeCodeForIdentity("code", { env, transport: recording });
    expect(seen).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
    ]);
  });

  it("treats a spent or forged code as rejected, not as an identity", async () => {
    // GitHub answers 200 with an error body here, so a naive read of the status
    // would accept a login that was never proven.
    const spent: HttpTransport = async () => ({
      status: 200,
      json: async () => ({ error: "bad_verification_code" }),
    });
    await expect(exchangeCodeForIdentity("code", { env, transport: spent })).resolves.toMatchObject({
      status: "error",
      code: "code_rejected",
    });
  });

  it("refuses an identity response missing what identity is matched on", async () => {
    const partial: HttpTransport = async (url) =>
      url.includes("access_token")
        ? { status: 200, json: async () => ({ access_token: "gho_token" }) }
        : { status: 200, json: async () => ({ login: "octo-reviewer" }) };
    await expect(
      exchangeCodeForIdentity("code", { env, transport: partial })
    ).resolves.toMatchObject({ status: "error", code: "identity_lookup_failed" });
  });

  it("reports an unreachable GitHub with a stable code", async () => {
    const unreachable: HttpTransport = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      exchangeCodeForIdentity("code", { env, transport: unreachable })
    ).resolves.toEqual({ status: "error", code: "github_unreachable", detail: "fetch failed" });
  });

  it("says so when the server was never configured for this", async () => {
    await expect(exchangeCodeForIdentity("code", { env: {}, transport: ok })).resolves.toMatchObject({
      status: "error",
      code: "not_configured",
    });
  });
});
