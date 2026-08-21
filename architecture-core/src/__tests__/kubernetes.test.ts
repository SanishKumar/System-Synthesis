import { describe, expect, it } from "vitest";
import { kubernetesAdapter } from "../index.js";
import { SourceImportError } from "../adapters/types.js";

function file(path: string, content: string) {
  return { path, content };
}

function workload(
  name: string,
  image: string,
  extras: { kind?: string; namespace?: string; replicas?: string; env?: string; probe?: boolean } = {}
): string {
  const kind = extras.kind || "Deployment";
  const namespace = extras.namespace ? `\n  namespace: ${extras.namespace}` : "";
  const replicas = extras.replicas === undefined ? "" : `\n  replicas: ${extras.replicas}`;
  const env = extras.env
    ? `\n          env:\n            - name: UPSTREAM\n              value: ${extras.env}`
    : "";
  const probe = extras.probe ? "\n          readinessProbe:\n            httpGet:\n              path: /\n              port: 8080" : "";
  return `apiVersion: apps/v1
kind: ${kind}
metadata:
  name: ${name}${namespace}
spec:${replicas}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${image}${env}${probe}
`;
}

function service(
  name: string,
  selector: string,
  extras: { type?: string; namespace?: string; externalIPs?: string; port?: number } = {}
): string {
  const namespace = extras.namespace ? `\n  namespace: ${extras.namespace}` : "";
  const type = extras.type ? `\n  type: ${extras.type}` : "";
  const externalIPs = extras.externalIPs ? `\n  externalIPs:\n    - ${extras.externalIPs}` : "";
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}${namespace}
spec:${type}${externalIPs}
  selector:
    app: ${selector}
  ports:
    - port: ${extras.port ?? 8080}
      targetPort: 8080
`;
}

function importAt(...documents: string[]) {
  return kubernetesAdapter.import(
    [file("k8s/app.yaml", documents.join("---\n"))],
    { revision: "head" }
  );
}

function nodeNamed(result: ReturnType<typeof importAt>, label: string) {
  const found = result.graph.nodes.find((node) => node.data.label === label);
  if (!found) throw new Error(`no node labelled ${label}`);
  return found;
}

describe("kubernetes detection", () => {
  it("is strong inside a conventional manifest directory and weaker outside one", () => {
    const manifest = workload("api", "node:22");
    expect(kubernetesAdapter.detect([file("k8s/api.yaml", manifest)])).toMatchObject({
      detected: true,
      confidence: "strong",
    });
    expect(kubernetesAdapter.detect([file("api.yaml", manifest)])).toMatchObject({
      detected: true,
      confidence: "possible",
    });
  });

  it("does not claim a Compose file", () => {
    expect(
      kubernetesAdapter.detect([
        file("docker-compose.yml", "services:\n  api:\n    image: node:22\n"),
      ])
    ).toMatchObject({ detected: false, confidence: "none" });
  });

  it("does not claim Helm chart templates", () => {
    const template = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-api
spec:
  {{- if .Values.enabled }}
  replicas: {{ .Values.replicas }}
  {{- end }}
`;
    expect(
      kubernetesAdapter.detect([file("chart/templates/api.yaml", template)])
    ).toMatchObject({ detected: false, confidence: "none" });
  });
});

