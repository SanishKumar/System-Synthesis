# Verified guarantees

Every statement here is limited to behaviour checked by a test in this repository. Each one names the test that holds it, so a claim that stops being true fails a build rather than quietly surviving in prose.

Run them with `npm run verify`. The PostgreSQL contract is skipped locally and executed in CI, which fails if those tests skip rather than run.

| Guarantee | Evidence |
| --- | --- |
| Source order, revision labels, and line movement do not create a semantic diff | Canonical fingerprint and formatting-only review tests |
| Entity IDs remain stable across revisions | Stable source identity tests |
| Malformed YAML, duplicate keys, excessive aliases, size limits, and service-count limits fail explicitly | Docker Compose adapter tests |
| A newly published persistence port blocks by critical severity | Change-review policy tests |
| A new public-service-to-persistence dependency blocks by rule policy | Core, CLI, and GitHub Action tests |
| Existing findings do not become new PR failures by default | Base/head finding-set comparison tests |
| Blank or expired suppressions do not apply | Suppression tests |
| CLI output and exit contracts are stable across JSON, Markdown, and SARIF | CLI tests and compiled-binary execution |
| SARIF contains repository-relative file/line evidence | Core/CLI tests |
| Browser approval is impossible while blocking findings remain | API end-to-end verification |
| Stale review decisions cannot overwrite a newer revision | Repository tests and API HTTP 409 verification |
| Review creation, suppression, and decision are auditable | Transactional repository tests and API event-sequence verification |
| Protected boards can only be mutated by owner/editor | Adversarial socket tests and authenticated integration |
| Granular Yjs graph operations converge in the tested model | Seeded randomized convergence harness |
| A verdict produced by an earlier rule set is reported as outdated, never as current | Pinned rule-set and analyzer-provenance tests |
| A port reachable only from the machine raises no exposure finding, and one exposure raises exactly one finding | Exposure rule matrix across reach and service type |
| Re-analysis that reproduces the same verdict does not revoke an existing decision | Recompute repository tests |
| An inferred environment dependency requires an exact service-name match and never overrides a declared one | Compose environment-reference tests |
| Environment values are never carried into the stored graph | Compose environment-reference tests |
| A change in extraction output cannot land without a deliberate import-version decision, for every path the fixture walks | Pinned extraction-fingerprint test, covering a datastore published both to loopback and beyond it |
| Exposing a component never removes a finding: what a component is decides where it sits, and publishing it is reported rather than reclassifying it | Zone tests across a private and a published datastore, and a review asserting nothing is resolved |
| Import staleness is reported independently of analyzer staleness | Import-provenance repository tests |
| A configured but unusable database stops a production boot instead of silently serving memory storage | Persistence startup tests and an unreachable-database boot |
| Database and Redis connections verify the server's certificate rather than encrypting to whoever answers, and transport security follows the host rather than the URL scheme | Shared transport-decision tests across both services, plus each database mode exercised against a real instance |
| Plaintext to a host other than this machine is refused in production unless it is accepted explicitly | Refusal tests for both services, and a startup that records it as a persistence failure |
| The TLS policy this service computes is the one the database driver connects with, not one the connection string can replace | Driver-resolution tests that read back what a real client resolved |
| A configured Redis that never connected, or that stops answering later, is reported rather than silently replaced by memory, and reported again when it returns | Lifetime state tests across drop and recovery, and a health endpoint that returns 503 in production |
| An explicit TLS instruction in a connection string is honoured or refused, never quietly dropped, and a value nobody can interpret is refused rather than guessed at | Driver-resolution tests for `ssl`, `sslmode`, `sslrootcert`, and client-certificate parameters, plus rejection of unknown and contradictory values |
| Reported Redis health, the client the process holds, and the fan-out built from it cannot disagree | Ownership tests across a failed start, a drop, and a recovery |
| A reviewer can prove which GitHub account they are, and an authorization cannot be redirected onto another account | Signed, expiring, account-bound state, with route tests for forgery, tampering, expiry, and a second claim on one identity. The state itself is stateless and stays valid for its ten minutes; what is single-use is GitHub's authorization code |
| Where the deployment can check it, deciding a pull-request review requires write access to that repository and refuses the change's own author by default; an explicit base-branch exception is checked live and recorded distinctly. Where the deployment cannot check, the decision is recorded as unverified rather than refused | Policy-parser and entitlement tests across permission levels, self-approval modes, collaborator pagination, an unreachable GitHub, an unconfigured server, and an App installation missing `Pull requests: Read`, plus route tests that nothing is written on refusal |
| A compose-path matching no file at either commit fails instead of passing an empty review | Compose source-resolution tests and a real two-commit repository run |
| GitHub App access is short-lived, repository-scoped, and never served near expiry | GitHub App credential tests |
| A browser decision publishes a merge gate on the pull request, and replaces it rather than duplicating it | Decision check tests |
| A GitHub outage cannot fail a decision that is already recorded | Best-effort publishing with skip/error outcomes |
| An unreachable GitHub is reported as an unpublished gate to retry, never as a review with nothing to publish | Credential-failure sync tests and a rendered outage |
| Every path that changes a decision records what publishing it achieved, and answers with that rather than with the state from before | Route tests for ingestion, decision, re-analysis and retry |
| An attempt made for a superseded revision cannot overwrite the state of a newer one, whether it published or not | Compare-and-set tests for both outcomes and skips |
| A slower failing attempt cannot undo a success for the same revision, and a review predating synchronization tracking still records its first attempt | Monotonic-success and generation-adoption tests, on memory and PostgreSQL |
| Overlapping attempts for one commit create a single check run, and no publication fault escapes unrecorded | Concurrent-write test and stable failure codes for every fault path |
Current automated count: 179 architecture-core tests, 17 CLI tests, 25 Action tests, 13 frontend tests, and 345 backend tests (579 total). A further 19 backend tests run the synchronization, decision-audit, connection-authority and schema-upgrade contracts against a real PostgreSQL; CI provides one and fails if they skip, and locally they are skipped unless `TEST_DATABASE_URL` points at a scratch database. The Next.js production build type-checks and prerenders the review list, review detail, and repository-connections routes.
