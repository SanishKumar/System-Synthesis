import { describe, expect, it } from "vitest";
import { kubernetesAdapter, reviewArchitectureChange } from "../index.js";

const REVIEWED_AT = "2026-08-12T00:00:00.000Z";

/**
 * Only the Kubernetes rules under test. A fixture that produces an edge also
 * raises the readiness-probe rule and the shared graph rules, which would
 * otherwise be counted as exposure findings.
 */
const EXPOSURE_RULES = new Set([
  "k8s-exposed-persistence-workload",
  "k8s-exposed-sensitive-workload",
  "k8s-unresolved-workload-exposure",
]);

function deployment(name: string, image: string, kind = "Deployment"): string {
  return `apiVersion: apps/v1
kind: ${kind}
metadata:
  name: ${name}
spec:
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${image}
`;
}

function service(name: string, type?: string): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:${type ? `\n  type: ${type}` : ""}
  selector:
    app: ${name}
  ports:
    - port: 5432
`;
}

const BASE = deployment("api", "ghcr.io/acme/api:1");

function graph(documents: string[], revision: string) {
  return kubernetesAdapter.import(
    [{ path: "k8s/app.yaml", content: documents.join("---\n") }],
    { revision }
  ).graph;
}

function findingsFor(head: string[], filter: Set<string> = EXPOSURE_RULES): string[] {
  const review = reviewArchitectureChange(
    graph([BASE], "base"),
    graph(head, "head"),
    {},
    REVIEWED_AT
  );
  return review.headValidation.issues
    .map((finding) => finding.ruleId)
    .filter((id) => filter.has(id))
    .sort();
}

describe("kubernetes exposure findings follow the Service that publishes a workload", () => {
  it("reports nothing for a workload reachable only inside the cluster", () => {
    expect(findingsFor([deployment("primary", "postgres:16", "StatefulSet"), service("primary")]))
      .toEqual([]);
  });

  it("reports a LoadBalancer database once, as persistence", () => {
    expect(
      findingsFor([
        deployment("primary", "postgres:16", "StatefulSet"),
        service("primary", "LoadBalancer"),
      ])
    ).toEqual(["k8s-exposed-persistence-workload"]);
  });

  it("reports a NodePort database, because a node address is outside the cluster", () => {
    expect(
      findingsFor([
        deployment("primary", "postgres:16", "StatefulSet"),
        service("primary", "NodePort"),
      ])
    ).toEqual(["k8s-exposed-persistence-workload"]);
  });

  it("reports a published cache once, as a sensitive workload rather than persistence", () => {
    // Disjoint from the persistence rule, so one exposure yields one finding.
    expect(findingsFor([deployment("sessions", "redis:7"), service("sessions", "LoadBalancer")]))
      .toEqual(["k8s-exposed-sensitive-workload"]);
    expect(findingsFor([deployment("events", "kafka:3"), service("events", "NodePort")]))
      .toEqual(["k8s-exposed-sensitive-workload"]);
  });

  it("reports an unresolved Service type on a datastore rather than staying silent", () => {
    expect(
      findingsFor([
        deployment("primary", "postgres:16", "StatefulSet"),
        service("primary", "${SERVICE_TYPE}"),
      ])
    ).toEqual(["k8s-unresolved-workload-exposure"]);
  });

  it("does not report an unresolved Service type on an ordinary service", () => {
    // The rule is about data that should never leave the cluster, not about
    // every value the import could not resolve.
    expect(findingsFor([deployment("web", "nginx:1.27"), service("web", "${SERVICE_TYPE}")]))
      .toEqual([]);
  });
});

describe("kubernetes network policy coverage", () => {
  const RULES = new Set([
    "k8s-sensitive-workload-without-network-policy",
    "k8s-unevaluated-network-policy-selector",
  ]);
  const policy = (spec: string) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict
spec:
${spec}
`;
  const selecting = (app: string) =>
    policy(`  podSelector:\n    matchLabels:\n      app: ${app}\n  policyTypes:\n    - Ingress`);

  it("says nothing about a repository that models no network boundaries at all", () => {
    expect(findingsFor([deployment("primary", "postgres:16", "StatefulSet")], RULES)).toEqual([]);
  });

  it("reports a datastore left uncovered where policies are in use", () => {
    expect(
      findingsFor(
        [
          deployment("api", "ghcr.io/acme/api:1"),
          deployment("primary", "postgres:16", "StatefulSet"),
          selecting("api"),
        ],
        RULES
      )
    ).toEqual(["k8s-sensitive-workload-without-network-policy"]);
  });

  it("reports nothing once a policy governs traffic into the datastore", () => {
    expect(
      findingsFor(
        [
          deployment("api", "ghcr.io/acme/api:1"),
          deployment("primary", "postgres:16", "StatefulSet"),
          selecting("primary"),
        ],
        RULES
      )
    ).toEqual([]);
  });

  it("is not satisfied by a policy that only governs egress", () => {
    // Reproduces the reported false negative: an egress-only policy left the
    // datastore reachable by every pod in the cluster while the finding stayed
    // silent.
    expect(
      findingsFor(
        [
          deployment("primary", "postgres:16", "StatefulSet"),
          policy("  podSelector:\n    matchLabels:\n      app: primary\n  policyTypes:\n    - Egress"),
        ],
        RULES
      )
    ).toEqual(["k8s-sensitive-workload-without-network-policy"]);
  });

  it("is not satisfied by an unrelated policy written with matchExpressions", () => {
    // The other half of the reported false negative. The selector cannot be
    // evaluated, so the honest answer is that coverage is unestablished — never
    // that it is covered.
    expect(
      findingsFor(
        [
          deployment("primary", "postgres:16", "StatefulSet"),
          policy(
            "  podSelector:\n    matchExpressions:\n      - key: tier\n        operator: In\n        values: [web]\n  policyTypes:\n    - Egress"
          ),
        ],
        RULES
      )
    ).toEqual(["k8s-sensitive-workload-without-network-policy"]);
  });

  it("separates an unevaluable selector from a confirmed absence", () => {
    // One finding, and the one that describes what is actually known.
    expect(
      findingsFor(
        [
          deployment("primary", "postgres:16", "StatefulSet"),
          policy(
            "  podSelector:\n    matchExpressions:\n      - key: tier\n        operator: Exists\n  policyTypes:\n    - Ingress"
          ),
        ],
        RULES
      )
    ).toEqual(["k8s-unevaluated-network-policy-selector"]);
  });
});

