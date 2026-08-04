import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/db.js", () => ({ getPool: () => null }));

import reviewIntegrationsRouter from "../reviewIntegrations.js";
import {
  authenticateReviewIntegrationToken,
  resetMemoryReviewIntegrationsForTests,
} from "../../services/reviewIntegrationRepository.js";

let server: Server | null = null;

interface IssuedIntegrationResponse {
  integration: {
    id: string;
    repository: string;
    revokedAt: string | null;
  };
  ingestionToken: string;
}

interface IntegrationListResponse {
  integrations: IssuedIntegrationResponse["integration"][];
}

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = String(req.headers["x-test-user"] || "owner-1");
    const guestHeader = req.headers["x-test-guest"];
    req.user = {
      userId,
      userName: userId,
      ...(guestHeader === undefined ? {} : { isGuest: guestHeader === "true" }),
    };
    next();
  });
  app.use("/api/review-integrations", reviewIntegrationsRouter);
  const runningServer = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  server = runningServer;
  const address = runningServer.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  baseUrl: string,
  path = "",
  init: RequestInit = {},
  userId = "owner-1"
): Promise<Response> {
  return fetch(`${baseUrl}/api/review-integrations${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-test-user": userId,
      ...init.headers,
    },
  });
}

describe("repository integration management API", () => {
  beforeEach(() => resetMemoryReviewIntegrationsForTests());

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  });

  it("requires a permanent account", async () => {
    const baseUrl = await startApp();
    const response = await request(baseUrl, "", {
      method: "POST",
      body: JSON.stringify({ provider: "github", repository: "acme/shop" }),
    }, "guest-12345678");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("permanent account"),
    });

    const upgradedGuest = await request(baseUrl, "", {
      headers: { "x-test-guest": "false" },
    }, "guest-upgraded");
    expect(upgradedGuest.status).toBe(200);
  });

  it("issues once, lists metadata, rotates, and revokes with owner isolation", async () => {
    const baseUrl = await startApp();
    const create = () => request(baseUrl, "", {
      method: "POST",
      body: JSON.stringify({ provider: "github", repository: "Acme/Shop" }),
    });
    const firstResponse = await create();
    const first = await firstResponse.json() as IssuedIntegrationResponse;
    expect(firstResponse.status).toBe(201);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    expect(first.ingestionToken).toMatch(/^ssri_/);

    const listResponse = await request(baseUrl);
    const list = await listResponse.json() as IntegrationListResponse;
    expect(list.integrations).toEqual([
      expect.objectContaining({
        id: first.integration.id,
        repository: "acme/shop",
        revokedAt: null,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(first.ingestionToken);
    expect(JSON.stringify(list)).not.toContain("tokenHash");

    const rotatedResponse = await create();
    const rotated = await rotatedResponse.json() as IssuedIntegrationResponse;
    expect(rotated.integration.id).toBe(first.integration.id);
    expect(rotated.ingestionToken).not.toBe(first.ingestionToken);
    await expect(
      authenticateReviewIntegrationToken(first.ingestionToken)
    ).resolves.toBeNull();

    const otherOwner = await request(
      baseUrl,
      `/${first.integration.id}`,
      { method: "DELETE" },
      "owner-2"
    );
    expect(otherOwner.status).toBe(404);

    const revoked = await request(baseUrl, `/${first.integration.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);
    await expect(
      authenticateReviewIntegrationToken(rotated.ingestionToken)
    ).resolves.toBeNull();
  });
});
