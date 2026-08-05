import { describe, expect, it, vi } from "vitest";
import { EMPTY_COMPOSE as EMPTY, resolveComposeSources } from "../composeSources.js";

const CONTENT = "services:\n  api:\n    image: api:1\n";

function resolve(overrides: Partial<Parameters<typeof resolveComposeSources>[0]>) {
  return resolveComposeSources({
    composePath: "compose.yaml",
    baseRevision: "aaaa111",
    headRevision: "bbbb222",
    baseFile: CONTENT,
    headFile: CONTENT,
    findCandidates: () => [],
    ...overrides,
  });
}

describe("compose source resolution", () => {
  it("compares both revisions when the file exists on each side", () => {
    expect(resolve({})).toEqual({ baseContent: CONTENT, headContent: CONTENT });
  });

  it("treats a pull request that adds the file as an empty base", () => {
    expect(resolve({ baseFile: undefined })).toEqual({
      baseContent: EMPTY,
      headContent: CONTENT,
    });
  });

  it("treats a pull request that deletes the file as an empty head", () => {
    expect(resolve({ headFile: undefined })).toEqual({
      baseContent: CONTENT,
      headContent: EMPTY,
    });
  });

  it("refuses to review nothing when the path is wrong on both sides", () => {
    expect(() =>
      resolve({ baseFile: undefined, headFile: undefined })
    ).toThrowError(/does not exist at aaaa111 or bbbb222/);
  });

  it("names the Compose files it can actually see", () => {
    expect(() =>
      resolve({
        composePath: "compose.yaml",
        baseFile: undefined,
        headFile: undefined,
        findCandidates: () => ["docker-compose.yml", "docker-compose.yaml"],
      })
    ).toThrowError(/Set compose-path to one of: docker-compose\.yml, docker-compose\.yaml\./);
  });

  it("says so plainly when no Compose file exists at the root", () => {
    expect(() =>
      resolve({ baseFile: undefined, headFile: undefined })
    ).toThrowError(/No Compose file was found at the repository root/);
  });

  it("does not look for candidates unless the path resolved to nothing", () => {
    const findCandidates = vi.fn(() => []);
    resolve({ findCandidates });
    expect(findCandidates).not.toHaveBeenCalled();
  });
});
