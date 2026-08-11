import { describe, expect, it } from "vitest";
import { dockerComposeAdapter } from "../index.js";

function bindingsFor(ports: string): {
  publishedPorts: string[];
  publishedPortBindings: Array<Record<string, unknown>> | undefined;
} {
  const { graph } = dockerComposeAdapter.import([
    {
      path: "compose.yaml",
      content: `services:\n  api:\n    image: api:1\n    ports:\n${ports}\n`,
    },
  ]);
  const api = graph.nodes.find((node) => node.data.label === "api");
  const source = api?.data.sourceProperties as Record<string, unknown>;
  return {
    publishedPorts: (source.publishedPorts as string[]) || [],
    publishedPortBindings: source.publishedPortBindings as
      | Array<Record<string, unknown>>
      | undefined,
  };
}

describe("published port extraction", () => {
  it("reads a host port bound to every interface", () => {
    expect(bindingsFor(`      - "8080:3000"`).publishedPortBindings).toEqual([
      { published: "8080", target: "3000", protocol: "tcp" },
    ]);
  });

  it("keeps an IPv4 loopback address instead of discarding it", () => {
    expect(bindingsFor(`      - "127.0.0.1:5432:5432"`).publishedPortBindings).toEqual([
      { hostIp: "127.0.0.1", published: "5432", target: "5432", protocol: "tcp" },
    ]);
  });

  it("unwraps a bracketed IPv6 address rather than splitting on its colons", () => {
    expect(bindingsFor(`      - "[::1]:5432:5432"`).publishedPortBindings).toEqual([
      { hostIp: "::1", published: "5432", target: "5432", protocol: "tcp" },
    ]);
    expect(bindingsFor(`      - "[::]:5432:5432"`).publishedPortBindings).toEqual([
      { hostIp: "::", published: "5432", target: "5432", protocol: "tcp" },
    ]);
  });

  it("treats a container-only port as published to an allocated host port", () => {
    // Compose publishes this to an ephemeral host port; absent `published` must
    // not be mistaken for an internal-only port.
    expect(bindingsFor(`      - "3000"`).publishedPortBindings).toEqual([
      { target: "3000", protocol: "tcp" },
    ]);
  });

  it("keeps a port range intact rather than coercing it to a number", () => {
    expect(bindingsFor(`      - "8000-8010:8000-8010"`).publishedPortBindings).toEqual([
      { published: "8000-8010", target: "8000-8010", protocol: "tcp" },
    ]);
  });

  it("records the protocol suffix", () => {
    expect(bindingsFor(`      - "5432:5432/udp"`).publishedPortBindings).toEqual([
      { published: "5432", target: "5432", protocol: "udp" },
    ]);
  });

  it("reads host_ip from the long syntax, which was previously dropped", () => {
    const ports = [
      "      - target: 5432",
      "        published: 5432",
      "        host_ip: 127.0.0.1",
    ].join("\n");
    expect(bindingsFor(ports).publishedPortBindings).toEqual([
      { hostIp: "127.0.0.1", published: "5432", target: "5432", protocol: "tcp" },
    ]);
  });

  it("keeps an unresolved address rather than guessing it is safe", () => {
    expect(bindingsFor(`      - "\${HOST_IP}:5432:5432"`).publishedPortBindings).toEqual([
      { hostIp: "${HOST_IP}", published: "5432", target: "5432", protocol: "tcp" },
    ]);
  });

  it("omits the structured field entirely when nothing is published", () => {
    const { graph } = dockerComposeAdapter.import([
      { path: "compose.yaml", content: "services:\n  api:\n    image: api:1\n" },
    ]);
    const source = graph.nodes[0]?.data.sourceProperties as Record<string, unknown>;
    expect(source.publishedPortBindings).toBeUndefined();
    expect(source.publishedPorts).toEqual([]);
  });
});

describe("the two published-port representations cannot drift", () => {
  const cases = [
    `      - "8080:3000"`,
    `      - "127.0.0.1:5432:5432"`,
    `      - "[::1]:5432:5432"`,
    `      - "3000"`,
    `      - "8000-8010:8000-8010"`,
    `      - "5432:5432/udp"`,
    `      - "0.0.0.0:80:80"`,
  ];

  function render(binding: Record<string, unknown>): string {
    const address = [binding.hostIp, binding.published, binding.target]
      .filter((part) => part !== undefined)
      .join(":");
    return binding.protocol === "udp" ? `${address}/udp` : address;
  }

  it.each(cases)("renders %s identically from the parsed binding", (ports) => {
    const { publishedPorts, publishedPortBindings } = bindingsFor(ports);
    expect(publishedPortBindings).toBeDefined();
    expect(publishedPorts).toEqual(publishedPortBindings!.map(render));
  });

  it("makes the short and long syntaxes agree with each other", () => {
    const short = bindingsFor(`      - "127.0.0.1:5432:5432"`);
    const long = bindingsFor(
      ["      - target: 5432", "        published: 5432", "        host_ip: 127.0.0.1"].join("\n")
    );
    // Rewriting one form as the other describes the same deployment, so it must
    // not read as an architecture change.
    expect(long.publishedPorts).toEqual(short.publishedPorts);
    expect(long.publishedPortBindings).toEqual(short.publishedPortBindings);
  });
});
