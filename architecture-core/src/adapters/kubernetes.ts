import type {
  SerializedEdge,
  SerializedNode,
  SourceProvenance,
} from "@system-synthesis/shared";
import {
  LineCounter,
  parseAllDocuments,
  type Document,
  type ParsedNode,
} from "yaml";
import { classifyByIdentity, zoneFor } from "../componentNature.js";
import {
  clusterExposure,
  formatClusterPort,
  isReachableFromOutsideCluster,
  isUnresolved,
  type ClusterExposure,
  type ClusterPortBinding,
} from "../clusterExposure.js";
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

const ADAPTER_ID = "kubernetes";

/**
 * Extraction contract for this adapter. Bump whenever the same manifests would
 * now yield a different graph — new or removed entities, changed identities,
 * changed classification, or a new relationship source.
 *
 * Version 1 models plain manifests and Kustomize bases: workloads become
 * components, Services and Ingresses decide reach, an Ingress is itself a
 * component, and dependencies are inferred from container environment and
 * argument references to Service names. Helm chart templates are detected and
 * refused rather than parsed, because a chart is Go template source that only
 * becomes YAML once values are supplied.
 *
 * Separate from COMPOSE_ADAPTER_VERSION on purpose. Each adapter is its own
 * extraction contract and a graph records which adapter produced it, so the two
 * numbers move independently.
 *
 * `architecture-core/src/__tests__/kubernetesVersion.test.ts` pins extraction
 * output so a change cannot land without a decision about this number.
 */
export const K8S_ADAPTER_VERSION = 1;

const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_RESOURCES = 1_000;

/** Namespace Kubernetes applies when a manifest does not name one. */
const DEFAULT_NAMESPACE = "default";

/** Workload kinds that become components, and where each keeps its pod spec. */
const WORKLOAD_POD_SPEC_PATHS = new Map<string, readonly string[]>([
  ["Deployment", ["spec", "template", "spec"]],
  ["StatefulSet", ["spec", "template", "spec"]],
  ["DaemonSet", ["spec", "template", "spec"]],
  ["ReplicaSet", ["spec", "template", "spec"]],
  ["Job", ["spec", "template", "spec"]],
  ["CronJob", ["spec", "jobTemplate", "spec", "template", "spec"]],
  ["Pod", ["spec"]],
]);

/** Where each workload kind keeps the labels a Service selector matches. */
const WORKLOAD_LABEL_PATHS = new Map<string, readonly string[]>([
  ["Deployment", ["spec", "template", "metadata", "labels"]],
  ["StatefulSet", ["spec", "template", "metadata", "labels"]],
  ["DaemonSet", ["spec", "template", "metadata", "labels"]],
  ["ReplicaSet", ["spec", "template", "metadata", "labels"]],
  ["Job", ["spec", "template", "metadata", "labels"]],
  ["CronJob", ["spec", "jobTemplate", "spec", "template", "metadata", "labels"]],
  ["Pod", ["metadata", "labels"]],
]);

/**
 * A DaemonSet runs one pod per eligible node, so its replica count is a
 * property of the cluster rather than of the manifest. Recording 1 would assert
 * a redundancy claim the source never made.
 */
const KINDS_WITHOUT_DECLARED_REPLICAS = new Set(["DaemonSet"]);

/** Directories that conventionally hold manifests meant to be applied. */
const MANIFEST_DIRECTORIES =
  /(^|\/)(k8s|kubernetes|manifests?|deploy|deployment|kustomize|base|bases|overlays)(\/|$)/i;

const API_VERSION_MARKER = /^\s*apiVersion\s*:/m;
const KIND_MARKER = /^\s*kind\s*:/m;

/**
 * Worst reach wins when several Services publish one workload. `unknown`
 * outranks `cluster` so an unresolved Service type cannot be masked by an
 * internal one sitting beside it.
 */