describe("kubernetes readiness", () => {
  const RULE = new Set(["k8s-dependency-without-readiness-probe"]);
  const consumer = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1
          env:
            - name: DATABASE_URL
              value: postgres://primary:5432/shop
`;

  it("reports a dependency that declares no readiness probe", () => {
    expect(
      findingsFor(
        [consumer, deployment("primary", "postgres:16", "StatefulSet"), service("primary")],
        RULE
      )
    ).toEqual(["k8s-dependency-without-readiness-probe"]);
  });

  it("reports nothing once the dependency declares one", () => {
    const probed = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: primary
spec:
  template:
    metadata:
      labels:
        app: primary
    spec:
      containers:
        - name: primary
          image: postgres:16
          readinessProbe:
            exec:
              command: ["pg_isready"]
`;
    expect(findingsFor([consumer, probed, service("primary")], RULE)).toEqual([]);
  });
});

describe("kubernetes rules stay out of a Compose review", () => {
  it("raises no Kubernetes finding on a graph this adapter did not produce", () => {
    const review = reviewArchitectureChange(
      graph([BASE], "base"),
      graph([deployment("primary", "postgres:16", "StatefulSet"), service("primary", "LoadBalancer")], "head"),
      {},
      REVIEWED_AT
    );
    // The gate: every Kubernetes rule is scoped to a Kubernetes graph, and no
    // Compose rule may fire on one.
    expect(
      review.headValidation.issues.filter((finding) => finding.ruleId.startsWith("compose-"))
    ).toEqual([]);
  });
});
