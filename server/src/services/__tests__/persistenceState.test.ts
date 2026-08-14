import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  databaseTls,
  getPersistenceState,
  initDatabase,
  isDbAvailable,
  markPersistenceFailed,
  shouldHaltOnPersistenceFailure,
} from "../db.js";
import {
  attachRedisLifecycle,
  getRedisState,
  initRedis,
  redisTls,
  setRedisStateForTests,
  shouldReportRedisDegraded,
} from "../redis.js";

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

  it("does not decide encryption from the URL scheme", () => {
    // The regression this replaces: postgres:// and postgresql:// name the same
    // database, and the first was sent in plaintext across a network while the
    // second tried TLS against a local instance that had none.
    for (const scheme of ["postgres", "postgresql"]) {
      expect(databaseTls(`${scheme}://user:pass@remote.example.com:5432/app`, {})).toEqual({
        mode: "verified",
      });
      expect(databaseTls(`${scheme}://postgres@localhost:5432/app`, {})).toEqual({
        mode: "disabled",
      });
    }
  });

  it("verifies a remote database that says nothing about TLS", () => {
    expect(databaseTls("postgres://user:pass@db.example.com/app", {})).toEqual({
      mode: "verified",
    });
  });

  it("leaves a database on this machine alone when nothing is specified", () => {
    // The documented local setup URL. Requiring ceremony to run Postgres on a
    // laptop is how a security default gets switched off wholesale.
    expect(databaseTls("postgresql://user:password@localhost:5432/system_synthesis", {}))
      .toEqual({ mode: "disabled" });
    expect(databaseTls("postgresql://user:pass@127.0.0.1:5432/app", {})).toEqual({
      mode: "disabled",
    });
  });

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

  it("honours an explicit disable, including for a container on a private network", () => {
    expect(databaseTls(LOCAL, {})).toEqual({ mode: "disabled" });
    // The Docker development stack: not loopback, so it has to say so.
    expect(
      databaseTls("postgresql://ss_user:pw@postgres:5432/system_synthesis?sslmode=disable", {
        NODE_ENV: "development",
      })
    ).toEqual({ mode: "disabled" });
  });

  it("refuses plaintext to a remote database in production", () => {
    const refused = databaseTls(
      "postgresql://user:pass@db.example.com:5432/app?sslmode=disable",
      { NODE_ENV: "production" }
    );
    expect(refused.mode).toBe("refused");
    expect(refused.mode === "refused" && refused.reason).toContain("plaintext");
  });

  it("still allows plaintext to this machine in production", () => {
    expect(
      databaseTls("postgresql://user:pass@127.0.0.1:5432/app?sslmode=disable", {
        NODE_ENV: "production",
      })
    ).toEqual({ mode: "disabled" });
  });

  it("accepts plaintext to a remote database only when it is stated twice", () => {
    expect(
      databaseTls("postgresql://user:pass@db.example.com/app?sslmode=disable", {
        NODE_ENV: "production",
        DATABASE_ALLOW_PLAINTEXT: "true",
      })
    ).toEqual({ mode: "disabled" });
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

  it("trusts the authorities a connection string points at", () => {
    // sslrootcert was stripped with the other driver parameters, leaving Node's
    // default roots in place of the trust the operator asked for — a different
    // trust decision, made silently.
    const decision = databaseTls(
      "postgresql://u:p@db.example.com/app?sslmode=verify-full&sslrootcert=/etc/ssl/private-ca.pem",
      {},
      (path) => (path === "/etc/ssl/private-ca.pem" ? "PRIVATE-CA-PEM" : (() => { throw new Error("wrong path"); })())
    );
    expect(decision).toEqual({ mode: "verified", ca: "PRIVATE-CA-PEM" });
  });

  it("refuses when the authorities it was told to trust cannot be read", () => {
    const decision = databaseTls(
      "postgresql://u:p@db.example.com/app?sslrootcert=/missing/ca.pem",
      {},
      () => { throw new Error("ENOENT: no such file or directory"); }
    );
    expect(decision.mode).toBe("refused");
    expect(decision.mode === "refused" && decision.reason).toContain("/missing/ca.pem");
  });

  it("prefers an inline authority over a path, for a deployment that cannot mount files", () => {
    expect(
      databaseTls(
        "postgresql://u:p@db.example.com/app?sslrootcert=/etc/ssl/ca.pem",
        { DATABASE_CA_CERT: "INLINE-PEM" },
        () => { throw new Error("must not be read"); }
      )
    ).toEqual({ mode: "verified", ca: "INLINE-PEM" });
  });

  it("refuses a client certificate rather than dropping mutual authentication", () => {
    // The driver cannot see these now that the string is sanitised, so carrying
    // on would remove client authentication without a word.
    const decision = databaseTls(
      "postgresql://u:p@db.example.com/app?sslcert=/c.pem&sslkey=/k.pem",
      {}
    );
    expect(decision.mode).toBe("refused");
    expect(decision.mode === "refused" && decision.reason).toContain("sslcert");
  });

  it("refuses a connection string it cannot read rather than guessing", () => {
    expect(databaseTls("not a url", {}).mode).toBe("refused");
  });
});

