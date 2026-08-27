import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { reviewDecisionEntitlement } from "../reviewEntitlement.js";
import {
  FORCED_REFRESH_INTERVAL_MS,
  resetGitHubAppCacheForTests, type HttpTransport } from "../githubApp.js";
import type { ArchitectureReviewRecord } from "../reviewRepository.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A deployment that can both identify a reviewer and check them. */
const env = {
  GITHUB_APP_ID: "1234",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "shhh",
};

const AUTHOR = 7001;
/** The documented least-privilege grant this deployment asks for. */
const FULL_GRANT = { checks: "write", metadata: "read", pull_requests: "read" };
/** An installation created before pull-request access was asked for. */
const CHECKS_ONLY = { checks: "write", metadata: "read" };

const REVIEWER_ID = 9002;
const REVIEWER = { githubUserId: String(REVIEWER_ID), githubLogin: "octo-reviewer" };

function review(
  external = true,
  policy: ArchitectureReviewRecord["policy"] = {}
): Pick<ArchitectureReviewRecord, "externalSource" | "policy"> {
  return {
    externalSource: external
      ? {
          provider: "github",
          repository: "acme/shop",
          changeNumber: 42,
          changeUrl: "https://github.com/acme/shop/pull/42",
          changeVersion: 1,
          workflowRunId: null,
          workflowRunUrl: null,
        }
      : null,
    policy,
  } as Pick<ArchitectureReviewRecord, "externalSource" | "policy">;
}

