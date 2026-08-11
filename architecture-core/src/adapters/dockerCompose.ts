import type {
  ArchNodeType,
  SerializedEdge,
  SerializedNode,
  SourceProvenance,
} from "@system-synthesis/shared";
import {
  LineCounter,
  isMap,
  parseDocument,
  type Document,
  type ParsedNode,
} from "yaml";
import {
  formatPublishedPort,
  isPubliclyReachable,
  parsePublishedPort,
  type PublishedPortBinding,
} from "../portExposure.js";
import {
  canonicalizeGraph,
  stableEdgeId,
  stableEntityId,
} from "../provenance.js";
import type {
  ArchitectureSourceAdapter,
  DetectionResult,
  RepositorySourceFile,
  SourceImportContext,
  SourceImportDiagnostic,
  SourceImportResult,
} from "./types.js";
import { SourceImportError } from "./types.js";

const ADAPTER_ID = "docker-compose";
/**
 * Extraction contract for this adapter. Bump whenever the same Compose source
 * would now yield a different graph — new or removed entities, changed
 * identities, changed classification, or a new relationship source.
 *
 * Version 1 modelled only explicit `depends_on`. Version 2 added dependencies
 * inferred from environment references. Version 3 parses each published port
 * into a structured binding, preserving the host address that the long syntax
 * previously discarded, and renders the string form from that same parse.
 * Version 4 reads an unbracketed IPv6 host address, keeps an entry it cannot
 * fully model instead of dropping it, and assigns the zone from whether a port
 * is reachable beyond the machine rather than from whether one exists.
 *
 * This is separate from the analyzer version. Analyzer identity answers "would
 * the current rules still reach this verdict from this graph"; this answers
 * "would the current importer still produce this graph from that source". A
 * stored review cannot re-import itself, so an outdated graph needs a new
 * delivery rather than re-analysis.
 *
 * `architecture-core/src/__tests__/importVersion.test.ts` pins extraction
 * output so a change cannot land without a decision about this number.
 */
export const COMPOSE_ADAPTER_VERSION = 4;
const MAX_COMPOSE_BYTES = 1_000_000;
const MAX_SERVICES = 500;
/** Filenames `docker compose` picks up without an explicit `-f`. */
export const COMPOSE_FILE_NAMES: readonly string[] = [
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];
const COMPOSE_FILE_NAME_SET = new Set(COMPOSE_FILE_NAMES);

type ComposeService = Record<string, unknown>;
type ComposeDocument = {
  name?: string;
  services: Record<string, ComposeService>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sourceLine(
  document: Document.Parsed,
  lineCounter: LineCounter,
  path: Array<string | number>
): number | undefined {
  const node = document.getIn(path, true) as ParsedNode | undefined;
  const start = node?.range?.[0];
  return typeof start === "number" ? lineCounter.linePos(start).line : undefined;
}

function provenance(
  file: string,
  sourceAddress: string,
  revision: string | undefined,
  line?: number,
  confidence: SourceProvenance["confidence"] = "explicit"
): SourceProvenance {
  return {
    adapter: ADAPTER_ID,
    revision,
    file,
    sourceAddress,
    confidence,
    ...(line ? { startLine: line, endLine: line } : {}),
  };
}

function imageName(service: ComposeService): string {
  if (typeof service.image === "string") return service.image;
  if (typeof service.build === "string") return service.build;
  if (isRecord(service.build) && typeof service.build.context === "string") {
    return service.build.context;
  }
  return "";
}

function classifyService(name: string, service: ComposeService): ArchNodeType {
  const identity = `${name} ${imageName(service)}`.toLowerCase();
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function namedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return stringList(value);
  if (isRecord(value)) return Object.keys(value);
  return [];
}

function environmentKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.split("=")[0])
      .filter(Boolean)
      .sort();
  }
  return isRecord(value) ? Object.keys(value).sort() : [];
}

/**
 * Environment entries as key/value pairs. Values are read to resolve service
 * references and are never carried into the graph: a Compose environment block
 * routinely holds credentials, and the review model deliberately stores only
 * key names.
 */
function environmentEntries(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const separator = entry.indexOf("=");
      if (separator <= 0) return [];
      return [[entry.slice(0, separator), entry.slice(separator + 1)] as [string, string]];
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" || typeof item === "number"
      ? [[key, String(item)] as [string, string]]
      : []
  );
}