describe("redis transport security", () => {
  it("verifies the certificate of a TLS Redis connection", () => {
    // The collaboration stream carries board updates and the identities
    // attached to them; accepting any certificate left both rewritable.
    expect(redisTls("rediss://default:pw@fly-cache.upstash.io:6379", {})).toEqual({
      mode: "verified",
    });
  });

  it("leaves a local Redis unencrypted", () => {
    expect(redisTls("redis://localhost:6379", {})).toEqual({ mode: "disabled" });
    expect(redisTls("redis://127.0.0.1:6379", {})).toEqual({ mode: "disabled" });
  });

  it("allows the Docker development stack to reach its container", () => {
    expect(redisTls("redis://redis:6379", { NODE_ENV: "development" })).toEqual({
      mode: "disabled",
    });
  });

  it("refuses plaintext Redis to a remote host in production", () => {
    const refused = redisTls("redis://cache.example.com:6379", { NODE_ENV: "production" });
    expect(refused.mode).toBe("refused");
    expect(refused.mode === "refused" && refused.reason).toContain("plaintext");
  });

  it("offers the same opt-out and supplied root as the database", () => {
    expect(redisTls("rediss://cache.example.com:6379", { REDIS_SSL_NO_VERIFY: "true" })).toEqual({
      mode: "unverified",
    });
    expect(redisTls("rediss://cache.example.com:6379", { REDIS_CA_CERT: "pem" })).toEqual({
      mode: "verified",
      ca: "pem",
    });
  });
});

describe("redis readiness", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    setRedisStateForTests({ mode: "disabled" });
  });

  it("treats an unconfigured Redis as a deliberate memory mode", async () => {
    delete process.env.REDIS_URL;
    await initRedis();
    expect(getRedisState()).toEqual({ mode: "disabled" });
  });

  it("reports a configured but unreachable Redis as failed, not as absent", async () => {
    // Nothing listens here, so the attempt fails immediately.
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    await initRedis();
    const state = getRedisState();
    expect(state.mode).toBe("failed");
    expect(state.mode === "failed" && state.reason).toBeTruthy();
  });

  it("reports a refused transport as failed rather than connecting anyway", async () => {
    process.env.REDIS_URL = "redis://cache.example.com:6379";
    process.env.NODE_ENV = "production";
    try {
      await initRedis();
      const state = getRedisState();
      expect(state.mode).toBe("failed");
      expect(state.mode === "failed" && state.reason).toContain("plaintext");
    } finally {
      process.env.NODE_ENV = "test";
    }
  });

  it("calls a production deployment degraded when its configured Redis is missing", () => {
    const failed = { mode: "failed", reason: "connection refused" } as const;

    // Every instance would keep a private copy of state meant to be shared, and
    // the platform would have no way to know.
    expect(shouldReportRedisDegraded(failed, "production")).toBe(true);
    // Development stays runnable; the log carries the reason.
    expect(shouldReportRedisDegraded(failed, "development")).toBe(false);
    // Choosing to run without Redis is never a reason to report degraded.
    expect(shouldReportRedisDegraded({ mode: "disabled" }, "production")).toBe(false);
    expect(shouldReportRedisDegraded({ mode: "active" }, "production")).toBe(false);
  });
});

describe("redis state over the process lifetime", () => {
  /** The events ioredis emits, without a server to emit them. */
  function lifecycle() {
    const handlers = new Map<string, Array<() => void>>();
    return {
      on(event: string, handler: () => void) {
        handlers.set(event, [...(handlers.get(event) || []), handler]);
        return this;
      },
      emit(event: string) {
        for (const handler of handlers.get(event) || []) handler();
      },
    };
  }

  afterEach(() => setRedisStateForTests({ mode: "disabled" }));

  it("stops reporting a shared store once the connection drops", () => {
    const client = lifecycle();
    attachRedisLifecycle(client as never);
    client.emit("ready");
    expect(getRedisState()).toEqual({ mode: "active" });

    // A startup answer alone goes stale here: the instance would keep claiming
    // a store it no longer shares with anything.
    client.emit("close");
    expect(getRedisState().mode).toBe("failed");
  });

  it("reports a shared store again once the connection returns", () => {
    const client = lifecycle();
    attachRedisLifecycle(client as never);
    client.emit("ready");
    client.emit("close");
    expect(getRedisState().mode).toBe("failed");

    // Recovery is the point of retrying forever rather than giving up.
    client.emit("ready");
    expect(getRedisState()).toEqual({ mode: "active" });
  });

  it("treats an ended connection as failed rather than absent", () => {
    const client = lifecycle();
    attachRedisLifecycle(client as never);
    client.emit("ready");
    client.emit("end");
    const state = getRedisState();
    expect(state.mode).toBe("failed");
    expect(state.mode === "failed" && state.reason).toBeTruthy();
  });
});
