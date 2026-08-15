/**
 * How a connection to a backing service should be secured.
 *
 * Shared by PostgreSQL and Redis because the mistake is the same in both: it is
 * easy to encrypt a connection and never check who answered, and easy to send
 * plaintext across a network because a URL happened to be written one way
 * rather than another. Deciding it once means the two cannot drift.
 */
export type TransportTls =
  | { mode: "disabled" }
  | { mode: "verified"; ca?: string }
  | { mode: "unverified" }
  | { mode: "refused"; reason: string };

/**
 * What the connection string asked for.
 *
 * `disabled` is an explicit instruction — `sslmode=disable`, or a `redis://`
 * scheme. `unspecified` means the URL said nothing, which is where a default
 * has to be chosen.
 */
export type TlsRequest = "disabled" | "encrypted" | "unspecified";

export interface TlsDecision {
  service: string;
  host: string;
  requested: TlsRequest;
  noVerify?: boolean;
  ca?: string;
  allowPlaintext?: boolean;
  nodeEnv?: string;
}

/**
 * Whether this address is the machine the process is running on.
 *
 * Only true loopback counts. A container hostname on a private network looks
 * local and is not: packets leave the process, and on a shared or overlay
 * network something else can be listening. Those connections say
 * `sslmode=disable` explicitly, which is exactly the point — the decision is
 * visible in the configuration rather than inferred from a name.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * Chooses transport security, defaulting to the safe answer.
 *
 * A URL that names a remote host and says nothing about TLS gets a verified
 * connection. Deciding that from the URL scheme instead — treating
 * `postgres://` and `postgresql://` differently — meant the same database
 * reached by two spellings of the same address got two different answers, and
 * one of them was plaintext across a network.
 *
 * Turning encryption off entirely stays possible, because a local instance and
 * a CI service container have none to offer. In production, to somewhere other
 * than this machine, it has to be stated twice: once in the URL and once as an
 * explicit acceptance. Sending credentials in the clear over a network is not
 * something a single misplaced query parameter should be able to arrange.
 */
export function decideTransportTls(decision: TlsDecision): TransportTls {
  const local = isLoopbackHost(decision.host);

  if (decision.requested === "disabled") {
    // Naming the authorities to trust and turning encryption off are opposite
    // instructions, and picking one silently is how a trust decision gets made
    // by accident. Checked here rather than where the URL is parsed, because a
    // trust anchor can also arrive through the environment, and both services
    // read one — the whole reason this decision is shared.
    if (decision.ca) {
      return {
        mode: "refused",
        reason:
          `${decision.service} was given certificate authorities to trust and also told ` +
          "not to use TLS. Remove one: authorities are only meaningful on an encrypted " +
          "connection.",
      };
    }
    if (!local && decision.nodeEnv === "production" && !decision.allowPlaintext) {
      return {
        mode: "refused",
        reason:
          `${decision.service} is configured to connect to ${decision.host} without TLS. ` +
          "Credentials and data would cross the network in plaintext. Remove the " +
          "disable, or accept it explicitly for this deployment.",
      };
    }
    return { mode: "disabled" };
  }

  // A trust anchor says there is a certificate to check, whether it was named
  // in the URL or supplied through the environment, so it is a request for TLS
  // even to a service on this machine.
  if (decision.requested === "unspecified" && local && !decision.ca) {
    // Nothing said, nothing to negotiate: a database on this machine.
    return { mode: "disabled" };
  }

  if (decision.noVerify) return { mode: "unverified" };
  return decision.ca ? { mode: "verified", ca: decision.ca } : { mode: "verified" };
}

/** The host a connection string names, or null if it cannot be read. */
export function connectionHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Every parameter node-postgres reads TLS settings from.
 *
 * Taken from what pg-connection-string actually consumes rather than from the
 * shorter list one would guess.
 */
const DRIVER_SSL_PARAMETERS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "uselibpqcompat",
];

/**
 * What a connection string asks for about TLS, in the several ways it can.
 *
 * `sslmode` is libpq's spelling and `ssl` is node-postgres's own. Reading only
 * the first meant `ssl=true` was stripped as a driver parameter and then not
 * counted as a request, so an explicit instruction to encrypt was answered by
 * connecting in the clear. A file of trusted roots was discarded the same way,
 * leaving Node's default trust in place of the one that was asked for.
 */