/**
 * Host candidates in an environment value, in the two forms a Compose service
 * reference actually takes: a bare service name, or the host component of a
 * URL/authority. Anything else is left alone — a substring match would invent
 * dependencies that do not exist.
 */
function hostCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) return [];
  const candidates = [trimmed];
  const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#:]+)/i.exec(trimmed);
  if (authority) candidates.push(authority[1]);
  const hostPort = /^([A-Za-z0-9_.-]+):\d{1,5}$/.exec(trimmed);
  if (hostPort) candidates.push(hostPort[1]);
  return candidates;
}

/**
 * Service references expressed through environment values, such as
 * `DATABASE_URL=postgres://database:5432/app`. Compose does not treat these as
 * dependencies, but they are how most real projects wire services together, so
 * they are modelled as inferred edges rather than ignored.
 */
function environmentReferences(
  service: ComposeService,
  serviceName: string,
  knownServices: Set<string>
): Array<{ key: string; target: string }> {
  const seen = new Set<string>();
  const references: Array<{ key: string; target: string }> = [];
  for (const [key, value] of environmentEntries(service.environment)) {
    for (const candidate of hostCandidates(value)) {
      if (candidate === serviceName || !knownServices.has(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      references.push({ key, target: candidate });
      break;
    }
  }
  return references.sort(
    (left, right) =>
      left.target.localeCompare(right.target) || left.key.localeCompare(right.key)
  );
}

function parseLongPort(entry: Record<string, unknown>): PublishedPortBinding | null {
  if (entry.target === undefined) return null;
  const hostIp = typeof entry.host_ip === "string" ? entry.host_ip.trim() : undefined;
  return {
    target: String(entry.target),
    ...(entry.published !== undefined ? { published: String(entry.published) } : {}),
    ...(hostIp ? { hostIp } : {}),
    protocol: String(entry.protocol || "").toLowerCase() === "udp" ? "udp" : "tcp",
  };
}

function portBindings(value: unknown): PublishedPortBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" || typeof entry === "number") {
      const parsed = parsePublishedPort(String(entry));
      return parsed ? [parsed] : [];
    }
    if (!isRecord(entry)) return [];
    const parsed = parseLongPort(entry);
    return parsed ? [parsed] : [];
  });
}

function exposedPortStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" || typeof entry === "number")
    .map(String);
}

function replicas(service: ComposeService): number {
  const deploy = isRecord(service.deploy) ? service.deploy : {};
  return typeof deploy.replicas === "number" && Number.isFinite(deploy.replicas)
    ? Math.max(1, Math.floor(deploy.replicas))
    : 1;
}

function dependencyNames(service: ComposeService): string[] {
  const dependencies = service.depends_on;
  if (Array.isArray(dependencies)) return stringList(dependencies).sort();
  if (isRecord(dependencies)) return Object.keys(dependencies).sort();
  return [];
}