const EXPOSURE_RANK: Record<ClusterExposure, number> = {
  cluster: 0,
  unknown: 1,
  node: 2,
  external: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isYamlPath(path: string): boolean {
  return /\.ya?ml$/i.test(normalizePath(path));
}

/**
 * Whether a file is Helm chart template source rather than a manifest.
 *
 * A chart template is not YAML. A conditional decides whether a resource exists
 * at all and a range decides how many there are, so reading one as a manifest
 * would assert a topology the source does not state. Detected so that it can be
 * reported rather than silently skipped.
 */
function isHelmTemplate(file: RepositorySourceFile): boolean {
  const path = normalizePath(file.path);
  if (/(^|\/)templates\//i.test(path) && file.content.includes("{{")) return true;
  return /\{\{-?\s*(if|range|define|include|template|with|end)\b/.test(file.content);
}

function looksLikeManifest(content: string): boolean {
  return API_VERSION_MARKER.test(content) && KIND_MARKER.test(content);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getIn(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    value
  );
}

interface K8sResource {
  file: string;
  line?: number;
  kind: string;
  namespace: string;
  name: string;
  body: Record<string, unknown>;
}

/** Identity as Kubernetes itself scopes it: kind, namespace, and name. */
function resourceAddress(resource: K8sResource): string {
  return `${resource.namespace}/${resource.kind}/${resource.name}`;
}

/** Namespace-scoped Service name, the key a workload reference resolves to. */
function qualifiedName(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function provenance(
  resource: K8sResource,
  revision: string | undefined,
  confidence: SourceProvenance["confidence"] = "explicit",
  sourceAddress = resourceAddress(resource)
): SourceProvenance {
  return {
    adapter: ADAPTER_ID,
    revision,
    file: resource.file,
    sourceAddress,
    confidence,
    ...(resource.line ? { startLine: resource.line, endLine: resource.line } : {}),
  };
}

function documentLine(
  document: Document.Parsed,
  lineCounter: LineCounter,
  path: Array<string | number>
): number | undefined {
  const node = document.getIn(path, true) as ParsedNode | undefined;
  const start = node?.range?.[0];
  return typeof start === "number" ? lineCounter.linePos(start).line : undefined;
}

function containers(resource: K8sResource): Array<Record<string, unknown>> {
  const podSpecPath = WORKLOAD_POD_SPEC_PATHS.get(resource.kind);
  if (!podSpecPath) return [];
  const podSpec = getIn(resource.body, podSpecPath);
  if (!isRecord(podSpec)) return [];
  return [
    ...(Array.isArray(podSpec.containers) ? podSpec.containers : []),
    ...(Array.isArray(podSpec.initContainers) ? podSpec.initContainers : []),
  ].filter(isRecord);
}

function images(resource: K8sResource): string[] {
  return containers(resource)
    .map((container) => container.image)
    .filter((image): image is string => typeof image === "string");
}

function workloadLabels(resource: K8sResource): Record<string, string> {
  const path = WORKLOAD_LABEL_PATHS.get(resource.kind);
  return path ? stringRecord(getIn(resource.body, path)) : {};
}

function replicas(resource: K8sResource): number | undefined {
  if (KINDS_WITHOUT_DECLARED_REPLICAS.has(resource.kind)) return undefined;
  const declared = getIn(resource.body, ["spec", "replicas"]);
  if (typeof declared === "number" && Number.isFinite(declared)) {
    return Math.max(0, Math.floor(declared));
  }
  // A replica count written as an unresolved value states no number at all, and
  // must not fall through to the default that an absent field implies.
  if (declared !== undefined) return undefined;
  return WORKLOAD_POD_SPEC_PATHS.has(resource.kind) ? 1 : undefined;
}

function containerPorts(resource: K8sResource): string[] {
  return [
    ...new Set(
      containers(resource)
        .flatMap((container) => (Array.isArray(container.ports) ? container.ports : []))
        .filter(isRecord)
        .map((port) =>
          typeof port.containerPort === "number" || typeof port.containerPort === "string"
            ? String(port.containerPort)
            : ""
        )
        .filter(Boolean)
    ),
  ].sort();
}

function hasProbe(resource: K8sResource, probe: string): boolean {
  return containers(resource).some((container) => isRecord(container[probe]));
}

/**
 * A Service selector matches a workload when every label it names is present on
 * the pod template with the same value. An absent or empty selector selects
 * nothing: a headless or ExternalName Service publishes no workload.
 */
function serviceSelects(
  selector: Record<string, string>,
  labels: Record<string, string>
): boolean {
  const entries = Object.entries(selector);
  if (!entries.length) return false;
  return entries.every(([key, value]) => labels[key] === value);
}

/**
 * A NetworkPolicy follows the opposite convention: an empty `podSelector`
 * selects every pod in the namespace, which is how a default-deny policy is
 * written. Reading it as "selects nothing" would report the strictest policy in
 * common use as absent.
 */
function policySelects(
  selector: Record<string, string>,
  labels: Record<string, string>
): boolean {
  const entries = Object.entries(selector);
  if (!entries.length) return true;
  return entries.every(([key, value]) => labels[key] === value);
}

function servicePorts(resource: K8sResource): ClusterPortBinding[] {
  const ports = getIn(resource.body, ["spec", "ports"]);
  if (!Array.isArray(ports)) return [];
  return ports.filter(isRecord).map((port) => {
    const declared = typeof port.protocol === "string" ? port.protocol.toUpperCase() : "TCP";
    return {
      port: port.port === undefined ? "" : String(port.port),
      targetPort: port.targetPort === undefined ? undefined : String(port.targetPort),
      nodePort: port.nodePort === undefined ? undefined : String(port.nodePort),
      protocol: declared === "UDP" || declared === "SCTP" ? declared : "TCP",
      name: typeof port.name === "string" ? port.name : undefined,
    } satisfies ClusterPortBinding;
  });
}

/** Service names an Ingress routes traffic to, within its own namespace. */
function ingressBackends(resource: K8sResource): string[] {
  const names = new Set<string>();
  const defaultBackend = getIn(resource.body, ["spec", "defaultBackend", "service", "name"]);
  if (typeof defaultBackend === "string") names.add(defaultBackend);
  const rules = getIn(resource.body, ["spec", "rules"]);
  if (Array.isArray(rules)) {
    for (const rule of rules.filter(isRecord)) {
      const paths = getIn(rule, ["http", "paths"]);
      if (!Array.isArray(paths)) continue;
      for (const entry of paths.filter(isRecord)) {
        const name = getIn(entry, ["backend", "service", "name"]);
        if (typeof name === "string") names.add(name);
        // The pre-1.19 spelling still appears in committed manifests.
        const legacy = getIn(entry, ["backend", "serviceName"]);
        if (typeof legacy === "string") names.add(legacy);
      }
    }
  }
  return [...names].sort();
}

/** Every literal string a container could resolve a dependency address from. */
function containerReferences(
  resource: K8sResource
): Array<{ key: string; value: string }> {
  return containers(resource).flatMap((container) => {
    const environment = Array.isArray(container.env) ? container.env.filter(isRecord) : [];
    const fromEnvironment = environment.flatMap((entry) => {
      const key = typeof entry.name === "string" ? entry.name : "";
      const value = typeof entry.value === "string" ? entry.value : "";
      return key && value ? [{ key, value }] : [];
    });
    const fromArguments = [
      ...stringList(container.args),
      ...stringList(container.command),
    ].map((value) => ({ key: "args", value }));
    return [...fromEnvironment, ...fromArguments];
  });
}

/**
 * Hostnames a value could be addressing. A Service answers to its bare name
 * inside its namespace and to progressively qualified forms across the cluster,
 * so each candidate is reduced to its first label.
 */
function referenceHosts(value: string): string[] {
  const hosts = new Set<string>();
  for (const token of value.split(/[\s,;'"()[\]{}<>|]+/).filter(Boolean)) {
    const withoutScheme = token.replace(/^[a-z0-9+.-]+:\/\//i, "");
    const authority = withoutScheme.split(/[/?#]/)[0] || "";
    const host = authority.split("@").at(-1)?.split(":")[0] || "";
    const first = host.split(".")[0];
    if (first && /^[a-z0-9-]+$/i.test(first)) hosts.add(first.toLowerCase());
  }
  return [...hosts];
}

interface WorkloadReach {
  exposure: ClusterExposure;
  serviceTypes: string[];
  serviceNames: string[];
  ports: ClusterPortBinding[];
}

function emptyReach(): WorkloadReach {
  return { exposure: "cluster", serviceTypes: [], serviceNames: [], ports: [] };
}

function tileAt(index: number): { x: number; y: number } {
  return { x: (index % 4) * 300, y: Math.floor(index / 4) * 190 };
}

function makeWorkloadNode(
  resource: K8sResource,
  reach: WorkloadReach,
  selectedByNetworkPolicy: boolean,
  policiesPresent: boolean,
  revision: string | undefined,
  index: number
): SerializedNode {
  const address = resourceAddress(resource);
  const workloadImages = images(resource);
  const type = classifyByIdentity(`${resource.name} ${workloadImages.join(" ")}`.toLowerCase());
  const reachable = isReachableFromOutsideCluster(reach.exposure);
  const instances = replicas(resource);
  return {
    id: stableEntityId("node", ADAPTER_ID, address),
    type: "architecture",
    position: tileAt(index),
    data: {
      label: resource.name,
      subtitle: `Kubernetes ${resource.kind}`,
      nodeType: type,
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
      tech: workloadImages[0]?.replace(/^.*\//, ""),
      zone: zoneFor(type, reachable),
      ...(instances === undefined ? {} : { instances }),
      provenance: provenance(resource, revision),
      sourceProperties: {
        kind: resource.kind,
        namespace: resource.namespace,
        images: [...workloadImages].sort(),
        containerPorts: containerPorts(resource),
        clusterExposure: reach.exposure,
        serviceTypes: [...new Set(reach.serviceTypes)].sort(),
        serviceNames: [...new Set(reach.serviceNames)].sort(),
        // Only the bindings that carry the workload past the cluster boundary.
        // A ClusterIP port is not an exposure and listing it as one would make
        // every workload look published.
        exposedPorts: reachable ? reach.ports.map(formatClusterPort).sort() : [],
        hasReadinessProbe: hasProbe(resource, "readinessProbe"),
        hasLivenessProbe: hasProbe(resource, "livenessProbe"),
        // Absent policies and unrestricted workloads are different claims: the
        // first says the source models no network boundaries at all.
        networkPoliciesDeclared: policiesPresent,
        selectedByNetworkPolicy,
      },
    },
  };
}

function makeIngressNode(
  resource: K8sResource,
  revision: string | undefined,
  index: number
): SerializedNode {
  const address = resourceAddress(resource);
  const className = getIn(resource.body, ["spec", "ingressClassName"]);
  return {
    id: stableEntityId("node", ADAPTER_ID, address),
    type: "architecture",
    position: tileAt(index),
    data: {
      label: resource.name,
      subtitle: "Kubernetes Ingress",
      nodeType: "gateway",
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
      tech: typeof className === "string" ? className : undefined,
      // An Ingress exists to admit traffic from outside the cluster. It is in
      // the perimeter by definition rather than by what it is connected to.
      zone: "dmz",
      provenance: provenance(resource, revision),
      sourceProperties: {
        kind: resource.kind,
        namespace: resource.namespace,
        backendServices: ingressBackends(resource),
        hosts: Array.isArray(getIn(resource.body, ["spec", "rules"]))
          ? [
              ...new Set(
                (getIn(resource.body, ["spec", "rules"]) as unknown[])
                  .filter(isRecord)
                  .map((rule) => (typeof rule.host === "string" ? rule.host : ""))
                  .filter(Boolean)
              ),
            ].sort()
          : [],
        hasTls: Array.isArray(getIn(resource.body, ["spec", "tls"])),
      },
    },
  };
}

function makeEdge(
  sourceAddress: string,
  targetAddress: string,
  relationship: string,
  provenanceEntry: SourceProvenance
): SerializedEdge {
  return {
    id: stableEdgeId(ADAPTER_ID, sourceAddress, targetAddress, relationship),
    source: stableEntityId("node", ADAPTER_ID, sourceAddress),
    target: stableEntityId("node", ADAPTER_ID, targetAddress),
    data: {
      label: relationship,
      direction: "unidirectional",
      provenance: [provenanceEntry],
    },
  };
}

/** Unambiguous key for a directed pair, free of delimiter collisions. */
function pairKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function manifestFiles(files: RepositorySourceFile[]): RepositorySourceFile[] {
  return files
    .filter((file) => isYamlPath(file.path) && looksLikeManifest(file.content))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export const kubernetesAdapter: ArchitectureSourceAdapter = {
  id: ADAPTER_ID,

  detect(files): DetectionResult {
    const candidates = manifestFiles(files).filter((file) => !isHelmTemplate(file));
    const paths = candidates.map((file) => file.path).sort();
    const inManifestDirectory = paths.some((path) =>
      MANIFEST_DIRECTORIES.test(normalizePath(path))
    );
    return {
      detected: paths.length > 0,
      confidence: paths.length ? (inManifestDirectory ? "strong" : "possible") : "none",
      files: paths,
    };
  },

  import(
    files: RepositorySourceFile[],
    context: SourceImportContext = {}
  ): SourceImportResult {
    const candidates = manifestFiles(files);
    const helmTemplates = candidates.filter(isHelmTemplate).map((file) => file.path);
    const selected = candidates.filter((file) => !isHelmTemplate(file));

    if (!selected.length) {
      throw new SourceImportError("No Kubernetes manifests were found.", [
        {
          code: helmTemplates.length ? "k8s.helm.unsupported" : "k8s.manifests.missing",
          severity: "error",
          message: helmTemplates.length
            ? `Kubernetes resources here are declared as Helm chart templates (${helmTemplates.length} file(s)), which this adapter does not render. Point it at rendered manifests or a Kustomize base.`
            : "Expected YAML documents carrying apiVersion and kind.",
          file: helmTemplates[0] || "",
        },
      ]);
    }

    const totalBytes = selected.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
      0
    );
    if (totalBytes > MAX_MANIFEST_BYTES) {
      throw new SourceImportError("Kubernetes manifests exceed the supported size limit.", [
        {
          code: "k8s.manifests.too_large",
          severity: "error",
          message: `Manifest imports are limited to ${MAX_MANIFEST_BYTES} bytes.`,
          file: selected[0].path,
        },
      ]);
    }

    const diagnostics: SourceImportDiagnostic[] = [];
    // Reported rather than dropped: a repository whose real topology lives in a
    // chart should be told that, not handed a graph built from whatever plain
    // YAML happened to sit beside it.
    for (const path of helmTemplates) {
      diagnostics.push({
        code: "k8s.helm.skipped",
        severity: "warning",
        message:
          "Helm chart template skipped. A chart states its resources conditionally, so reading it as a manifest would assert a topology the source does not.",
        file: path,
      });
    }

    const resources: K8sResource[] = [];
    const parseErrors: SourceImportDiagnostic[] = [];
    for (const file of selected) {
      const lineCounter = new LineCounter();
      const documents = parseAllDocuments(file.content, {
        lineCounter,
        prettyErrors: false,
        uniqueKeys: false,
      });
      for (const document of documents) {
        if (document.errors.length) {
          parseErrors.push(
            ...document.errors.map((error) => ({
              code: "k8s.yaml.invalid",
              severity: "error" as const,
              message: error.message,
              file: file.path,
              line: error.linePos?.[0]?.line,
            }))
          );
          continue;
        }
        let value: unknown;
        try {
          value = document.toJS({ maxAliasCount: 50 }) as unknown;
        } catch (error) {
          parseErrors.push({
            code: "k8s.yaml.alias_limit",
            severity: "error",
            message:
              error instanceof Error
                ? error.message
                : "YAML alias expansion exceeded the supported limit.",
            file: file.path,
          });
          continue;
        }
        // A document separator with nothing after it is ordinary in manifest
        // bundles and is not an error.
        if (value === null || value === undefined) continue;
        if (!isRecord(value)) continue;
        const kind = typeof value.kind === "string" ? value.kind : "";
        const metadata = isRecord(value.metadata) ? value.metadata : {};
        const name = typeof metadata.name === "string" ? metadata.name : "";
        if (!kind || !name) continue;
        const namespace =
          typeof metadata.namespace === "string" && metadata.namespace
            ? metadata.namespace
            : DEFAULT_NAMESPACE;
        resources.push({
          file: file.path,
          line: documentLine(document, lineCounter, ["metadata", "name"]),
          kind,
          namespace,
          name,
          body: value,
        });
      }
    }

    if (parseErrors.length) {
      throw new SourceImportError("Kubernetes YAML is invalid.", parseErrors);
    }
    if (resources.length > MAX_RESOURCES) {
      throw new SourceImportError("Kubernetes resource count exceeds the supported limit.", [
        {
          code: "k8s.resources.too_many",
          severity: "error",
          message: `Manifest imports are limited to ${MAX_RESOURCES} resources.`,
          file: selected[0].path,
        },
      ]);
    }

    const workloads = resources
      .filter((resource) => WORKLOAD_POD_SPEC_PATHS.has(resource.kind))
      .sort((left, right) => resourceAddress(left).localeCompare(resourceAddress(right)));
    if (!workloads.length) {
      throw new SourceImportError("No Kubernetes workloads were found.", [
        {
          code: "k8s.workloads.missing",
          severity: "error",
          message: `Expected at least one of: ${[...WORKLOAD_POD_SPEC_PATHS.keys()].join(", ")}.`,
          file: selected[0].path,
        },
      ]);
    }

    const services = resources.filter((resource) => resource.kind === "Service");
    const ingresses = resources
      .filter((resource) => resource.kind === "Ingress")
      .sort((left, right) => resourceAddress(left).localeCompare(resourceAddress(right)));
    const policies = resources.filter((resource) => resource.kind === "NetworkPolicy");

    const labelsByWorkload = new Map(
      workloads.map((workload) => [resourceAddress(workload), workloadLabels(workload)])
    );

    // An Ingress routes to a Service by name inside its own namespace.
    const ingressRouted = new Set(
      ingresses.flatMap((ingress) =>
        ingressBackends(ingress).map((name) => qualifiedName(ingress.namespace, name))
      )
    );

    const reachByWorkload = new Map<string, WorkloadReach>(
      workloads.map((workload) => [resourceAddress(workload), emptyReach()])
    );
    // Service name to the workloads it publishes, used both for reach and for
    // resolving an environment reference to a component.
    const workloadsByService = new Map<string, string[]>();

    for (const service of services) {
      const selector = stringRecord(getIn(service.body, ["spec", "selector"]));
      const matched = workloads.filter(
        (workload) =>
          workload.namespace === service.namespace &&
          serviceSelects(selector, labelsByWorkload.get(resourceAddress(workload)) || {})
      );
      const serviceKey = qualifiedName(service.namespace, service.name);
      workloadsByService.set(
        serviceKey,
        matched.map(resourceAddress).sort()
      );
      if (!matched.length) continue;

      const declaredType = getIn(service.body, ["spec", "type"]);
      const externalIPs = stringList(getIn(service.body, ["spec", "externalIPs"]));
      const exposure = clusterExposure({
        type: typeof declaredType === "string" ? declaredType : undefined,
        externalIPs,
        routedByIngress: ingressRouted.has(serviceKey),
      });
      const ports = servicePorts(service);
      for (const workload of matched) {
        const address = resourceAddress(workload);
        const current = reachByWorkload.get(address) || emptyReach();
        reachByWorkload.set(address, {
          exposure:
            EXPOSURE_RANK[exposure] > EXPOSURE_RANK[current.exposure]
              ? exposure
              : current.exposure,
          serviceTypes: [
            ...current.serviceTypes,
            typeof declaredType === "string" ? declaredType : "ClusterIP",
          ],
          serviceNames: [...current.serviceNames, service.name],
          ports: [...current.ports, ...ports],
        });
      }
    }

    const policiesPresent = policies.length > 0;
    const policySelected = new Set(
      workloads
        .filter((workload) =>
          policies.some(
            (policy) =>
              policy.namespace === workload.namespace &&
              policySelects(
                stringRecord(getIn(policy.body, ["spec", "podSelector", "matchLabels"])),
                labelsByWorkload.get(resourceAddress(workload)) || {}
              )
          )
        )
        .map(resourceAddress)
    );

    const nodes: SerializedNode[] = [
      ...workloads.map((workload, index) =>
        makeWorkloadNode(
          workload,
          reachByWorkload.get(resourceAddress(workload)) || emptyReach(),
          policySelected.has(resourceAddress(workload)),
          policiesPresent,
          context.revision,
          index
        )
      ),
      ...ingresses.map((ingress, index) =>
        makeIngressNode(ingress, context.revision, workloads.length + index)
      ),
    ];

    const edges: SerializedEdge[] = [];
    const seen = new Set<string>();

    // An Ingress states its route explicitly, so it is recorded before any
    // inferred reference and outranks one for the same pair.
    for (const ingress of ingresses) {
      const from = resourceAddress(ingress);
      for (const backend of ingressBackends(ingress)) {
        const targets = workloadsByService.get(qualifiedName(ingress.namespace, backend));
        if (!targets?.length) {
          diagnostics.push({
            code: "k8s.ingress.unknown_backend",
            severity: "warning",
            message: `Ingress "${ingress.name}" routes to Service "${backend}", which selects no workload in this import.`,
            file: ingress.file,
            sourceAddress: `${from}.backend.${backend}`,
            line: ingress.line,
          });
          continue;
        }
        for (const to of targets) {
          if (seen.has(pairKey(from, to))) continue;
          seen.add(pairKey(from, to));
          edges.push(
            makeEdge(
              from,
              to,
              "routes",
              provenance(ingress, context.revision, "explicit", `${from}.backend.${backend}`)
            )
          );
        }
      }
    }

    for (const workload of workloads) {
      const from = resourceAddress(workload);
      for (const reference of containerReferences(workload)) {
        if (isUnresolved(reference.value)) continue;
        for (const host of referenceHosts(reference.value)) {
          const targets = workloadsByService.get(qualifiedName(workload.namespace, host));
          if (!targets?.length) continue;
          for (const to of targets) {
            // A workload reaching its own Service is addressing itself, not a
            // dependency.
            if (to === from || seen.has(pairKey(from, to))) continue;
            seen.add(pairKey(from, to));
            edges.push(
              makeEdge(
                from,
                to,
                "environment",
                provenance(
                  workload,
                  context.revision,
                  "inferred",
                  `${from}.env.${reference.key}`
                )
              )
            );
          }
        }
      }
    }

    return {
      graph: canonicalizeGraph({
        source: {
          adapter: ADAPTER_ID,
          adapterVersion: K8S_ADAPTER_VERSION,
          repository: context.repository,
          revision: context.revision,
          files: selected.map((file) => file.path),
        },
        nodes,
        edges,
      }),
      diagnostics,
    };
  },
};