/** GitHub answering about the pull request and the reviewer's standing. */
function transportFor(options: {
  authorId?: number;
  permission?: string;
  permissionStatus?: number;
  resolvedId?: number;
  resolvedLogin?: string;
  omitResolvedUser?: boolean;
  /** `null` reproduces a response that describes no permissions at all. */
  permissions?: Record<string, string> | null;
  /**
   * Accounts the repository's collaborator listing reports. Each entry is the
   * cumulative permission block GitHub returns for that endpoint.
   */
  collaborators?: Array<{ permissions: Record<string, boolean> }>;
  /** Anything other than 200 leaves "is anyone else here" unanswered. */
  collaboratorsStatus?: number;
} = {}): HttpTransport {
  return async (url) => {
    if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
    if (url.includes("/access_tokens")) {
      return {
        status: 201,
        json: async () => ({
          token: "ghs_x",
          expires_at: "2999-01-01T00:00:00Z",
          // What GitHub reports as granted. The default is the documented
          // least-privilege set; a test omitting it is reproducing an
          // installation that was never given what verification needs.
          ...(options.permissions === null
            ? {}
            : { permissions: options.permissions ?? FULL_GRANT }),
        }),
      };
    }
    if (url.includes("/pulls/")) {
      return { status: 200, json: async () => ({ user: { id: options.authorId ?? AUTHOR } }) };
    }
    // The listing, not the single-account permission lookup below it.
    if (url.includes("/collaborators?")) {
      return {
        status: options.collaboratorsStatus ?? 200,
        json: async () =>
          options.collaborators ?? [{ permissions: { push: true, admin: true } }],
      };
    }
    if (url.includes("/collaborators/")) {
      return {
        status: options.permissionStatus ?? 200,
        json: async () => ({
          permission: options.permission ?? "write",
          // GitHub names the account the login resolved to. Omitted only when a
          // test is deliberately reproducing a response that does not.
          ...(options.omitResolvedUser
            ? {}
            : {
                user: {
                  id: options.resolvedId ?? REVIEWER_ID,
                  login: options.resolvedLogin ?? "octo-reviewer",
                },
              }),
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
}

describe("who may decide a review", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  it("allows a collaborator who did not open the pull request", async () => {
    await expect(
      reviewDecisionEntitlement(review(), REVIEWER, { env, transport: transportFor() })
    ).resolves.toEqual({
      status: "allowed",
      evidence: {
        basis: "verified",
        repository: "acme/shop",
        githubUserId: String(REVIEWER_ID),
        githubLogin: "octo-reviewer",
        permission: "write",
        checkedAt: expect.any(String),
        // Recorded on every verified decision, so that a decision made by
        // somebody other than the author says so rather than merely omitting it.
        selfApproved: false,
      },
    });
  });

  it("refuses the author of the change, whatever their permission", async () => {
    // Proposing a change and certifying it are different acts. An admin who
    // opened the pull request is still its author.
    for (const permission of ["admin", "maintain", "write"]) {
      const verdict = await reviewDecisionEntitlement(
        review(),
        { githubUserId: String(AUTHOR), githubLogin: "octo-author" },
        { env, transport: transportFor({ permission }) }
      );
      expect(verdict).toMatchObject({ status: "refused", code: "self_approval" });
      resetGitHubAppCacheForTests();
    }
  });

  it("refuses someone with no write access to the repository", async () => {
    for (const permission of ["read", "triage", "none"]) {
      const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
        env,
        transport: transportFor({ permission }),
      });
      expect(verdict).toMatchObject({ status: "refused", code: "insufficient_permission" });
      resetGitHubAppCacheForTests();
    }
  });

  it("accepts the permissions that amount to changing the repository", async () => {
    for (const permission of ["admin", "maintain", "write"]) {
      const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
        env,
        transport: transportFor({ permission }),
      });
      expect(verdict).toMatchObject({ status: "allowed", evidence: { basis: "verified" } });
      resetGitHubAppCacheForTests();
    }
  });

  it("treats a 404 from the permission lookup as no standing", async () => {
    // GitHub declines to name a non-collaborator, which is an answer about
    // standing rather than a failure to answer.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permissionStatus: 404 }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "insufficient_permission" });
  });

  it("does not read a forbidden permission lookup as the reviewer lacking access", async () => {
    // Rate limits, IP allow lists and organisation policy all answer 403.
    // Reporting one of those as "you do not have access to this repository"
    // tells an authorised reviewer something false about their own permissions.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permissionStatus: 403 }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("requires a linked account before it will check anything", async () => {
    const verdict = await reviewDecisionEntitlement(
      review(),
      { githubUserId: null, githubLogin: null },
      { env, transport: transportFor() }
    );
    expect(verdict).toMatchObject({ status: "refused", code: "identity_required" });
  });

  it("refuses rather than allows when GitHub cannot be reached", async () => {
    // Failing open would let anyone decide exactly when a false gate is least
    // likely to be noticed.
    const unreachable: HttpTransport = async (url) => {
      if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
      if (url.includes("/access_tokens")) {
        return { status: 201, json: async () => ({ token: "t", expires_at: "2999-01-01T00:00:00Z" }) };
      }
      throw new TypeError("fetch failed");
    };
    await expect(
      reviewDecisionEntitlement(review(), REVIEWER, { env, transport: unreachable })
    ).resolves.toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("refuses when the App itself cannot get a credential", async () => {
    const uninstalled: HttpTransport = async (url) =>
      url.endsWith("/installation")
        ? { status: 404, json: async () => ({}) }
        : { status: 200, json: async () => ({}) };
    await expect(
      reviewDecisionEntitlement(review(), REVIEWER, { env, transport: uninstalled })
    ).resolves.toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("refuses when the pull request cannot be read", async () => {
    const missing: HttpTransport = async (url) => {
      if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
      if (url.includes("/access_tokens")) {
        return { status: 201, json: async () => ({ token: "t", expires_at: "2999-01-01T00:00:00Z" }) };
      }
      if (url.includes("/pulls/")) return { status: 500, json: async () => ({}) };
      return { status: 200, json: async () => ({ permission: "admin" }) };
    };
    await expect(
      reviewDecisionEntitlement(review(), REVIEWER, { env, transport: missing })
    ).resolves.toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("leaves a manual review to whoever owns it", async () => {
    // There is no pull request to have standing on, and no repository to check.
    await expect(
      reviewDecisionEntitlement(
        review(false),
        { githubUserId: null, githubLogin: null },
        { env, transport: transportFor() }
      )
    ).resolves.toEqual({ status: "allowed", evidence: { basis: "manual" } });
  });

  it("does not lock out a deployment that cannot check, and says it did not", async () => {
    // A server without the App, or without identity configured, has no way to
    // ask. Refusing every decision would break a product that worked, and
    // claiming the decision was verified would be a lie; it records neither.
    for (const partial of [
      {},
      { GITHUB_APP_ID: "1234", GITHUB_APP_PRIVATE_KEY: privateKey },
      { GITHUB_APP_CLIENT_ID: "Iv1.abc", GITHUB_APP_CLIENT_SECRET: "shhh" },
    ]) {
      await expect(
        reviewDecisionEntitlement(review(), REVIEWER, { env: partial, transport: transportFor() })
      ).resolves.toEqual({
        status: "allowed",
        evidence: { basis: "unenforced", repository: "acme/shop" },
      });
    }
  });
});

describe("permission is established for the linked account, not for a name", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  it("refuses when the login resolves to a different account than the linked one", async () => {
    // The reviewer renamed, somebody else took the old login, and that account
    // has write access. Asking by name would grant standing to a stranger while
    // the self-approval check still guarded the linked id.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ resolvedId: 99999, resolvedLogin: "someone-else" }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "identity_mismatch" });
  });

  it("does not decide from a response that names no account", async () => {
    // Failing open here would restore the defect entirely.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ omitResolvedUser: true }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("still reports insufficient permission when the response names no account", async () => {
    // Permission is read first, so somebody without access is told that rather
    // than being asked to try again later.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permission: "read", omitResolvedUser: true }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "insufficient_permission" });
  });

  it("records the login GitHub resolved rather than the one on file", async () => {
    // Same account, new name. The evidence should let a later reader find it.
    const verdict = await reviewDecisionEntitlement(
      review(),
      { githubUserId: String(REVIEWER_ID), githubLogin: "old-name" },
      { env, transport: transportFor({ resolvedLogin: "new-name" }) }
    );
    expect(verdict).toMatchObject({
      status: "allowed",
      evidence: { githubLogin: "new-name", githubUserId: String(REVIEWER_ID) },
    });
  });
  it("refuses a half-linked identity rather than asking GitHub about a null login", async () => {
    // An id with no login would be interpolated into the permission path as the
    // literal string. GitHub answers 404, which this would otherwise report as
    // insufficient permission — telling the reviewer they lack access when what
    // they have is an incomplete link.
    const asked: string[] = [];
    const verdict = await reviewDecisionEntitlement(
      review(),
      { githubUserId: String(REVIEWER_ID), githubLogin: null },
      {
        env,
        transport: async (url, init) => {
          asked.push(url);
          return transportFor()(url, init);
        },
      }
    );
    expect(verdict).toMatchObject({ status: "refused", code: "identity_required" });
    expect(asked.filter((url) => url.includes("/collaborators/"))).toEqual([]);
  });

  it("carries the permission level GitHub reported into the evidence", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permission: "maintain" }),
    });
    expect(verdict).toMatchObject({
      status: "allowed",
      evidence: { basis: "verified", permission: "maintain" },
    });
  });
});

