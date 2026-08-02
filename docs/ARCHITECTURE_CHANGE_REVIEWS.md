# Architecture change reviews

System Synthesis compares infrastructure source as canonical architecture graphs. The first supported adapter is deliberately narrow: one Docker Compose document.

## Review contract

Given a base file, a head file, and policy:

1. Parse both sources with bounded YAML aliases, unique-key checks, a 1 MB core limit, and a 500-service limit.
2. Assign stable node and edge IDs from source addresses such as `services.checkout`.
3. Remove volatile revision and source-line metadata from semantic equality.
4. Calculate resource, dependency, exposure, trust-boundary, redundancy, and blast-radius impact.
5. Run deterministic graph rules on both versions.
6. Gate newly introduced findings by default. Existing debt remains visible but does not become a new failure.
7. Emit the same review as JSON, Markdown, and SARIF 2.1.0.

Malformed source exits with code 2. A valid review with blocking findings exits 1. A passing review exits 0.

## Supported Docker Compose subset

The adapter currently models:

- `services`
- `image` and simple/object `build` context
- short and long `ports`
- `expose`
- short and object `depends_on`
- service networks, volumes, secrets, and environment variable names
- healthcheck presence
- deploy replica count

It derives common service categories from well-known service/image names, including databases, caches, brokers, search engines, proxies, monitoring, storage, vault, and auth.

It does not resolve Compose interpolation, `extends`, `include`, profiles, generated overrides, runtime service discovery, or dependencies implied only by environment values. Only explicit `depends_on` relationships become edges. See [known limitations](./KNOWN_LIMITATIONS.md).

## Policy

Policy is JSON:

```json
{
  "failOn": ["critical"],
  "includeExistingFindings": false,
  "rules": {
    "compose-public-service-to-persistence": {
      "severity": "warning",
      "blockMerge": true
    }
  },
  "suppressions": []
}
```

Each rule can be enabled/disabled, receive a severity override, and independently block merge. Suppressions require a non-empty justification and can be scoped to a finding, node, edge, or source address. They can also carry an actor, ADR/ticket, creation time, and expiry.

Expired, malformed, or blank-justification suppressions do not apply.

The GitHub Action reads policy from the base commit. A pull request therefore cannot change the policy that evaluates that same pull request. A merged policy change governs later reviews.

## GitHub outputs

The bundled Node 24 action writes:

- `architecture-review.json`
- `architecture-review.md`
- `architecture-review.sarif`

The repository workflow uploads SARIF with `github/codeql-action/upload-sarif@v4`, updates one marker-based PR comment, appends the Markdown report to the job summary, preserves all reports as a short-lived artifact, and enforces the action exit code last.

GitHub code scanning is available for public repositories and for eligible organization-owned repositories with GitHub Code Security enabled. See GitHub's [official SARIF upload documentation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file).

## Browser review lifecycle

Authenticated users can import base/head Compose content at `/reviews`. The server stores canonical graphs, policy, report, decision state, and an append-only event trail; raw source content is not retained.

Mutations require the current review revision:

- create review → revision 1
- add justified suppression → revision 2 and decision returns to pending
- approve or reject → revision 3

A stale mutation receives HTTP 409. Approval receives HTTP 422 while blocking findings remain. Rejection requires a note.

## Repository ingestion foundation

The server now has the secure persistence boundary needed for future Action synchronization:

- `POST /api/review-integrations` creates or rotates a GitHub repository-scoped ingestion token for the authenticated user.
- `GET /api/review-integrations` lists token metadata without revealing token values.
- `DELETE /api/review-integrations/:id` revokes a token.
- `POST /api/review-ingestions/github` accepts bounded canonical Docker Compose graphs from that repository credential.

Ingestion tokens are shown once and stored only as SHA-256 digests. The submitted repository must match the credential. The server validates graph shape, provenance, IDs, edge endpoints, URLs, revisions, policy, and payload size, then recomputes the deterministic report instead of trusting a caller-supplied result. Raw Compose documents are not uploaded or retained.

There is exactly one persisted review per owner, provider, repository, and pull-request number. Duplicate deliveries are idempotent. A provider-supplied monotonic change version prevents a delayed older workflow from replacing a newer head. A same-version delivery with different content is rejected as a conflict. PostgreSQL advisory locking and a partial unique index protect concurrent deliveries.

The bundled Action can now call this endpoint when both optional inputs are configured:

```yaml
with:
  ingestion-url: ${{ vars.SYSTEM_SYNTHESIS_INGESTION_URL }}
  ingestion-token: ${{ secrets.SYSTEM_SYNTHESIS_INGESTION_TOKEN }}
```

`SYSTEM_SYNTHESIS_INGESTION_URL` must be the complete HTTPS URL ending in `/api/review-ingestions/github`. The token comes from `POST /api/review-integrations` and must be stored as a GitHub Actions secret. A successful upload exposes `ingestion-status`, `review-id`, and `review-url` Action outputs; the repository workflow includes the interactive review link in its marker-based PR comment.

The Action derives repository, pull-request, base/head SHA, update timestamp, and workflow-run identity from the GitHub event and rejects mismatches with the analyzed graphs. It retries only transient HTTP/network failures, reusing the identical idempotent payload. Authentication, configuration, validation, and conflict failures do not retry and produce exit code 2 so persistence failures cannot be mistaken for a successful review.

Never pass the ingestion secret to `uses: ./` from a pull-request checkout. A pull request can modify that Action code. The repository workflow checks out the trusted Action implementation from the base commit into a separate path before supplying the secret. External consumers should pin the Action to a reviewed full commit SHA. Fork PRs receive neither ingestion input and continue with local deterministic analysis only.

The browser still does not provide integration setup controls; token creation/rotation/revocation is API-only in this increment.
