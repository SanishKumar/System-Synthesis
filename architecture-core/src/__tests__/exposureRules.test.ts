import { describe, expect, it } from "vitest";
import { dockerComposeAdapter, reviewArchitectureChange } from "../index.js";

const REVIEWED_AT = "2026-08-12T00:00:00.000Z";
const EMPTY = "services: {}\n";

function serviceWith(name: string, image: string, ports?: string): string {
  return `services:\n  ${name}:\n    image: ${image}\n${ports ? `    ports:\n      - "${ports}"\n` : ""}`;
}

function graph(content: string, revision: string) {
  return dockerComposeAdapter.import(
    [{ path: "compose.yaml", content }],
    { revision }
  ).graph;
}

/**
 * Only the rules under test. A fixture using `depends_on` also raises the
 * healthcheck rule, which would otherwise be counted as an exposure finding.
 */
const EXPOSURE_RULES = new Set([
  "compose-published-persistence-port",
  "compose-published-sensitive-service-port",
  "compose-restricted-sensitive-service-port",
  "compose-public-service-to-persistence",
]);

/** Rule ids raised by the head revision, which is what the gate considers. */
function findingsFor(head: string, base = EMPTY): string[] {
  const review = reviewArchitectureChange(
    graph(base, "base"),
    graph(head, "head"),
    {},
    REVIEWED_AT
  );
  return review.headValidation.issues
    .map((finding) => finding.ruleId)
    .filter((id) => EXPOSURE_RULES.has(id))
    .sort();
}

describe("exposure findings follow the bind address", () => {
  it("reports an externally published database once, as persistence", () => {
    expect(findingsFor(serviceWith("postgres", "postgres:16", "5432:5432"))).toEqual([
      "compose-published-persistence-port",
    ]);
  });

  it("reports an externally published cache once, as a sensitive service", () => {
    // Disjoint from the persistence rule, so one exposure yields one finding.
    expect(findingsFor(serviceWith("redis", "redis:7", "6379:6379"))).toEqual([
      "compose-published-sensitive-service-port",
    ]);
    expect(findingsFor(serviceWith("kafka", "kafka:3", "9092:9092"))).toEqual([
      "compose-published-sensitive-service-port",
    ]);
    expect(
      findingsFor(serviceWith("elasticsearch", "elasticsearch:8", "9200:9200"))
    ).toEqual(["compose-published-sensitive-service-port"]);
  });

  it("reports a specific reachable address as a warning only", () => {
    expect(
      findingsFor(serviceWith("postgres", "postgres:16", "192.168.1.10:5432:5432"))
    ).toEqual(["compose-restricted-sensitive-service-port"]);
  });

  it("reports an unresolved address as a warning only", () => {
    expect(
      findingsFor(serviceWith("postgres", "postgres:16", "${HOST_IP}:5432:5432"))
    ).toEqual(["compose-restricted-sensitive-service-port"]);
  });

  it("reports nothing for a loopback-bound sensitive service", () => {
    expect(
      findingsFor(serviceWith("postgres", "postgres:16", "127.0.0.1:5432:5432"))
    ).toEqual([]);
    expect(findingsFor(serviceWith("redis", "redis:7", "[::1]:6379:6379"))).toEqual([]);
  });

  it("reports nothing when a sensitive service publishes no port", () => {
    expect(findingsFor(serviceWith("postgres", "postgres:16"))).toEqual([]);
  });
});

describe("public source detection follows reachability", () => {
  const withDependency = (ports: string) =>
    `services:\n  web:\n    image: web:1\n    ports:\n      - "${ports}"\n    depends_on:\n      - postgres\n  postgres:\n    image: postgres:16\n    expose:\n      - "5432"\n`;

  it("does not treat a loopback-bound service as public", () => {
    expect(findingsFor(withDependency("127.0.0.1:3000:3000"))).toEqual([]);
  });

  it("treats an externally published service as public", () => {
    expect(findingsFor(withDependency("3000:3000"))).toEqual([
      "compose-public-service-to-persistence",
    ]);
  });

  it("treats a specific address and an unresolved address as public", () => {
    expect(findingsFor(withDependency("192.168.1.10:3000:3000"))).toEqual([
      "compose-public-service-to-persistence",
    ]);
    expect(findingsFor(withDependency("${HOST_IP}:3000:3000"))).toEqual([
      "compose-public-service-to-persistence",
    ]);
  });
});

describe("exposure impacts describe the reach they actually found", () => {
  function impactKinds(base: string, head: string): string[] {
    return reviewArchitectureChange(graph(base, "base"), graph(head, "head"), {}, REVIEWED_AT)
      .impacts.map((item) => item.kind)
      .filter((kind) => kind.endsWith("-added"))
      .sort();
  }

  it("does not call a loopback binding a public exposure", () => {
    const kinds = impactKinds(
      serviceWith("postgres", "postgres:16"),
      serviceWith("postgres", "postgres:16", "127.0.0.1:5432:5432")
    );
    expect(kinds).toContain("loopback-binding-added");
    expect(kinds).not.toContain("public-exposure-added");
  });

  it("still calls an external binding a public exposure", () => {
    expect(
      impactKinds(
        serviceWith("postgres", "postgres:16"),
        serviceWith("postgres", "postgres:16", "5432:5432")
      )
    ).toContain("public-exposure-added");
  });

  it("separates a specific address from an unresolved one", () => {
    expect(
      impactKinds(
        serviceWith("postgres", "postgres:16"),
        serviceWith("postgres", "postgres:16", "192.168.1.10:5432:5432")
      )
    ).toContain("restricted-exposure-added");
    expect(
      impactKinds(
        serviceWith("postgres", "postgres:16"),
        serviceWith("postgres", "postgres:16", "${HOST_IP}:5432:5432")
      )
    ).toContain("unresolved-exposure-added");
  });

  it("keeps a loopback impact informational", () => {
    const review = reviewArchitectureChange(
      graph(serviceWith("postgres", "postgres:16"), "base"),
      graph(serviceWith("postgres", "postgres:16", "127.0.0.1:5432:5432"), "head"),
      {},
      REVIEWED_AT
    );
    const loopback = review.impacts.find((item) => item.kind === "loopback-binding-added");
    expect(loopback?.severity).toBe("info");
  });
});