describe("kubernetes import boundaries", () => {
  it("refuses a Helm chart by naming Helm rather than reporting nothing found", () => {
    const template = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-api
spec:
  {{- range .Values.tiers }}
  replicas: 1
  {{- end }}
`;
    try {
      kubernetesAdapter.import([file("chart/templates/api.yaml", template)]);
      throw new Error("expected the import to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceImportError);
      const diagnostics = (error as SourceImportError).diagnostics;
      expect(diagnostics[0].code).toBe("k8s.helm.unsupported");
      expect(diagnostics[0].message).toContain("Helm");
    }
  });

  it("reports a skipped chart template rather than silently reading around it", () => {
    const result = kubernetesAdapter.import([
      file("k8s/api.yaml", workload("api", "node:22")),
      file("chart/templates/db.yaml", "apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: {{ .Release.Name }}-db\nspec:\n  {{- if .Values.db }}\n  replicas: 1\n  {{- end }}\n"),
    ]);
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("k8s.helm.skipped");
  });

  it("fails when nothing in the manifests is a workload", () => {
    expect(() => importAt(service("api", "api"))).toThrow(SourceImportError);
  });
});

describe("kubernetes workloads", () => {
  it("classifies from the workload name and its images", () => {
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      workload("sessions", "redis:7"),
      workload("api", "ghcr.io/acme/api:1.4")
    );
    expect(nodeNamed(result, "primary").data.nodeType).toBe("database");
    expect(nodeNamed(result, "sessions").data.nodeType).toBe("cache");
    expect(nodeNamed(result, "api").data.nodeType).toBe("service");
  });

  it("defaults a Deployment to one replica and reads a declared count", () => {
    const result = importAt(
      workload("api", "node:22"),
      workload("worker", "node:22", { replicas: "3" })
    );
    expect(nodeNamed(result, "api").data.instances).toBe(1);
    expect(nodeNamed(result, "worker").data.instances).toBe(3);
  });

  it("claims no replica count for a DaemonSet, whose count belongs to the cluster", () => {
    const result = importAt(workload("agent", "node-exporter:1", { kind: "DaemonSet" }));
    expect(nodeNamed(result, "agent").data.instances).toBeUndefined();
  });

  it("claims no replica count when the count is not a resolved number", () => {
    const result = importAt(workload("api", "node:22", { replicas: "${REPLICAS}" }));
    expect(nodeNamed(result, "api").data.instances).toBeUndefined();
  });
});

describe("kubernetes reach", () => {
  it("treats a ClusterIP Service as internal and a NodePort as past the boundary", () => {
    const internal = importAt(workload("api", "node:22"), service("api", "api"));
    expect(nodeNamed(internal, "api").data.sourceProperties?.clusterExposure).toBe("cluster");
    expect(nodeNamed(internal, "api").data.zone).toBe("private");

    const nodePort = importAt(
      workload("api", "node:22"),
      service("api", "api", { type: "NodePort" })
    );
    expect(nodeNamed(nodePort, "api").data.sourceProperties?.clusterExposure).toBe("node");
    expect(nodeNamed(nodePort, "api").data.zone).toBe("dmz");
  });

  it("treats a pinned external address as external even on a ClusterIP Service", () => {
    const result = importAt(
      workload("api", "node:22"),
      service("api", "api", { externalIPs: "203.0.113.10" })
    );
    expect(nodeNamed(result, "api").data.sourceProperties?.clusterExposure).toBe("external");
  });

  it("does not fold an unresolved Service type into internal", () => {
    const result = importAt(
      workload("api", "node:22"),
      service("api", "api", { type: "${SERVICE_TYPE}" })
    );
    expect(nodeNamed(result, "api").data.sourceProperties?.clusterExposure).toBe("unknown");
    expect(nodeNamed(result, "api").data.zone).toBe("dmz");
  });

  it("keeps the worst reach when several Services select one workload", () => {
    const result = importAt(
      workload("api", "node:22"),
      service("api-internal", "api"),
      service("api-public", "api", { type: "LoadBalancer" })
    );
    expect(nodeNamed(result, "api").data.sourceProperties?.clusterExposure).toBe("external");
  });

  it("does not let a Service reach a workload in another namespace", () => {
    const result = importAt(
      workload("api", "node:22", { namespace: "shop" }),
      service("api", "api", { type: "LoadBalancer", namespace: "other" })
    );
    expect(nodeNamed(result, "api").data.sourceProperties?.clusterExposure).toBe("cluster");
  });

  it("leaves a datastore private even when it is published", () => {
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      service("primary", "primary", { type: "LoadBalancer", port: 5432 })
    );
    // What a component is decides its zone; exposure is reported by the rules
    // that exist for it and must not remove a trust-boundary crossing.
    expect(nodeNamed(result, "primary").data.zone).toBe("private");
    expect(nodeNamed(result, "primary").data.sourceProperties?.clusterExposure).toBe("external");
  });
});

describe("kubernetes relationships", () => {
  const ingress = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public
spec:
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 8080
`;

  it("models an Ingress as a perimeter component that routes to the workload behind it", () => {
    const result = importAt(workload("api", "node:22"), service("api", "api"), ingress);
    const gateway = nodeNamed(result, "public");
    expect(gateway.data.nodeType).toBe("gateway");
    expect(gateway.data.zone).toBe("dmz");
    const routes = result.graph.edges.filter((edge) => edge.data?.label === "routes");
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe(gateway.id);
    expect(routes[0].target).toBe(nodeNamed(result, "api").id);
  });

  it("makes a workload external because an Ingress routes to its ClusterIP Service", () => {
    const result = importAt(workload("api", "node:22"), service("api", "api"), ingress);
    expect(nodeNamed(result, "api").data.sourceProperties?.clusterExposure).toBe("external");
  });

  it("infers a dependency from an environment reference to a Service name", () => {
    const result = importAt(
      workload("api", "node:22", { env: "postgres://primary:5432/shop" }),
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      service("primary", "primary", { port: 5432 })
    );
    const inferred = result.graph.edges.filter((edge) => edge.data?.label === "environment");
    expect(inferred).toHaveLength(1);
    expect(inferred[0].source).toBe(nodeNamed(result, "api").id);
    expect(inferred[0].target).toBe(nodeNamed(result, "primary").id);
    expect(inferred[0].data?.provenance?.[0].confidence).toBe("inferred");
  });

  it("does not infer a dependency from a workload to its own Service", () => {
    const result = importAt(
      workload("api", "node:22", { env: "http://api:8080/health" }),
      service("api", "api")
    );
    expect(result.graph.edges).toHaveLength(0);
  });

  it("does not infer a dependency from a reference it could not resolve", () => {
    const result = importAt(
      workload("api", "node:22", { env: "postgres://${DB_HOST}:5432/shop" }),
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      service("primary", "primary", { port: 5432 })
    );
    expect(result.graph.edges).toHaveLength(0);
  });

  it("reports an Ingress backend that selects no workload instead of dropping it", () => {
    const result = importAt(workload("api", "node:22"), service("api", "api"), `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: absent
                port:
                  number: 80
`);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "k8s.ingress.unknown_backend"
    );
  });
});

describe("kubernetes network policies", () => {
  const policy = (spec: string, name = "restrict") => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${name}
spec:
${spec}
`;

  const coverage = (result: ReturnType<typeof importAt>, label: string) => ({
    ingress: nodeNamed(result, label).data.sourceProperties?.ingressPolicyCoverage,
    egress: nodeNamed(result, label).data.sourceProperties?.egressPolicyCoverage,
  });

  it("records coverage for the workloads a policy selects, and only those", () => {
    const result = importAt(
      workload("api", "node:22"),
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      policy("  podSelector:\n    matchLabels:\n      app: api\n  policyTypes:\n    - Ingress")
    );
    expect(coverage(result, "api").ingress).toBe("covered");
    expect(coverage(result, "primary").ingress).toBe("uncovered");
  });

  it("reads an empty podSelector as selecting every pod in the namespace", () => {
    // The default-deny idiom. Reading it as selecting nothing would report the
    // strictest policy in common use as absent.
    const result = importAt(
      workload("api", "node:22"),
      policy("  podSelector: {}\n  policyTypes:\n    - Ingress")
    );
    expect(coverage(result, "api").ingress).toBe("covered");
  });

  it("does not let an egress-only policy establish inbound coverage", () => {
    // A policy that says nothing about who may open a connection to a workload
    // is not a statement that anybody is restricted from doing so.
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      policy("  podSelector:\n    matchLabels:\n      app: primary\n  policyTypes:\n    - Egress")
    );
    expect(coverage(result, "primary")).toEqual({ ingress: "uncovered", egress: "covered" });
  });

  it("infers the direction Kubernetes infers when policyTypes is absent", () => {
    // Ingress always applies; egress applies only where egress rules exist.
    const withoutEgress = importAt(
      workload("api", "node:22"),
      policy("  podSelector:\n    matchLabels:\n      app: api")
    );
    expect(coverage(withoutEgress, "api")).toEqual({ ingress: "covered", egress: "uncovered" });

    const withEgress = importAt(
      workload("api", "node:22"),
      policy("  podSelector:\n    matchLabels:\n      app: api\n  egress:\n    - {}")
    );
    expect(coverage(withEgress, "api")).toEqual({ ingress: "covered", egress: "covered" });
  });

  it("does not treat a matchExpressions selector as selecting everything", () => {
    // The defect this replaces: matchExpressions reduced to an empty selector,
    // and an empty selector selects the whole namespace, so an unrelated policy
    // became proof that a datastore was protected.
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      policy(
        "  podSelector:\n    matchExpressions:\n      - key: tier\n        operator: In\n        values: [web]\n  policyTypes:\n    - Ingress"
      )
    );
    expect(coverage(result, "primary").ingress).toBe("unknown");
  });

  it("excludes a workload whose matchLabels do not match, expressions or not", () => {
    // The two halves combine with AND, so a matchLabels miss is decisive and
    // does not need the expressions evaluated.
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      policy(
        "  podSelector:\n    matchLabels:\n      app: api\n    matchExpressions:\n      - key: tier\n        operator: Exists\n  policyTypes:\n    - Ingress"
      )
    );
    expect(coverage(result, "primary").ingress).toBe("uncovered");
  });

  it("does not resolve a selector value it could not read", () => {
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      policy("  podSelector:\n    matchLabels:\n      app:\n        nested: value\n  policyTypes:\n    - Ingress")
    );
    expect(coverage(result, "primary").ingress).toBe("unknown");
  });

  it("lets a definite policy outrank an unevaluable one", () => {
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet" }),
      policy("  podSelector:\n    matchLabels:\n      app: primary\n  policyTypes:\n    - Ingress", "definite"),
      policy(
        "  podSelector:\n    matchExpressions:\n      - key: tier\n        operator: Exists\n  policyTypes:\n    - Ingress",
        "vague"
      )
    );
    expect(coverage(result, "primary").ingress).toBe("covered");
  });

  it("does not let a policy reach a workload in another namespace", () => {
    const result = importAt(
      workload("primary", "postgres:16", { kind: "StatefulSet", namespace: "shop" }),
      `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict
  namespace: other
spec:
  podSelector: {}
  policyTypes:
    - Ingress
`
    );
    expect(coverage(result, "primary").ingress).toBe("uncovered");
  });

  it("separates a repository that declares no policies from one whose workload is uncovered", () => {
    const without = importAt(workload("api", "node:22"));
    expect(nodeNamed(without, "api").data.sourceProperties?.networkPoliciesDeclared).toBe(false);
    const declared = importAt(
      workload("api", "node:22"),
      policy("  podSelector:\n    matchLabels:\n      app: other\n  policyTypes:\n    - Ingress")
    );
    expect(nodeNamed(declared, "api").data.sourceProperties?.networkPoliciesDeclared).toBe(true);
    expect(coverage(declared, "api").ingress).toBe("uncovered");
  });
});

describe("the current importer states coverage for every workload it produces", () => {
  /**
   * The invariant the legacy compatibility fallback depends on.
   *
   * Validation treats an absent coverage field as `unstated` and makes no
   * finding from it, which is right for a graph an older importer stored. It
   * would be silently wrong for a current one: a regression that stopped
   * emitting these fields would not fail a rule test, because the rules would
   * simply go quiet. Pinning the contract here is what keeps `unstated` a
   * statement about old graphs rather than a way for new ones to say nothing.
   */
  const STATED = new Set(["covered", "uncovered", "unknown"]);

  const policy = (spec: string, name = "restrict") => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${name}
spec:
${spec}
`;

  /** Every node that stands for a pod, which is every node but an Ingress. */
  const workloads = (result: ReturnType<typeof importAt>) =>
    result.graph.nodes.filter((node) => node.data.sourceProperties?.kind !== "Ingress");

  const cases: Array<[string, ReturnType<typeof importAt>]> = [
    [
      "no policies declared anywhere",
      importAt(workload("api", "node:22"), workload("primary", "postgres:16", { kind: "StatefulSet" })),
    ],
    [
      "a policy selecting one workload and not another",
      importAt(
        workload("api", "node:22"),
        workload("primary", "postgres:16", { kind: "StatefulSet" }),
        policy("  podSelector:\n    matchLabels:\n      app: api\n  policyTypes:\n    - Ingress")
      ),
    ],
    [
      "an egress-only policy",
      importAt(
        workload("primary", "postgres:16", { kind: "StatefulSet" }),
        policy("  podSelector:\n    matchLabels:\n      app: primary\n  policyTypes:\n    - Egress")
      ),
    ],
    [
      "a selector this adapter cannot evaluate",
      importAt(
        workload("primary", "postgres:16", { kind: "StatefulSet" }),
        policy(
          "  podSelector:\n    matchExpressions:\n      - key: tier\n        operator: Exists\n  policyTypes:\n    - Ingress"
        )
      ),
    ],
    [
      "workloads in separate namespaces",
      importAt(
        workload("api", "node:22", { namespace: "shop" }),
        workload("api", "node:22", { namespace: "staging" }),
        policy("  podSelector: {}\n  policyTypes:\n    - Ingress")
      ),
    ],
    [
      "every workload kind",
      importAt(
        workload("api", "node:22"),
        workload("primary", "postgres:16", { kind: "StatefulSet" }),
        workload("agent", "node-exporter:1", { kind: "DaemonSet" }),
        workload("once", "ghcr.io/acme/jobs:1", { kind: "Job" })
      ),
    ],
  ];

  it.each(cases)("states both directions with %s", (_name, result) => {
    const nodes = workloads(result);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(STATED).toContain(node.data.sourceProperties?.ingressPolicyCoverage);
      expect(STATED).toContain(node.data.sourceProperties?.egressPolicyCoverage);
    }
  });

  it("never emits the compatibility state from a current import", () => {
    // `unstated` is not a value this adapter writes. It is what validation calls
    // an absent field, and only a graph from before version 2 has one.
    for (const [, result] of cases) {
      for (const node of result.graph.nodes) {
        expect(node.data.sourceProperties?.ingressPolicyCoverage).not.toBe("unstated");
        expect(node.data.sourceProperties?.egressPolicyCoverage).not.toBe("unstated");
      }
    }
  });
});
