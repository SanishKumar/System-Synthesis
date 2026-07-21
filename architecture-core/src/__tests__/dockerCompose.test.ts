import { describe, expect, it } from "vitest";
import {
  dockerComposeAdapter,
  SourceImportError,
} from "../index.js";
import { canonicalGraphFingerprint } from "../provenance.js";

const compose = `name: shop
services:
  api:
    build:
      context: .
    ports:
      - "8080:3000"
    depends_on:
      database:
        condition: service_healthy
      cache:
        condition: service_started
    networks:
      - public
      - private
    environment:
      DATABASE_URL: postgresql://database/shop
      LOG_LEVEL: info
  cache:
    image: redis:7-alpine
    expose:
      - "6379"
  database:
    image: postgres:16
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
    deploy:
      replicas: 2
networks:
  public: {}
  private: {}
volumes:
  db-data: {}
`;

describe("Docker Compose source detection", () => {
  it("detects supported filenames anywhere in a repository", () => {
    expect(dockerComposeAdapter.detect([
      { path: "README.md", content: "" },
      { path: "deploy/compose.yaml", content: compose },
    ])).toEqual({
      detected: true,
      confidence: "strong",
      files: ["deploy/compose.yaml"],
    });
  });

  it("does not claim unrelated YAML files", () => {
    expect(dockerComposeAdapter.detect([
      { path: "deployment.yaml", content: "services: {}" },
    ])).toEqual({
      detected: false,
      confidence: "none",
      files: [],
    });
  });
});

