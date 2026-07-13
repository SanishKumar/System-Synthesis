# Threat model

## Scope

This model covers the browser client, Express REST API, Socket.IO collaboration path, PostgreSQL persistence, Redis transport, invitations, export, and optional LLM explanation. Deployment-layer TLS termination, cloud IAM, host hardening, backups, and denial-of-service protection outside the process remain operator responsibilities.

## Assets

- Private board metadata and graph contents
- Board membership and owner/editor/viewer roles
- Durable Yjs updates and document snapshots
- Semantic versions and audit records
- Invitation capabilities
- Exported infrastructure files
- JWT signing secret and optional LLM credentials

## Trust boundaries

1. Browser to REST/Socket.IO server: all inputs are hostile until authenticated, authorized, size-limited, and schema-validated.
2. Server to PostgreSQL: PostgreSQL is the durable authority when configured.
3. Server to Redis: Redis distributes accepted updates; it is not allowed to override authorization.
4. Rule engine to LLM provider: deterministic findings are authoritative; LLM text is explanatory and untrusted.
5. Generated export to operator: generated files require review and secret injection before use.

## Threats and controls

| Threat | Control |
| --- | --- |
| Client spoofs another user or owner ID | REST and socket identity is derived only from a verified JWT. Client `identityId` values are ignored. |
| Viewer manually sends a mutation | Every mutation re-resolves the current board role and requires editor or owner. |
| User targets a board they did not join | Socket state, joined room, payload board ID, and fresh board role must all agree. |
| Role is revoked after join | Role is re-resolved for each mutation; unauthorized sockets are ejected when access is removed. |
| Invitation is guessed, logged, reused, or used after expiry | Tokens are cryptographically random, stored as hashes, expire, and are single-use. Tokens are accepted in a REST path only for the redemption request. |
| Malformed or oversized Yjs payload exhausts resources | Zod validates event structure; update payload is capped at 128 KiB and Socket.IO at 256 KiB. Candidate application must succeed before durable acceptance. |
| Event flood | General REST, board creation, AI, export, cursor, and socket mutation limits are independently enforced. |
| Cross-origin browser uses authenticated API | CORS uses an explicit frontend-origin allowlist. |
| Duplicate delivery corrupts state | Updates are hash-deduplicated in PostgreSQL and Yjs application is idempotent. |
| LLM invents a validation issue | The deterministic rule engine creates the finding set. LLM output can only explain finding IDs already supplied by the server. |
| Export embeds credentials | Exporters emit secret placeholders/sensitive variables and never synthesize default production secrets. |
| Sensitive action is repudiated | Board joins, denied mutations, permission changes, invitations, export, versions, AI explanation, and deletion create attributable audit records. |

## Authentication assumptions

- Production must configure a high-entropy `JWT_SECRET`; startup fails in production when the development secret would be used.
- JWT verification fixes HS256, issuer `system-synthesis`, and audience `system-synthesis-client`.
- Tokens currently last seven days by default. Revocation before expiry is not implemented; role checks still prevent a revoked member from mutating a board.
- Guest JWT issuance provides a verified server token but not proof of a real-world identity. Deployments that need accountable human identity should replace guest issuance with an external identity provider.

## Authorization matrix

| Action | Viewer | Editor | Owner |
| --- | :---: | :---: | :---: |
| View board, validation, history, duplicate version | Yes | Yes | Yes |
| Mutate graph, create/rename checkpoint | No | Yes | Yes |
| Change metadata/visibility/members, create invites, inspect audit, restore/delete | No | No | Yes |

## Residual risks

- A stolen JWT remains usable until expiry; there is no token denylist.
- Application-level rate limits do not replace a reverse proxy, WAF, connection quotas, or network-layer protection.
- Optional LLM prompts contain deterministic finding text and modeled component metadata; operators must evaluate provider data-handling requirements.
- Audit records are stored in the same database as application state and are not an immutable external security log.
- Exported infrastructure is deterministic for a supported subset, not security-certified deployment code.

## Security regression commands

```bash
npm test --workspace server
npm run build --workspace server
node test_phases.mjs
```

The integration command requires the built server to be running on `http://localhost:4000`.
