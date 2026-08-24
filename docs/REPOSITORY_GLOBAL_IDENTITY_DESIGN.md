# Repository-global identity

**Status: proposed, not implemented.** Nothing in this document has been built. It exists to be
argued with before any schema, route, or access behaviour changes.

Reviews are owner-scoped today. Before widening who may read or decide one, a repository and a
pull request need a single identity that does not depend on which account connected them.
Otherwise the first collaborator to be given access is shown a set of duplicate reviews with no
canonical member, which is worse than showing them nothing.

Second revision. The first draft contained three contradictions that would have become migration
failures — a per-administrator credential model under a one-credential-per-repository index, legacy
duplicate credentials kept alive under that same index, and duplicate reviews merged on verdict
equality alone. It also conflated the connector's admin proof with authorization for a *different*
person to read. Those are corrected below, and the reasoning is kept rather than quietly replaced,
because each one is a plausible mistake to make twice.

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
| `architecture_review_events` | `review_id NOT NULL REFERENCES architecture_reviews(id) ON DELETE CASCADE` | Every audit record must belong to a review. Repository-level acts have nowhere to live, and deleting a review destroys its evidence. |
| Check run | `name` is a constant; `external_id` is `review.id` | Runs are per review, not per pull request. |
| Repository | the string `owner/name` | A rename or transfer silently becomes a different repository. |

## Proposed keys

