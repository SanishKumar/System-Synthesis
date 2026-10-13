/** The one kind of credential a connection accepts. */
export type ReviewIntegrationAuthMode = "token" | "oidc";

export interface ReviewIntegration {
  id: string;
  ownerId: string;
  provider: "github";
  repository: string;
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Absent from a server that predates GitHub OIDC, where it is a token. */
  authMode?: ReviewIntegrationAuthMode;
}

export interface IssuedReviewIntegration {
  integration: ReviewIntegration;
  /** Null for GitHub OIDC: the workflow asks GitHub for a token on each run. */
  ingestionToken: string | null;
  /** The address identity tokens must be requested for, for GitHub OIDC. */
  audience?: string;
  warning?: string;
}
