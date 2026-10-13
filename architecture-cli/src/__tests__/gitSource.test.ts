import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, type CliIO } from "../cli.js";
import { composePairFromGit, verifyRevision } from "../gitSource.js";

/**
 * A real repository with real history.
 *
 * Reading a revision is the one part of this that cannot be checked against a
 * stub: the behaviour being relied on belongs to git, not to a fake of it.
 */
let repository: string;
let baseCommit: string;
let headCommit: string;

const BASE = `services:
  api:
    image: acme/api:1
    ports: ["0.0.0.0:8080:3000"]
  db:
    image: postgres:16
`;
const HEAD = `services:
  api:
    image: acme/api:1
    ports: ["0.0.0.0:8080:3000"]
  db:
    image: postgres:16
    ports: ["0.0.0.0:5432:5432"]
`;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

beforeAll(() => {
  repository = mkdtempSync(join(tmpdir(), "ss-git-"));
  git("init", "--quiet");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  writeFileSync(join(repository, "docker-compose.yml"), BASE);
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  baseCommit = git("rev-parse", "HEAD");
  writeFileSync(join(repository, "docker-compose.yml"), HEAD);
  git("add", ".");
  git("commit", "--quiet", "-m", "publish the database");
  headCommit = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(repository, { recursive: true, force: true });
});

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    readFile: (path: string) => {
      throw new Error(`no file should be read in repository mode: ${path}`);
    },
    writeFile: () => undefined,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  } as CliIO & { out: string[]; err: string[] };
}

describe("reading both sides out of a repository", () => {
  it("reads each revision's file without anything being extracted first", () => {
    const sources = composePairFromGit({
      directory: repository,
      composePath: "docker-compose.yml",
      baseRevision: baseCommit,
      headRevision: headCommit,
    });
    expect(sources.baseContent).toBe(BASE);
    expect(sources.headContent).toBe(HEAD);
  });

  it("treats a file absent on one side as an empty architecture", () => {
    // Adding or deleting the file is a real architecture change, not an error.
    const sources = composePairFromGit({
      directory: repository,
      composePath: "docker-compose.yml",
      baseRevision: git("rev-list", "--max-parents=0", "HEAD"),
      headRevision: headCommit,
    });
    expect(sources.headContent).toBe(HEAD);
  });

  it("refuses a path that exists at neither revision", () => {
    // Comparing two empty documents would exit zero and present a misconfigured
    // command as architecture coverage.
    expect(() =>
      composePairFromGit({
        directory: repository,
        composePath: "deploy/nowhere.yml",
        baseRevision: baseCommit,
        headRevision: headCommit,
      })
    ).toThrow(/does not exist at/);
  });

  it("names the revision it could not resolve", () => {
    expect(() => verifyRevision("not-a-real-revision", repository)).toThrow(
      /"not-a-real-revision" is not a commit/
    );
  });

  it("resolves refs to immutable commit SHAs and detects the tracked Compose path", () => {
    const sources = composePairFromGit({ directory: repository,
      baseRevision: `${baseCommit}~0`, headRevision: `${headCommit}~0` });
    expect(sources).toEqual({ composePath: "docker-compose.yml",
      baseRevision: baseCommit, headRevision: headCommit, baseContent: BASE, headContent: HEAD });
  });

  it.each(["--help", "--all", "--show-toplevel", "--glob=*", "-q"])(
    "refuses the option-shaped revision %s as something that is not a commit",
    (revision) => {
      // What is held here is the outcome: nothing shaped like an option is ever
      // acted on. The `^{commit}` suffix is what achieves that today, so this
      // passes with or without `--end-of-options` — the fence only starts to
      // matter if the suffix ever changes, and no input can tell them apart.
      expect(() => verifyRevision(revision, repository)).toThrow("is not a commit");
    }
  );

  it("does not mistake a directory with a Compose filename for a Compose file", () => {
    // A tree passes an existence check, and `git show` on one returns a listing
    // rather than a document. Counted as a candidate it would make an ordinary
    // repository look ambiguous, or hand the importer a directory to parse.
    const directory = mkdtempSync(join(tmpdir(), "ss-git-tree-"));
    try {
      const run = (...args: string[]) =>
        execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
      run("init", "--quiet");
      run("config", "user.email", "test@example.test");
      run("config", "user.name", "Test");
      mkdirSync(join(directory, "compose.yaml"));
      writeFileSync(join(directory, "compose.yaml", "notes.txt"), "not a Compose file\n");
      writeFileSync(join(directory, "docker-compose.yml"), BASE);
      run("add", ".");
      run("commit", "--quiet", "-m", "base");
      const commit = run("rev-parse", "HEAD");

      expect(
        composePairFromGit({ directory, baseRevision: commit, headRevision: commit }).composePath
      ).toBe("docker-compose.yml");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reviews from the CLI without --compose-path but still requires named revisions", () => {
    const context = io();
    expect(runCli(["review", "--repo", repository, "--base-revision", baseCommit,
      "--head-revision", headCommit, "--format", "json"], context)).toBe(1);
    expect(JSON.parse(context.out.join("")).base.revision).toBe(baseCommit);
    expect(context.out.join("")).toContain("docker-compose.yml");
    const missing = io();
    expect(runCli(["review", "--repo", repository], missing)).toBe(2);
    expect(missing.err.join("")).toContain("--base-revision");
  });

  it("reviews a repository in one command, and fails on what it finds", () => {
    const context = io();
    const code = runCli(
      [
        "review",
        "--repo",
        repository,
        "--compose-path",
        "docker-compose.yml",
        "--base-revision",
        baseCommit,
        "--head-revision",
        headCommit,
        "--format",
        "markdown",
      ],
      context
    );

    expect(code).toBe(1);
    const report = context.out.join("");
    expect(report).toContain("Persistence port is publicly published");
    // Evidence points at the path as it exists in the repository, so a line
    // reference means something to whoever opens the file.
    expect(report).toContain("docker-compose.yml");
  });

  it("still compares two files when no repository is given", () => {
    const context = io();
    context.readFile = (path: string) => (path === "b.yml" ? BASE : HEAD);
    const code = runCli(
      ["review", "--base", "b.yml", "--head", "h.yml", "--format", "markdown"],
      context
    );
    expect(code).toBe(1);
    expect(context.out.join("")).toContain("Persistence port is publicly published");
  });
});
