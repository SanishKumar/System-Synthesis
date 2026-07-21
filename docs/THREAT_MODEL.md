# Threat model

## Scope

This model covers the browser client, Express REST API, Socket.IO collaboration path, PostgreSQL persistence, Redis transport, invitations, source-derived architecture reviews, the GitHub Action, export, and optional LLM explanation. Deployment-layer TLS termination, cloud IAM, host hardening, backups, repository permissions, and denial-of-service protection outside the process remain operator responsibilities.

## Assets

- Private board metadata and graph contents
- Board membership and owner/editor/viewer roles
- Durable Yjs updates and document snapshots
- Semantic versions and audit records
- Canonical review graphs, deterministic findings, suppression justifications, decisions, and review events
- Base-branch policy and pull-request check integrity
- Invitation capabilities
- Exported infrastructure files
- JWT signing secret and optional LLM credentials

## Trust boundaries

1. Browser to REST/Socket.IO server: all inputs are hostile until authenticated, authorized, size-limited, and schema-validated.
2. Server to PostgreSQL: PostgreSQL is the durable authority when configured.
3. Server to Redis: Redis distributes accepted updates; it is not allowed to override authorization.
4. Rule engine to LLM provider: deterministic findings are authoritative; LLM text is explanatory and untrusted.
5. Generated export to operator: generated files require review and secret injection before use.
6. Repository source to architecture adapter: Compose and policy files are hostile, bounded inputs; they do not execute.
7. GitHub Action to pull request: the action reports deterministic artifacts, while repository permissions and branch protection decide who can publish or bypass checks.

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
| Malicious Compose input causes resource exhaustion or code execution | Import is data-only, rejects duplicate keys and excessive aliases, and caps source bytes and service count. No Compose interpolation, command, image, or extension is executed. |
| Pull request weakens its own policy | The GitHub Action reads policy from the base revision. A policy change governs later pull requests only after merge. |
| Pull request replaces the checker implementation | This repository dogfoods a local action, which is reviewable but mutable in the same pull request. External consumers must pin a released commit or immutable tag; branch protection and CODEOWNERS remain operator controls. |
| User suppresses a different or obsolete finding | The API accepts suppression only for an active finding, requires justification, records actor/time/ticket/expiry, and recomputes the report. Expired suppressions do not apply. |
| Stale browser overwrites a newer review decision | Every review mutation requires the current revision and uses an optimistic transactional update. Stale writes return HTTP 409. |
| User approves a failing review | Approval is rejected while any unsuppressed blocking finding remains. Rejection requires a note. |
| User reads or changes another user's review | Every list, detail, event, suppression, and decision query is scoped to the JWT-derived owner ID. |
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
- Browser review ownership is per user rather than organization/role based.
- The GitHub workflow can upload SARIF and comment only with the repository permissions granted to it; branch protection and required-check configuration are outside the application.
- Canonical review graphs are durable, but submitted raw Compose source is not retained for independent re-parsing.
- Exported infrastructure is deterministic for a supported subset, not security-certified deployment code.

## Security regression commands

```bash
npm test --workspace server
npm run build --workspace server
node test_phases.mjs
```

The integration command requires the built server to be running on `http://localhost:4000`.
