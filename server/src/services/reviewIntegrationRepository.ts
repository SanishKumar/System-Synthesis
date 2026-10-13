import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getPool } from "./db.js";

export type ReviewIntegrationProvider = "github";

/**
 * The one kind of credential a connection accepts.
 *
 * `token` is the repository-scoped secret this service issues. `oidc` is the
 * identity token GitHub issues to a run of the repository, which leaves nothing
 * to store or rotate. A connection is one or the other and never both, so an
 * administrator who keeps a token behind a protected environment is not
 * quietly given a second way in, and nobody has to reason about which of two
 * credentials a delivery was allowed by.
 */
export type ReviewIntegrationAuthMode = "token" | "oidc";

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
  authMode: ReviewIntegrationAuthMode;
  /**
   * GitHub's numeric id for the repository, as of the proof above. Null where
   * it was never established, which a token connection tolerates and an
   * identity-token connection does not.
   */
  verifiedRepositoryId: string | null;
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
    // Anything but an explicit opt-in is a token connection, including a row
    // written before the column existed.
    authMode: row.auth_mode === "oidc" ? "oidc" : "token",
    verifiedRepositoryId: row.verified_repository_id ?? null,
  };
}

export function normalizeRepositoryIdentity(repository: string): string {
  return repository.trim().toLowerCase();
}

/** What was established about a connection, and when. */
export interface VerifiedConnection {
  githubUserId: string;
  githubLogin: string;
  permission: string;
  verifiedAt: string;
  /** GitHub's numeric id for the repository, where it was established. */
  repositoryId?: string | null;
}

/** Named, because a violation of it is the one conflict a caller can explain. */
const OIDC_REPOSITORY_INDEX = "idx_review_integrations_oidc_repository";

/**
 * One statement for both ways of connecting, so the two cannot drift apart
 * about what a connection is. The mode is always written, which is what makes
 * reconnecting in one mode leave the other.
 */
const UPSERT_CONNECTION_SQL = `INSERT INTO architecture_review_integrations (
     id, owner_id, provider, repository, token_hash, token_prefix,
     verified_github_user_id, verified_github_login, verified_permission, verified_at,
     auth_mode, verified_repository_id
   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
   ON CONFLICT (owner_id, provider, repository) DO UPDATE
   SET token_hash = EXCLUDED.token_hash,
       token_prefix = EXCLUDED.token_prefix,
       revoked_at = NULL,
       updated_at = NOW(),
       verified_github_user_id = EXCLUDED.verified_github_user_id,
       verified_github_login = EXCLUDED.verified_github_login,
       verified_permission = EXCLUDED.verified_permission,
       verified_at = EXCLUDED.verified_at,
       auth_mode = EXCLUDED.auth_mode,
       verified_repository_id = EXCLUDED.verified_repository_id
   RETURNING *`;