describe("an installation that cannot read pull requests says so", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  it("refuses with a configuration code rather than an outage code", async () => {
    // The distinction is the point. "Try again shortly" is advice that can never
    // come true when an administrator has to change the App and an organisation
    // owner has to approve it.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permissions: CHECKS_ONLY }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "app_permission_missing" });
    expect(verdict).not.toMatchObject({ code: "verification_unavailable" });
  });

  it("tells the reader what has to change, and that retrying will not do it", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permissions: CHECKS_ONLY }),
    });
    const message = verdict.status === "refused" ? verdict.message : "";
    expect(message).toContain("Pull requests: Read");
    expect(message).toContain("Retrying will not help");
  });

  it("does not ask GitHub about a pull request it is not allowed to read", async () => {
    // Established from the grant, not from a status code, so nothing is spent
    // discovering what GitHub already said when it minted the token.
    const asked: string[] = [];
    await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        asked.push(url);
        return transportFor({ permissions: CHECKS_ONLY })(url, init);
      },
    });
    expect(asked.filter((url) => url.includes("/pulls/"))).toEqual([]);
  });

  it("allows the author lookup once pull-request read is granted", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permissions: FULL_GRANT }),
    });
    expect(verdict).toMatchObject({ status: "allowed", evidence: { basis: "verified" } });
  });

  it("needs nothing beyond metadata for the collaborator permission lookup", async () => {
    // GitHub lists that endpoint under Metadata, which every installation has.
    // Only the pull-request read is additional, so granting it is sufficient.
    const asked: string[] = [];
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        asked.push(url);
        return transportFor({ permissions: FULL_GRANT })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "allowed" });
    expect(asked.some((url) => url.includes("/collaborators/"))).toBe(true);
    expect(asked.some((url) => url.includes("/contents/"))).toBe(false);
  });

  it("does not read the accepted-permissions header as proof of a missing grant", async () => {
    // GitHub sends that header to describe what the endpoint requires, not to
    // report what the caller was found to be missing. The grant said this was
    // allowed, so a 403 afterwards is something to retry.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        if (url.includes("/pulls/")) {
          return {
            status: 403,
            json: async () => ({}),
            headers: { "x-accepted-github-permissions": "pull_requests=read" },
          };
        }
        return transportFor({ permissions: FULL_GRANT })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("still reports an outage as an outage", async () => {
    // A response that says nothing about permissions is not a response saying
    // none were granted, and a 500 is not a configuration problem.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        if (url.includes("/pulls/")) return { status: 500, json: async () => ({}) };
        return transportFor({ permissions: null })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });
});

