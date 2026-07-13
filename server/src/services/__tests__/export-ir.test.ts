import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SerializedEdge, SerializedNode } from "@system-synthesis/shared";
import { generateDockerCompose } from "../export/docker-compose.js";
import { generateTerraform } from "../export/terraform.js";
import {
  buildInfrastructureIR,
  diffInfrastructureIR,
  UnsupportedExportError,
} from "../export/ir.js";

const metadata = { notes: "", links: [], codeSnippet: "", attachedFiles: [] };
const nodes: SerializedNode[] = [
  {
    id: "api",
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: { label: "API", nodeType: "service", status: "active", metadata, instances: 2, zone: "private" },
  },
  {
    id: "db",
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: { label: "Main DB", nodeType: "database", status: "active", metadata, tech: "PostgreSQL", zone: "restricted" },
  },
];
const edges: SerializedEdge[] = [{ id: "api-db", source: "api", target: "db" }];

describe("formal infrastructure IR", () => {
  it("is stable when source nodes and edges arrive in a different order", () => {
    const first = buildInfrastructureIR(nodes, edges, "terraform");
    const second = buildInfrastructureIR([...nodes].reverse(), [...edges].reverse(), "terraform");
    expect(second).toEqual(first);
  });

  it("returns explicit unsupported-resource errors", () => {
    const unsupported = {
      ...nodes[0],
      id: "dns",
      data: { ...nodes[0].data, label: "DNS", nodeType: "dns" as const },
    };
    expect(() => buildInfrastructureIR([unsupported], [], "terraform")).toThrow(UnsupportedExportError);
    try {
      buildInfrastructureIR([unsupported], [], "terraform");
    } catch (error) {
      expect((error as UnsupportedExportError).unsupported[0]).toMatchObject({ nodeId: "dns", nodeType: "dns" });
    }
  });

  it("produces a semantic diff", () => {
    const before = buildInfrastructureIR(nodes, edges, "docker-compose");
    const scaled = nodes.map((item) => item.id === "api" ? { ...item, data: { ...item.data, instances: 4 } } : item);
    const after = buildInfrastructureIR(scaled, edges, "docker-compose");
    const diff = diffInfrastructureIR(before, after);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].after.instances).toBe(4);
  });
});

describe("deterministic export golden files", () => {
  it("matches the Docker Compose golden file and contains no embedded secret", () => {
    const expected = readFileSync(new URL("./golden/docker-compose.golden.yml", import.meta.url), "utf8").trimEnd();
    const generated = generateDockerCompose(nodes, edges).trimEnd();
    expect(generated).toBe(expected);
    expect(generated).not.toContain("changeme");
    expect(generated).not.toContain(":latest");
    expect(generateDockerCompose([...nodes].reverse(), edges).trimEnd()).toBe(expected);
  });

  it("matches the Terraform golden hash manifest and pins its provider", () => {
    const expected = JSON.parse(
      readFileSync(new URL("./golden/terraform.sha256.json", import.meta.url), "utf8")
    );
    const bundle = generateTerraform(nodes, edges);
    const hashes = Object.fromEntries(
      Object.entries(bundle).map(([filename, content]) => [
        filename,
        createHash("sha256").update(content).digest("hex"),
      ])
    );
    expect(hashes).toEqual(expected);
    expect(bundle["main.tf"]).toContain('version = "= 5.100.0"');
    const passwordBlock = bundle["variables.tf"].split('variable "db_password"')[1].split("}")[0];
    expect(passwordBlock).not.toContain("default");
  });
});
