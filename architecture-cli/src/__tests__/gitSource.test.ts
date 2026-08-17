import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
