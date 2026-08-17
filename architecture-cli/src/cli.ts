#!/usr/bin/env node
import {
  SourceImportError,
  dockerComposeAdapter,
  reviewArchitectureChange,
  stableStringify,
  type ArchitecturePolicy,
} from "@system-synthesis/architecture-core";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { parseArchitecturePolicy } from "./policy.js";
import { composePairFromGit } from "./gitSource.js";
import {
  formatReview,
  type ReviewOutputFormat,
} from "./reporters.js";

export interface CliIO {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stdout(message: string): void;
  stderr(message: string): void;
  now(): Date;
}

interface ParsedArguments {
  command?: string;
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = `System Synthesis architecture change intelligence

Usage:
  system-synthesis review --base <compose.yaml> --head <compose.yaml> [options]
  system-synthesis review --repo <dir> --compose-path <path>       --base-revision <rev> --head-revision <rev> [options]
  system-synthesis import --file <compose.yaml> [options]

Review options:
  --format <json|markdown|sarif>   Output format (default: markdown)
  --output <path>                 Write report to a file instead of stdout
  --policy <policy.json>          Rule policy and justified suppressions
  --repository <owner/name>       Repository recorded in source provenance
  --repo <dir>                    Read both sides from a Git repository, using
                                  --base-revision and --head-revision as commits
  --compose-path <path>           Compose file to read at each revision (with --repo)
  --source-path <path>            Repository-relative Compose path for evidence
  --base-revision <sha>           Base revision; a label without --repo (default: base)
  --head-revision <sha>           Head revision; a label without --repo (default: head)
  --reviewed-at <ISO timestamp>   Reproducible report time

Exit codes:
  0  Review passed
  1  Review found blocking architecture changes
  2  Invalid input, policy, or command
`;

const VALUE_OPTIONS = new Set([
  "base",
  "head",
  "repo",
  "compose-path",
  "file",
  "format",
  "output",
  "policy",
  "repository",
  "source-path",
  "base-revision",
  "head-revision",
  "revision",
  "reviewed-at",
]);

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    values: new Map(),
    flags: new Set(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      if (parsed.command) throw new Error(`Unexpected argument: ${argument}`);
      parsed.command = argument;
      continue;
    }
    const option = argument.slice(2);
    if (option === "help") {
      parsed.flags.add(option);
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) throw new Error(`Unknown option: --${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${option} requires a value.`);
    }
    if (parsed.values.has(option)) {
      throw new Error(`Option --${option} was provided more than once.`);
    }
    parsed.values.set(option, value);
    index += 1;
  }
  return parsed;
}

function required(parsed: ParsedArguments, option: string): string {
  const value = parsed.values.get(option);
  if (!value) throw new Error(`Missing required option: --${option}`);
  return value;
}

function outputFormat(value: string | undefined): ReviewOutputFormat {
  const format = value || "markdown";
  if (!["json", "markdown", "sarif"].includes(format)) {
    throw new Error("--format must be json, markdown, or sarif.");
  }
  return format as ReviewOutputFormat;
}

function sourcePath(inputPath: string, override: string | undefined): string {
  return (override || basename(inputPath)).replace(/\\/g, "/");
}

function loadPolicy(parsed: ParsedArguments, io: CliIO): ArchitecturePolicy {
  const policyPath = parsed.values.get("policy");
  return policyPath
    ? parseArchitecturePolicy(io.readFile(policyPath))
    : {};
}

function emit(
  parsed: ParsedArguments,
  io: CliIO,
  content: string
): void {
  const output = parsed.values.get("output");
  if (output) io.writeFile(output, content);
  else io.stdout(content);
}

function importCompose(
  inputPath: string,
  evidencePath: string,
  io: CliIO,
  context: { repository?: string; revision?: string }
) {
  return dockerComposeAdapter.import(
    [{ path: evidencePath, content: io.readFile(inputPath) }],
    context
  );
}

