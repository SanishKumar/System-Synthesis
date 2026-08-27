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

### Published port bindings

Each published port is parsed once into a structured binding carrying the target port, the host port where one is given, the host address where one is given, and the protocol. Ports and addresses stay strings so a range such as `8000-8010` survives without being coerced to a number.

Both `publishedPorts` and `publishedPortBindings` are rendered from that single parse, and a test asserts they cannot drift. The structured field is additive: an Action pinned to an importer that predates it keeps sending only the strings, and the ingestion boundary keeps accepting that. Its absence therefore means the producer could not report a host address — never that the ports bind to loopback.

The host address was previously lost. The long syntax discarded `host_ip` entirely, so `127.0.0.1:5432:5432` and its long-form equivalent extracted differently and rewriting one as the other registered as an architecture change. They now agree, as do `5432:5432` and `5432:5432/tcp`, since `tcp` is the default.

How a binding was written is deliberately not recorded. `sourceProperties` is inside the content fingerprint, so keeping the syntax would make reformatting Compose report a change.

An absent host port means Docker allocates one, which is still host publication and must not be read as an internal-only port. `expose` remains separate and never denotes host publication.

An entry the adapter cannot fully model is kept rather than dropped. Losing a declared published port is a false negative in a security review, so what cannot be parsed into an address and ports is still recorded.

Each binding classifies into how far the port reaches:

| Host address | Reach |
| --- | --- |
| Absent, `0.0.0.0`, `::` | External — every interface |
| `127.0.0.0/8`, `::1`, `localhost` | Loopback — the machine only |
| Any other resolvable address | Host — that network |
| Unexpanded variable, or unrecognized | Unknown |

Unknown is never folded into loopback. An unexpanded variable could hold `0.0.0.0`, so a port whose reach cannot be established is treated as reachable rather than reported as contained.

Zone assignment follows that classification: a service is in the perimeter when any port reaches beyond the machine, rather than merely because a port exists. A loopback-only service is `private`, which is what stops a local binding from being read as public and producing a spurious trust-boundary crossing.

Exposure findings read that classification:

| Reach | Database, storage, warehouse | Cache, broker, search |
| --- | --- | --- |
| External | `compose-published-persistence-port`, critical | `compose-published-sensitive-service-port`, critical |
| Host or unknown | `compose-restricted-sensitive-service-port`, warning | `compose-restricted-sensitive-service-port`, warning |
| Loopback | None | None |

The rules are deliberately disjoint by service type, so one exposure produces one finding rather than two. The warning tier is a separate rule rather than a severity inside an existing one, because a rule carries a single configured severity and cannot report an external binding as critical while reporting a specific-address binding as a warning.

A service counts as public for `compose-public-service-to-persistence` when any of its ports reaches beyond the machine, so a loopback-bound frontend no longer registers as a public service.

Impacts follow the same classification, since a report that raises no exposure finding while describing the change as a public exposure contradicts itself. An external binding is `public-exposure-added`, a specific address `restricted-exposure-added`, an unresolved one `unresolved-exposure-added`, and loopback `loopback-binding-added` at informational severity. Removals mirror them, classified from the node as it was, so removing a loopback binding is not reported as reduced public exposure. Narrowing an external binding to loopback therefore reports both a public removal and a loopback addition, which is what actually happened. Impact wording is invisible to the rule-set fingerprint, which is why the analyzer version is bumped by hand.

A graph from an importer that predates structured bindings is read through its port strings. Those retain the host address for every short-syntax entry, so a loopback or specific address is recovered and classified normally, which keeps the rules working for a repository still pinned to an older Action instead of silently reporting nothing.

A legacy string carrying no address is treated as unresolved rather than external. It is either a short entry genuinely bound to every interface or a long entry whose `host_ip` that importer discarded, and the stored evidence cannot distinguish them. Reporting a critical exposure on every interface would assert a certainty the graph does not carry, so it produces the warning instead — still reachable, still gated for the direct-dependency rule, but not a claim about interfaces nobody recorded. A structured binding with no address is unambiguous, because the importer that wrote it would have kept one, and remains critical.

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

### Who may decide

Proposing a change and certifying it are different acts, so by default the author of a pull request cannot decide its review however much permission they hold. Two exceptions exist, named in the same base-commit policy:

```json
{ "decision": { "selfApproval": "forbidden" } }
```

| Value | Meaning |
| --- | --- |
| `forbidden` | The default. The author is always refused |
| `sole_reviewer` | The author may decide only while GitHub confirms no other account holds write access |
| `admin_override` | An administrator may decide their own change even where other reviewers exist |

