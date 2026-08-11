import { describe, expect, it } from "vitest";
import { dockerComposeAdapter, portExposure } from "../index.js";
import type { PublishedPortBinding } from "../adapters/dockerCompose.js";

function binding(hostIp?: string): PublishedPortBinding {
  return { target: "5432", published: "5432", protocol: "tcp", ...(hostIp ? { hostIp } : {}) };
}

describe("port exposure classification", () => {
  it("treats an unspecified address as every interface", () => {
    expect(portExposure(binding())).toBe("external");
  });

  it("treats the wildcard addresses as every interface", () => {
    expect(portExposure(binding("0.0.0.0"))).toBe("external");
    expect(portExposure(binding("::"))).toBe("external");
  });

  it("recognizes loopback in both address families", () => {
    expect(portExposure(binding("127.0.0.1"))).toBe("loopback");
    expect(portExposure(binding("127.1.2.3"))).toBe("loopback");
    expect(portExposure(binding("::1"))).toBe("loopback");
    expect(portExposure(binding("0:0:0:0:0:0:0:1"))).toBe("loopback");
    expect(portExposure(binding("localhost"))).toBe("loopback");
  });

  it("separates a specific reachable address from a wildcard", () => {
    expect(portExposure(binding("192.168.1.10"))).toBe("host");
    expect(portExposure(binding("10.0.0.5"))).toBe("host");
    expect(portExposure(binding("2001:db8::1"))).toBe("host");
  });

  it("refuses to call an unresolved address safe", () => {
    // An unexpanded variable could hold 0.0.0.0, so it must never read as
    // contained just because it is not recognizable.
    expect(portExposure(binding("${HOST_IP}"))).toBe("unknown");
    expect(portExposure(binding("$HOST_IP"))).toBe("unknown");
    expect(portExposure(binding("not-an-address"))).toBe("unknown");
  });
});

describe("zone assignment follows reachability", () => {
  function zoneFor(ports: string): string {
    const { graph } = dockerComposeAdapter.import([
      {
        path: "compose.yaml",
        content: `services:\n  api:\n    image: api:1\n${ports}\n`,
      },
    ]);
    return String(graph.nodes[0]?.data.zone);
  }

  it("keeps a loopback-only service out of the perimeter", () => {
    expect(zoneFor(`    ports:\n      - "127.0.0.1:3000:3000"`)).toBe("private");
    expect(zoneFor(`    ports:\n      - "[::1]:3000:3000"`)).toBe("private");
  });

  it("places an externally published service in the perimeter", () => {
    expect(zoneFor(`    ports:\n      - "3000:3000"`)).toBe("dmz");
    expect(zoneFor(`    ports:\n      - "0.0.0.0:3000:3000"`)).toBe("dmz");
  });

  it("treats a service with any reachable port as reachable", () => {
    expect(
      zoneFor(`    ports:\n      - "127.0.0.1:3000:3000"\n      - "8080:8080"`)
    ).toBe("dmz");
  });

  it("does not assume an unresolved address is contained", () => {
    expect(zoneFor(`    ports:\n      - "\${HOST_IP}:3000:3000"`)).toBe("dmz");
  });

  it("leaves a service with no published ports private", () => {
    expect(zoneFor(`    expose:\n      - "3000"`)).toBe("private");
  });
});
