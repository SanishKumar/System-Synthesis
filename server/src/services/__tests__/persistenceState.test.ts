import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  databaseTls,
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

describe("database transport security", () => {
  const HOSTED = "postgresql://user:pass@ep-example.aws.neon.tech/main?sslmode=require";
  const LOCAL = "postgresql://postgres:postgres@localhost:5432/scratch?sslmode=disable";

  it("verifies the certificate of a hosted connection", () => {
    // Encrypting without checking who answered stops passive eavesdropping and
    // nothing else: whoever can answer for the address can read every query.
    expect(databaseTls(HOSTED, {})).toEqual({ mode: "verified" });
  });

  it("verifies by default rather than trusting the driver's reading of sslmode", () => {
    // node-postgres currently treats sslmode=require as full verification and
    // warns that a future major will weaken it to libpq's meaning. Deciding
    // here means that upgrade cannot silently stop verifying.
    for (const mode of ["require", "prefer", "allow", "verify-ca", "verify-full"]) {
      expect(
        databaseTls(`postgresql://user:pass@db.example.com/main?sslmode=${mode}`, {})
      ).toEqual({ mode: "verified" });
    }
  });

  it("leaves a database with no TLS to negotiate alone", () => {
    expect(databaseTls(LOCAL, {})).toEqual({ mode: "disabled" });
  });

  it("keeps a connection that never used TLS unencrypted rather than breaking it", () => {
    // The only behaviour that changes is unverified to verified. A local URL
    // that reaches its database without TLS today still does.
    expect(databaseTls("postgres://postgres@localhost:5432/scratch", {})).toEqual({
      mode: "disabled",
    });
  });

  it("offers an opt-out that does not need a redeploy", () => {
    // If a chain stops validating in production, an operator sets this and
    // restarts: encrypted again in one step, while the cause is found.
    expect(databaseTls(HOSTED, { DATABASE_SSL_NO_VERIFY: "true" })).toEqual({
      mode: "unverified",
    });
    // Anything other than the exact opt-out keeps verifying.
    expect(databaseTls(HOSTED, { DATABASE_SSL_NO_VERIFY: "yes" })).toEqual({ mode: "verified" });
  });

  it("never encrypts a connection that asked for no encryption, opt-out or not", () => {
    expect(databaseTls(LOCAL, { DATABASE_SSL_NO_VERIFY: "true" })).toEqual({ mode: "disabled" });
  });

  it("accepts a supplied root for a provider Node does not bundle", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(databaseTls(HOSTED, { DATABASE_CA_CERT: ca })).toEqual({ mode: "verified", ca });
  });

  it("treats an unparseable connection string as having no sslmode", () => {
    expect(databaseTls("not a url", {})).toEqual({ mode: "disabled" });
  });
});
