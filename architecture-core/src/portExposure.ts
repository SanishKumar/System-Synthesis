import type { SerializedNode } from "@system-synthesis/shared";

/**
 * One published port, parsed once.
 *
 * Ports and addresses stay strings so a range such as `8000-8010` survives
 * without being coerced to a number. An absent `hostIp` means every interface;
 * an absent `published` means Docker allocates a host port, which is still host
 * publication rather than an internal-only port.
 *
 * How the binding was written is deliberately not recorded. `sourceProperties`
 * is inside the content fingerprint, so keeping the syntax would make rewriting
 * a short entry as an equivalent long one register as an architecture change.
 */
export interface PublishedPortBinding {
  target: string;
  published?: string;
  hostIp?: string;
  protocol: "tcp" | "udp";
}

/**
 * Who can reach a published port.
 *
 * `external` is every interface, `host` is one specific non-loopback address,
 * `loopback` is the machine itself, and `unknown` is an address that could not
 * be resolved — an unexpanded variable, or a form this adapter does not model.
 * Unknown is never folded into loopback: a port whose reach cannot be
 * established must not be reported as safe.
 */
export type PortExposure = "external" | "host" | "loopback" | "unknown";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;
/** Any of the documented spellings of the IPv6 loopback address. */
const IPV6_LOOPBACK = /^(::1|(0{1,4}:){7}0{0,3}1)$/;
const IPV6ISH = /^[0-9a-f:]+$/;

export function portExposure(binding: PublishedPortBinding): PortExposure {
  const host = binding.hostIp?.trim();
  // Compose binds to every interface when no address is given.
  if (!host) return "external";
  // An unexpanded variable could be anything, including 0.0.0.0.
  if (host.includes("$")) return "unknown";

  const value = host.toLowerCase();
  if (value === "0.0.0.0" || value === "::" || value === "*") return "external";
  if (value === "localhost" || IPV4_LOOPBACK.test(value) || IPV6_LOOPBACK.test(value)) {
    return "loopback";
  }
  if (IPV4.test(value) || IPV6ISH.test(value)) return "host";
  return "unknown";
}

/**
 * Whether a binding puts the port beyond the machine. Loopback does not; an
 * address that cannot be resolved is assumed to, because the alternative is
 * silently treating an unknown reach as contained.
 */
export function isPubliclyReachable(binding: PublishedPortBinding): boolean {
  return portExposure(binding) !== "loopback";
}

function normalizeProtocol(value: unknown): "tcp" | "udp" {
  return typeof value === "string" && value.trim().toLowerCase() === "udp"
    ? "udp"
    : "tcp";
}

/**
 * Compose short syntax: `[HOST_IP:][HOST_PORT:]CONTAINER_PORT[/PROTOCOL]`.
 *
 * An IPv6 host address may be bracketed or bare, which is what makes splitting
 * on every colon wrong. The host port and container port are always the final
 * two segments, so the address is whatever precedes them, and both address
 * families fall out of the same rule.
 */
export function parsePublishedPort(raw: string): PublishedPortBinding | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  const protocol = normalizeProtocol(slash === -1 ? undefined : trimmed.slice(slash + 1));
  const withoutProtocol = slash === -1 ? trimmed : trimmed.slice(0, slash);

  const bracketed = /^\[([^\]]+)\]:(.*)$/.exec(withoutProtocol);
  const hostIp = bracketed ? bracketed[1] : undefined;
  const remainder = bracketed ? bracketed[2] : withoutProtocol;
  const parts = remainder.split(":");

  if (hostIp !== undefined) {
    if (parts.length === 2) return { hostIp, published: parts[0], target: parts[1], protocol };
    if (parts.length === 1) return { hostIp, target: parts[0], protocol };
    // Brackets already delimited the address, so anything further is unmodelled.
    return { hostIp, target: parts.join(":"), protocol };
  }
  if (parts.length === 1) return { target: parts[0], protocol };
  if (parts.length === 2) return { published: parts[0], target: parts[1], protocol };
  return {
    hostIp: parts.slice(0, -2).join(":"),
    published: parts[parts.length - 2],
    target: parts[parts.length - 1],
    protocol,
  };
}

/** The string form, rendered from a binding so the two cannot disagree. */
export function formatPublishedPort(binding: PublishedPortBinding): string {
  const address = [binding.hostIp, binding.published, binding.target]
    .filter((part) => part !== undefined)
    .join(":");
  return binding.protocol === "udp" ? `${address}/udp` : address;
}

function isBinding(value: unknown): value is PublishedPortBinding {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PublishedPortBinding).target === "string"
  );
}

/**
 * Published ports of a node as classified bindings.
 *
 * A graph from an importer that predates structured bindings carries only the
 * string form, so those are parsed back. That recovers the host address for
 * every short-syntax entry, which is the common case; a long-syntax entry had
 * its address discarded at extraction and can only read as external, exactly as
 * it did before. Reading the strings keeps the exposure rules working for
 * repositories still pinned to an older Action, rather than silently reporting
 * nothing for them.
 */
export function nodePortBindings(node: SerializedNode): PublishedPortBinding[] {
  const properties = node.data.sourceProperties as
    | { publishedPortBindings?: unknown; publishedPorts?: unknown }
    | undefined;
  const structured = properties?.publishedPortBindings;
  if (Array.isArray(structured)) return structured.filter(isBinding);

  const strings = properties?.publishedPorts;
  if (!Array.isArray(strings)) return [];
  return strings.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const parsed = parsePublishedPort(entry);
    return parsed ? [parsed] : [];
  });
}