describe("a forbidden answer is only a permission answer when the response says so", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  /** A 403 carrying whichever headers the case is about. */
  const forbiddenWith = (headers: Record<string, string>): HttpTransport =>
    async (url, init) => {
      if (url.includes("/pulls/")) {
        return { status: 403, json: async () => ({}), headers };
      }
      return transportFor({ permissions: FULL_GRANT })(url, init);
    };

  it("calls a rate-limited refusal an outage, not a configuration error", async () => {
    // The grant said this was allowed. Sending somebody to edit their App when
    // the real problem is a rate limit is work that cannot help.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: forbiddenWith({ "x-ratelimit-remaining": "0" }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("treats a secondary rate limit the same way", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: forbiddenWith({ "retry-after": "60" }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("stays conservative when the response explains nothing", async () => {
    // An IP allow list and an organisation policy both answer 403 without
    // saying so. Neither is a permission this deployment can grant itself.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: forbiddenWith({}),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("stays conservative when the transport reports no headers at all", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        if (url.includes("/pulls/")) return { status: 403, json: async () => ({}) };
        return transportFor({ permissions: FULL_GRANT })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("puts rate-limit evidence ahead of the accepted-permissions header", async () => {
    // A rate-limited response carries the endpoint's requirements just as
    // readily as any other. Read in the other order, the response that carries
    // both would be classified by the header that means least on it.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: forbiddenWith({
        "x-accepted-github-permissions": "pull_requests=read",
        "x-ratelimit-remaining": "0",
      }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("keeps an unknown grant plus that header conservative", async () => {
    // Nothing here establishes a missing permission: the token response said
    // nothing about the grant, and the header describes the endpoint.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        if (url.includes("/pulls/")) {
          return {
            status: 403,
            json: async () => ({}),
            headers: { "x-accepted-github-permissions": "pull_requests=read" },
          };
        }
        return transportFor({ permissions: null })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("reports a rate-limited collaborator lookup as retryable, not as no access", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        if (url.includes("/collaborators/")) {
          return { status: 403, json: async () => ({}), headers: { "retry-after": "60" } };
        }
        return transportFor({ permissions: FULL_GRANT })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("still reports a genuinely low permission level as no standing", async () => {
    // A 200 that names a level below write is an answer, and it is this one.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: transportFor({ permission: "read" }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "insufficient_permission" });
  });

  it("still refuses before asking when the grant itself is short", async () => {
    // The explicit grant stays authoritative: no request is made, so no 403
    // classification is involved at all.
    const asked: string[] = [];
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: async (url, init) => {
        asked.push(url);
        return transportFor({ permissions: CHECKS_ONLY })(url, init);
      },
    });
    expect(verdict).toMatchObject({ status: "refused", code: "app_permission_missing" });
    expect(asked.filter((url) => url.includes("/pulls/"))).toEqual([]);
  });
});

describe("accepting the permission recovers without waiting for the token to expire", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  /** Mints a token whose grant changes once the installation accepts. */
  function installation() {
    const state = { granted: CHECKS_ONLY as Record<string, string>, minted: 0 };
    const transport: HttpTransport = async (url, init) => {
      if (url.includes("/access_tokens")) {
        state.minted += 1;
        return {
          status: 201,
          json: async () => ({
            token: `ghs_${state.minted}`,
            expires_at: "2999-01-01T00:00:00Z",
            permissions: state.granted,
          }),
        };
      }
      return transportFor({ permissions: FULL_GRANT })(url, init);
    };
    return { state, transport };
  }

  const AT = new Date("2026-08-21T09:00:00.000Z");
  const later = (ms: number) => new Date(AT.getTime() + ms);

  it("recovers in a bounded minute rather than the hour a token lives", async () => {
    const { state, transport } = installation();

    const before = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport,
      now: AT,
    });
    expect(before).toMatchObject({ status: "refused", code: "app_permission_missing" });

    // The administrator accepts the permission. The cached token still carries
    // the old grant and does not expire for an hour.
    state.granted = FULL_GRANT;

    const allowed = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport,
      now: later(FORCED_REFRESH_INTERVAL_MS + 1),
    });
    expect(allowed).toMatchObject({ status: "allowed", evidence: { basis: "verified" } });
  });

  it("holds the bound within the interval, so refusals cannot mint tokens freely", async () => {
    // Recovery must not become a token request per refused decision.
    const { state, transport } = installation();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await reviewDecisionEntitlement(review(), REVIEWER, {
        env,
        transport,
        now: later(attempt * 1_000),
      });
    }
    // One to fill the cache, one forced look. Nothing further inside the window.
    expect(state.minted).toBe(2);
  });

  it("needs no restart and no configuration change to pick the grant up", async () => {
    // The same process, the same cache, the same App configuration.
    const { state, transport } = installation();
    await reviewDecisionEntitlement(review(), REVIEWER, { env, transport, now: AT });
    state.granted = FULL_GRANT;
    const allowed = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport,
      now: later(FORCED_REFRESH_INTERVAL_MS * 2),
    });
    expect(allowed).toMatchObject({ status: "allowed" });
  });
});

