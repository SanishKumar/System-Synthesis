import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getPool } from "./db.js";

export type ReviewIntegrationProvider = "github";

export interface ReviewIntegrationRecord {
  id: string;
  ownerId: string;
  provider: ReviewIntegrationProvider;
  repository: string;
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /**
   * The GitHub account whose administration of this repository was confirmed
   * when the credential was issued. Null on a row written before connections
   * were verified, which is a state to notice rather than to trust.
   */
  verifiedGithubUserId: string | null;
  verifiedGithubLogin: string | null;
  verifiedPermission: string | null;
  verifiedAt: string | null;
}

interface StoredReviewIntegration extends ReviewIntegrationRecord {
  tokenHash: string;
}

export interface IssuedReviewIntegration {
  integration: ReviewIntegrationRecord;
  /** Returned once. Only the SHA-256 digest is persisted. */
  ingestionToken: string;
}

const TOKEN_MARKER = "ssri_";
const memoryIntegrations = new Map<string, StoredReviewIntegration>();

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function publicRecord(
  integration: StoredReviewIntegration
): ReviewIntegrationRecord {
  const { tokenHash: _tokenHash, ...record } = integration;
  return structuredClone(record);
}

function rowToStoredIntegration(row: any): StoredReviewIntegration {
  return {
    id: row.id,
    ownerId: row.owner_id,
    provider: row.provider,
    repository: row.repository,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    lastUsedAt: row.last_used_at ? timestamp(row.last_used_at) : null,
    revokedAt: row.revoked_at ? timestamp(row.revoked_at) : null,
    verifiedGithubUserId: row.verified_github_user_id ?? null,
    verifiedGithubLogin: row.verified_github_login ?? null,
    verifiedPermission: row.verified_permission ?? null,
    verifiedAt: row.verified_at ? timestamp(row.verified_at) : null,
  };
}

export function normalizeRepositoryIdentity(repository: string): string {
  return repository.trim().toLowerCase();
}

export async function createOrRotateReviewIntegration(input: {
  ownerId: string;
  provider: ReviewIntegrationProvider;
  repository: string;
  /**
   * Proof that the connecting account administers this repository. Required,
   * because a credential issued without it is one the App will act on for
   * somebody who may have no standing on the repository at all.
   */
  verified: {
    githubUserId: string;
    githubLogin: string;
    permission: string;
    verifiedAt: string;
  };
}): Promise<IssuedReviewIntegration> {
  const repository = normalizeRepositoryIdentity(input.repository);
  const token = `${TOKEN_MARKER}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 13);
  const pool = getPool();

  if (pool) {
    const result = await pool.query(
      `INSERT INTO architecture_review_integrations (
         id, owner_id, provider, repository, token_hash, token_prefix,
         verified_github_user_id, verified_github_login, verified_permission, verified_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (owner_id, provider, repository) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           token_prefix = EXCLUDED.token_prefix,
           revoked_at = NULL,
           updated_at = NOW(),
           verified_github_user_id = EXCLUDED.verified_github_user_id,
           verified_github_login = EXCLUDED.verified_github_login,
           verified_permission = EXCLUDED.verified_permission,
           verified_at = EXCLUDED.verified_at
       RETURNING *`,
      [
        randomUUID(),
        input.ownerId,
        input.provider,
        repository,
        tokenHash,
        tokenPrefix,
        input.verified.githubUserId,
        input.verified.githubLogin,
        input.verified.permission,
        input.verified.verifiedAt,
      ]
    );
    return {
      integration: publicRecord(rowToStoredIntegration(result.rows[0])),
      ingestionToken: token,
    };
  }

  const existing = [...memoryIntegrations.values()].find(
    (integration) =>
      integration.ownerId === input.ownerId &&
      integration.provider === input.provider &&
      integration.repository === repository
  );
  const now = new Date().toISOString();
  const stored: StoredReviewIntegration = {
    id: existing?.id || randomUUID(),
    ownerId: input.ownerId,
    provider: input.provider,
    repository,
    tokenHash,
    tokenPrefix,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || null,
    revokedAt: null,
    // Memory storage records the same proof as PostgreSQL. The two disagreeing
    // about what was verified is its own defect.
    verifiedGithubUserId: input.verified.githubUserId,
    verifiedGithubLogin: input.verified.githubLogin,
    verifiedPermission: input.verified.permission,
    verifiedAt: input.verified.verifiedAt,
  };
  memoryIntegrations.set(stored.id, stored);
  return { integration: publicRecord(stored), ingestionToken: token };
}

export async function listReviewIntegrations(
  ownerId: string
): Promise<ReviewIntegrationRecord[]> {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT * FROM architecture_review_integrations
       WHERE owner_id = $1
       ORDER BY updated_at DESC`,
      [ownerId]
    );
    return result.rows.map(rowToStoredIntegration).map(publicRecord);
  }
  return [...memoryIntegrations.values()]
    .filter((integration) => integration.ownerId === ownerId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(publicRecord);
}

