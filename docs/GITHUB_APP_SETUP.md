# GitHub App setup

The Action can review a pull request without any of this. The App exists for one
additional thing: publishing the **Architecture Decision** check, so that a
decision recorded in the browser becomes a merge gate on the pull request.

Without the App the product still works — analysis runs, the comment appears,
the review persists, decisions are recorded and audited. They are simply not
mirrored to GitHub, and every publish attempt is skipped with `not_configured`.

Nothing here requires a webhook. The server never receives GitHub events; it
only writes check runs when a review changes.

## 1. Register the App

**Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
| --- | --- |
| Name | Anything unique, e.g. `System Synthesis Decision Gate` |
| Homepage URL | Your deployed frontend |
| Webhook | **Uncheck Active.** No events are consumed |
| Repository permission | **Checks: Read and write** |
| Where can it be installed | Only on this account, unless you intend to share it |

`Checks: Read and write` is the only permission required. `Metadata: Read-only`
is added by GitHub automatically. Do not grant contents, pull-request, or
administration access: the server never reads your source and never merges
anything, so a broader grant buys nothing and widens the blast radius if the
private key leaks.

Create the App, then **Generate a private key** and download the `.pem`. GitHub
shows it once. Note the numeric **App ID** from the same page.

## 2. Install it

**Install App → choose the account → Only select repositories → pick the
repository.**

Installing is separate from registering. An App that exists but is not installed
on a repository reports `not_installed`, and no check is published.

## 3. Configure the server

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | The complete PEM contents |

Paste the PEM including the `-----BEGIN` and `-----END` lines. Where a hosting
provider only accepts single-line values, replace the newlines with `\n`; the
server restores them. Both forms work.

Never commit the key or paste it into an issue, a pull request, or a chat. If it
is exposed, delete it in the App's settings and generate a new one — that
revokes the old key immediately.

Redeploy, then confirm the running commit is the one you expect.

## 4. Connect the repository for ingestion

The App publishes checks. It does not upload reviews — the Action does, using a
separate repository-scoped credential.

1. Sign in with a permanent account and open `/integrations`.
2. Connect the repository and copy the `ssri_…` token. It is shown once.
3. In **Repository → Settings → Secrets and variables → Actions**:
   - Secret `SYSTEM_SYNTHESIS_INGESTION_TOKEN` — the token
   - Variable `SYSTEM_SYNTHESIS_INGESTION_URL` — `https://<your-backend>/api/review-ingestions/github`

Both are optional inputs. A fork pull request receives neither by design.

## 5. Verify against a real pull request

Mocked tests cannot prove an API contract. Run this once, on a disposable branch,
before trusting the gate.

Open a pull request that introduces a deliberate violation — giving a service
that publishes a host port a direct dependency on a database is enough.

1. The deterministic Action check **fails**.
2. Exactly **one** `Architecture Decision` check appears, as **action required**.
3. Its details link opens the correct review.
4. **Reject** the review → the same check becomes **failure**.
5. Accept the finding with a justification → the same check becomes **success**,
   because with nothing blocking there is no decision left to make.
6. **Approve** → it stays **success**.
7. Change the decision again → the same check updates. A second check appearing
   is a bug; report it.
8. Push another commit → the review refreshes to the new head commit, and the
   decision returns to pending.

Approving is deliberately refused while unsuppressed blocking findings remain,
so step 5 must come before step 6.

## 6. Make it the merge gate

Once the sequence above behaves, add **Architecture Decision** as a required
status check in branch protection. Until then it is advisory and merges are
unaffected — which is the right order: prove it, then enforce it.

## When no check appears

Publishing is best effort by design. The decision is durable and audited before
GitHub is contacted, so a failure here never fails the reviewer's action; it is
logged as `Architecture decision check not published` with a reason.

The review records which of two things happened, because they call for
different responses. A **skip** means there is nothing to publish, or nothing to
publish with until someone changes the setup:

| Skipped | Meaning |
| --- | --- |
| `not_configured` | One or both environment variables are missing or blank |
| `not_installed` | The App is registered but not installed on that repository |
| `not_external` | A manually imported review; there is no pull request to gate |
| `not_a_commit` | The head revision is a branch name, and only a commit can carry a check |

A **failure** means the attempt should have worked and did not, so the gate is
unpublished and retrying is worth doing:

| Failed | Meaning |
| --- | --- |
| `fetch failed` | GitHub was unreachable from the server |
| `installation lookup returned 401` | The App's private key no longer matches the registration |
| `installation lookup returned 5xx` | GitHub was failing; retry later |
| `check run write returned 403` | The App lacks `Checks: Read and write`, or the installation was removed |
| `check run write returned 422` | GitHub rejected the payload — a genuine bug worth reporting |

The distinction is load-bearing. A transient fault reported as a skip would tell
a reviewer their pull request needs no update while the gate sits unpublished,
which is the failure the sync panel exists to prevent. Only a setup state or an
absent pull request is a skip; everything else is a failure carrying its own
reason.

A decision that was recorded while publishing failed stays recorded. The review
shows the failure and offers **Retry sync**, and a new commit on the pull
request publishes it again.

## What this does not do yet

The App authenticates *the application*, not the person. It does not verify that
whoever clicked approve is a repository collaborator, a code owner, or somebody
other than the pull request author. That is fine for reviewing your own
repositories; it is not yet sufficient for enforcing a gate on a team, and
GitHub-authenticated reviewer identity is the next step before that claim can be
made. See [known limitations](./KNOWN_LIMITATIONS.md).
