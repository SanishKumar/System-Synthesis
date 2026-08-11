import type { PublishedPortBinding } from "./adapters/dockerCompose.js";

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
  if (host.includes("${") || host.includes("$")) return "unknown";

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