describe("minting a token is single-flight per repository", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  /** Counts mints and answers only after every caller has arrived. */
  function slowInstallation(granted: Record<string, string>) {
    const state = { granted, minted: 0 };
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: HttpTransport = async (url, init) => {
      if (url.includes("/access_tokens")) {
        state.minted += 1;
        await gate;
        return {
          status: 201,
          json: async () => ({
            token: `ghs_${state.minted}`,
            expires_at: "2999-01-01T00:00:00Z",
            permissions: state.granted,
          }),
        };
      }
      return transportFor({ permissions: FULL_GRANT })(url, init);
    };
    return { state, transport, open: () => release?.() };
  }

  it("shares one mint across a burst arriving on a cold cache", async () => {
    // Every caller finds the cache empty. Without single-flight each of them
    // mints, which is the burst the interval never protected against because
    // the interval only decides whether to discard the cache.
    const { state, transport, open } = slowInstallation(FULL_GRANT);
    const burst = Promise.all(
      Array.from({ length: 6 }, () =>
        reviewDecisionEntitlement(review(), REVIEWER, { env, transport })
      )
    );
    open();
    const verdicts = await burst;
    expect(state.minted).toBe(1);
    for (const verdict of verdicts) {
      expect(verdict).toMatchObject({ status: "allowed", evidence: { basis: "verified" } });
    }
  });

  it("shares one refresh across a burst after the permission is accepted", async () => {
    const { state, transport, open } = slowInstallation(CHECKS_ONLY);
    open();
    const AT = new Date("2026-08-21T09:00:00.000Z");
    const refused = await reviewDecisionEntitlement(review(), REVIEWER, { env, transport, now: AT });
    expect(refused).toMatchObject({ status: "refused", code: "app_permission_missing" });
    const beforeBurst = state.minted;

    state.granted = FULL_GRANT;
    const later = new Date(AT.getTime() + FORCED_REFRESH_INTERVAL_MS + 1);
    const verdicts = await Promise.all(
      Array.from({ length: 6 }, () =>
        reviewDecisionEntitlement(review(), REVIEWER, { env, transport, now: later })
      )
    );

    // One refresh for the whole burst, and everybody recovers on it.
    expect(state.minted).toBe(beforeBurst + 1);
    for (const verdict of verdicts) {
      expect(verdict).toMatchObject({ status: "allowed", evidence: { basis: "verified" } });
    }
  });

  it("does not discard a token it minted moments ago", async () => {
    // A token minted during this call already describes the current grant.
    // Refreshing it would spend a request to be told the same thing.
    const { state, transport, open } = slowInstallation(CHECKS_ONLY);
    open();
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, { env, transport });
    expect(verdict).toMatchObject({ status: "refused", code: "app_permission_missing" });
    expect(state.minted).toBe(1);
  });
});

