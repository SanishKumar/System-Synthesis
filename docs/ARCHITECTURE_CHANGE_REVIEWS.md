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

It does not resolve Compose interpolation, `extends`, `include`, profiles, generated overrides, or runtime service discovery. See [known limitations](./KNOWN_LIMITATIONS.md).

### Inferred environment dependencies

Most projects wire services together through environment values rather than `depends_on`, so a value naming another service becomes an edge labelled `environment` with `inferred` confidence, separate from the `explicit` confidence carried by `depends_on`.

The match is deliberately narrow. A value contributes an edge only when the whole value, the host of a URL, or the host of a `host:port` pair is **exactly** a service name in the same file. `databases`, `my-database`, and `db.example.com` do not match a service called `database`, and a service does not depend on itself. One edge is recorded per referenced service however many variables name it, and an explicit `depends_on` always wins — an inferred edge never duplicates or downgrades it.

Environment values are read to resolve these references and are never stored. A Compose environment block routinely holds credentials, so the graph keeps only key names, and provenance points at the key that produced the edge, such as `services.api.environment.DATABASE_URL`.

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

## Resolving compose-path

The Action reads the configured `compose-path` at both the base and head commit and treats the two absences differently.

- **Present at both.** Normal comparison.
- **Absent on one side.** A real architecture change: the pull request adds or deletes the file, and the missing side is an empty architecture.
- **Absent on both sides.** A configuration error, not a review. The Action exits 2 and names any root-level Compose file it can see, so `compose.yaml` configured against a repository that uses `docker-compose.yml` reports the correction instead of silently comparing two empty documents, finding no components, and passing.

That last case matters because `compose-path` defaults to `compose.yaml`. Without the check a misconfigured workflow reports a healthy architecture review forever while reviewing nothing at all, which is indistinguishable from real coverage.

Only root-level Compose filenames are suggested. A file kept in a subdirectory still works when configured explicitly; it is simply not guessed.

## Pull-request comment

The deterministic report is thorough, which is why it buries the one thing a reviewer must act on. The Action therefore emits a ready-to-post comment through the `comment-file` output rather than leaving consumers to assemble one.

It leads with the verdict, names the finding that produced it, and offers the decision link, then reproduces the full report unchanged beneath a rule. The stable marker comes first so repeated runs update a single comment instead of appending. When ingestion is not configured no link is invented; the comment points at the policy file instead.

The job summary is written on a best-effort basis. GitHub caps summaries at 1 MB and omits the backing file in some environments, so a summary failure is downgraded to a warning: it must not abort the run, discard the verdict, or suppress the comment.

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

## Import provenance

A graph records the extraction contract that produced it as `source.adapterVersion`. `COMPOSE_ADAPTER_VERSION` is bumped whenever the same Compose source would now yield a different graph: new or removed entities, changed identities, changed classification, or a new relationship source. Version 1 modelled only explicit `depends_on`; version 2 added inferred environment dependencies. A pinned extraction fingerprint fails whenever output changes, so the number cannot drift silently.

This is a different question from analyzer identity, and the two are reported separately:

- Analyzer identity answers *would the current rules still reach this verdict from this graph*. Re-analysis fixes it.
- Import version answers *would the current importer still produce this graph from that source*. Re-analysis cannot fix it, because it reuses the stored graphs rather than re-reading the source. Only a new pull-request delivery or a fresh import rebuilds them.

Review responses carry `importVersion`, `currentImportVersion`, and `importOutdated`, derived per request. Both graphs must report the same version and match the running deployment; a disagreement between base and head, or a graph written before extraction was versioned, reads as outdated rather than current. An outdated import shows its own notice naming the remedy that actually applies.

The version is excluded from the content fingerprint, so restamping never changes graph identity or ingestion idempotence.

For ingested reviews the value is the producer's own report: the Action performed the extraction with its bundled importer, and the server never sees the source, so it records what was reported rather than restamping. A repository pinned to an older Action therefore surfaces as an outdated import, which is the accurate signal.

## Analyzer provenance

A stored review freezes a verdict, so every persisted review records the analyzer that produced it as `v<version>+<rule-set-fingerprint>`.

The fingerprint is derived from rule identities and default severities, so adding, removing, renaming, or re-grading a rule changes it automatically. Rule titles, rationale, and references are excluded: rewording a message must not invalidate stored reviews. `ANALYZER_VERSION` is the manual part and covers what a fingerprint cannot see — an existing rule whose findings change while its id and severity stay the same. A pinned rule-set test fails whenever the rule set changes, so the identity is always a deliberate decision.

Review responses carry `analyzerVersion`, `currentAnalyzerVersion`, and `analyzerOutdated`. Staleness is derived per request, never stored, because "current" is a property of the running deployment. Rows written before this column report `null` and are treated as outdated rather than assumed current.

An outdated review shows a banner instead of silently presenting a verdict the current rules would not produce, and offers re-analysis in place.

`POST /api/reviews/:id/recompute` takes the expected revision and re-runs the analysis against the stored canonical graphs and policy. Submitted source is never retained and is not needed. The stored import diagnostics are carried through so re-analysis does not lose evidence it cannot re-derive.

Recomputation is deliberately conservative about decisions:

- An unchanged verdict re-stamps the analyzer only. The revision does not advance and an existing approval survives, because a rule change that does not affect this review must not silently revoke it.
- A changed verdict advances the revision and returns the decision to pending, like any other analysis update.
- Either way an audit event records the previous and current analyzer, status, and blocking-finding count.

The report carries the review time and both validation timestamps from the wall clock. Those are normalized before comparison; otherwise every recomputation looks like a changed verdict and revokes decisions.

Recomputation is never automatic. A pull-request review also refreshes when the workflow runs again, and accepting an exception re-analyzes and re-stamps because that path already recomputes the report. There is no bulk re-analysis across reviews.

## Repository ingestion foundation

The server and browser expose the secure persistence boundary used by Action synchronization:

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

A synchronized review is re-read when the tab regains attention, and polled while a decision is still outstanding, because the Action rewrites it on every new commit and an open tab must never present a verdict the pull request has moved past. A background tab is left alone, a failed background read stays silent, and a mutation in flight always wins so a refresh cannot overwrite what the reviewer just did. Manually imported reviews change only when their owner changes them, so they are not polled.

A synchronized review carries its origin in the browser. The review list marks the repository and pull-request number, the detail header repeats them, and a pull-request source panel links back to the pull request and the workflow run, showing base commit, head commit, last synchronization, and the accepted delivery version. Both outbound links are re-checked against the GitHub origin at render time. The audit trail distinguishes `Imported from pull request` from `Refreshed from new commit <sha>`, so a reviewer can see which commit reset the decision. Manually imported reviews are unaffected and still read `Local repository`.

Permanent-account users can manage these credentials at `/integrations`. The page creates or rotates a repository-scoped token, reveals it only in the immediate response, copies the ingestion endpoint and pinned-Action workflow inputs, lists non-secret metadata, and revokes or reconnects a repository. Guest sessions are rejected because a temporary identity must not own a long-lived repository secret. Dismissing the one-time panel removes the plaintext token from browser state; returning to the page cannot recover it, so a lost token must be rotated.
