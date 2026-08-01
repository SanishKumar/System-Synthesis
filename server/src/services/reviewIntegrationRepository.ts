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
  };
}

export function normalizeRepositoryIdentity(repository: string): string {
  return repository.trim().toLowerCase();
}

export async function createOrRotateReviewIntegration(input: {
  ownerId: string;
  provider: ReviewIntegrationProvider;
  repository: string;
}): Promise<IssuedReviewIntegration> {
  const repository = normalizeRepositoryIdentity(input.repository);
  const token = `${TOKEN_MARKER}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 13);
  const pool = getPool();

  if (pool) {
    const result = await pool.query(
      `INSERT INTO architecture_review_integrations (
         id, owner_id, provider, repository, token_hash, token_prefix
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id, provider, repository) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           token_prefix = EXCLUDED.token_prefix,
           revoked_at = NULL,
           updated_at = NOW()
       RETURNING *`,
      [
        randomUUID(),
        input.ownerId,
        input.provider,
        repository,
        tokenHash,
        tokenPrefix,
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