describe("an author deciding their own change", () => {
  beforeEach(() => resetGitHubAppCacheForTests());

  /** The reviewer is also the author of the pull request. */
  const asAuthor = { authorId: REVIEWER_ID };
  type Collaborator = { permissions: Record<string, boolean> };
  const solo: Collaborator[] = [{ permissions: { push: true, admin: true } }];
  const team: Collaborator[] = [
    { permissions: { push: true, admin: true } },
    { permissions: { push: true } },
    // Read-only, so not a reviewer and not counted.
    { permissions: { pull: true } },
    { permissions: { maintain: true } },
  ];

  function decide(policy: unknown, transport: ReturnType<typeof transportFor>) {
    return reviewDecisionEntitlement(review(true, policy as never), REVIEWER, { env, transport });
  }

  const soleReviewer = { decision: { selfApproval: "sole_reviewer" } };
  const adminOverride = { decision: { selfApproval: "admin_override" } };

  it("refuses by default, with no policy expressed at all", async () => {
    await expect(decide({}, transportFor(asAuthor))).resolves.toMatchObject({
      status: "refused",
      code: "self_approval",
    });
  });

  it("refuses when the policy names the default explicitly", async () => {
    const verdict = await decide(
      { decision: { selfApproval: "forbidden" } },
      transportFor(asAuthor)
    );
    expect(verdict).toMatchObject({ status: "refused", code: "self_approval" });
  });

  it("allows a sole reviewer, and records that nobody else could have decided", async () => {
    const verdict = await decide(
      soleReviewer,
      transportFor({ ...asAuthor, permission: "admin", collaborators: solo })
    );
    expect(verdict).toMatchObject({
      status: "allowed",
      evidence: {
        basis: "self_sole_reviewer",
        selfApproved: true,
        eligibleReviewers: 1,
        githubUserId: String(REVIEWER_ID),
      },
    });
  });

  it("refuses a sole-reviewer claim the moment somebody else can decide", async () => {
    // Three of the four listed accounts can change the repository; the fourth
    // is read-only and is not a reviewer.
    const verdict = await decide(
      soleReviewer,
      transportFor({ ...asAuthor, permission: "admin", collaborators: team })
    );
    expect(verdict).toMatchObject({ status: "refused", code: "self_approval" });
    expect((verdict as { message: string }).message).toContain("3 accounts");
  });

  it("refuses rather than assuming solitude when the listing cannot be read", async () => {
    // Failing open here would make every GitHub outage a licence to self-approve.
    const verdict = await decide(
      soleReviewer,
      transportFor({ ...asAuthor, permission: "admin", collaboratorsStatus: 500 })
    );
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
  });

  it("does not let an exception grant standing the author does not have", async () => {
    // Read-only on the repository. No self-approval policy makes that enough.
    const verdict = await decide(
      soleReviewer,
      transportFor({ ...asAuthor, permission: "read", collaborators: solo })
    );
    expect(verdict).toMatchObject({ status: "refused", code: "insufficient_permission" });
  });

  it("allows an administrator override, and states how many reviewers it skipped", async () => {
    const verdict = await decide(
      adminOverride,
      transportFor({ ...asAuthor, permission: "admin", collaborators: team })
    );
    expect(verdict).toMatchObject({
      status: "allowed",
      evidence: { basis: "self_admin_override", selfApproved: true, eligibleReviewers: 3 },
    });
  });

  it("refuses an override to someone who is not an administrator", async () => {
    const verdict = await decide(
      adminOverride,
      transportFor({ ...asAuthor, permission: "write", collaborators: team })
    );
    expect(verdict).toMatchObject({ status: "refused", code: "self_approval" });
    expect((verdict as { message: string }).message).toContain("write");
  });

  it("still grants an administrator override when the reviewer count is unknown", async () => {
    // The override rests on administrator standing, which was established. The
    // count is context, so its absence withholds the context and not the grant.
    const verdict = await decide(
      adminOverride,
      transportFor({ ...asAuthor, permission: "admin", collaboratorsStatus: 502 })
    );
    expect(verdict).toMatchObject({
      status: "allowed",
      evidence: { basis: "self_admin_override" },
    });
    if (verdict.status !== "allowed") throw new Error("expected the override to be allowed");
    expect(verdict.evidence.eligibleReviewers).toBeUndefined();
  });

  it("still refuses an author whose linked account no longer owns that login", async () => {
    const verdict = await decide(
      soleReviewer,
      transportFor({ ...asAuthor, permission: "admin", collaborators: solo, resolvedId: 12345 })
    );
    expect(verdict).toMatchObject({ status: "refused", code: "identity_mismatch" });
  });

  it("records a decision by somebody else as not self-approved, whatever the policy", async () => {
    const verdict = await decide(soleReviewer, transportFor({ permission: "write" }));
    expect(verdict).toMatchObject({
      status: "allowed",
      evidence: { basis: "verified", selfApproved: false },
    });
  });
});
