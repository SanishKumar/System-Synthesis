# Repository-global identity

**Status: proposed, not implemented.** Nothing in this document has been built. It exists to be
argued with before any schema, route, or access behaviour changes.

Reviews are owner-scoped today. Before widening who may read or decide one, a repository and a
pull request need a single identity that does not depend on which account connected them.
Otherwise the first collaborator to be given access is shown a set of duplicate reviews with no
canonical member, which is worse than showing them nothing.

## The failure, reproduced

Two accounts — both verified admins of `acme/shop` — each connect the repository, and each one's
Action delivers the same pull request at the same head commit.

```
reviews: ac9748b8-c2bc-4067-a876-092dbcef3b6a | c79f83d9-c3b3-4e4e-acfb-24aaa8610a0c

check runs on bbbbbbb: [
  {
    "id": 100,
    "name": "Architecture Decision",
    "external_id": "ac9748b8-c2bc-4067-a876-092dbcef3b6a",
    "conclusion": "action_required"
  },
  {
    "id": 101,
    "name": "Architecture Decision",
    "external_id": "c79f83d9-c3b3-4e4e-acfb-24aaa8610a0c",
    "conclusion": "action_required"
  }
]

conclusions: Architecture Decision=success  |  Architecture Decision=failure
```

One commit, one required-check name, two runs, opposite conclusions. Which conclusion a branch
protection rule honours is not something this project controls or can reason about.

This is not a race and not an edge case. It is the deterministic result of the current identity
model, and it reproduces on every run.

Reproducing it required a fake GitHub that remembers the check runs it was given. The transport
in the existing suite answers every `GET` with an empty list, so no current test can reach the
"a run already exists" branch at all. That is why a green pipeline has never mentioned this.

