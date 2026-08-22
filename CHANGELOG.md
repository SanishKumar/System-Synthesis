# Changelog

All notable changes are documented here. The project has not tagged a public release from this workspace; entries remain under Unreleased until a release is intentionally created.

## Unreleased

### Added

- Kubernetes source adapter in `architecture-core` for plain manifests and Kustomize bases: workloads become components, Services and Ingresses decide reach past the cluster boundary, NetworkPolicy coverage is recorded, and dependencies are inferred from literal container environment and argument references. Carries its own extraction contract, `K8S_ADAPTER_VERSION`, and refuses Helm chart templates by name rather than reading them as YAML. Not yet selectable from the CLI, Action, or server
- Five deterministic Kubernetes rules, scoped to Kubernetes graphs so no Compose review changes: published persistence and sensitive workloads, unresolved Service types, sensitive workloads left uncovered where NetworkPolicies are in use, and dependencies without a readiness probe
- Source-derived architecture reviews for a bounded Docker Compose subset, with stable graph identities and source-line provenance
- Semantic pull-request impact for component/dependency, host exposure, trust-boundary, redundancy, and downstream blast-radius changes
- Deterministic change policy with base-branch authority, scoped/expiring suppressions, Markdown/JSON/SARIF output, and merge-gating exit codes
- Standalone architecture CLI plus a tested, bundled Node 24 GitHub Action and dogfood pull-request workflow
- Authenticated browser review import, findings/evidence inspection, suppression, approve/reject decisions, optimistic revisions, and append-only events
- Reproducible base/head example fixtures and ADR-007 for the source-derived product direction
- Light-first, persisted top-navigation UI and read-only viewer/disconnected states
- Owner/editor/viewer board roles, expiring single-use invitations, and audit records
- Granular nested Yjs graph state with user-local undo
- PostgreSQL append-only collaboration updates, snapshots, compaction, Redis Streams/pub/sub distribution, and transport-recovery replay
- Adversarial socket, convergence, storage-failure, transactional-version, export, and graph-analysis tests
- Deterministic graph algorithms, configurable rules, suppression justifications, JSON and SARIF output
- Validated infrastructure IR, stable Docker Compose/Terraform output, provenance, semantic export diff, and golden tests
- Named semantic versions with attribution, graph-aware diffs, duplication, race-safe numbering, and collaboration-safe restore
- Reproducible convergence and live Socket.IO benchmark scripts
- Threat model, failure model, ADRs, benchmark report, and known limitations

### Fixed