describe("Docker Compose import", () => {
  it("creates a canonical graph with stable identities and source evidence", () => {
    const result = dockerComposeAdapter.import(
      [{ path: "deploy/compose.yaml", content: compose }],
      { repository: "acme/shop", revision: "base-sha" }
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.graph.source).toEqual({
      adapter: "docker-compose",
      repository: "acme/shop",
      revision: "base-sha",
      files: ["deploy/compose.yaml"],
    });
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.edges).toHaveLength(2);

    const api = result.graph.nodes.find((node) => node.data.label === "api");
    const database = result.graph.nodes.find((node) => node.data.label === "database");
    const cache = result.graph.nodes.find((node) => node.data.label === "cache");

    expect(api?.data.nodeType).toBe("service");
    expect(api?.data.zone).toBe("dmz");
    expect(api?.data.sourceProperties).toMatchObject({
      publishedPorts: ["8080:3000"],
      networks: ["private", "public"],
      environmentKeys: ["DATABASE_URL", "LOG_LEVEL"],
      hasBuild: true,
    });
    expect(api?.data.provenance).toMatchObject({
      adapter: "docker-compose",
      revision: "base-sha",
      file: "deploy/compose.yaml",
      sourceAddress: "services.api",
      confidence: "explicit",
      startLine: 4,
    });
    expect(database?.data.nodeType).toBe("database");
    expect(database?.data.instances).toBe(2);
    expect(database?.data.sourceProperties).toMatchObject({
      volumes: ["db-data:/var/lib/postgresql/data"],
      hasHealthcheck: true,
    });
    expect(cache?.data.nodeType).toBe("cache");

    const apiDependencies = result.graph.edges.filter(
      (edge) => edge.source === api?.id
    );
    expect(apiDependencies.map((edge) => edge.target).sort()).toEqual(
      [cache?.id, database?.id].sort()
    );
    expect(apiDependencies.every(
      (edge) => edge.data?.provenance?.[0]?.startLine !== undefined
    )).toBe(true);
  });

  it("supports the short depends_on list syntax", () => {
    const result = dockerComposeAdapter.import([{
      path: "docker-compose.yml",
      content: `services:
  worker:
    image: worker:latest
    depends_on: [queue]
  queue:
    image: rabbitmq:4
`,
    }]);

    expect(result.graph.nodes).toHaveLength(2);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.nodes.find(
      (node) => node.data.label === "queue"
    )?.data.nodeType).toBe("broker");
  });

  it("imports an explicitly supplied Compose file with a custom filename", () => {
    const result = dockerComposeAdapter.import([{
      path: "deploy/docker-compose.production.yml",
      content: "services:\n  api:\n    image: api:1.0.0\n",
    }]);

    expect(result.graph.source.files).toEqual([
      "deploy/docker-compose.production.yml",
    ]);
    expect(result.graph.nodes[0]?.data.label).toBe("api");
  });

  it("warns about unknown dependencies without creating dangling edges", () => {
    const result = dockerComposeAdapter.import([{
      path: "compose.yml",
      content: `services:
  api:
    image: api:latest
    depends_on:
      - missing-db
`,
    }]);

    expect(result.graph.edges).toEqual([]);
    expect(result.diagnostics).toMatchObject([{
      code: "compose.dependency.unknown",
      severity: "warning",
      file: "compose.yml",
      sourceAddress: "services.api.depends_on.missing-db",
    }]);
  });

  it("is deterministic across source order and commit revisions", () => {
    const reordered = `services:
  database:
    deploy:
      replicas: 2
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
    volumes:
      - db-data:/var/lib/postgresql/data
    image: postgres:16
  cache:
    expose: ["6379"]
    image: redis:7-alpine
  api:
    environment:
      LOG_LEVEL: info
      DATABASE_URL: postgresql://database/shop
    networks: [private, public]
    depends_on:
      cache: {}
      database: {}
    ports: ["8080:3000"]
    build:
      context: .
`;
    const base = dockerComposeAdapter.import(
      [{ path: "compose.yaml", content: compose }],
      { revision: "base" }
    ).graph;
    const head = dockerComposeAdapter.import(
      [{ path: "compose.yaml", content: reordered }],
      { revision: "head" }
    ).graph;

    expect(canonicalGraphFingerprint(base)).toBe(
      canonicalGraphFingerprint(head)
    );
  });

  it.each([
    {
      name: "invalid YAML",
      content: "services:\n  api: [",
      code: "compose.yaml.invalid",
    },
    {
      name: "missing services",
      content: "name: empty\nvolumes: {}",
      code: "compose.services.missing",
    },
    {
      name: "duplicate service keys",
      content: "services:\n  api: {}\n  api: {}\n",
      code: "compose.yaml.invalid",
    },
    {
      name: "non-mapping service",
      content: "services:\n  api: null\n",
      code: "compose.service.invalid",
    },
  ])("rejects $name with structured diagnostics", ({ content, code }) => {
    expect(() => dockerComposeAdapter.import([
      { path: "compose.yaml", content },
    ])).toThrowError(SourceImportError);

    try {
      dockerComposeAdapter.import([{ path: "compose.yaml", content }]);
    } catch (error) {
      expect(error).toBeInstanceOf(SourceImportError);
      expect((error as SourceImportError).diagnostics[0]?.code).toBe(code);
    }
  });

  it("rejects excessive YAML alias expansion with structured diagnostics", () => {
    const aliases = Array.from({ length: 60 }, () => "*defaults").join(", ");
    const content = `defaults: &defaults { LOG_LEVEL: info, REGION: local, RETRIES: 3 }
services:
  api:
    environment: [${aliases}]
`;

    expect(() => dockerComposeAdapter.import([
      { path: "compose.yaml", content },
    ])).toThrowError(SourceImportError);

    try {
      dockerComposeAdapter.import([{ path: "compose.yaml", content }]);
    } catch (error) {
      expect((error as SourceImportError).diagnostics[0]?.code).toBe(
        "compose.yaml.alias_limit"
      );
    }
  });

  it("rejects files and service sets beyond the documented bounds", () => {
    expect(() => dockerComposeAdapter.import([{
      path: "compose.yaml",
      content: `services: {}\n# ${"x".repeat(1_000_000)}`,
    }])).toThrowError(SourceImportError);

    const services = Array.from(
      { length: 501 },
      (_, index) => `  service-${index}:\n    image: example/service:${index}\n`
    ).join("");
    expect(() => dockerComposeAdapter.import([{
      path: "compose.yaml",
      content: `services:\n${services}`,
    }])).toThrowError(SourceImportError);

    try {
      dockerComposeAdapter.import([{
        path: "compose.yaml",
        content: `services:\n${services}`,
      }]);
    } catch (error) {
      expect(error).toBeInstanceOf(SourceImportError);
      expect((error as SourceImportError).diagnostics[0]?.code).toBe(
        "compose.services.too_many"
      );
    }
  });
});