The reproduction is recorded here as evidence and is deliberately **not** committed as a test. A
passing test that asserts today's duplicate behaviour would encode the defect as intended. The
rows in the [adversarial test matrix](#adversarial-test-matrix) become real tests as each phase
lands, asserting the behaviour we want rather than the behaviour we have.

## Why it happens

Four decisions, each defensible alone, compose into the duplicate.

1. **Repository identity is owner-relative.** `architecture_review_integrations` is
   `UNIQUE(owner_id, provider, repository)`. Two admins are two rows, and both are valid.

2. **Review identity is owner-relative.** `idx_architecture_reviews_external_change` keys on
   `owner_id` alongside provider, repository and change number. One pull request, two owners,
   two reviews.

3. **The check name is global; the check identity is not.** `DECISION_CHECK_NAME` is the
   constant `"Architecture Decision"`, but `external_id` is the review's UUID. Same name on the
   commit, different identity underneath it.

4. **The guard against foreign runs guarantees the duplicate.** Publication filters existing runs
   to `external_id === review.id` so it never overwrites a check published by some other
   application. When the "other application" is a second admin of *this* product, that filter is
   exactly what makes it create a second run instead of updating the first.

The advisory lock keyed on `repository@headRevision` is not at fault and does not help. It stops
two concurrent attempts for *one* review from both creating a run. It cannot merge two distinct
review identities, because from its point of view nothing is wrong.

## Current keys

| Table | Key today | Consequence |
| --- | --- | --- |
| `architecture_review_integrations` | `UNIQUE(owner_id, provider, repository)` | Every admin gets their own connection to the same repository. Unconditional, so a revoked row still occupies the key; reconnecting sets `revoked_at = NULL` on the existing row rather than inserting. |
| `architecture_reviews` | `UNIQUE(owner_id, integration_provider, external_repository, external_change_number)`, partial on those columns being non-null | One review per owner per pull request, so N admins produce N reviews. |
| Check run | `name` is a constant; `external_id` is `review.id` | Runs are per review, not per pull request. |
| Repository | the string `owner/name` | A rename or transfer silently becomes a different repository. |

## Proposed keys

| Table | Proposed key | Buys |
| --- | --- | --- |
| `review_repositories` (new) | `UNIQUE(provider, provider_repository_id)` | One row per real repository, independent of who connected it and of what it is currently called. |
| `architecture_review_integrations` | `UNIQUE(repository_ref) WHERE repository_ref IS NOT NULL AND revoked_at IS NULL` | One active credential per repository. Partial on `revoked_at`, so a revoked connection never blocks a reconnect. |
| `architecture_reviews` | `UNIQUE(repository_ref, external_change_number) WHERE both non-null` | One review per pull request. |
| Check run | unchanged: `external_id` stays `review.id` | Once the review is canonical its id is already stable; see [canonical check-run identity](#canonical-check-run-identity). |

`owner_id` keeps exactly one meaning throughout: **who stored the row**. Reachability derives from
repository membership instead. That separation landed in `f1f163f` and is why this work does not
have to revisit every query.

## Canonical repository identity

A repository is its immutable numeric GitHub id, not its name.

```
provider              github
providerRepositoryId  GitHub's numeric repository id, stored as text
repositoryFullName    owner/name — mutable, for display and for the next lookup
```

The project already applies this reasoning to accounts. `repositoryAuthority` matches the
connecting user on `level.user.id` rather than on their login, precisely because a login can be
changed and reused. Repositories have the same property and currently do not get the same
treatment.

That numeric id is fetched nowhere today. `githubApp` resolves `GET /repos/{full_name}/installation`,
which identifies the App *installation*, not the repository. Capturing the repository id needs one
additional `GET /repos/{full_name}` using the installation token already in hand.

**That request runs at connection time and on revalidation only — never on ingestion.** Ingestion
is the hot path and already resolves the credential; adding a GitHub round trip to it would put an
external dependency in front of every Action delivery.

### Rename and transfer

Renaming a repository, or transferring it to another organisation, changes `owner/name` and leaves
the numeric id alone. Under the current string key both operations silently fork identity: the next
delivery arrives under a name nothing matches, a second integration and a second review appear, and
the pull request acquires a second check run — the same failure as two admins, reached by a
different route.

Under the proposed key:

- The numeric id resolves to the existing `review_repositories` row.
- `repositoryFullName` is refreshed to the new name as a side effect of the lookup that already
  happens on revalidation.
- Existing reviews, decisions, and check runs stay attached.
- Nothing is created and nothing is orphaned.

The stored name is display and lookup material. It is never a key, never compared for authority,
and a delivery whose name disagrees with the stored one is a rename to record rather than a
mismatch to refuse — the numeric id is what was matched.

## Canonical review identity

For GitHub-sourced reviews, identity is:

```
(provider, provider_repository_id, pull_request_number)
```

Not `(owner_id, provider, owner/name, pull_request_number)`.

The head commit is deliberately absent. A review *advances* as new commits arrive — that is what the
existing refresh path already does, replacing head revision, graphs, report, and returning the
decision to pending. The semantic identity of the review is the pull request; the head commit is
state the review carries, not part of what makes it that review.

The check run is per head commit, because a check run can only hang off a commit. The review is not.

## Canonical check-run identity

`external_id` stays `review.id`.

An earlier draft proposed deriving it from `{provider_repository_id}:{pull_request_number}` so that
the identifier would be stable across administrators. That is the wrong fix, and rejecting it is
worth recording: while two conflicting review records still exist, a shared `external_id` makes the
two reviews **overwrite one check run**. The pull request would then show a single gate flipping
between an approval and a rejection with no indication that two people disagree. That hides the
conflict rather than removing it, and it is strictly worse than the visible duplicate, because a
visible duplicate can at least be noticed.

The conflict is removed by making the review canonical. Once one review exists per repository and
pull request, its id is already the stable identifier, the existing `external_id === review.id`
filter keeps doing its real job of never adopting another application's same-named run, and check
runs already published in production keep matching. No transition window is needed and no
identifier changes format.

## Credential rotation and revocation

Once a repository has one connection rather than one per admin, revocation stops being a private
act: revoking the credential stops every Action configured against that repository, not just the
revoker's.

**Proposed: any verified admin of the repository may rotate or revoke it, and the acting account is
recorded on the audit event.** Restricting the operation to whoever connected it first would rebuild
owner-scoping under a different name — the same limitation, reached through a permission error
instead of a 404.

Two properties this must preserve:

- Authority is checked at the moment of the operation, not read from the stored connection. An admin
  whose permission was removed on GitHub must not be able to revoke a shared credential using proof
  captured an hour ago. The existing revalidation path already answers this question; rotation and
  revocation must ask it rather than trusting `verified_permission` on the row.
- Rotation is not a way to take a repository over. Rotating issues a new credential for the same
  canonical repository; it does not change who else may administer it.

## Existing duplicates: detection and reconciliation

No automatic winner is chosen. Selecting the newest row, the oldest row, or the one carrying a
decision each silently discards a recorded decision and the entitlement evidence stored with it —
the audit trail that exists to answer who decided on what authority.

Before any global unique constraint is added, a **preflight** groups the existing data by
repository and pull request and classifies what it finds:

| Class | Meaning | Handling |
| --- | --- | --- |
| Duplicate integrations | More than one active credential for one repository | Link to one canonical repository row; keep both credentials; no decision data is at risk |
| Duplicate reviews, decisions agree | Two reviews, same verdict, or one decided and one pending | Safe to reconcile onto one canonical review, preserving both event trails |
| Duplicate reviews, decisions conflict | One approved, one rejected | **Stop.** Requires explicit human reconciliation; migration must not proceed for that repository |
| Duplicate check runs on the current head | More than one run under the required name | Report; resolved as a consequence of review reconciliation, not independently |

The migration refuses to collapse a conflicting group. It reports the group, leaves those rows
owner-scoped as legacy, refuses new ingestion for that repository, and surfaces it for an admin to
resolve.

Production today is expected to hold a single user's own test data, so reconciliation is likely
trivial. **The migration must not assume that.** The preflight runs and reports regardless, and its
output is a precondition for the enforcing phase rather than a formality.

## Migration ordering and rollback

Each phase is independently deployable and independently revertible. Nothing destructive happens
before the data has been inspected, and no phase before 6 changes who can see anything.

| Phase | Does | Rollback |
| --- | --- | --- |
| 1 · Preflight | Read-only classification of duplicate integrations, reviews, and check runs. Reports; changes nothing. | Not applicable |
| 2 · Capture | Add `review_repositories` and nullable `repository_ref` columns. Fetch and store the numeric repository id on connect and revalidation. Backfill. Nothing enforced. | Drop the table and columns; no read path depends on them |
| 3 · Contain | Refuse a connection to a repository already actively connected by another account, with `409 repository_already_connected`. Stops new duplicates appearing while the rest is built. | Remove the check |
| 4 · Enforce | Add both unique indexes. Fails loudly if phase 1 found conflicts, which is the intended behaviour. | Drop the indexes |
| 5 · Canonical review | Reads and ingestion resolve a review by `(repository_ref, change_number)`. Check-run identity is unchanged by design. | Restore owner-keyed resolution; rows still carry `owner_id` |
| 6 · Collaborator reads | Verified collaborators reach a review by direct link. First change to who sees what. | Narrow the scope constructor — one call site, because of `f1f163f` |
| 7 · Collaborator decisions | Decisions through the existing entitlement check; audit events attribute the acting collaborator. | Narrow the entitlement |
| 8 · Discovery | Shared listing. Last deliberately: a list is the only surface that exposes reviews nobody navigated to on purpose. | Hide the listing |

Phase 3 is containment, not the finished model. A permanent `409` for a second verified admin would
preserve the owner-centric limitation behind a friendlier error message. The target is that the
second admin **joins** the existing connection; the refusal exists only to stop the population of
duplicates growing while phases 4 and 5 are built, and phase 6 is not reached until joining works.

Rollback rule for every phase: the previous release must keep serving unchanged against the migrated
database. Columns are additive and nullable; indexes are droppable; no column is removed and no data
is destroyed in any phase described here. Removing `owner_id`-based keys is explicitly **not** part
of this plan.

Diagnostics: `/health` already reports the running commit, which is how a deploy is confirmed. The
preflight's classification output should be retrievable after the fact rather than existing only in
a deploy log, so that a later question about what the migration saw has an answer.

## Memory and PostgreSQL parity

The server runs without a database, and the in-memory store is not a toy: it is what every test that
does not opt into `TEST_DATABASE_URL` exercises, which is nearly all of them. The two backends have
already drifted once — the compare-and-set that protects a sync outcome lived only in SQL, and the
timestamps a new generation clears lived only in memory.

Every constraint proposed here therefore has to hold in both:

- One active integration per repository.
- One review per repository and pull request.
- Rename and transfer resolving to the same canonical repository.
- Preflight classification producing the same groups from the same data.

Reading both implementations is not enough to establish this, because each is correct on its own
terms. The synchronization contract is already executed against both by running one shared
expectation file against a real PostgreSQL in CI; the constraints here follow the same pattern.

A local gate cannot prove the PostgreSQL half — there is no local PostgreSQL, so those tests skip.
CI runs them and fails if they skip rather than run. That property must be preserved for the new
tests, or the parity claim is untested in exactly the environment that matters.

## Adversarial test matrix

`fails` marks behaviour this design has to change; `holds` marks behaviour that must survive it.

| Scenario | Required outcome | Today |
| --- | --- | --- |
| Two verified admins connect one repository | Second joins the existing connection; never a parallel identity | fails |
| Two admins ingest the same pull request and head | One review | fails |
| Two admins publish a decision on one commit | One check run | fails |
| Opposite decisions on one commit | Impossible by construction — one review holds one decision | fails |
| Repository renamed between deliveries | Same canonical identity; no forked review | fails |
| Repository transferred to another organisation | Same canonical identity | fails |
| Review deleted and re-created | Updates the existing check run, not a second one | fails |
| Preflight meets conflicting decisions | Migration stops for that repository; nothing merged | fails |
| Preflight meets agreeing duplicates | Reconciled onto one review, both event trails preserved | fails |
| Every constraint above under memory storage | Identical answers to PostgreSQL | fails |
| Migration rolled back mid-phase | Previous release keeps serving unchanged | fails |
| Another application publishes a same-named check | Never adopted or overwritten | holds |
| Non-admin attempts to connect | Refused; no row written, no token returned | holds |
| Admin permission withdrawn on GitHub | Credential refused within the revalidation window | holds |
| Revoked admin attempts to rotate a shared credential | Refused on live authority, not on stored proof | holds |
| Pull-request author attempts self-approval | Refused on numeric account id | holds |
| Concurrent duplicate deliveries | Idempotent; one run | holds |
| Formatting-only change | No semantic diff, no new finding | holds |

## Open questions

Four questions change the shape of the work. Each carries a recommendation; none is settled.

### 1. Does a second verified admin join, or get refused?

*Alternatives.* Refuse permanently, keeping one administrator per repository. Refuse temporarily as
containment, then allow joining. Allow joining immediately.

*Recommendation: refuse temporarily, join eventually.* A permanent refusal is the current
single-admin limitation wearing a better error message, and the product's claim is that a team
reviews together. `409 repository_already_connected` is acceptable as phase 3 containment and is not
the finished model.

*Open part.* What joining grants exactly — its own credential bound to the shared repository, or
shared use of one credential. Own credential is recommended, so revoking one automation does not
stop another.

### 2. Who may rotate or revoke a shared credential?

*Alternatives.* Only the account that first connected it. Any verified admin. Any verified admin,
with a confirmation step naming what will break.

*Recommendation: any verified admin, checked live, recorded on the audit event.* Restricting it to
the first connector rebuilds owner-scoping. The confirmation step is a product question, not a
correctness one.

### 3. What is the check-run transition window?

*Dissolved by the decision above.* Because `external_id` stays `review.id`, no identifier changes
format, existing runs keep matching, and there is no window to size. The question is recorded
because the alternative — a derived repository/pull-request identifier — is an obvious-looking idea
that makes two conflicting reviews overwrite one check and hide the disagreement.

### 4. Do collaborator reads re-check repository membership per request?

*Alternatives.* Live check per read. Reuse the existing hourly revalidation. A separate, shorter
freshness rule for reads.

*Recommendation: reuse the hourly revalidation.* A live check per read is a GitHub request per page
view, and a second freshness rule is a second thing to get wrong. The cost is that read access lags
a removed collaborator by up to that window, which belongs in `KNOWN_LIMITATIONS.md` stated plainly
rather than left for someone to discover.

*Open part.* Whether decisions keep their stricter live check. They should — a decision is the act
the audit trail exists for — but that makes reads and decisions answer to different clocks, which is
worth stating rather than discovering.

## What this document does not do

No schema, route, access behaviour, or collaborator functionality has been implemented. No test
asserting the current duplicate behaviour has been added.

Two things remain outstanding and are unaffected by this document: deploying the current commit, and
the production authorization walkthrough, which needs a second person with write access on a private
repository. The walkthrough does not block writing this design, and should be complete before phase
6 changes who may read a review.