- The verification columns now reach an existing database. They were added only inside `CREATE TABLE IF NOT EXISTS`, which leaves an existing table untouched, so an upgraded deployment would have kept the old shape and failed every connection attempt with a database error. Four `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements ship alongside, matching how every other added column in this schema reaches an existing database, and a PostgreSQL test starts from the old table shape rather than a fresh one
- Credentials issued before repository authority was checked are refused at authentication. Guarding only new issuance left every credential handed out during the vulnerable window still able to drive the App into publishing. There is no backfill: nothing stored can establish that such a credential was ever legitimate, so its owner reconnects once and proves admin, and the refusal says so rather than failing opaquely
- Authority is established again when the stored proof is more than an hour old, so a credential no longer outlives the access that justified it. A revalidation that cannot be completed refuses the ingestion and publishes nothing

- Connecting a repository now requires proving authority over it. Any permanent account could name any `owner/name` and be issued an ingestion credential for it with no GitHub check at all; that credential submits reviews, and the server publishes the resulting check through the shared App installation. An account with no standing on a repository could therefore drive the App into placing a gate on somebody else's pull request — the App acting against its own installer. Issuing or rotating a credential now requires a linked GitHub identity with admin permission on that repository, confirmed live through the installation token and matched on GitHub's immutable numeric account id
- Every failure mode refuses and writes nothing: unconfigured App, uninstalled App, missing or mismatched identity, permission below admin, and GitHub unavailable or rate limited. A rate-limited `403` is reported as unavailable rather than as insufficient permission, and no refusal returns a token, writes a row, or repeats any part of GitHub's response
- Connections record the GitHub account id, resolved login, permission and verification time that authorised them, in both PostgreSQL and memory storage

- A stored graph no longer has findings invented from fields it never recorded. Absent Kubernetes coverage was read as `uncovered`, so re-analysing a graph from importer version 1 manufactured a "no ingress NetworkPolicy" finding out of silence. Version 1's `selectedByNetworkPolicy` is not reinterpreted either, in either direction: it counted egress-only policies and misread set-based selectors, so neither value it holds is convertible into coverage
- Importer freshness is measured per adapter. `CURRENT_IMPORT_VERSION` was Compose's number alone, so every current Kubernetes review reported as outdated against a contract it does not use. Each adapter is now compared with its own, and the review carries the adapter identity alongside the versions so `v2` is never shown without saying what it numbers. An unrecognised adapter, a missing version, disagreeing adapters and disagreeing versions all read as outdated
- `ANALYZER_VERSION` is 4. The Kubernetes NetworkPolicy rule changed what it means while keeping its id and severity, which is exactly the change the rule-set fingerprint cannot see and this number exists to record

- The collaborator-permission lookup no longer reports a `403` as the reviewer lacking repository access. A rate-limited response would have told an authorised reviewer something false about their own permissions; a `404`, or a successful response naming a level below write, still reports insufficient access
- Installation-token minting is single-flight per repository. Concurrent callers arriving on a cold cache share one request instead of each minting a token, which the refresh interval never prevented because it only decides whether to discard the cache. Concurrent refreshes after an accepted permission share one request too, and every caller recovers on it
- A token minted during the current attempt is no longer discarded and minted again. It already describes the current grant, so the second request could only be told the same thing

- A forbidden lookup is never read as a missing permission. GitHub answers `403` for primary and secondary rate limits, IP allow lists and organisation policy, and none of those are fixed by editing the App. The installation's own grant — which GitHub states when it mints a token — is the only thing that establishes a missing permission, and it is consulted before any request is made. `X-Accepted-GitHub-Permissions` describes what an endpoint requires rather than what the caller lacks, so it decides nothing; rate-limit evidence is read first, and the header only enriches the detail line
- The HTTP transport preserves a small allow-list of response headers — `x-ratelimit-remaining`, `retry-after` and `x-accepted-github-permissions` — so that classification rests on evidence rather than on a status code alone
- Accepting a new App permission takes effect within about a minute instead of within the hour a token lives. A decision refused for a short grant asks GitHub for a fresh token rather than trusting the cached one, bounded to one extra request per repository per minute so refusals cannot become a token-minting storm

- The GitHub App now asks for `Pull requests: Read` alongside `Checks: Read and write`. Establishing who opened a pull request reads that endpoint, which GitHub documents under the Pull requests permission, but the setup guide named Checks as the only permission and told operators not to grant pull-request access. On a private repository the lookup would fail and every decision would be refused as though GitHub were unreachable
- A missing installation permission is reported as `app_permission_missing` rather than `verification_unavailable`, and says what an administrator has to change. It is established from the permissions GitHub reports when it mints the token, so no request is spent discovering it, and check publishing is unaffected — a Checks-only installation still gates pull requests, it just cannot authorise a browser decision

- Kubernetes NetworkPolicy coverage is evaluated rather than assumed. A policy written with `matchExpressions` produced an empty selector, and an empty selector means "every pod in the namespace", so an unrelated policy silently satisfied the protection finding for a sensitive workload. `policyTypes` was ignored entirely, so an egress-only policy counted as inbound protection. Coverage is now recorded per direction, absent `policyTypes` is inferred the way Kubernetes infers it, and a selector the importer cannot evaluate is `unknown` — never covered. Importer version 2

- `/health` reports the commit the running process was built from, read from `RENDER_GIT_COMMIT` or `GIT_COMMIT`. Whether a deployment is current was previously inferred from uptime, which only ever shows that something restarted and never what it restarted into
- A half-linked identity — a GitHub account id stored without its login — no longer puts the literal string `null` in the permission request path. GitHub answered 404 and the reviewer was told they lacked repository access when what they had was an incomplete link

- Repository permission is now established for the linked GitHub account rather than for a login. The check was made by name while self-approval was refused by numeric id, so a renamed account, a reassigned login, or a stale identity row could point the two halves of the gate at different accounts. The permission response's own account id is compared with the linked id and a mismatch fails closed; the stored login is refreshed only once the id matches
- Decisions record the entitlement they were allowed on. The route calculated it and discarded it, so the history could not say which GitHub account decided, whether permission was verified, or whether the deployment was running unenforced — while the documentation claimed it could. The evidence is written in the same transaction as the decision, in both PostgreSQL and memory storage, and a PostgreSQL contract test asserts no decision can exist without it

- Page views are reported with an absolute URL again. The analytics `beforeSend` hook replaced the event URL with a bare path, which is not the shape the client forwards; the route is still stripped of review identifiers, board identifiers, invitation tokens, and the whole query, but the origin is now preserved
- Corrected the privacy claim in the analytics component and in known limitations: the integration is anonymous and cookieless, but Vercel does derive a day-long visitor hash from the request, and whether consent is required is not a question a source comment can settle

- Corrected two documentation claims the code does not support: the GitHub authorisation state is expiring and account-bound but not single-use, and the development-only esbuild advisory it described no longer exists at the resolved version

### Changed

- Moved component classification and zone assignment into a shared `componentNature` module so every adapter agrees on what a component is and where exposure may not put it; Compose extraction is unchanged and its pinned fingerprint proves it
- Repositioned the product around deterministic architecture change intelligence; the collaborative canvas is now a supporting inspection/modeling surface
- Extracted canonical graph analysis, diffing, validation, source import, and review policy into the reusable `architecture-core` workspace
- Hardened the production server image so the extracted core is built, pruned, and available at runtime
- AI analysis now runs deterministic rules first; an LLM may only explain existing finding IDs
- Protected collaboration no longer accepts legacy/client-supplied identity
- Documentation no longer claims generic production readiness or unmeasured horizontal scalability
