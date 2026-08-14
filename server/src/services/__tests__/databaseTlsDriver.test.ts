import pg from "pg";
import { describe, expect, it } from "vitest";
import { databaseTls, poolConfig } from "../db.js";

/**
 * What the driver actually ends up connecting with.
 *
 * The decision function was fully tested and the connection was still wrong.
 * node-postgres does not merge a connection string's SSL settings with the
 * `ssl` option — the string replaces the object — so a URL ending in
 * `sslmode=require` discarded the whole policy. The supplied CA never reached
 * the socket and the emergency no-verify switch did nothing, while every test
 * of the decision passed. Only asking the driver what it resolved catches that.
 *
 * These construct a client and read its parameters. Nothing connects.
 */
interface ResolvedParameters {
  ssl: false | undefined | { rejectUnauthorized?: boolean; ca?: string };
  host: string;
  port: number;
  database: string;
  user: string;
  application_name?: string;
}

/** `connectionParameters` is what the driver resolved, and is not in its types. */
function connectionParameters(url: string, env: NodeJS.ProcessEnv = {}): ResolvedParameters {
  const client = new pg.Client(poolConfig(url, databaseTls(url, env)));
  return (client as unknown as { connectionParameters: ResolvedParameters })
    .connectionParameters;
}

function resolvedSsl(url: string, env: NodeJS.ProcessEnv = {}) {
  return connectionParameters(url, env).ssl;
}

const REMOTE = "postgresql://u:p@db.example.com:5432/app";
const CA = "-----BEGIN CERTIFICATE-----\nsentinel\n-----END CERTIFICATE-----";

describe("TLS settings the PostgreSQL driver resolves", () => {
  it("keeps the decided policy on the URL the hosted deployment actually uses", () => {
    // The production connection string ends in sslmode=require. That parameter
    // replaced the ssl object entirely, leaving `{}` — verified only because
    // this version of the driver reads `require` as full verification, and it
    // warns that a future major will read it as libpq does, which does not.
    expect(resolvedSsl(`${REMOTE}?sslmode=require`, { DATABASE_CA_CERT: CA })).toEqual({
      rejectUnauthorized: true,
      ca: CA,
    });
  });

  it("delivers a supplied certificate authority for every spelling of the URL", () => {
    for (const suffix of ["", "?sslmode=require", "?sslmode=verify-full", "?sslmode=prefer"]) {
      expect(resolvedSsl(`${REMOTE}${suffix}`, { DATABASE_CA_CERT: CA })).toMatchObject({
        rejectUnauthorized: true,
        ca: CA,
      });
    }
  });

  it("lets the emergency switch actually reach the socket", () => {
    // If this is set and the connection still verifies, an operator has no way
    // to restore service without a redeploy.
    expect(
      resolvedSsl(`${REMOTE}?sslmode=require`, { DATABASE_SSL_NO_VERIFY: "true" })
    ).toEqual({ rejectUnauthorized: false });
  });

  it("does not let the connection string weaken verification", () => {
    // sslmode=no-verify is a node-postgres extension that turns verification
    // off. Asking for TLS and asking to skip checking who answered are
    // different requests, and only the first is the URL's to make.
    expect(resolvedSsl(`${REMOTE}?sslmode=no-verify`)).toEqual({ rejectUnauthorized: true });
  });

  it("still disables TLS entirely where that was the decision", () => {
    const local = resolvedSsl("postgresql://u:p@localhost:5432/app?sslmode=disable");
    expect(local === false || local === undefined).toBe(true);
  });

  it("keeps the address and every parameter that is not about TLS", () => {
    const url = `${REMOTE}?sslmode=require&application_name=system-synthesis&connect_timeout=9`;
    const parameters = connectionParameters(url);
    expect(parameters.host).toBe("db.example.com");
    expect(parameters.port).toBe(5432);
    expect(parameters.database).toBe("app");
    expect(parameters.user).toBe("u");
    expect(parameters.application_name).toBe("system-synthesis");
  });

  it("leaves a connection string without TLS parameters untouched", () => {
    expect(poolConfig(REMOTE, databaseTls(REMOTE, {})).connectionString).toBe(REMOTE);
  });

  it("honours node-postgres's own ssl parameter, not only libpq's sslmode", () => {
    // ssl=true was stripped as a driver parameter and then not counted as a
    // request, so an explicit instruction to encrypt connected in the clear.
    expect(resolvedSsl("postgresql://u:p@localhost:5432/app?ssl=true")).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(resolvedSsl("postgresql://u:p@localhost:5432/app?ssl=1")).toMatchObject({
      rejectUnauthorized: true,
    });
  });

  it("reads ssl=false as a request for no encryption", () => {
    const local = resolvedSsl("postgresql://u:p@localhost:5432/app?ssl=false");
    expect(local === false || local === undefined).toBe(true);
  });

  it("still refuses ssl=false to a remote host in production", () => {
    expect(
      databaseTls("postgresql://u:p@db.example.com:5432/app?ssl=false", {
        NODE_ENV: "production",
      }).mode
    ).toBe("refused");
  });
});
