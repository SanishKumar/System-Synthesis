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
}

export interface IssuedReviewIntegration {
  integration: ReviewIntegration;
  ingestionToken: string;
  warning: string;
}
