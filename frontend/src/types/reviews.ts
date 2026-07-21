import type {
  SerializedEdge,
  SerializedNode,
  SourceProvenance,
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "@system-synthesis/shared";

export type ReviewDecision = "pending" | "approved" | "rejected";

export interface ReviewSummary {
  id: string;
  title: string;
  repository: string | null;
  sourcePath: string;
  baseRevision: string;
  headRevision: string;
  analysisStatus: "pass" | "fail";
  decision: ReviewDecision;
  blockingFindings: number;
  semanticChanges: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalReviewGraph {
  source: {
    adapter: string;
    repository?: string;
    revision?: string;
    files: string[];
  };
  nodes: SerializedNode[];
  edges: SerializedEdge[];
}

export interface ReviewImpact {
  id: string;
  kind: string;
  severity: ValidationSeverity;
  summary: string;
  description: string;
  nodeIds: string[];
  edgeIds: string[];
  locations: SourceProvenance[];
  before?: unknown;
  after?: unknown;
}

export interface ReviewGraphChange {
  id: string;
  kind: "added" | "removed" | "changed";
  entity: "node" | "edge";
  entityId: string;
  summary: string;
  fields: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface ReviewSuppression {
  id?: string;
  ruleId: string;
  findingId?: string;
  justification: string;
  ticket?: string;
  createdBy?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ReviewReport {
  status: "pass" | "fail";
  reviewedAt: string;
  diff: {
    changes: ReviewGraphChange[];
    stats: {
      added: number;
      removed: number;
      changed: number;
      total: number;
    };
  };
  impacts: ReviewImpact[];
  baseValidation: ValidationResult;
  headValidation: ValidationResult;
  newFindings: ValidationIssue[];
  resolvedFindings: ValidationIssue[];
  blockingFindings: ValidationIssue[];
  suppressedFindings: Array<{
    finding: ValidationIssue;
    suppression: ReviewSuppression;
  }>;
  baseDiagnostics: Array<{
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
    file: string;
    line?: number;
  }>;
  headDiagnostics: Array<{
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
    file: string;
    line?: number;
  }>;
}

export interface ReviewRecord {
  id: string;
  ownerId: string;
  title: string;
  repository: string | null;
  sourcePath: string;
  baseRevision: string;
  headRevision: string;
  baseGraph: CanonicalReviewGraph;
  headGraph: CanonicalReviewGraph;
  policy: {
    failOn?: ValidationSeverity[];
    includeExistingFindings?: boolean;
    rules?: Record<string, {
      enabled?: boolean;
      severity?: ValidationSeverity;
      blockMerge?: boolean;
    }>;
    suppressions?: ReviewSuppression[];
  };
  report: ReviewReport;
  decision: ReviewDecision;
  decisionNote: string | null;
  decidedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewEvent {
  id: string;
  reviewId: string;
  actorId: string;
  eventType: "review.created" | "suppression.added" | "decision.changed";
  reviewRevision: number;
  data: Record<string, unknown>;
  createdAt: string;
}

export function findingLocation(finding: ValidationIssue): string {
  const location = finding.locations?.[0];
  if (!location) return "Derived graph analysis";
  return `${location.file}${location.startLine ? `:${location.startLine}` : ""}`;
}
