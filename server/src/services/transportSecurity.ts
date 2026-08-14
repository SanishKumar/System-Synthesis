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

  // Nothing said, nothing to negotiate: a database on this machine.
  if (decision.requested === "unspecified" && local) return { mode: "disabled" };

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