`sole_reviewer` exists because refusing is not always protecting anything: a repository with one contributor has no separation of duties to preserve, and a gate nobody can pass is a wall. It is not a stored property of the repository — the count is re-established against GitHub on every decision, so it stops applying the moment a second person is given access, and a listing that cannot be read refuses rather than assuming solitude.

`admin_override` does weaken the gate, which is why it must be asked for, is checked against live administrator permission, and is recorded distinctly.

Neither exception bypasses anything else. The author still has to hold write access, still has to be the account their linked login resolves to, and is refused for either failure exactly as any other reviewer would be.

The decision is recorded with the basis it was granted on — `verified`, `self_sole_reviewer`, or `self_admin_override` — alongside `selfApproved` and, where it was established, how many accounts could have decided instead. A self-approval is therefore never indistinguishable from a peer review after the fact.

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

## Reachability and authority

Two different questions decide what a request may do with a stored review, and they are answered in two different places.

*Reachability* is which reviews a caller can address at all. `architecture_reviews.owner_id` records who stored a review; a review access scope records who may reach one. Today the only scope reaches the reviews an account stored itself, so the two coincide and every query still filters on `owner_id`. They are kept apart because they are not the same question: once reachability widens to the collaborators on a repository, a query written against storage attribution grants or refuses the wrong thing while continuing to look correct.

Every list, detail, event, suppression, recompute, and decision path derives its filter from one predicate rather than restating it, and that predicate binds exactly one parameter so a widened condition cannot silently renumber the placeholders around it. The in-memory store answers through the same scope, because a deployment that changes storage backend must not change who can see what.

*Authority* is whether a review that can be reached may be decided. It stays a separate check made against GitHub at the moment it matters. Being able to address a review is deliberately not permission to decide it.

Event actors are recorded independently of both. The account that acted is passed separately from the scope that let it reach the row, so an audit trail cannot credit the storing account for what somebody else did.

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

## GitHub App credentials

Registration, installation, key handling, and the pull-request verification
sequence are in [GitHub App setup](./GITHUB_APP_SETUP.md). This section covers
what the server does with the credentials.

Writing back to a pull request needs write access to the repository, which a repository-scoped ingestion token deliberately does not carry. That access comes from a GitHub App rather than a personal access token, because an App is installed per repository by its owner, grants only the permissions it declares, and issues tokens that expire in an hour.

Two environment variables configure it, and their absence is a supported state rather than a failure:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` — the PEM; escaped newlines are restored, since an environment variable usually flattens them and would otherwise break signing silently

Nothing long-lived is held. The private key signs a short RS256 assertion, backdated a minute against clock skew and valid for well under the ten minutes GitHub allows. That assertion is only ever used to resolve a repository to its installation and to mint an installation token; it never reaches repository content itself. Installation tokens are cached per repository and re-minted a minute before expiry, so a token is never presented at the edge of its lifetime.

A repository whose owner has not installed the App is reported as not installed, distinct from an error, because it is a setup state a user can resolve. Failures never echo the request that carried the signed assertion.

### The decision check

The App publishes an `Architecture Decision` check run on the pull request's head commit, deliberately separate from the Action's own check. The Action answers *what deterministic analysis found*, which is fixed for a head commit, a policy and an analyzer version. This answers *whether a person has accepted the change*, which is not fixed and belongs to a reviewer. Merging them would make a verdict look revisable and a decision look computed.

| Review state | Conclusion |
| --- | --- |
| Blocking findings, nobody has ruled | `action_required` |
| No blocking findings | `success` — no reviewer is owed |
| Approved | `success` |
| Rejected | `failure` |

`action_required` is used rather than a plain failure because the resolution is a person opening the review, not a code change. The check's details link points at that review, which is the affordance a reviewer actually clicks.

It is written when a review is ingested, when a decision changes, and when re-analysis changes the verdict — so the gate appears with the review rather than only once somebody decides. A stale delivery is ignored, so a late workflow cannot reopen a settled gate. An existing check on the same commit is updated rather than duplicated, because a reviewer who changes their mind should replace the gate rather than add a second one.

Publishing is best effort. The decision is durable and audited before the check is attempted, so an unreachable or uninstalled App is logged and never turns a recorded decision into a failed request. Manual reviews and any head revision that is not a commit SHA are skipped, since only a commit can carry a check run.

Making this the merge gate is a repository setting: mark `Architecture Decision` as a required status check in branch protection.

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
