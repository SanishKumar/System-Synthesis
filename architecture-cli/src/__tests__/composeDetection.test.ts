import { describe, expect, it, vi } from "vitest";
import { COMPOSE_FILE_NAMES } from "@system-synthesis/architecture-core";
import { resolveComposePath } from "../gitSource.js";

function detect(base: string[], head: string[], composePath?: string) {
  return resolveComposePath({ baseRevision: "base", headRevision: "head", composePath,
    findCandidates: (revision) => revision === "base" ? base : head });
}

describe("bounded Compose path detection", () => {
  it.each(COMPOSE_FILE_NAMES)("detects and deduplicates %s across both revisions", (name) => {
    expect(detect([name], [name])).toBe(name);
  });

  it("retains a file deleted at head", () => {
    expect(detect(["docker-compose.yaml"], [])).toBe("docker-compose.yaml");
  });

  it("finds a file added at head", () => {
    expect(detect([], ["compose.yml"])).toBe("compose.yml");
  });

  it("requires an explicit choice instead of preferring compose.yaml to another file", () => {
    expect(() => detect(["compose.yaml", "docker-compose.yml"], ["compose.yaml"]))
      .toThrow("Multiple Compose files");
  });

  it("does not silently switch sources when a file was renamed", () => {
    expect(() => detect(["compose.yaml"], ["docker-compose.yml"]))
      .toThrow("Set compose-path explicitly");
  });

  it("requires an explicit path when there is no standard root file", () => {
    expect(() => detect([], [])).toThrow("nested or custom-named file");
  });

  it("honors a custom explicit path without probing candidates", () => {
    const findCandidates = vi.fn(() => ["compose.yaml", "docker-compose.yml"]);
    expect(resolveComposePath({ composePath: ".\\deploy\\production.yml",
      baseRevision: "base", headRevision: "head", findCandidates })).toBe("deploy/production.yml");
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it.each(["../secret.yml", "/compose.yml", "C:\\compose.yml", "\\\\host\\compose.yml", "compose.yml\n", "."])("refuses a non-repository path %j", (path) => {
    expect(() => detect([], [], path)).toThrow("repository-relative path");
  });
});
