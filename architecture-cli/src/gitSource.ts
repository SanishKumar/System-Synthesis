import { execFileSync } from "node:child_process";
import { COMPOSE_FILE_NAMES } from "@system-synthesis/architecture-core";

/**
 * Reading a Compose document as it stood at a revision.
 *
 * Shared by the CLI and the Action rather than written twice. Both answer the
 * same question — what did this file look like at this commit, and what should
 * happen when it is not there — and two copies of that answer would drift, with
 * the Action's behaviour tested and the CLI's not.
 */
const MAX_GIT_FILE_BYTES = 1_000_000;

export const EMPTY_COMPOSE = "services: {}\n";

/**
 * Fails loudly for a revision git cannot resolve, before anything is read.
 *
 * The message names the revision rather than repeating git's command line: a
 * shallow clone that lacks the base commit and a mistyped branch look identical
 * in the raw error, and both are things the person running this can fix.
 */
export function verifyRevision(revision: string, cwd: string): void {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `"${revision}" is not a commit this repository can resolve. Check the name, ` +
        "and that the clone has enough history to contain it."
    );
  }
}

/** The file's contents at that revision, or undefined if it did not exist. */
export function readFileAtRevision(
  revision: string,
  repositoryPath: string,
  cwd: string
): string | undefined {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${repositoryPath}`], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    return undefined;
  }
  return execFileSync("git", ["show", `${revision}:${repositoryPath}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_FILE_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Root-level Compose files present at a revision, used only to turn a
 * misconfigured path into an actionable message. Probing the known names
 * directly keeps this to a few cheap lookups instead of listing the tree.
 */
export function composeCandidatesAt(revision: string, cwd: string): string[] {
  return COMPOSE_FILE_NAMES.filter((name) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${revision}:${name}`], {
        cwd,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Compose documents to compare, or a configuration error.
 *
 * Missing on one side is a real architecture change: the pull request adds or
 * deletes the file, and the absent side is an empty architecture. Missing on
 * both sides means the configured path is wrong. Comparing two empty documents
 * there would report no components and no changes, exit zero, and present a
 * misconfigured check as architecture coverage — the failure mode that looks
 * exactly like success.
 */
export function resolveComposeSources(input: {
  composePath: string;
  baseRevision: string;
  headRevision: string;
  baseFile: string | undefined;
  headFile: string | undefined;
  findCandidates: () => string[];
}): { baseContent: string; headContent: string } {
  if (input.baseFile === undefined && input.headFile === undefined) {
    const candidates = input.findCandidates();
    throw new Error(
      `compose-path "${input.composePath}" does not exist at ${input.baseRevision} or ${input.headRevision}. ` +
        (candidates.length
          ? `Set compose-path to one of: ${candidates.join(", ")}.`
          : "No Compose file was found at the repository root either; set compose-path to the file you want reviewed.")
    );
  }
  return {
    baseContent: input.baseFile ?? EMPTY_COMPOSE,
    headContent: input.headFile ?? EMPTY_COMPOSE,
  };
}

/** Both sides of a comparison, read straight out of a repository's history. */
export function composePairFromGit(input: {
  directory: string;
  composePath: string;
  baseRevision: string;
  headRevision: string;
}): { baseContent: string; headContent: string } {
  verifyRevision(input.baseRevision, input.directory);
  verifyRevision(input.headRevision, input.directory);
  return resolveComposeSources({
    composePath: input.composePath,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    baseFile: readFileAtRevision(input.baseRevision, input.composePath, input.directory),
    headFile: readFileAtRevision(input.headRevision, input.composePath, input.directory),
    findCandidates: () => composeCandidatesAt(input.headRevision, input.directory),
  });
}
