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

function review(external = true): Pick<ArchitectureReviewRecord, "externalSource"> {
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
  } as Pick<ArchitectureReviewRecord, "externalSource">;
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

  it("treats a refused permission lookup as no standing, not as an outage", async () => {
    // GitHub answers 403 or 404 for someone it will not discuss, which is an
    // answer about standing rather than a failure to answer.
    for (const status of [403, 404]) {
      const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
        env,
        transport: transportFor({ permissionStatus: status }),
      });
      expect(verdict).toMatchObject({ status: "refused", code: "insufficient_permission" });
      resetGitHubAppCacheForTests();
    }
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

  it("treats a forbidden pull-request response as a permission answer only with evidence", async () => {
    // An installation can be edited between minting a token and using it, so a
    // grant that looked right is not proof the request will be allowed — but
    // GitHub has to be the one saying which permission was wanted.
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
    expect(verdict).toMatchObject({ status: "refused", code: "app_permission_missing" });
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

  it("does call it a permission problem when GitHub names the permission", async () => {
    // GitHub sends this header precisely to say which grant the request needed,
    // which is evidence rather than inference.
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: forbiddenWith({ "x-accepted-github-permissions": "pull_requests=read" }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "app_permission_missing" });
  });

  it("does not read some other permission's name as this one", async () => {
    const verdict = await reviewDecisionEntitlement(review(), REVIEWER, {
      env,
      transport: forbiddenWith({ "x-accepted-github-permissions": "administration=write" }),
    });
    expect(verdict).toMatchObject({ status: "refused", code: "verification_unavailable" });
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
