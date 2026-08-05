export const EMPTY_COMPOSE = "services: {}\n";

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