function runImport(parsed: ParsedArguments, io: CliIO): number {
  const input = required(parsed, "file");
  const imported = importCompose(
    input,
    sourcePath(input, parsed.values.get("source-path")),
    io,
    {
      repository: parsed.values.get("repository"),
      revision: parsed.values.get("revision"),
    }
  );
  emit(
    parsed,
    io,
    `${JSON.stringify(JSON.parse(stableStringify(imported)), null, 2)}\n`
  );
  return 0;
}

/**
 * Both sides of the comparison, from two files or from a repository's history.
 *
 * Reading history directly is what makes this usable against a project you have
 * only cloned: the alternative is extracting each revision by hand first, and a
 * step that has to be got right before the tool runs is a step where people
 * stop. The revisions must be named explicitly — guessing a default would let a
 * misremembered branch quietly review the wrong pair.
 */
function reviewSides(
  parsed: ParsedArguments,
  io: CliIO
): { base: ReturnType<typeof importCompose>; head: ReturnType<typeof importCompose> } {
  const repository = parsed.values.get("repository");
  const directory = parsed.values.get("repo");

  if (directory) {
    const composePath = required(parsed, "compose-path");
    const baseRevision = required(parsed, "base-revision");
    const headRevision = required(parsed, "head-revision");
    const evidencePath = (parsed.values.get("source-path") || composePath).replace(/\\/g, "/");
    const sources = composePairFromGit({
      directory,
      composePath,
      baseRevision,
      headRevision,
    });
    return {
      base: dockerComposeAdapter.import(
        [{ path: evidencePath, content: sources.baseContent }],
        { repository, revision: baseRevision }
      ),
      head: dockerComposeAdapter.import(
        [{ path: evidencePath, content: sources.headContent }],
        { repository, revision: headRevision }
      ),
    };
  }

  const basePath = required(parsed, "base");
  const headPath = required(parsed, "head");
  const evidencePath = parsed.values.get("source-path");
  return {
    base: importCompose(basePath, sourcePath(basePath, evidencePath), io, {
      repository,
      revision: parsed.values.get("base-revision") || "base",
    }),
    head: importCompose(headPath, sourcePath(headPath, evidencePath), io, {
      repository,
      revision: parsed.values.get("head-revision") || "head",
    }),
  };
}

function runReview(parsed: ParsedArguments, io: CliIO): number {
  const { base, head } = reviewSides(parsed, io);
  const reviewedAt = parsed.values.get("reviewed-at")
    ? new Date(parsed.values.get("reviewed-at")!)
    : io.now();
  const review = reviewArchitectureChange(
    base.graph,
    head.graph,
    loadPolicy(parsed, io),
    reviewedAt,
    {
      base: base.diagnostics,
      head: head.diagnostics,
    }
  );
  emit(
    parsed,
    io,
    formatReview(review, outputFormat(parsed.values.get("format")))
  );
  return review.status === "fail" ? 1 : 0;
}

function formatImportError(error: SourceImportError): string {
  const details = error.diagnostics
    .map((diagnostic) =>
      `  - ${diagnostic.code}: ${diagnostic.message}${diagnostic.line ? ` (${diagnostic.file}:${diagnostic.line})` : ""}`
    )
    .join("\n");
  return `${error.message}${details ? `\n${details}` : ""}`;
}

export function runCli(args: string[], io: CliIO): number {
  try {
    const parsed = parseArguments(args);
    if (parsed.flags.has("help") || !parsed.command) {
      io.stdout(HELP);
      return 0;
    }
    if (parsed.command === "import") return runImport(parsed, io);
    if (parsed.command === "review" || parsed.command === "analyze") {
      return runReview(parsed, io);
    }
    throw new Error(`Unknown command: ${parsed.command}`);
  } catch (error) {
    const message = error instanceof SourceImportError
      ? formatImportError(error)
      : error instanceof Error
        ? error.message
        : "Unknown CLI error.";
    io.stderr(`Error: ${message}\n`);
    return 2;
  }
}

export const defaultCliIO: CliIO = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  },
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  now: () => new Date(),
};
