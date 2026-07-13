/**
 * Docker Compose Exporter
 *
 * Converts an architecture graph into a docker-compose.yml string.
 * Maps node types to Docker images, parses edges for depends_on,
 * and generates environment variables, ports, and volumes.
 */

import type { SerializedNode, SerializedEdge } from "@system-synthesis/shared";
import { buildInfrastructureIR, provenanceHeader } from "./ir.js";

// ── Image & Port Mappings ──────────────────────────────────────────

interface DockerMapping {
  image: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  command?: string;
}

/** Resolve a Docker image from tech string or node type */
function resolveDockerMapping(node: SerializedNode): DockerMapping {
  const tech = (node.data.tech || "").toLowerCase();
  const nodeType = node.data.nodeType;

  // --- Tech-specific overrides ---
  if (tech.includes("postgres"))     return { image: "postgres:16.3-alpine", ports: ["5432:5432"], environment: { POSTGRES_USER: "${POSTGRES_USER:-app}", POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}", POSTGRES_DB: "${POSTGRES_DB:-appdb}" }, volumes: ["pgdata:/var/lib/postgresql/data"] };
  if (tech.includes("mysql"))        return { image: "mysql:8.4", ports: ["3306:3306"], environment: { MYSQL_ROOT_PASSWORD: "${MYSQL_ROOT_PASSWORD:?set MYSQL_ROOT_PASSWORD}", MYSQL_DATABASE: "${MYSQL_DATABASE:-appdb}" }, volumes: ["mysqldata:/var/lib/mysql"] };
  if (tech.includes("mongo"))        return { image: "mongo:7", ports: ["27017:27017"], volumes: ["mongodata:/data/db"] };
  if (tech.includes("redis"))        return { image: "redis:7-alpine", ports: ["6379:6379"], command: "redis-server --appendonly yes", volumes: ["redisdata:/data"] };
  if (tech.includes("kafka"))        return { image: "confluentinc/cp-kafka:7.6.0", ports: ["9092:9092"], environment: { KAFKA_BROKER_ID: "1", KAFKA_ZOOKEEPER_CONNECT: "zookeeper:2181", KAFKA_ADVERTISED_LISTENERS: "PLAINTEXT://kafka:9092", KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1" } };
  if (tech.includes("rabbit"))       return { image: "rabbitmq:3-management-alpine", ports: ["5672:5672", "15672:15672"] };
  if (tech.includes("elastic"))      return { image: "elasticsearch:8.13.0", ports: ["9200:9200"], environment: { "discovery.type": "single-node", "xpack.security.enabled": "false" }, volumes: ["esdata:/usr/share/elasticsearch/data"] };
  if (tech.includes("clickhouse"))   return { image: "clickhouse/clickhouse-server:24", ports: ["8123:8123", "9000:9000"], volumes: ["chdata:/var/lib/clickhouse"] };
  if (tech.includes("timescale"))    return { image: "timescale/timescaledb:2.15.3-pg16", ports: ["5432:5432"], environment: { POSTGRES_USER: "${POSTGRES_USER:-app}", POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}" }, volumes: ["tsdata:/var/lib/postgresql/data"] };
  if (tech.includes("nginx"))        return { image: "nginx:alpine", ports: ["80:80", "443:443"] };
  if (tech.includes("kong"))         return { image: "kong:3.6", ports: ["8000:8000", "8443:8443", "8001:8001"], environment: { KONG_DATABASE: "off", KONG_PROXY_ACCESS_LOG: "/dev/stdout", KONG_ADMIN_ACCESS_LOG: "/dev/stdout", KONG_PROXY_ERROR_LOG: "/dev/stderr", KONG_ADMIN_ERROR_LOG: "/dev/stderr" } };
  if (tech.includes("haproxy"))      return { image: "haproxy:2.9-alpine", ports: ["80:80", "443:443"] };
  if (tech.includes("minio") || tech.includes("s3")) return { image: "minio/minio:RELEASE.2024-06-29T01-20-47Z", ports: ["9000:9000", "9001:9001"], command: "server /data --console-address ':9001'", volumes: ["miniodata:/data"], environment: { MINIO_ROOT_USER: "${MINIO_ROOT_USER:?set MINIO_ROOT_USER}", MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD}" } };

  // --- Node type fallbacks ---
  switch (nodeType) {
    case "database":      return { image: "postgres:16.3-alpine", ports: ["5432:5432"], environment: { POSTGRES_USER: "${POSTGRES_USER:-app}", POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}", POSTGRES_DB: "${POSTGRES_DB:-appdb}" }, volumes: ["pgdata:/var/lib/postgresql/data"] };
    case "cache":         return { image: "redis:7-alpine", ports: ["6379:6379"] };
    case "queue":         return { image: "rabbitmq:3-management-alpine", ports: ["5672:5672", "15672:15672"] };
    case "gateway":       return { image: "nginx:alpine", ports: ["80:80"] };
    case "loadbalancer":  return { image: "haproxy:2.9-alpine", ports: ["80:80"] };
    case "storage":       return { image: "minio/minio:latest", ports: ["9000:9000", "9001:9001"], command: "server /data --console-address ':9001'" };
    case "service":       return { image: "node:20-alpine", ports: ["3000:3000"], command: "node server.js" };
    case "client":        return { image: "nginx:alpine", ports: ["8080:80"] };
    default:              return { image: "alpine:latest" };
  }
}

// ── Compose Generator ──────────────────────────────────────────────

export function generateDockerCompose(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): string {
  const ir = buildInfrastructureIR(nodes, edges, "docker-compose");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const volumes = new Set<string>();
  const services: string[] = [];

  for (const resource of ir.resources) {
    const node = nodeById.get(resource.sourceNodeId)!;
    // Skip client nodes (browsers) — they don't run as Docker services
    if (node.data.nodeType === "client") continue;

    const svcName = resource.name;
    const mapping = resolveDockerMapping(node);
    const lines: string[] = [];

    lines.push(`  ${svcName}:`);
    lines.push(`    image: ${mapping.image}`);
    lines.push(`    container_name: ${svcName}`);

    if (node.data.instances && node.data.instances > 1) {
      lines.push(`    deploy:`);
      lines.push(`      replicas: ${node.data.instances}`);
    }

    lines.push(`    restart: unless-stopped`);

    if (mapping.ports && mapping.ports.length > 0) {
      lines.push(`    ports:`);
      for (const p of mapping.ports) lines.push(`      - "${p}"`);
    }

    if (mapping.environment && Object.keys(mapping.environment).length > 0) {
      lines.push(`    environment:`);
      for (const [k, v] of Object.entries(mapping.environment).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`      ${k}: "${v}"`);
      }
    }

    if (mapping.volumes && mapping.volumes.length > 0) {
      lines.push(`    volumes:`);
      for (const v of mapping.volumes) {
        const [baseName, mountPath] = v.split(":");
        const volName = `${svcName}-${baseName}`;
        lines.push(`      - ${volName}:${mountPath}`);
        volumes.add(volName);
      }
    }

    if (mapping.command) {
      lines.push(`    command: ${mapping.command}`);
    }

    // depends_on from edges
    const resolvedDeps = resource.dependsOn.filter((name) => name !== svcName);
    if (resolvedDeps.length > 0) {
      lines.push(`    depends_on:`);
      for (const dep of resolvedDeps) lines.push(`      - ${dep}`);
    }

    // Networks
    const zone = node.data.zone;
    if (zone) {
      lines.push(`    networks:`);
      lines.push(`      - ${zone}`);
    }

    services.push(lines.join("\n"));
  }

  // Assemble
  let output = `${provenanceHeader(ir)}\n\n`;
  output += `version: "3.9"\n\n`;
  output += `services:\n`;
  output += services.join("\n\n");
  output += `\n`;

  // Volumes
  if (volumes.size > 0) {
    output += `\nvolumes:\n`;
    for (const vol of [...volumes].sort()) {
      output += `  ${vol}:\n    driver: local\n`;
    }
  }

  // Networks from zones
  const zones = new Set(
    ir.resources.map((resource) => resource.zone).filter(Boolean) as string[]
  );
  if (zones.size > 0) {
    output += `\nnetworks:\n`;
    for (const zone of [...zones].sort()) {
      output += `  ${zone}:\n    driver: bridge\n`;
    }
  }

  return output;
}
