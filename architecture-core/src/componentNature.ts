import type { ArchNodeType } from "@system-synthesis/shared";

/**
 * What a component is, decided from how it identifies itself.
 *
 * Shared by every source adapter. A Postgres image is a database whether it was
 * declared as a Compose service or a Kubernetes StatefulSet, and the two
 * adapters disagreeing about that would make the same system compare as changed
 * across sources rather than across revisions.
 *
 * The caller supplies an already-lowercased identity string assembled from
 * whatever names its source offers — for Compose the service name and image,
 * for Kubernetes the workload name and its container images.
 */
export function classifyByIdentity(identity: string): ArchNodeType {
  if (/(postgres|mysql|mariadb|mongo|cassandra|cockroach|sqlserver|mssql|oracle)/.test(identity)) return "database";
  if (/(redis|memcached)/.test(identity)) return "cache";
  if (/(rabbitmq|kafka|nats|pulsar|activemq|redpanda)/.test(identity)) return "broker";
  if (/(elasticsearch|opensearch|meilisearch|solr)/.test(identity)) return "search";
  if (/(nginx|traefik|envoy|haproxy|caddy)/.test(identity)) return "proxy";
  if (/(prometheus|grafana|datadog|newrelic|jaeger|zipkin)/.test(identity)) return "monitor";
  if (/(minio|seaweedfs)/.test(identity)) return "storage";
  if (/(vault)/.test(identity)) return "vault";
  if (/(keycloak|ory|authentik)/.test(identity)) return "auth";
  return "service";
}

/**
 * Components whose place in the topology is decided by what they are.
 *
 * A database is internal whether or not somebody published its port. Deriving
 * the zone from exposure alone made that backwards: publishing a database moved
 * it from `private` into `dmz`, and the trust-boundary crossings into it stopped
 * being crossings at all. Exposing a datastore made two findings disappear.
 *
 * Exposure is still reported — by the rules that exist for it, which name the
 * component and the port. It just no longer rewrites what the component is.
 */
export const INTERNAL_BY_NATURE = new Set<ArchNodeType>([
  "database",
  "storage",
  "warehouse",
  "cache",
  "broker",
  "queue",
  "search",
  "stream",
  "vault",
  "registry",
]);

/**
 * Where a component sits, given what it is and whether anything outside can
 * reach it.
 *
 * `reachableFromOutside` means beyond the boundary the source describes — the
 * machine for Compose, the cluster for Kubernetes. A binding that stays inside
 * that boundary does not put a component in a perimeter zone; treating it as
 * though it did marked correct internal bindings as publicly exposed.
 */
export function zoneFor(
  type: ArchNodeType,
  reachableFromOutside: boolean
): "dmz" | "private" {
  if (INTERNAL_BY_NATURE.has(type)) return "private";
  return reachableFromOutside ? "dmz" : "private";
}