export async function createOrRotateReviewIntegration(input: {
  ownerId: string;
  provider: ReviewIntegrationProvider;
  repository: string;
  /**
   * Proof that the connecting account administers this repository. Required,
   * because a credential issued without it is one the App will act on for
   * somebody who may have no standing on the repository at all.
   */
  verified: VerifiedConnection;
}): Promise<IssuedReviewIntegration> {
  const repository = normalizeRepositoryIdentity(input.repository);
  const token = `${TOKEN_MARKER}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 13);
  const pool = getPool();

  if (pool) {
    const result = await pool.query(
      UPSERT_CONNECTION_SQL,
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
        // Issuing a token makes this a token connection, including when it was
        // an identity-token one a moment ago.
        "token",
        input.verified.repositoryId ?? null,
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
    authMode: "token",
    verifiedRepositoryId: input.verified.repositoryId ?? null,
  };
  memoryIntegrations.set(stored.id, stored);
  return { integration: publicRecord(stored), ingestionToken: token };
}

export type OidcConnectionResult =
  | { status: "connected"; integration: ReviewIntegrationRecord }
  /** Another account already receives this repository's identity tokens. */
  | { status: "conflict" };

/**
 * Connect a repository so that it authenticates with the identity token GitHub
 * issues to its own runs, instead of a stored secret.
 *
 * No credential is returned because none exists. The row still carries a token
 * digest, since the column is part of what a connection is, but it is the
 * digest of bytes that were never shown to anybody: switching an existing
 * connection to this mode is therefore also what ends its old token.
 *
 * An identity token names a repository and no account, so at most one
 * connection per repository may accept one. A second account is refused here
 * rather than left to make every later delivery ambiguous.
 */
export async function connectReviewIntegrationForOidc(input: {
  ownerId: string;
  provider: ReviewIntegrationProvider;
  repository: string;
  /**
   * The repository id is required, not best effort. It is the only thing that
   * ties a later token to the repository an administrator actually proved
   * authority over, rather than to whatever holds that name by then.
   */
  verified: VerifiedConnection & { repositoryId: string };
}): Promise<OidcConnectionResult> {
  const repository = normalizeRepositoryIdentity(input.repository);
  const unusableDigest = hashToken(randomBytes(32).toString("base64url"));
  const pool = getPool();

  if (pool) {
    try {
      const result = await pool.query(UPSERT_CONNECTION_SQL, [
        randomUUID(),
        input.ownerId,
        input.provider,
        repository,
        unusableDigest,
        "",
        input.verified.githubUserId,
        input.verified.githubLogin,
        input.verified.permission,
        input.verified.verifiedAt,
        "oidc",
        input.verified.repositoryId,
      ]);
      return {
        status: "connected",
        integration: publicRecord(rowToStoredIntegration(result.rows[0])),
      };
    } catch (error) {
      // The upsert arbitrates on this account's own row. A second account's
      // row for the same repository is caught by the partial unique index
      // instead, and that is the one failure this is allowed to explain.
      const violation = error as { code?: unknown; constraint?: unknown };
      if (violation.code === "23505" && violation.constraint === OIDC_REPOSITORY_INDEX) {
        return { status: "conflict" };
      }
      throw error;
    }
  }

  const all = [...memoryIntegrations.values()];
  const taken = all.some(
    (integration) =>
      integration.ownerId !== input.ownerId &&
      integration.provider === input.provider &&
      integration.repository === repository &&
      integration.authMode === "oidc" &&
      !integration.revokedAt
  );
  if (taken) return { status: "conflict" };

  const existing = all.find(
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
    tokenHash: unusableDigest,
    tokenPrefix: "",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || null,
    revokedAt: null,
    verifiedGithubUserId: input.verified.githubUserId,
    verifiedGithubLogin: input.verified.githubLogin,
    verifiedPermission: input.verified.permission,
    verifiedAt: input.verified.verifiedAt,
    authMode: "oidc",
    verifiedRepositoryId: input.verified.repositoryId,
  };
  memoryIntegrations.set(stored.id, stored);
  return { status: "connected", integration: publicRecord(stored) };
}

export type OidcConnectionLookup =
  | { status: "found"; integration: ReviewIntegrationRecord }
  | { status: "none" }
  /** More than one, which storage is meant to make impossible. */
  | { status: "ambiguous" };

/**
 * The connection waiting for identity tokens from this repository, if exactly
 * one is.
 *
 * Deliberately never chooses. Storage keeps this to one row; if it ever finds
 * two, picking the older or the newer would be deciding whose account a
 * repository's reviews belong to, on no authority at all.
 */
export async function findOidcReviewIntegration(
  provider: ReviewIntegrationProvider,
  repository: string
): Promise<OidcConnectionLookup> {
  const normalized = normalizeRepositoryIdentity(repository);
  const pool = getPool();
  if (pool) {
    const found = await pool.query(
      `SELECT id FROM architecture_review_integrations
       WHERE provider = $1 AND repository = $2
         AND auth_mode = 'oidc' AND revoked_at IS NULL`,
      [provider, normalized]
    );
    if (found.rows.length === 0) return { status: "none" };
    if (found.rows.length > 1) return { status: "ambiguous" };
    const used = await pool.query(
      `UPDATE architecture_review_integrations
       SET last_used_at = NOW()
       WHERE id = $1 AND auth_mode = 'oidc' AND revoked_at IS NULL
       RETURNING *`,
      [found.rows[0].id]
    );
    return used.rows[0]
      ? { status: "found", integration: publicRecord(rowToStoredIntegration(used.rows[0])) }
      : { status: "none" };
  }

  const matches = [...memoryIntegrations.values()].filter(
    (integration) =>
      integration.provider === provider &&
      integration.repository === normalized &&
      integration.authMode === "oidc" &&
      !integration.revokedAt
  );
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) return { status: "ambiguous" };
  const updated = { ...matches[0], lastUsedAt: new Date().toISOString() };
  memoryIntegrations.set(updated.id, updated);
  return { status: "found", integration: publicRecord(updated) };
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
  // The level and the time are checked, not merely present. A boundary that
  // accepts any non-empty permission would accept a row saying write, and one
  // that accepts any non-empty timestamp would read an unparseable value as
  // infinitely old — which the staleness check turns into "revalidate", not
  // into a refusal. Only what issuance actually produces is honoured.
  return Boolean(
    integration.verifiedGithubUserId &&
      integration.verifiedGithubLogin &&
      integration.verifiedPermission === "admin" &&
      integration.verifiedAt &&
      Number.isFinite(Date.parse(integration.verifiedAt))
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
  verified: VerifiedConnection,
  /**
   * The proof the caller read before it started. The row is written only if
   * that still holds, so an answer about a credential that has since been
   * rotated or revoked cannot overwrite the one that replaced it. A rotation
   * is caught because issuing a credential writes a fresh proof of its own,
   * and a revocation because a revoked row is excluded outright.
   */
  expected: { previousVerifiedAt: string | null }
): Promise<boolean> {
  const pool = getPool();
  if (pool) {
    const updated = await pool.query(
      `UPDATE architecture_review_integrations
         SET verified_github_user_id = $2,
             verified_github_login = $3,
             verified_permission = $4,
             verified_at = $5,
             -- Written with the proof it belongs to, as GitHub reports it now.
             -- Keeping an older id beside a newer proof would describe a
             -- repository nobody has just confirmed anything about.
             verified_repository_id = $7
       WHERE id = $1
         AND revoked_at IS NULL
         AND verified_at IS NOT DISTINCT FROM $6::timestamptz
       RETURNING id`,
      [
        id,
        verified.githubUserId,
        verified.githubLogin,
        verified.permission,
        verified.verifiedAt,
        expected.previousVerifiedAt,
        verified.repositoryId ?? null,
      ]
    );
    return Boolean(updated.rows[0]);
  }
  const stored = memoryIntegrations.get(id);
  if (
    !stored ||
    stored.revokedAt ||
    (stored.verifiedAt ?? null) !== expected.previousVerifiedAt
  ) {
    return false;
  }
  stored.verifiedGithubUserId = verified.githubUserId;
  stored.verifiedGithubLogin = verified.githubLogin;
  stored.verifiedPermission = verified.permission;
  stored.verifiedAt = verified.verifiedAt;
  stored.verifiedRepositoryId = verified.repositoryId ?? null;
  return true;
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

/** Lowers a connection's recorded permission, which issuance never produces. */
export function downgradeVerificationForTests(id: string, permission: string): void {
  const stored = memoryIntegrations.get(id);
  if (stored) stored.verifiedPermission = permission;
}

/**
 * Sets what a connection accepts without going through connecting.
 *
 * Connecting refuses a second identity-token connection for a repository and
 * never leaves one without a repository id. Both states are only reachable by
 * writing them, which is what this is for.
 */
export function forceAuthModeForTests(id: string, authMode: ReviewIntegrationAuthMode): void {
  const stored = memoryIntegrations.get(id);
  if (stored) stored.authMode = authMode;
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
       WHERE token_hash = $1 AND revoked_at IS NULL AND auth_mode = 'token'
       RETURNING *`,
      [tokenHash]
    );
    return result.rows[0]
      ? publicRecord(rowToStoredIntegration(result.rows[0]))
      : null;
  }
  const current = [...memoryIntegrations.values()].find(
    (integration) =>
      integration.tokenHash === tokenHash &&
      !integration.revokedAt &&
      integration.authMode === "token"
  );
  if (!current) return null;
  const updated = { ...current, lastUsedAt: new Date().toISOString() };
  memoryIntegrations.set(updated.id, updated);
  return publicRecord(updated);
}

export function resetMemoryReviewIntegrationsForTests(): void {
  memoryIntegrations.clear();
}
