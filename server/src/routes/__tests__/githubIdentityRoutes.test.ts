import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/db.js", () => ({ getPool: () => null }));

const originalFetch = globalThis.fetch;
/** What GitHub answers during a link attempt. */
const github = { tokenStatus: 200, tokenBody: { access_token: "gho_x" }, user: { id: 4242, login: "octo-reviewer" } };

import { signToken, signingSecret } from "../../middleware/auth.js";
import { signLinkState } from "../../services/githubIdentity.js";
import authRouter from "../auth.js";

let server: Server | null = null;

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("no test address");
  return `http://127.0.0.1:${address.port}`;
}

async function register(baseUrl: string, email: string) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName: "Reviewer", email, password: "a-long-enough-password" }),
  });
  return (await response.json()) as { token: string; user: { userId: string } };
}

describe("linking a GitHub identity to an account", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc";
    process.env.GITHUB_APP_CLIENT_SECRET = "shhh";
    process.env.FRONTEND_URL = "http://localhost:3000";
    github.tokenStatus = 200;
    github.tokenBody = { access_token: "gho_x" };
    github.user = { id: 4242, login: "octo-reviewer" };

    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify(github.tokenBody), { status: github.tokenStatus });
      }
      if (url.includes("api.github.com/user")) {
        return new Response(JSON.stringify(github.user), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  interface Me { github: { userId: string; login: string } | null }
  const me = async (baseUrl: string, token: string): Promise<Me> =>
    (await (await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json()) as Me;

  const reason = (response: Response) =>
    new URL(response.headers.get("location") || "http://x/").searchParams.get("github");

  it("will not start a link for an unauthenticated caller", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/auth/github/start`);
    expect(response.status).toBe(401);
  });

  it("hands back an authorisation URL carrying a state, and no secret", async () => {
    const baseUrl = await startApp();
    const { token } = await register(baseUrl, "one@example.test");
    const response = await fetch(`${baseUrl}/api/auth/github/start`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { url: string };
    const url = new URL(body.url);
    expect(url.host).toBe("github.com");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(body.url).not.toContain("shhh");
  });

  it("records the identity against the account that began the link", async () => {
    const baseUrl = await startApp();
    const { token, user } = await register(baseUrl, "two@example.test");
    const state = signLinkState(user.userId, signingSecret());

    const callback = await fetch(
      `${baseUrl}/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    expect(reason(callback)).toBe("linked");

    const current = await me(baseUrl, token);
    expect(current.github).toMatchObject({ userId: "4242", login: "octo-reviewer" });
  });

  it("refuses a callback whose state this server did not sign", async () => {
    const baseUrl = await startApp();
    const { token, user } = await register(baseUrl, "three@example.test");
    // A state minted elsewhere, naming this account: the attack the signature
    // exists to stop, arriving at the endpoint that would act on it.
    const forged = signLinkState(user.userId, "not-this-servers-secret");

    const callback = await fetch(
      `${baseUrl}/api/auth/github/callback?code=abc&state=${encodeURIComponent(forged)}`,
      { redirect: "manual" }
    );
    expect(reason(callback)).toBe("state_invalid");

    const current = await me(baseUrl, token);
    expect(current.github).toBeNull();
  });

  it("refuses a callback with no state at all", async () => {
    const baseUrl = await startApp();
    const callback = await fetch(`${baseUrl}/api/auth/github/callback?code=abc`, {
      redirect: "manual",
    });
    expect(reason(callback)).toBe("state_invalid");
  });

  it("will not let a second account claim the same GitHub identity", async () => {
    const baseUrl = await startApp();
    const first = await register(baseUrl, "first@example.test");
    const second = await register(baseUrl, "second@example.test");

    await fetch(
      `${baseUrl}/api/auth/github/callback?code=abc&state=${encodeURIComponent(signLinkState(first.user.userId, signingSecret()))}`,
      { redirect: "manual" }
    );
    const second_attempt = await fetch(
      `${baseUrl}/api/auth/github/callback?code=abc&state=${encodeURIComponent(signLinkState(second.user.userId, signingSecret()))}`,
      { redirect: "manual" }
    );

    // Two accounts answering to one person would make "who approved this"
    // ambiguous exactly where it has to be decidable.
    expect(reason(second_attempt)).toBe("already_linked");
    const current = await me(baseUrl, second.token);
    expect(current.github).toBeNull();
  });

  it("reports a rejected code without linking anything", async () => {
    const baseUrl = await startApp();
    const { token, user } = await register(baseUrl, "four@example.test");
    github.tokenBody = { error: "bad_verification_code" } as never;

    const callback = await fetch(
      `${baseUrl}/api/auth/github/callback?code=spent&state=${encodeURIComponent(signLinkState(user.userId, signingSecret()))}`,
      { redirect: "manual" }
    );
    expect(reason(callback)).toBe("code_rejected");
    const current = await me(baseUrl, token);
    expect(current.github).toBeNull();
  });

  it("lets an account undo a link it should not have made", async () => {
    const baseUrl = await startApp();
    const { token, user } = await register(baseUrl, "five@example.test");
    await fetch(
      `${baseUrl}/api/auth/github/callback?code=abc&state=${encodeURIComponent(signLinkState(user.userId, signingSecret()))}`,
      { redirect: "manual" }
    );

    const unlinked = await fetch(`${baseUrl}/api/auth/github`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unlinked.status).toBe(200);
    const current = await me(baseUrl, token);
    expect(current.github).toBeNull();
  });

  it("says plainly when the server was never configured for this", async () => {
    delete process.env.GITHUB_APP_CLIENT_ID;
    const baseUrl = await startApp();
    const { token } = await register(baseUrl, "six@example.test");
    const response = await fetch(`${baseUrl}/api/auth/github/start`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("not_configured");
  });
});
