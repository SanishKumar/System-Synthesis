import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { reviewDecisionEntitlement } from "../reviewEntitlement.js";
import { resetGitHubAppCacheForTests, type HttpTransport } from "../githubApp.js";
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
const REVIEWER = { githubUserId: "9002", githubLogin: "octo-reviewer" };

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
function transportFor(options: { authorId?: number; permission?: string; permissionStatus?: number } = {}): HttpTransport {
  return async (url) => {
    if (url.endsWith("/installation")) return { status: 200, json: async () => ({ id: 42 }) };
    if (url.includes("/access_tokens")) {
      return { status: 201, json: async () => ({ token: "ghs_x", expires_at: "2999-01-01T00:00:00Z" }) };
    }
    if (url.includes("/pulls/")) {
      return { status: 200, json: async () => ({ user: { id: options.authorId ?? AUTHOR } }) };
    }
    if (url.includes("/collaborators/")) {
      return {
        status: options.permissionStatus ?? 200,
        json: async () => ({ permission: options.permission ?? "write" }),
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
    ).resolves.toEqual({ status: "allowed", basis: "verified", login: "octo-reviewer" });
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
      expect(verdict).toMatchObject({ status: "allowed", basis: "verified" });
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
    ).resolves.toEqual({ status: "allowed", basis: "manual" });
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
      ).resolves.toEqual({ status: "allowed", basis: "unenforced" });
    }
  });
});
