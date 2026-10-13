import { createHmac, generateKeyPairSync, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";
import type { HttpTransport } from "../githubApp.js";
import {
  GITHUB_OIDC_ISSUER,
  OIDC_KEYS_LIFETIME_MS,
  OIDC_KEYS_REFRESH_INTERVAL_MS,
  gitHubOidcAudience,
  resetGitHubOidcKeysForTests,
  verifyGitHubOidcToken,
} from "../githubOidc.js";

const AUDIENCE = "https://reviews.example.test";
const env = { PUBLIC_API_URL: `${AUDIENCE}/` };
// Deliberately years from any day this suite will run on. Verification takes
// its clock as an argument, and a version that quietly read the real one would
// find every token below not yet valid.
const NOW = new Date("2031-03-04T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function keyPair(modulusLength = 2048) {
  return generateKeyPairSync("rsa", { modulusLength });
}
const current = keyPair();
const rotated = keyPair();
const stranger = keyPair();

/** A published key document, as GitHub serves it. */
function published(...entries: Array<{ kid: string; key: KeyObject }>) {
  return {
    keys: entries.map(({ kid, key }) => ({
      ...key.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    })),
  };
}

/** GitHub's key endpoint, counting how often it is asked. */
function keyEndpoint(answer: () => { status: number; body?: unknown } | never) {
  const state = { calls: 0 };
  const transport: HttpTransport = async () => {
    state.calls += 1;
    const { status, body } = answer();
    return { status, json: async () => body };
  };
  return { state, transport };
}

const servesCurrentKey = () =>
  keyEndpoint(() => ({ status: 200, body: published({ kid: "key-1", key: current.publicKey }) }));

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUDIENCE,
    sub: "repo:Acme/Shop:pull_request",
    iat: NOW_SECONDS - 10,
    nbf: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 290,
    repository: "Acme/Shop",
    repository_id: "5001",
    repository_owner_id: "7001",
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
    run_id: "9001",
    run_attempt: "1",
    actor_id: "88",
    ...overrides,
  };
}

function signed(
  overrides: Record<string, unknown> = {},
  signer: { key: KeyObject; kid: string } = { key: current.privateKey, kid: "key-1" }
) {
  // A claim overridden with undefined is left out of the token altogether,
  // which is how a test asks for one GitHub would never omit.
  const payload = Object.fromEntries(
    Object.entries(claims(overrides)).filter(([, value]) => value !== undefined)
  );
  return jwt.sign(payload, signer.key, {
    algorithm: "RS256",
    keyid: signer.kid,
    allowInsecureKeySizes: true,
  });
}

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function verify(
  token: string,
  transport: HttpTransport,
  now = NOW,
  environment: NodeJS.ProcessEnv = env
) {
  return verifyGitHubOidcToken(token, { env: environment, transport, now });
}