export interface UrlTlsIntent {
  requested: TlsRequest;
  /** `sslrootcert`: a file of certificate authorities to trust instead. */
  caPath?: string;
  /** `sslcert`/`sslkey`: a client certificate, which is not supported here. */
  clientCertificateParameters: string[];
  /** Set when the string cannot be honoured as written. */
  invalid?: string;
}

/**
 * What libpq accepts, plus node-postgres's own extension.
 *
 * A value outside this set is a mistake, not a preference. `sslmode=требуется`
 * or a typo like `requir` would otherwise fall through to "something was asked
 * for, so encrypt" — the right answer by luck, from a string nobody read.
 */
const SSL_MODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
  "no-verify",
]);

export function readUrlTlsIntent(url: string): UrlTlsIntent {
  const empty: UrlTlsIntent = { requested: "unspecified", clientCertificateParameters: [] };
  let parameters: URLSearchParams;
  try {
    parameters = new URL(url).searchParams;
  } catch {
    return empty;
  }

  const caPath = parameters.get("sslrootcert") || undefined;
  const clientCertificateParameters = ["sslcert", "sslkey"].filter((name) =>
    parameters.has(name)
  );
  const invalid = (reason: string): UrlTlsIntent => ({
    requested: "unspecified",
    caPath,
    clientCertificateParameters,
    invalid: reason,
  });

  const sslmode = parameters.get("sslmode");
  const ssl = parameters.get("ssl");
  if (sslmode !== null && !SSL_MODES.has(sslmode)) {
    return invalid(`sslmode=${sslmode} is not a value this connection can be made with`);
  }
  if (ssl !== null && !["true", "false", "1", "0"].includes(ssl)) {
    return invalid(`ssl=${ssl} is not a value this connection can be made with`);
  }

  let requested: TlsRequest = "unspecified";
  if (sslmode !== null) {
    requested = sslmode === "disable" ? "disabled" : "encrypted";
  }
  if (ssl !== null) {
    const fromSsl: TlsRequest = ssl === "true" || ssl === "1" ? "encrypted" : "disabled";
    // Two parameters that answer the same question differently is a mistake
    // whichever one wins, so neither does.
    if (requested !== "unspecified" && requested !== fromSsl) {
      return invalid(`sslmode=${sslmode} and ssl=${ssl} ask for opposite things`);
    }
    requested = fromSsl;
  }

  // Naming the authorities to trust is a statement that there is a certificate
  // to check, so it is a request for TLS even when nothing else says so. Paired
  // with an instruction to disable, it is a contradiction rather than a default.
  if (caPath) {
    if (requested === "disabled") {
      return invalid(
        `sslrootcert names certificate authorities to trust, but the same URL turns TLS off`
      );
    }
    requested = "encrypted";
  }

  return { requested, caPath, clientCertificateParameters };
}

/**
 * Removes the TLS parameters the driver would act on itself.
 *
 * node-postgres does not merge a connection string's SSL settings with an `ssl`
 * option — the string replaces the object. So a URL ending in `sslmode=require`
 * silently discarded everything decided here: the supplied CA never reached the
 * socket, and the emergency no-verify switch did nothing at all. What looked
 * like a verified connection was verified only because this version of the
 * driver happens to read `require` as full verification, and it warns that a
 * future major will read it as libpq does, which does not verify.
 *
 * Deciding the policy and then leaving the driver an instruction to override it
 * is not a decision. The string carries the address; the `ssl` object carries
 * the security.
 */
export function withoutDriverSslParameters(url: string): string {
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const parameter of DRIVER_SSL_PARAMETERS) {
      if (parsed.searchParams.has(parameter)) {
        parsed.searchParams.delete(parameter);
        touched = true;
      }
    }
    return touched ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Says which of the four it chose, because an operator cannot tell by looking
 * at a working connection whether the certificate was checked.
 */
export function describeTls(service: string, tls: TransportTls): string {
  if (tls.mode === "verified") {
    return `${service} TLS: certificate verified${tls.ca ? " against a supplied CA" : ""}`;
  }
  if (tls.mode === "unverified") {
    return (
      `${service} TLS: encrypted but NOT verified. ` +
      "Anything that can answer for that address can read and rewrite every request."
    );
  }
  if (tls.mode === "refused") return tls.reason;
  return `${service} TLS: disabled`;
}
