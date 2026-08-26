import { describe, expect, it } from "vitest";
import { K8S_ADAPTER_VERSION, kubernetesAdapter } from "../index.js";
import { canonicalGraphFingerprint } from "../provenance.js";

/**
 * Exercises every relationship source and classification path the adapter
 * claims to model, so a change in extraction shows up here.
 *
 * The datastore is deliberately published: zone assignment for a datastore is
 * the case a fixture is most likely to leave unwalked, and the Compose pin
 * passed for months while exactly that case was wrong. The DaemonSet, the
 * unresolved Service type, and the second namespace are here for the same
 * reason — a pin only guards the paths its fixture actually walks. The three
 * policy documents are here for that reason too: an egress-only policy, one
 * that selects by label, and one whose selector this adapter cannot evaluate,
 * so each of the three coverage states is walked rather than assumed.
 *
 * `api` is selected by two Services at once — one the Ingress routes to, and
 * one internal — because port evidence is per Service. A fixture where every
 * workload has a single Service cannot tell a correct exposure list from one
 * that pools every selecting Service's ports together.
 */
const FIXTURE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  replicas: 3
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
          env:
            - name: DATABASE_URL
              value: postgres://primary:5432/shop
            - name: CACHE_URL
              value: redis://sessions:6379
            - name: LOG_LEVEL
              value: info
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: shop
spec:
  selector:
    app: api
  ports:
    - port: 8080
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: api-internal
  namespace: shop
spec:
  selector:
    app: api
  ports:
    - port: 80
      targetPort: http-internal
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: primary
  namespace: shop
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app: primary
    spec:
      containers:
        - name: primary
          image: postgres:16
---
apiVersion: v1
kind: Service
metadata:
  name: primary
  namespace: shop
spec:
  type: LoadBalancer
  selector:
    app: primary
  ports:
    - port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sessions
  namespace: shop
spec:
  template:
    metadata:
      labels:
        app: sessions
    spec:
      containers:
        - name: sessions
          image: redis:7-alpine
---
apiVersion: v1
kind: Service
metadata:
  name: sessions
  namespace: shop
spec:
  type: \${SERVICE_TYPE}
  selector:
    app: sessions
  ports:
    - port: 6379
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: agent
  namespace: shop
spec:
  template:
    metadata:
      labels:
        app: agent
    spec:
      containers:
        - name: agent
          image: quay.io/prometheus/node-exporter:v1.8.2
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
  namespace: shop
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: nightly
        spec:
          containers:
            - name: nightly
              image: ghcr.io/acme/jobs:1.4
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public
  namespace: shop
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - shop.example.com
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
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-api
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: primary-egress-only
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: primary
  policyTypes:
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: staging-by-expression
  namespace: staging
spec:
  podSelector:
    matchExpressions:
      - key: tier
        operator: In
        values: [cache]
  policyTypes:
    - Ingress
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: staging
spec:
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4
`;

const PINNED_FINGERPRINT = "c37cdff6e2766062";

const { graph } = kubernetesAdapter.import(
  [{ path: "k8s/shop.yaml", content: FIXTURE }],
  { repository: "acme/shop", revision: "head" }
);

function node(label: string, kind: string, namespace = "shop") {
  const found = graph.nodes.find(
    (entry) =>
      entry.data.label === label &&
      entry.data.sourceProperties?.kind === kind &&
      entry.data.sourceProperties?.namespace === namespace
  );
  if (!found) throw new Error(`no ${kind} named ${label} in ${namespace}`);
  return found;
}

describe("kubernetes extraction is versioned", () => {
  it("stamps the adapter and its extraction contract", () => {
    expect(graph.source.adapter).toBe("kubernetes");
    expect(graph.source.adapterVersion).toBe(K8S_ADAPTER_VERSION);
  });

  it("pins extraction output so a change forces a version decision", () => {
    expect(canonicalGraphFingerprint(graph)).toBe(PINNED_FINGERPRINT);
  });

  it("keeps the version out of the content fingerprint", () => {
    const restamped = { ...graph, source: { ...graph.source, adapterVersion: 999 } };
    expect(canonicalGraphFingerprint(restamped)).toBe(canonicalGraphFingerprint(graph));
  });

  it("extracts both declared and inferred relationships in the fixture", () => {
    expect(graph.edges.map((edge) => edge.data?.label).sort()).toEqual([
      "environment",
      "environment",
      "routes",
    ]);
  });

  it("walks the classification and reach paths the pin is meant to guard", () => {
    // A published datastore stays private: what it is decides its zone.
    expect(node("primary", "StatefulSet").data.zone).toBe("private");
    expect(node("primary", "StatefulSet").data.sourceProperties?.clusterExposure).toBe("external");
    // An unresolved Service type is not folded into cluster-internal.
    expect(node("sessions", "Deployment").data.sourceProperties?.clusterExposure).toBe("unknown");
    // An Ingress puts the workload behind it past the boundary.
    expect(node("api", "Deployment").data.sourceProperties?.clusterExposure).toBe("external");
    expect(node("api", "Deployment").data.zone).toBe("dmz");
    // Two Services select `api`. Both are recorded, and only the one the
    // Ingress routes to publishes a port: the internal Service's 80 is not an
    // opening merely because something else exposes the same workload.
    expect(node("api", "Deployment").data.sourceProperties?.serviceNames).toEqual([
      "api",
      "api-internal",
    ]);
    expect(node("api", "Deployment").data.sourceProperties?.exposedPorts).toEqual(["8080"]);
    expect(node("api", "Deployment").data.sourceProperties?.exposedPorts).not.toContain(
      "80->http-internal"
    );
    // A DaemonSet claims no replica count.
    expect(node("agent", "DaemonSet").data.instances).toBeUndefined();
    expect(node("nightly", "CronJob").data.nodeType).toBe("service");
    // Namespaces are separate: the staging copy is its own component and the
    // shop Ingress does not reach it.
    expect(graph.nodes.filter((entry) => entry.data.label === "api")).toHaveLength(2);
    expect(node("api", "Deployment", "staging").data.sourceProperties?.clusterExposure).toBe("cluster");
    // Coverage is per direction, and a selector this adapter cannot evaluate is
    // unknown rather than covered — the case that made an unrelated policy look
    // like protection.
    expect(node("api", "Deployment").data.sourceProperties?.ingressPolicyCoverage).toBe("covered");
    expect(node("api", "Deployment").data.sourceProperties?.egressPolicyCoverage).toBe("uncovered");
    expect(node("primary", "StatefulSet").data.sourceProperties?.ingressPolicyCoverage).toBe("uncovered");
    expect(node("primary", "StatefulSet").data.sourceProperties?.egressPolicyCoverage).toBe("covered");
    expect(node("sessions", "Deployment").data.sourceProperties?.ingressPolicyCoverage).toBe("uncovered");
    // A selector this adapter cannot evaluate could match any pod in its own
    // namespace, so it makes that namespace unknown rather than covered.
    expect(
      node("api", "Deployment", "staging").data.sourceProperties?.ingressPolicyCoverage
    ).toBe("unknown");
  });
});
