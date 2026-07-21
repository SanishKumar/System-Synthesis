import type { CanonicalArchitectureGraph } from "../provenance.js";

export interface RepositorySourceFile {
  path: string;
  content: string;
}

export interface SourceImportContext {
  repository?: string;
  revision?: string;
}

export interface SourceImportDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  sourceAddress?: string;
  line?: number;
}

export interface SourceImportResult {
  graph: CanonicalArchitectureGraph;
  diagnostics: SourceImportDiagnostic[];
}

export interface DetectionResult {
  detected: boolean;
  confidence: "none" | "possible" | "strong";
  files: string[];
}

export interface ArchitectureSourceAdapter {
  id: string;
  detect(files: RepositorySourceFile[]): DetectionResult;
  import(
    files: RepositorySourceFile[],
    context?: SourceImportContext
  ): SourceImportResult;
}

export class SourceImportError extends Error {
  constructor(
    message: string,
    readonly diagnostics: SourceImportDiagnostic[]
  ) {
    super(message);
    this.name = "SourceImportError";
  }
}
