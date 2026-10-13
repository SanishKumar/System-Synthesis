import { describe, expect, it, vi } from "vitest";
import { resolveActionRevisions } from "../inputs.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const environment = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/shop", GITHUB_SHA: "c".repeat(40) };
const event = () => ({ repository: { full_name: "acme/shop" }, pull_request: {
  base: { sha: BASE }, head: { sha: HEAD },
} });

describe("Action revision defaults", () => {
  it("takes the actual PR SHAs, not GITHUB_SHA or a branch name", () => {
    expect(resolveActionRevisions({}, environment, event))
      .toEqual({ baseRevision: BASE, headRevision: HEAD });
  });

  it("does not need ingestion-only metadata to run local analysis", () => {
    expect(resolveActionRevisions({ baseRevision: " ", headRevision: "" }, environment, event))
      .toEqual({ baseRevision: BASE, headRevision: HEAD });
  });

  it.each([
    { input: { baseRevision: "my-base" }, expected: { baseRevision: "my-base", headRevision: HEAD } },
    { input: { headRevision: "my-head" }, expected: { baseRevision: BASE, headRevision: "my-head" } },
  ])("preserves an explicit $input while detecting the missing side", ({ input, expected }) => {
    expect(resolveActionRevisions(input, environment, event)).toEqual(expected);
  });

  it("needs no event file or GitHub environment when both revisions are explicit", () => {
    const read = vi.fn(() => { throw new Error("Must not read an event"); });
    expect(resolveActionRevisions({ baseRevision: " release ", headRevision: " HEAD " }, {}, read))
      .toEqual({ baseRevision: "release", headRevision: "HEAD" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, "push", "workflow_dispatch", "pull_request_target"])("does not infer revisions for %s", (name) => {
    const read = vi.fn(event);
    expect(() => resolveActionRevisions({}, { ...environment, GITHUB_EVENT_NAME: name }, read))
      .toThrow("base-revision and head-revision");
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses metadata for a different repository", () => {
    expect(() => resolveActionRevisions({}, { ...environment, GITHUB_REPOSITORY: "other/shop" }, event))
      .toThrow("does not match GITHUB_REPOSITORY");
  });

  it.each(["main", "a".repeat(7), "a".repeat(41), undefined])("refuses an invalid event SHA: %s", (sha) => {
    expect(() => resolveActionRevisions({}, environment, () => ({
      ...event(), pull_request: { base: { sha }, head: { sha: HEAD } },
    }))).toThrow("full Git commit SHA");
  });

  it("refuses an empty pull request event instead of guessing", () => {
    expect(() => resolveActionRevisions({}, environment, () => ({}))).toThrow("GitHub pull request");
  });
});