function displayTechnology(image: string): string | undefined {
  if (!image) return undefined;
  return image.replace(/^.*\//, "");
}

function makeNode(
  serviceName: string,
  service: ComposeService,
  file: string,
  revision: string | undefined,
  line: number | undefined,
  index: number
): SerializedNode {
  const address = `services.${serviceName}`;
  const image = imageName(service);
  const publishedPortBindings = portBindings(service.ports);
  const publishedPorts = publishedPortBindings.map(formatPublishedPort);
  const exposedPorts = exposedPortStrings(service.expose);
  const networks = namedKeys(service.networks).sort();
  const volumes = stringList(service.volumes).sort();
  const secrets = namedKeys(service.secrets).sort();
  const type = classifyService(serviceName, service);
  return {
    id: stableEntityId("node", ADAPTER_ID, address),
    type: "architecture",
    position: {
      x: (index % 4) * 300,
      y: Math.floor(index / 4) * 190,
    },
    data: {
      label: serviceName,
      subtitle: image || "Docker Compose service",
      nodeType: type,
      status: "active",
      metadata: {
        notes: "",
        links: [],
        codeSnippet: "",
        attachedFiles: [],
      },
      tech: displayTechnology(image),
      environment: "development",
      instances: replicas(service),
      // A port reachable only from the machine itself does not put the service
      // in a perimeter zone; treating it as though it did marked correct local
      // bindings as publicly exposed.
      zone: publishedPortBindings.some(isPubliclyReachable) ? "dmz" : "private",
      provenance: provenance(file, address, revision, line),
      sourceProperties: {
        image: image || undefined,
        command: typeof service.command === "string" ? service.command : undefined,
        publishedPorts,
        // Structured form alongside the strings rather than replacing them, so a
        // pinned older Action keeps producing a payload this release accepts.
        publishedPortBindings: publishedPortBindings.length
          ? publishedPortBindings
          : undefined,
        exposedPorts,
        networks,
        volumes,
        secrets,
        environmentKeys: environmentKeys(service.environment),
        hasHealthcheck: isRecord(service.healthcheck),
        hasBuild: service.build !== undefined,
      },
    },
  };
}

function makeDependencyEdge(
  sourceName: string,
  targetName: string,
  file: string,
  revision: string | undefined,
  line: number | undefined
): SerializedEdge {
  const sourceAddress = `services.${sourceName}`;
  const targetAddress = `services.${targetName}`;
  return {
    id: stableEdgeId(ADAPTER_ID, sourceAddress, targetAddress, "depends_on"),
    source: stableEntityId("node", ADAPTER_ID, sourceAddress),
    target: stableEntityId("node", ADAPTER_ID, targetAddress),
    data: {
      label: "depends_on",
      direction: "unidirectional",
      provenance: [
        provenance(
          file,
          `${sourceAddress}.depends_on.${targetName}`,
          revision,
          line
        ),
      ],
    },
  };
}

/** Unambiguous key for a directed service pair, free of delimiter collisions. */
function pairKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function makeEnvironmentEdge(
  sourceName: string,
  targetName: string,
  environmentKey: string,
  file: string,
  revision: string | undefined,
  line: number | undefined
): SerializedEdge {
  const sourceAddress = `services.${sourceName}`;
  const targetAddress = `services.${targetName}`;
  return {
    id: stableEdgeId(ADAPTER_ID, sourceAddress, targetAddress, "environment"),
    source: stableEntityId("node", ADAPTER_ID, sourceAddress),
    target: stableEntityId("node", ADAPTER_ID, targetAddress),
    data: {
      label: "environment",
      direction: "unidirectional",
      provenance: [
        provenance(
          file,
          `${sourceAddress}.environment.${environmentKey}`,
          revision,
          line,
          "inferred"
        ),
      ],
    },
  };
}

function composeFile(files: RepositorySourceFile[]): RepositorySourceFile | undefined {
  const namedMatch = [...files]
    .filter((file) => COMPOSE_FILE_NAME_SET.has(file.path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() || ""))
    .sort((left, right) => left.path.localeCompare(right.path))[0];
  // An explicit single-file import may use any filename accepted by
  // `docker compose -f`; repository auto-detection remains conservative.
  return namedMatch || (files.length === 1 ? files[0] : undefined);
}

export const dockerComposeAdapter: ArchitectureSourceAdapter = {
  id: ADAPTER_ID,

  detect(files): DetectionResult {
    const matches = files
      .filter((file) => COMPOSE_FILE_NAME_SET.has(file.path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() || ""))
      .map((file) => file.path)
      .sort();
    return {
      detected: matches.length > 0,
      confidence: matches.length ? "strong" : "none",
      files: matches,
    };
  },

  import(
    files: RepositorySourceFile[],
    context: SourceImportContext = {}
  ): SourceImportResult {
    const file = composeFile(files);
    if (!file) {
      throw new SourceImportError("No Docker Compose file was found.", [{
        code: "compose.file.missing",
        severity: "error",
        message: "Expected compose.yml, compose.yaml, docker-compose.yml, or docker-compose.yaml.",
        file: "",
      }]);
    }
    if (Buffer.byteLength(file.content, "utf8") > MAX_COMPOSE_BYTES) {
      throw new SourceImportError("Docker Compose file exceeds the supported size limit.", [{
        code: "compose.file.too_large",
        severity: "error",
        message: `Compose files are limited to ${MAX_COMPOSE_BYTES} bytes.`,
        file: file.path,
      }]);
    }

    const lineCounter = new LineCounter();
    const document = parseDocument(file.content, {
      lineCounter,
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length) {
      const diagnostics = document.errors.map((error) => ({
        code: "compose.yaml.invalid",
        severity: "error" as const,
        message: error.message,
        file: file.path,
        line: error.linePos?.[0]?.line,
      }));
      throw new SourceImportError("Docker Compose YAML is invalid.", diagnostics);
    }
    if (!isMap(document.contents)) {
      throw new SourceImportError("Docker Compose root must be a mapping.", [{
        code: "compose.root.invalid",
        severity: "error",
        message: "The Compose document root must be a YAML mapping.",
        file: file.path,
      }]);
    }

    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 50 }) as unknown;
    } catch (error) {
      throw new SourceImportError("Docker Compose YAML exceeds the supported alias-expansion limit.", [{
        code: "compose.yaml.alias_limit",
        severity: "error",
        message: error instanceof Error
          ? error.message
          : "YAML alias expansion exceeded the supported limit.",
        file: file.path,
      }]);
    }
    if (!isRecord(value) || !isRecord(value.services)) {
      throw new SourceImportError("Docker Compose services are missing.", [{
        code: "compose.services.missing",
        severity: "error",
        message: "The Compose document must contain a services mapping.",
        file: file.path,
        sourceAddress: "services",
        line: sourceLine(document, lineCounter, ["services"]),
      }]);
    }
    const compose = value as ComposeDocument;
    const serviceNames = Object.keys(compose.services).sort();
    const invalidServices = serviceNames.filter(
      (name) => !isRecord(compose.services[name])
    );
    if (invalidServices.length) {
      throw new SourceImportError("Docker Compose services must be mappings.", invalidServices.map(
        (name) => ({
          code: "compose.service.invalid",
          severity: "error" as const,
          message: `Service "${name}" must be a YAML mapping.`,
          file: file.path,
          sourceAddress: `services.${name}`,
          line: sourceLine(document, lineCounter, ["services", name]),
        })
      ));
    }
    if (serviceNames.length > MAX_SERVICES) {
      throw new SourceImportError("Docker Compose service count exceeds the supported limit.", [{
        code: "compose.services.too_many",
        severity: "error",
        message: `Compose imports are limited to ${MAX_SERVICES} services.`,
        file: file.path,
        sourceAddress: "services",
      }]);
    }

    const diagnostics: SourceImportDiagnostic[] = [];
    const knownServices = new Set(serviceNames);
    const nodes = serviceNames.map((name, index) =>
      makeNode(
        name,
        compose.services[name],
        file.path,
        context.revision,
        sourceLine(document, lineCounter, ["services", name]),
        index
      )
    );
    const edges = serviceNames.flatMap((name) =>
      dependencyNames(compose.services[name]).flatMap((dependency) => {
        const line = sourceLine(document, lineCounter, ["services", name, "depends_on", dependency])
          || sourceLine(document, lineCounter, ["services", name, "depends_on"]);
        if (!knownServices.has(dependency)) {
          diagnostics.push({
            code: "compose.dependency.unknown",
            severity: "warning",
            message: `Service "${name}" depends on unknown service "${dependency}".`,
            file: file.path,
            sourceAddress: `services.${name}.depends_on.${dependency}`,
            line,
          });
          return [];
        }
        return [makeDependencyEdge(name, dependency, file.path, context.revision, line)];
      })
    );
    // An explicit `depends_on` already states the relationship; an inferred
    // environment reference must not duplicate or outrank it.
    const declaredPairs = new Set(
      serviceNames.flatMap((name) =>
        dependencyNames(compose.services[name])
          .filter((dependency) => knownServices.has(dependency))
          .map((dependency) => pairKey(name, dependency))
      )
    );
    edges.push(
      ...serviceNames.flatMap((name) =>
        environmentReferences(compose.services[name], name, knownServices)
          .filter(({ target }) => !declaredPairs.has(pairKey(name, target)))
          .map(({ key, target }) =>
            makeEnvironmentEdge(
              name,
              target,
              key,
              file.path,
              context.revision,
              sourceLine(document, lineCounter, ["services", name, "environment", key])
                || sourceLine(document, lineCounter, ["services", name, "environment"])
            )
          )
      )
    );

    return {
      graph: canonicalizeGraph({
        source: {
          adapter: ADAPTER_ID,
          adapterVersion: COMPOSE_ADAPTER_VERSION,
          repository: context.repository,
          revision: context.revision,
          files: [file.path],
        },
        nodes,
        edges,
      }),
      diagnostics,
    };
  },
};
