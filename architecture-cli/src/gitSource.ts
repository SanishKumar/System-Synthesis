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
export function verifyRevision(revision: string, cwd: string): string {
  // The `^{commit}` suffix already keeps an option-shaped name from being read
  // as an option. `--end-of-options` is there so that stays true if the suffix
  // ever changes; no input distinguishes the two today.
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `"${revision}" is not a commit this repository can resolve. Check the name, ` +
        "and that the clone has enough history to contain it (actions/checkout: fetch-depth: 0)."
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
 * Root-level Compose blobs present at a revision, for detection and actionable
 * misconfiguration messages. Probing the known names
 * directly keeps this to a few cheap lookups instead of listing the tree.
 */
export function composeCandidatesAt(revision: string, cwd: string): string[] {
  return COMPOSE_FILE_NAMES.filter((name) => {
    try {
      const type = execFileSync("git", ["cat-file", "-t", `${revision}:${name}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return type.trim() === "blob";
    } catch {
      return false;
    }
  });
}

export function safeRepositoryPath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") ||
      normalized.split("/").includes("..") || /[:\0\r\n]/.test(normalized)) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  return normalized;
}

/** Never prefer a filename or revision when the repository gives two choices. */
export function resolveComposePath(input: {
  composePath?: string;
  baseRevision: string;
  headRevision: string;
  findCandidates: (revision: string) => string[];
}): string {
  if (input.composePath) return safeRepositoryPath(input.composePath, "compose-path");
  const found = new Set([
    ...input.findCandidates(input.baseRevision),
    ...input.findCandidates(input.headRevision),
  ]);
  const candidates = COMPOSE_FILE_NAMES.filter((name) => found.has(name));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`Multiple Compose files exist across the base/head revisions: ${candidates.join(", ")}. Set compose-path explicitly; files are not merged.`);
  }
  throw new Error("No standard Compose file was found at the repository root in either revision. Set compose-path explicitly for a nested or custom-named file.");
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
  composePath?: string;
  baseRevision: string;
  headRevision: string;
}): { composePath: string; baseRevision: string; headRevision: string; baseContent: string; headContent: string } {
  // Resolve refs once, so detection, source reads and policy cannot disagree if
  // a local branch moves while the comparison is running.
  const baseRevision = verifyRevision(input.baseRevision, input.directory);
  const headRevision = verifyRevision(input.headRevision, input.directory);
  const composePath = resolveComposePath({
    composePath: input.composePath, baseRevision, headRevision,
    findCandidates: (revision) => composeCandidatesAt(revision, input.directory),
  });
  return {
    composePath, baseRevision, headRevision,
    ...resolveComposeSources({
      composePath, baseRevision, headRevision,
      baseFile: readFileAtRevision(baseRevision, composePath, input.directory),
      headFile: readFileAtRevision(headRevision, composePath, input.directory),
      findCandidates: () => [...new Set([
        ...composeCandidatesAt(baseRevision, input.directory),
        ...composeCandidatesAt(headRevision, input.directory),
      ])],
    }),
  };
}