describe("a graph from an importer without structured bindings", () => {
  /** What an older Action sent: strings only, no structured bindings. */
  function legacy(ports: string[]) {
    const built = graph(serviceWith("postgres", "postgres:16", "5432:5432"), "head");
    return {
      ...built,
      nodes: built.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          sourceProperties: { ...node.data.sourceProperties, publishedPorts: ports, publishedPortBindings: undefined },
        },
      })),
    };
  }

  function legacyFindings(ports: string[]): string[] {
    return reviewArchitectureChange(graph(EMPTY, "base"), legacy(ports), {}, REVIEWED_AT)
      .headValidation.issues.map((finding) => finding.ruleId)
      .filter((id) => EXPOSURE_RULES.has(id))
      .sort();
  }

  it("will not call an address-less string proof of external reach", () => {
    // The old importer discarded host_ip from the long syntax, so "5432:5432"
    // is either a short entry on every interface or a long entry that was bound
    // to loopback. Reporting a critical external exposure would assert more
    // than the stored evidence carries, so it is reported as unresolved.
    expect(legacyFindings(["5432:5432"])).toEqual([
      "compose-restricted-sensitive-service-port",
    ]);
  });

  it("recovers a loopback address the string form retained", () => {
    expect(legacyFindings(["127.0.0.1:5432:5432"])).toEqual([]);
  });

  it("recovers a specific reachable address the string form retained", () => {
    expect(legacyFindings(["192.168.1.10:5432:5432"])).toEqual([
      "compose-restricted-sensitive-service-port",
    ]);
  });

  it("reports nothing when no port was recorded at all", () => {
    expect(legacyFindings([])).toEqual([]);
  });
});

describe("exposure impacts describe how far a binding reached", () => {
  function impactKinds(base: string, head: string): string[] {
    const review = reviewArchitectureChange(
      graph(base, "base"),
      graph(head, "head"),
      {},
      REVIEWED_AT
    );
    return review.impacts
      .map((item) => item.kind)
      .filter((kind) => /exposure|binding/.test(kind))
      .sort();
  }

  const external = serviceWith("postgres", "postgres:16", "5432:5432");
  const loopback = serviceWith("postgres", "postgres:16", "127.0.0.1:5432:5432");
  const specific = serviceWith("postgres", "postgres:16", "192.168.1.10:5432:5432");
  const unresolved = serviceWith("postgres", "postgres:16", "${HOST_IP}:5432:5432");
  const none = serviceWith("postgres", "postgres:16");

  it("reports adding each category as its own kind", () => {
    expect(impactKinds(none, external)).toEqual(["public-exposure-added"]);
    expect(impactKinds(none, specific)).toEqual(["restricted-exposure-added"]);
    expect(impactKinds(none, unresolved)).toEqual(["unresolved-exposure-added"]);
    // A loopback binding is not a public exposure, and must not be called one.
    expect(impactKinds(none, loopback)).toEqual(["loopback-binding-added"]);
  });

  it("reports removing each category as its own kind", () => {
    expect(impactKinds(external, none)).toEqual(["public-exposure-removed"]);
    expect(impactKinds(specific, none)).toEqual(["restricted-exposure-removed"]);
    expect(impactKinds(unresolved, none)).toEqual(["unresolved-exposure-removed"]);
    expect(impactKinds(loopback, none)).toEqual(["loopback-binding-removed"]);
  });

  it("describes narrowing an external binding to loopback as both", () => {
    // Reporting only the addition would read as new exposure; reporting only
    // the removal would hide that a binding still exists.
    expect(impactKinds(external, loopback)).toEqual([
      "loopback-binding-added",
      "public-exposure-removed",
    ]);
  });

  it("describes widening a loopback binding to external as both", () => {
    expect(impactKinds(loopback, external)).toEqual([
      "loopback-binding-removed",
      "public-exposure-added",
    ]);
  });

  it("keeps the critical severity for a newly published persistence port", () => {
    const review = reviewArchitectureChange(
      graph(none, "base"),
      graph(external, "head"),
      {},
      REVIEWED_AT
    );
    const added = review.impacts.find((item) => item.kind === "public-exposure-added");
    expect(added?.severity).toBe("critical");
  });

  it("does not raise the severity of a loopback binding", () => {
    const review = reviewArchitectureChange(
      graph(none, "base"),
      graph(loopback, "head"),
      {},
      REVIEWED_AT
    );
    const added = review.impacts.find((item) => item.kind === "loopback-binding-added");
    expect(added?.severity).toBe("info");
  });
});
