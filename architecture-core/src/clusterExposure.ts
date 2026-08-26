/**
 * One Kubernetes Service port, parsed once.
 *
 * Values stay strings so a named `targetPort` such as `web` survives alongside
 * a numeric one, and so a value the manifest did not resolve is preserved as
 * written rather than coerced. `nodePort` is present only when the manifest
 * pinned one; a NodePort Service without it still allocates one.
 */
export interface ClusterPortBinding {
  port: string;
  targetPort?: string;
  nodePort?: string;
  protocol: "TCP" | "UDP" | "SCTP";
  name?: string;
}

/**
 * Who can reach a workload through a Service.
 *
 * `external` is routable from outside the cluster by design — a LoadBalancer, a
 * pinned external address, or an Ingress route. `node` is a NodePort, which
 * opens the port on every node's own address: past the cluster boundary, but
 * how far past depends on the node network. `cluster` is reachable only from
 * inside. `unknown` is a value this adapter could not resolve — a Helm
 * directive, an unexpanded variable, or a form it does not model.
 *
 * Unknown is never folded into `cluster`, for the same reason an unresolved
 * host address is never folded into loopback: a reach that cannot be
 * established must not be reported as contained.
 */
export type ClusterExposure = "external" | "node" | "cluster" | "unknown";

/** A value the manifest did not resolve to a literal. */
export function isUnresolved(value: string): boolean {
  return value.includes("$") || value.includes("{{");
}

export interface ServiceReachInput {
  /** `spec.type`, absent when the manifest relies on the ClusterIP default. */
  type?: string;
  /** `spec.externalIPs`, each an address the cluster answers on directly. */
  externalIPs?: string[];
  /** Whether an Ingress in the same import routes traffic to this Service. */
  routedByIngress?: boolean;
}

export function clusterExposure(service: ServiceReachInput): ClusterExposure {
  const declared = service.type?.trim();
  const externalIPs = service.externalIPs || [];

  // Definite reach outranks an unresolved property beside it. A literal address
  // or an Ingress route proves that traffic crosses the cluster boundary even
  // when `spec.type` is templated. Treating the template first would downgrade
  // known exposure to "unknown" and, for Ingress, lose the backend-port
  // narrowing that depends on the route being the source of exposure.
  if (externalIPs.some((address) => !isUnresolved(address))) return "external";
  if (service.routedByIngress) return "external";

  // These literal types establish reach on their own. An unresolved
  // `externalIPs` entry beside one cannot make that known opening disappear.
  if (declared === "LoadBalancer") return "external";
  if (declared === "NodePort") return "node";

  if (declared && isUnresolved(declared)) return "unknown";
  if (externalIPs.some((address) => isUnresolved(address))) return "unknown";

  switch (declared || "ClusterIP") {
    case "ClusterIP":
    // An ExternalName Service is a DNS alias out of the cluster. It publishes
    // nothing of the workload, so it grants no inbound reach.
    case "ExternalName":
      return "cluster";
    default:
      return "unknown";
  }
}

/**
 * Whether an exposure puts a workload past the cluster boundary. An exposure
 * that could not be resolved counts, because the alternative is silently
 * treating an unknown reach as contained.
 */
export function isReachableFromOutsideCluster(exposure: ClusterExposure): boolean {
  return exposure !== "cluster";
}

export function formatClusterPort(binding: ClusterPortBinding): string {
  const target = binding.targetPort && binding.targetPort !== binding.port
    ? `->${binding.targetPort}`
    : "";
  const node = binding.nodePort ? `:${binding.nodePort}` : "";
  const protocol = binding.protocol === "TCP" ? "" : `/${binding.protocol.toLowerCase()}`;
  return `${binding.port}${target}${node}${protocol}`;
}