export async function revokeReviewIntegration(
  id: string,
  ownerId: string
): Promise<boolean> {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `UPDATE architecture_review_integrations
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [id, ownerId]
    );
    return Boolean(result.rows[0]);
  }
  const current = memoryIntegrations.get(id);
  if (!current || current.ownerId !== ownerId || current.revokedAt) return false;
  const now = new Date().toISOString();
  memoryIntegrations.set(id, {
    ...current,
    revokedAt: now,
    updatedAt: now,
  });
  return true;
}

/**
 * Whether a stored credential carries the proof this deployment now requires.
 *
 * A row issued before repository authority was checked has none of it. That
 * absence is not a detail to tolerate: such a credential was issued to whoever
 * asked, for whatever repository they named, and it still makes the App publish
 * there. Nothing about it can be reconstructed after the fact, so it is refused
 * rather than guessed at, and its owner reconnects to prove authority once.
 */
export function isVerifiedIntegration(
  integration: Pick<
    ReviewIntegrationRecord,
    "verifiedGithubUserId" | "verifiedGithubLogin" | "verifiedPermission" | "verifiedAt"
  >
): boolean {
  return Boolean(
    integration.verifiedGithubUserId &&
      integration.verifiedGithubLogin &&
      integration.verifiedPermission &&
      integration.verifiedAt
  );
}

/**
 * Replaces the proof on a connection after authority was established again.
 *
 * The login and the permission are written as GitHub reports them now, not as
 * they were: an account can be renamed, and a permission can be reduced
 * without losing admin outright.
 */
export async function recordIntegrationAuthority(
  id: string,
  verified: {
    githubUserId: string;
    githubLogin: string;
    permission: string;
    verifiedAt: string;
  }
): Promise<void> {
  const pool = getPool();
  if (pool) {
    await pool.query(
      `UPDATE architecture_review_integrations
         SET verified_github_user_id = $2,
             verified_github_login = $3,
             verified_permission = $4,
             verified_at = $5
       WHERE id = $1`,
      [id, verified.githubUserId, verified.githubLogin, verified.permission, verified.verifiedAt]
    );
    return;
  }
  const stored = memoryIntegrations.get(id);
  if (!stored) return;
  stored.verifiedGithubUserId = verified.githubUserId;
  stored.verifiedGithubLogin = verified.githubLogin;
  stored.verifiedPermission = verified.permission;
  stored.verifiedAt = verified.verifiedAt;
}

/**
 * Removes the verification proof from a stored connection.
 *
 * Only for reproducing a row as the build before authority checking wrote it.
 * No current write path produces this shape, which is why it has to be made.
 */
export function stripVerificationForTests(id: string): void {
  const stored = memoryIntegrations.get(id);
  if (!stored) return;
  stored.verifiedGithubUserId = null;
  stored.verifiedGithubLogin = null;
  stored.verifiedPermission = null;
  stored.verifiedAt = null;
}

/** Moves a connection's proof back in time, so staleness can be reached. */
export function ageVerificationForTests(id: string, verifiedAt: string): void {
  const stored = memoryIntegrations.get(id);
  if (stored) stored.verifiedAt = verifiedAt;
}

export async function authenticateReviewIntegrationToken(
  token: string
): Promise<ReviewIntegrationRecord | null> {
  if (!token.startsWith(TOKEN_MARKER) || token.length < 40 || token.length > 80) {
    return null;
  }
  const tokenHash = hashToken(token);
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `UPDATE architecture_review_integrations
       SET last_used_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING *`,
      [tokenHash]
    );
    return result.rows[0]
      ? publicRecord(rowToStoredIntegration(result.rows[0]))
      : null;
  }
  const current = [...memoryIntegrations.values()].find(
    (integration) => integration.tokenHash === tokenHash && !integration.revokedAt
  );
  if (!current) return null;
  const updated = { ...current, lastUsedAt: new Date().toISOString() };
  memoryIntegrations.set(updated.id, updated);
  return publicRecord(updated);
}

export function resetMemoryReviewIntegrationsForTests(): void {
  memoryIntegrations.clear();
}
