import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPersistenceState,
  initDatabase,
  isDbAvailable,
  markPersistenceFailed,
  shouldHaltOnPersistenceFailure,
} from "../db.js";

const originalUrl = process.env.DATABASE_URL;

// Nothing listens here, so the connection is refused immediately rather than
// waiting out the pool's cold-start timeout.
const UNREACHABLE = "postgresql://user:pass@127.0.0.1:1/system_synthesis";

describe("persistence state", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("treats an unconfigured database as a deliberate memory mode", async () => {
    await expect(initDatabase()).resolves.toBe(false);

    expect(getPersistenceState()).toEqual({ mode: "disabled" });
    expect(isDbAvailable()).toBe(false);
  });

  it("treats a configured but unreachable database as a failure", async () => {
    process.env.DATABASE_URL = UNREACHABLE;

    await expect(initDatabase()).resolves.toBe(false);

    const state = getPersistenceState();
    expect(state.mode).toBe("failed");
    expect(state.mode === "failed" && state.reason).toBeTruthy();
    expect(isDbAvailable()).toBe(false);
  });

  it("records a schema failure discovered after the pool came up", () => {
    markPersistenceFailed("relation \"users\" could not be created");

    expect(getPersistenceState()).toEqual({
      mode: "failed",
      reason: 'relation "users" could not be created',
    });
    expect(isDbAvailable()).toBe(false);
  });

  it("halts a production boot only when a configured database failed", () => {
    const failed = { mode: "failed", reason: "connection refused" } as const;

    expect(shouldHaltOnPersistenceFailure(failed, "production")).toBe(true);
    // Local development stays runnable; the warning carries the message.
    expect(shouldHaltOnPersistenceFailure(failed, "development")).toBe(false);
    expect(shouldHaltOnPersistenceFailure(failed, undefined)).toBe(false);
    // Running without a database on purpose is never a reason to halt.
    expect(shouldHaltOnPersistenceFailure({ mode: "disabled" }, "production")).toBe(false);
    expect(shouldHaltOnPersistenceFailure({ mode: "active" }, "production")).toBe(false);
  });
});