describe("verifying a GitHub Actions identity token", () => {
  beforeEach(() => resetGitHubOidcKeysForTests());

  it("accepts a token GitHub signed for this deployment and reports what it says", async () => {
    const { transport } = servesCurrentKey();
    await expect(verify(signed(), transport)).resolves.toEqual({
      status: "verified",
      claims: {
        // Compared everywhere else in lower case, so it is normalised here once.
        repository: "acme/shop",
        repositoryId: "5001",
        repositoryOwnerId: "7001",
        eventName: "pull_request",
        ref: "refs/pull/42/merge",
        runId: "9001",
        runAttempt: "1",
        actorId: "88",
        expiresAt: NOW_SECONDS + 290,
      },
    });
  });

  it("accepts nothing when the deployment has no public address to require", async () => {
    const { state, transport } = servesCurrentKey();
    const verdict = await verify(signed(), transport, NOW, {});
    expect(verdict).toMatchObject({ status: "refused", code: "oidc_not_configured" });
    expect(state.calls).toBe(0);
  });

  it("refuses a valid GitHub token that was requested for somebody else", async () => {
    // The case the audience exists for: a real token, correctly signed, minted
    // for a cloud provider or another service and presented here instead.
    const { state, transport } = servesCurrentKey();
    for (const aud of ["https://github.com/acme", "sts.amazonaws.com", `${AUDIENCE}.evil.test`]) {
      const verdict = await verify(signed({ aud }), transport);
      expect(verdict).toMatchObject({ status: "refused", code: "oidc_audience_mismatch" });
      expect((verdict as { message: string }).message).toContain(AUDIENCE);
    }
    // Settled from the token alone, without asking GitHub for anything.
    expect(state.calls).toBe(0);
  });

  it("accepts a token whose audience list includes this deployment", async () => {
    const { transport } = servesCurrentKey();
    const verdict = await verify(signed({ aud: ["https://other.example", AUDIENCE] }), transport);
    expect(verdict.status).toBe("verified");
  });

  it("refuses another issuer even when the signature is one it would trust", async () => {
    const { transport } = servesCurrentKey();
    const verdict = await verify(signed({ iss: "https://token.actions.example.test" }), transport);
    expect(verdict).toMatchObject({ status: "refused", code: "oidc_token_invalid" });
  });

  it("refuses an expired token, allowing only for clock skew", async () => {
    const { transport } = servesCurrentKey();
    expect((await verify(signed({ exp: NOW_SECONDS - 30 }), transport)).status).toBe("verified");
    expect(await verify(signed({ exp: NOW_SECONDS - 120 }), transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_expired",
    });
  });

  it("refuses a token that is not valid yet, and one with no expiry at all", async () => {
    const { transport } = servesCurrentKey();
    expect(await verify(signed({ nbf: NOW_SECONDS + 600 }), transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
    expect(await verify(signed({ exp: undefined }), transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
  });

  it("refuses an unsigned token without consulting any key", async () => {
    const { state, transport } = servesCurrentKey();
    const unsigned = `${segment({ alg: "none", typ: "JWT", kid: "key-1" })}.${segment(claims())}.`;
    expect(await verify(unsigned, transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
    expect(state.calls).toBe(0);
  });

  it("refuses a symmetric signature made with the published public key", async () => {
    // The public key is public. A verifier that let the token pick HS256 would
    // check this with that same key as the shared secret, and it would match.
    const { state, transport } = servesCurrentKey();
    const head = segment({ alg: "HS256", typ: "JWT", kid: "key-1" });
    const body = segment(claims());
    const secret = current.publicKey.export({ type: "spki", format: "pem" });
    const mac = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
    expect(await verify(`${head}.${body}.${mac}`, transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
    expect(state.calls).toBe(0);
  });

  it("refuses a signature from a key GitHub did not publish, whatever name it claims", async () => {
    const { transport } = servesCurrentKey();
    const forged = signed({}, { key: stranger.privateKey, kid: "key-1" });
    expect(await verify(forged, transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
  });

  it("refuses claims that were altered after the token was signed", async () => {
    const { transport } = servesCurrentKey();
    const [head, , signature] = signed().split(".");
    const altered = `${head}.${segment(claims({ repository: "victim/payments", repository_id: "1" }))}.${signature}`;
    expect(await verify(altered, transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
  });

  it("refuses a token missing the claims a run is identified by", async () => {
    const { transport } = servesCurrentKey();
    for (const overrides of [
      { repository_id: undefined },
      { repository_owner_id: undefined },
      { run_id: undefined },
      { repository: "not-a-repository" },
      { repository_id: "12ab" },
      { event_name: undefined },
      { ref: undefined },
    ]) {
      expect(await verify(signed(overrides), transport)).toMatchObject({
        status: "refused",
        code: "oidc_token_invalid",
      });
    }
  });

  it("refuses anything that is not a token before doing any work", async () => {
    const { state, transport } = servesCurrentKey();
    for (const value of ["", "not a token", "a.b", "a.b.c", `${"x".repeat(9000)}`]) {
      expect(await verify(value, transport)).toMatchObject({
        status: "refused",
        code: "oidc_token_invalid",
      });
    }
    expect(state.calls).toBe(0);
  });

  it("ignores a published key too small to rely on", async () => {
    const weak = keyPair(1024);
    const { transport } = keyEndpoint(() => ({
      status: 200,
      body: published({ kid: "weak", key: weak.publicKey }, { kid: "key-1", key: current.publicKey }),
    }));
    const token = signed({}, { key: weak.privateKey, kid: "weak" });
    expect(await verify(token, transport)).toMatchObject({
      status: "refused",
      code: "oidc_token_invalid",
    });
  });
});

describe("GitHub's signing keys", () => {
  beforeEach(() => resetGitHubOidcKeysForTests());

  it("are fetched once and reused", async () => {
    const { state, transport } = servesCurrentKey();
    await verify(signed(), transport);
    await verify(signed({ run_id: "9002" }), transport);
    expect(state.calls).toBe(1);
  });

  it("are fetched once for deliveries that arrive together", async () => {
    const { state, transport } = servesCurrentKey();
    const verdicts = await Promise.all(
      Array.from({ length: 5 }, (_, index) => verify(signed({ run_id: String(9100 + index) }), transport))
    );
    expect(verdicts.every((verdict) => verdict.status === "verified")).toBe(true);
    expect(state.calls).toBe(1);
  });

  it("are fetched again once the held set is too old to rely on", async () => {
    const { state, transport } = servesCurrentKey();
    await verify(signed(), transport);
    const later = new Date(NOW.getTime() + OIDC_KEYS_LIFETIME_MS + 1000);
    const laterSeconds = Math.floor(later.getTime() / 1000);
    const verdict = await verify(
      signed({ iat: laterSeconds - 10, nbf: laterSeconds - 10, exp: laterSeconds + 290 }),
      transport,
      later
    );
    expect(verdict.status).toBe("verified");
    expect(state.calls).toBe(2);
  });

  it("pick up a rotation, so a token signed with a new key is accepted", async () => {
    let rotatedIn = false;
    const { state, transport } = keyEndpoint(() => ({
      status: 200,
      body: rotatedIn
        ? published({ kid: "key-1", key: current.publicKey }, { kid: "key-2", key: rotated.publicKey })
        : published({ kid: "key-1", key: current.publicKey }),
    }));
    await verify(signed(), transport);
    rotatedIn = true;

    const afterInterval = new Date(NOW.getTime() + OIDC_KEYS_REFRESH_INTERVAL_MS + 1000);
    const verdict = await verify(
      signed({}, { key: rotated.privateKey, kid: "key-2" }),
      transport,
      afterInterval
    );
    expect(verdict.status).toBe("verified");
    expect(state.calls).toBe(2);
  });

  it("are not fetched again for every unknown key name a caller invents", async () => {
    // A key name costs nothing to make up. Each one must not become a request
    // to GitHub made on a stranger's behalf.
    const { state, transport } = servesCurrentKey();
    await verify(signed(), transport);
    expect(state.calls).toBe(1);

    const soon = new Date(NOW.getTime() + 5_000);
    for (const kid of ["invented-1", "invented-2", "invented-3"]) {
      const verdict = await verify(signed({}, { key: stranger.privateKey, kid }), transport, soon);
      expect(verdict).toMatchObject({ status: "refused", code: "oidc_token_invalid" });
    }
    expect(state.calls).toBe(1);

    const afterInterval = new Date(NOW.getTime() + OIDC_KEYS_REFRESH_INTERVAL_MS + 1000);
    await verify(signed({}, { key: stranger.privateKey, kid: "invented-4" }), transport, afterInterval);
    expect(state.calls).toBe(2);
  });

  it("being unavailable refuses as a retryable outage, never as an invalid token", async () => {
    let healthy = false;
    const { state, transport } = keyEndpoint(() =>
      healthy
        ? { status: 200, body: published({ kid: "key-1", key: current.publicKey }) }
        : { status: 503 }
    );
    expect(await verify(signed(), transport)).toMatchObject({
      status: "refused",
      code: "oidc_keys_unavailable",
      httpStatus: 503,
    });
    // Asked again immediately: still unavailable, and GitHub is not asked twice.
    healthy = true;
    expect(await verify(signed(), transport, new Date(NOW.getTime() + 1000))).toMatchObject({
      status: "refused",
      code: "oidc_keys_unavailable",
    });
    expect(state.calls).toBe(1);

    const afterInterval = new Date(NOW.getTime() + OIDC_KEYS_REFRESH_INTERVAL_MS + 1000);
    expect((await verify(signed(), transport, afterInterval)).status).toBe("verified");
    expect(state.calls).toBe(2);
  });

  it("failing to arrive at all is an outage too", async () => {
    const transport: HttpTransport = async () => {
      throw new Error("socket hang up");
    };
    expect(await verify(signed(), transport)).toMatchObject({
      status: "refused",
      code: "oidc_keys_unavailable",
    });
  });

  it("that fail to refresh do not turn a rotated key into an invalid token", async () => {
    // A set is held and fresh, the token names a key that is not in it, and the
    // fetch that would have settled it fails. That is not knowledge that the
    // key is wrong.
    let healthy = true;
    const { transport } = keyEndpoint(() =>
      healthy
        ? { status: 200, body: published({ kid: "key-1", key: current.publicKey }) }
        : { status: 500 }
    );
    await verify(signed(), transport);
    healthy = false;
    const afterInterval = new Date(NOW.getTime() + OIDC_KEYS_REFRESH_INTERVAL_MS + 1000);
    expect(
      await verify(signed({}, { key: rotated.privateKey, kid: "key-2" }), transport, afterInterval)
    ).toMatchObject({ status: "refused", code: "oidc_keys_unavailable" });
    // And the same while GitHub may not be asked again yet: the set that is
    // held is still fresh, but the last attempt to update it failed.
    expect(
      await verify(
        signed({}, { key: rotated.privateKey, kid: "key-2" }),
        transport,
        new Date(afterInterval.getTime() + 1000)
      )
    ).toMatchObject({ status: "refused", code: "oidc_keys_unavailable" });
  });
});

describe("the audience this deployment requires", () => {
  it("is its public origin, without a path and in canonical form", () => {
    expect(gitHubOidcAudience({ PUBLIC_API_URL: "https://Reviews.Example.test/api/" })).toBe(
      "https://reviews.example.test"
    );
    expect(gitHubOidcAudience({ PUBLIC_API_URL: "http://localhost:4000" })).toBe(
      "http://localhost:4000"
    );
  });

  it("is absent when nothing usable is configured", () => {
    for (const value of [undefined, "", "   ", "not a url", "ftp://reviews.example.test"]) {
      expect(gitHubOidcAudience({ PUBLIC_API_URL: value })).toBeNull();
    }
  });
});