| Table | Proposed key | Buys |
| --- | --- | --- |
| `review_repositories` (new) | `UNIQUE(provider, provider_repository_id)` | One row per real repository, independent of who connected it and of what it is currently called. |
| `architecture_review_integrations` | `UNIQUE(repository_ref) WHERE repository_ref IS NOT NULL AND revoked_at IS NULL` | **One** active credential per repository — see [one repository credential](#one-repository-credential). Partial on `revoked_at`, so a revoked connection never blocks a reconnect. |
| `architecture_reviews` | `UNIQUE(repository_ref, external_change_number) WHERE both non-null` | One review per pull request. |
| `review_repository_events` (new) | `review_repository_id`, no review required | A home for join, rotate, revoke, and migration acts. |
| Check run | unchanged: `external_id` stays `review.id` | Once the review is canonical its id is already stable; see [canonical check-run identity](#canonical-check-run-identity). |

`owner_id` keeps exactly one meaning throughout: **who stored the row**. Reachability derives from
repository membership instead. That separation landed in `f1f163f` and is why this work does not
have to revisit every query.

## Canonical repository identity

A repository is its immutable numeric GitHub id, not its name.

```
provider              github
providerRepositoryId  GitHub's numeric repository id, stored as text
installationId        the App installation currently covering it
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

`installationId` is stored alongside the numeric id because identity and reach are different
questions. A repository that still exists under the same numeric id may have moved to an
organisation where this App was never installed, and a stable identity must not be read as
continued access.

### Repository metadata is only ever written from GitHub's answer

`repositoryFullName` is refreshed from the body of a GitHub response, never from an ingestion
payload. An ingestion delivery carries a repository name supplied by the caller. Allowing that name
to update canonical metadata would let the holder of an automation credential rewrite what the
system believes a repository is called — the same shape of confused-deputy problem the connection
authority check already closed, arriving through a different door.

An ingestion credential may **resolve** a repository internally. It may not **describe** one.

### Rename and transfer

Renaming a repository, or transferring it to another organisation, changes `owner/name` and leaves
the numeric id alone. Under the current string key both operations silently fork identity: the next
delivery arrives under a name nothing matches, a second integration and a second review appear, and
the pull request acquires a second check run — the same failure as two admins, reached by a
different route.

Under the proposed key, identity survives. **Authority does not follow it automatically.**

| | Rename, same owner | Transfer to another owner |
| --- | --- | --- |
| Canonical row | Same; `repositoryFullName` refreshed from GitHub's response | Same |
| Existing reviews, decisions, check runs | Stay attached | Stay attached |
| Installation | Unchanged | **Must be re-resolved.** The App may not be installed at the destination |
| Ingestion | Continues | **Paused** until installation and admin authority are verified at the destination |
| Collaborator reads | Continue | Unavailable while the repository is unresolved — membership cannot be checked |

A transfer is never assumed safe merely because the numeric id did not change. Concretely: on
detecting that `repositoryFullName` from GitHub's answer has a different owner segment than the
stored one, the repository enters the `transferred` unresolved state, ingestion refuses with a
distinguishable reason, and it leaves that state only when the App resolves an installation at the
destination and a verified admin there reconnects.

## One repository credential

An ingestion credential is repository automation, not a person. It is held by a GitHub Actions
secret, used by a workflow, and rotated as an operational act. Modelling one per administrator
confuses it with an identity.

**Decision: one active repository-scoped ingestion credential per repository.**

- The first verified admin connecting a repository creates the canonical connection and receives
  the credential.
- A second verified admin **joins** that canonical connection. Joining grants management authority
  — rotate, revoke, view metadata — and issues no second ingestion token.
- Rotation replaces the shared credential and invalidates the previous one. Whoever rotates is
  responsible for the Actions secret being replaced; the old token stops working.
- Management authority comes from the joining admin's own linked GitHub identity, verified live,
  not from possession of the token.

The first draft of this document recommended a credential per joining admin, which contradicted the
`UNIQUE(repository_ref) WHERE revoked_at IS NULL` index in the same document — the schema permitted
one, the prose promised many. The index is right and the prose was wrong.

Multiple simultaneous credentials remain plausible later for a genuine reason — separate workflows,
staging versus production environments — keyed by purpose rather than by person. That is a separate
design with its own naming and revocation semantics, and it is explicitly not this one.

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

This holds **only** while a canonical review's id is permanent, which is the next section.

## Canonical reviews are tombstoned, never hard-deleted

A recreated row would receive a new UUID, and a new UUID is a new check run. Stability of
`external_id` therefore depends on the row never being destroyed and recreated.

**Decision: a GitHub-sourced canonical review is never hard-deleted.** Removal sets an archived
state and preserves the row and its id; a later delivery for the same repository and pull request
restores that row rather than inserting a new one.

Two facts make this cheap and make it matter:

- **No hard-delete path exists today.** There is no `DELETE FROM architecture_reviews` anywhere in
  the server. This is a forward constraint that prevents someone adding one, not a repair of
  something already wrong.
- **`architecture_review_events` cascades on delete.** Deleting a review would destroy its entire
  audit trail — who decided, on what authority, with what evidence. That is the record the product
  exists to keep, so the rule earns its place independently of check-run identity.

Manually created reviews have no external check run and no pull request to be canonical for. They
may keep ordinary lifecycle rules; the constraint above is scoped to GitHub-sourced canonical rows.

## Collaborator read authorization

**The connector's admin proof cannot authorize a collaborator's read.** It establishes that the
account which connected the repository held admin permission at a point in time. It says nothing
whatsoever about a different person now asking to see the topology. The first draft recommended
reusing the hourly revalidation for collaborator reads; that was a conflation of two different
subjects and is withdrawn.

Reads need their own answer, per user and per repository:

- A per-`(account, repository)` access record holding the permission GitHub reported and when it
  was checked.
- **Positive results cached with a short bounded TTL, 10–15 minutes.** Reads are frequent enough
  that a live check per read means a GitHub request per page view.
- **Negative results are not cached for the same duration.** A collaborator added a minute ago must
  not be locked out for fifteen. Failures reuse the short retry-backoff pattern already used for
  held authority refusals — enough to avoid hammering GitHub, not enough to be a denial with a
  lifetime.
- **Decisions are always checked live.** A decision is the act the audit trail exists for, and the
  existing entitlement check already asks GitHub at the moment it matters. That does not change.

Reads and decisions therefore answer to different clocks. This is deliberate and belongs in
`KNOWN_LIMITATIONS.md` stated plainly: read access may lag a removed collaborator by up to the
cache TTL, while their ability to decide stops immediately.

## Repository-level audit model

Joining, rotating, revoking, and migrating are acts on a repository, not on a review. They can
happen when no pull request is open. `architecture_review_events.review_id` is `NOT NULL` with a
foreign key, so today these acts have nowhere to be recorded at all.

A new `review_repository_events` record carries:

| Field | Why |
| --- | --- |
| `review_repository_id` | What was acted on |
| `actor_id` | The System Synthesis account that acted |
| `github_user_id`, `github_login` | Immutable numeric id, and the login it resolved to at the time |
| `verified_permission` | What GitHub said the actor's permission was, when it was asked |
| `operation` | `connected`, `joined`, `rotated`, `revoked`, `migrated`, `reconciled` |
| `credential_before`, `credential_after` | Safe token prefixes or credential ids — never token values |
| `result`, `reason` | Including refusals, which are the records most worth having |
| `created_at` | When |

The same rule as decisions applies: evidence is written in the same transaction as the act. Evidence
recorded separately is absent for exactly the operation somebody later needs to account for.

### Rotation is compare-and-set

Two admins rotating concurrently must not both believe their token is the live one. Rotation reads
the current credential identifier, writes conditional on it being unchanged, and the loser is told
it lost rather than being silently overwritten. The synchronization path already uses this pattern;
this reuses it rather than inventing a second one.

## Existing duplicates: detection and reconciliation

No automatic winner is chosen. Selecting the newest row, the oldest row, or the one carrying a
decision each silently discards a recorded decision and the entitlement evidence stored with it.

Before any global unique constraint is added, a **preflight** groups the existing data by repository
and pull request and classifies what it finds.

### Credentials

The first draft proposed linking duplicate integrations to one canonical repository while keeping
both credentials. The proposed unique index forbids exactly that, so the draft contradicted itself.

The deeper problem is that **only token hashes are stored**. The system cannot determine which of
two legacy tokens is the one currently sitting in a repository's Actions secret. Choosing one and
hoping is a silent breakage of somebody's automation.

The migration therefore does not choose:

1. Mark every legacy credential for the repository as requiring reconnection.
2. Issue one new canonical credential to a verified admin who reconnects.
3. Require the Actions secret to be replaced — the same reconnect flow already used when
   pre-authority credentials were refused, which is a path users have walked before.
4. Revoke every old credential once the new one exists.

This is deliberately disruptive. A brief, loud interruption that names its cause is better than a
quiet one that stops a gate from publishing.

### Reviews

Verdict equality is **not** sufficient to merge. Two reviews both reading `pass` can differ in base
and head revision, canonical graph contents, policy fingerprint, analyzer version, importer
versions, the finding set, suppressions, decision evidence, sync generation, revision number, and
audit history. "One decided, one pending" is not safe either — the pending one may be the newer
commit, and adopting the decided one silently walks the gate backwards.

Automatic reconciliation requires **strict semantic equivalence** across all of:

- `base_revision` and `head_revision`
- base and head canonical graph fingerprints
- policy fingerprint
- `analyzer_version` and every adapter version recorded in graph provenance
- the finding set, by id and severity
- suppressions, including justification and expiry
- decision, note, and entitlement evidence
- sync generation and published conclusion

| Class | Handling |
| --- | --- |
| Duplicate credentials | Reconnect flow above; no silent selection |
| Duplicate reviews, strictly equivalent | Designate one canonical; the others become archived rows pointing at it. Nothing is destroyed |
| Duplicate reviews, any difference | **Stop.** Operator reconciliation required; migration does not proceed for that repository |
| Duplicate check runs on the current head | Neutralised — see the next section |

Reconciliation archives rather than merges. Merging two audit trails into one requires deciding
whose account performed which act; archiving keeps both trails intact and adds a pointer.

Production today is expected to hold a single user's own test data, so reconciliation is likely
trivial. **The migration must not assume that.** The preflight runs and reports regardless.

## Superseded check runs on GitHub

Repairing the database does not retract check runs already published. A pull request whose head
commit carries two `Architecture Decision` runs still carries two after the rows behind them are
reconciled, and a reader looking at the pull request sees a contradiction the database no longer
has.

For each reconciled repository, on the current head of each affected pull request:

1. Identify the run belonging to the canonical review by its `external_id`.
2. Update every other run this App published on that commit to a **non-gating terminal
   conclusion** — `neutral` or `skipped`.
3. Give each a summary saying it was superseded by the canonical review, so somebody reading the
   pull request learns why there are two.
4. Link it to the canonical review's details URL.
5. Verify against a branch protection rule that a neutral run does not gate, rather than assuming
   it.

Only runs carrying an `external_id` this application issued are touched. A same-named run from
another application is left entirely alone, which is the property the existing filter protects and
which reconciliation must not trade away.

Historical commits are left as they are. Rewriting the check history of commits nobody is merging
adds risk without adding truth.

## Unresolved repository states

The migration and the runtime both assume GitHub answers. It does not always, and the reasons are
not equivalent.

| State | Cause | Ingestion | Collaborator reads | Migration |
| --- | --- | --- | --- | --- |
| `resolved` | Normal | Proceeds | Per the read cache | Classified normally |
| `rate_limited` | 429 or secondary limit | Retried with backoff; not a durable state | Served from unexpired cache; refused once stale | **Retry.** Never classified on a transient failure |
| `unavailable` | 5xx, timeout, network | As above | As above | Retry, then report unresolved |
| `uninstalled` | App removed from the repository | Paused, distinguishable reason | Unavailable | Reported unresolved; constraints not enforced for it |
| `transferred` | Owner segment changed | Paused until destination verified | Unavailable | Reported unresolved |
| `inaccessible` | 403 or 404 for a repository that existed | Paused | Unavailable | Reported unresolved |
| `deleted` | Repository gone | Paused permanently | Unavailable | Rows retained and archived; never destroyed |

Two rules govern the table. **Transient failures are never durable states** — a rate-limited lookup
during a migration must not be recorded as an uninstalled App. And **fail closed on authority**: an
unresolved repository does not grant collaborator access on last-known information, because GitHub
being unreachable has never been allowed to mean authority was established.

Existing reviews for an unresolved repository remain readable by the account that stored them.
Nothing is hidden from the person who already had it.

## Migration ordering and rollback

Twelve phases. Nothing destructive happens before the data has been inspected, and no phase before
10 changes who can see anything.

| Phase | Does |
| --- | --- |
| 1 · Preflight | Read-only classification of duplicate credentials, reviews, and check runs, and of unresolved repositories. Reports; changes nothing |
| 2 · Capture | Add `review_repositories` and nullable `repository_ref`. Store numeric repository id and installation id for new connections and on revalidation. Backfill what resolves. Nothing enforced |
| 3 · Unresolved states | Define and record the states above, so later phases have somewhere to put a repository they cannot classify |
| 4 · Contain | Refuse a connection to a repository already actively connected by another account: `409 repository_already_connected`. Stops the duplicate population growing |
| 5 · Credential reconciliation | Mark legacy duplicates for reconnection, issue one canonical credential, revoke the rest |
| 6 · Review reconciliation | Archive strictly equivalent duplicates onto a canonical row; stop and report anything else |
| 7 · Neutralise checks | Mark superseded runs non-gating on current heads |
| 8 · Enforce | Add the repository, credential, and review unique indexes. Fails loudly if phases 5 and 6 left conflicts, which is intended |
| 9 · Admin management and audit | Joining, rotation with compare-and-set, revocation, and `review_repository_events` |
| 10 · Collaborator reads | Per-user access cache with bounded TTL. First change to who sees what |
| 11 · Collaborator decisions | Through the existing entitlement check, live, with actor attribution |
| 12 · Discovery | Separate design — see below |

Phase 4 is containment, not the finished model. A permanent `409` for a second verified admin would
preserve the owner-centric limitation behind a friendlier error message. The target is joining, in
phase 9; the refusal exists only to stop duplicates accumulating while phases 5 through 8 are built.

### Rollback

The first draft claimed phase 2 could be rolled back by dropping the new table and columns. That is
wrong twice over: dropping columns is itself a destructive migration, and additive nullable schema
is precisely the kind that does **not** need removing.

The correct rule:

- **Schema added by phases 2, 3, and 9 stays in place on rollback.** New tables and nullable
  columns are inert to a previous binary that never reads them. Removing them is a separate,
  riskier operation than the one being undone.
- **Indexes added by phase 8 may be dropped**, which is non-destructive and is the actual rollback
  for that phase.
- **Behavioural phases roll back by deploying the previous release**, not by touching data.
- **"The previous binary still works" is a claim requiring a test**, not an assumption. A
  compatibility check runs the previous release's expectations against the migrated schema. Without
  it, rollback is a hope.

Reconciliation phases 5, 6, and 7 are the ones that genuinely cannot be undone by redeploying,
because they revoke credentials and write to GitHub. They run only after phase 1 has reported, and
they refuse to act on anything they cannot classify.

Diagnostics: `/health` already reports the running commit. The preflight's classification output
must be retrievable after the fact rather than existing only in a deploy log, so that a later
question about what the migration saw has an answer.

## Memory and PostgreSQL parity

The server runs without a database, and the in-memory store is not a toy: it is what every test
that does not opt into `TEST_DATABASE_URL` exercises, which is nearly all of them. The two backends
have already drifted once — the compare-and-set protecting a sync outcome lived only in SQL, and
the timestamps a new generation clears lived only in memory.

Every constraint proposed here has to hold in both:

- One active credential per repository.
- One review per repository and pull request.
- Rename and transfer resolving to the same canonical repository.
- Rotation compare-and-set refusing the loser.
- Archived reviews reachable for restore, and never resurrected as a new id.
- Preflight classification producing the same groups from the same data.
- Unresolved states behaving identically, including the transient-versus-durable distinction.

Reading both implementations is not enough to establish this, because each is correct on its own
terms. The synchronization contract is already executed against both by running one shared
expectation file against a real PostgreSQL in CI; the constraints here follow that pattern.

A local gate cannot prove the PostgreSQL half — there is no local PostgreSQL, so those tests skip.
CI runs them and fails if they skip rather than run. That property must be preserved for the new
tests, or the parity claim is untested in exactly the environment that matters.

## Discovery needs its own design

Phase 12 is listed separately because it is blocked on something this design does not resolve.

**GitHub OAuth access tokens are deliberately discarded.** `githubIdentity` uses the token once, to
ask GitHub who the visitor is, and never stores it — every later question is asked through the
App's installation token. That is a privacy property worth keeping, and it means the application
**cannot enumerate the repositories a user can access.**

Three options, none free:

| Option | Cost |
| --- | --- |
| Retain a scoped OAuth token | Inverts the property above and creates a new long-lived secret to protect. Needs its own threat-model entry |
| A second GitHub App flow | More installation friction on the path we are trying to shorten |
| List only repositories System Synthesis already knows about, filtered by the viewer's verified permission | No new secret, no new flow; a user cannot discover a repository the product has never seen |

The third is the recommended first cut, and it is genuinely limited rather than complete. Deciding
between them is a separate document; discovery is not part of this one beyond acknowledging that it
cannot be built by assuming a token that does not exist.

## Adversarial test matrix

`fails` marks behaviour this design has to change; `holds` marks behaviour that must survive it.

| Scenario | Required outcome | Today |
| --- | --- | --- |
| Two verified admins connect one repository | Second joins the canonical connection; no second credential, review, or check identity | fails |
| Second admin joins | Gains management authority; receives no ingestion token | fails |
| Two admins ingest the same pull request and head | One review | fails |
| Two admins publish a decision on one commit | One check run | fails |
| Opposite decisions on one commit | Impossible by construction — one review holds one decision | fails |
| Two admins rotate concurrently | One wins; the loser is told it lost | fails |
| Rotation by an admin whose permission was removed | Refused on live authority, not on stored proof | fails |
| Repository renamed, same owner | Same canonical identity; name refreshed from GitHub's answer | fails |
| Ingestion payload names a different `owner/name` | Canonical metadata unchanged; payload never describes a repository | fails |
| Repository transferred to another organisation | History preserved; ingestion paused until destination installation and admin verified | fails |
| Canonical review removed and re-delivered | Same row and id restored; one check run | fails |
| Preflight meets strictly equivalent duplicates | Archived onto one canonical row; nothing destroyed | fails |
| Preflight meets any non-equivalent difference | Stops for that repository; nothing merged | fails |
| Preflight meets a rate-limited lookup | Retried; never recorded as uninstalled or deleted | fails |
| Superseded check run on the current head | Set non-gating, summary explains, links to canonical | fails |
| Neutral run under branch protection | Does not gate — verified, not assumed | fails |
| Collaborator read after permission removed | Refused once the bounded TTL expires | fails |
| Collaborator added moments ago | Not locked out by a cached denial | fails |
| Collaborator decision after permission removed | Refused immediately; decisions are live | holds |
| Repository unresolved | No collaborator access granted on last-known information | fails |
| Previous release against migrated schema | Serves unchanged; proven by a compatibility test | fails |
| Every constraint above under memory storage | Identical answers to PostgreSQL | fails |
| Another application publishes a same-named check | Never adopted, overwritten, or neutralised | holds |
| Non-admin attempts to connect | Refused; no row written, no token returned | holds |
| Admin permission withdrawn on GitHub | Credential refused within the revalidation window | holds |
| Pull-request author attempts self-approval | Refused on numeric account id | holds |
| Concurrent duplicate deliveries | Idempotent; one run | holds |
| Formatting-only change | No semantic diff, no new finding | holds |

## Settled decisions

These were open in the first revision and are now proposed as settled. They remain open to
objection, but implementation should not begin while any is genuinely undecided.

| Question | Decision |
| --- | --- |
| What happens when another admin connects? | Joins the canonical repository connection. No second ingestion token. `409` during phase 4 is containment only |
| Who may rotate or revoke? | Any currently verified GitHub admin, checked live, with compare-and-set and a repository-level audit event |
| What identifies a check? | The canonical `review.id`. Canonical GitHub-sourced reviews are tombstoned, never hard-deleted |
| How are collaborator reads authorized? | A per-user, per-repository access cache with a 10–15 minute positive TTL and no long-lived negative caching. Not the connector's admin proof. Decisions stay live |
| What happens after a transfer? | History preserved, ingestion paused, destination installation and admin authority required |
| How are duplicates merged? | Only under strict semantic equivalence, and by archiving rather than merging. Otherwise operator reconciliation |
| How are duplicate credentials resolved? | Reconnect and revoke. Never silently select one of two hashes |
| How is discovery built? | Undecided by design — blocked on the discarded OAuth token, and deferred to its own document |

## What this document does not do

No schema, route, access behaviour, or collaborator functionality has been implemented. No
migration has been written. No test asserting the current duplicate behaviour has been added.

Two things remain outstanding and are unaffected by this document: deploying the current commit,
and the production authorization walkthrough, which needs a second person with write access on a
private repository. The walkthrough does not block this design and must be complete before phase 10
changes who may read a review.
