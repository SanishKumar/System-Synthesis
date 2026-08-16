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
| `github_unreachable` | GitHub could not be reached from the server |
| `credential_unusable` | The App's private key could not sign a request; replace it |
| `credential_rejected` | GitHub refused the App's credential — a rotated key, or access removed |
| `installation_lookup_failed` | GitHub could not confirm the installation; usually transient |
| `token_request_failed` | GitHub would not issue an installation token |
| `check_write_forbidden` | The App lacks `Checks: Read and write`, or the installation was removed |
| `check_write_invalid` | GitHub rejected the payload — a genuine bug worth reporting |
| `check_write_failed` | GitHub refused the write for some other reason |
| `configuration_invalid` | `FRONTEND_URL` is not a valid URL, so the check cannot be addressed |
| `unexpected_error` | A fault nobody anticipated; the server log carries the detail |

These are a fixed vocabulary rather than whatever an exception happened to say.
A reviewer sees them, so they have to mean the same thing every time and reveal
nothing about the server's insides; the originating message is logged for
whoever operates the service.

The distinction is load-bearing. A transient fault reported as a skip would tell
a reviewer their pull request needs no update while the gate sits unpublished,
which is the failure the sync panel exists to prevent. Only a setup state or an
absent pull request is a skip; everything else is a failure carrying its own
reason.

Every review states which of these applies, including a manual one, which
reports that no pull request exists to gate rather than showing nothing at all.

A decision that was recorded while publishing failed stays recorded. The review
shows the failure and offers **Retry sync**, and a new commit on the pull
request publishes it again.

An attempt is recorded against the revision, commit and conclusion it was made
for. If the pull request moves on while an attempt is in flight, the answer is
discarded rather than applied to the newer state — for a skip as much as for a
success, because "nothing was published" is true only of the generation it was
attempted for.

Within one generation a success is never undone. Two attempts can overlap — a
retry alongside the publish a decision triggered — and if one succeeds and a
slower one fails, the pull request still carries the gate the successful one
wrote, because nothing about the review changed in between. Recording the later
failure would report a gate that is present as missing. A later success is still
recorded, so retrying after fixing a permission works as expected.

Reviews created before synchronization was tracked hold no recorded generation.
The first attempt one of them makes adopts the empty slot and fills it in, so
such a review reports its gate correctly from then on instead of claiming
forever that it had never reached a pull request.

## 7. Let reviewers prove who they are

The App proves the application. It says nothing about the person who clicked
approve, so a decision is otherwise attributed to a System Synthesis account and
nothing else — an identity this product issued to itself.

On the App's settings page, copy the **Client ID**, generate a **Client secret**,
and set the callback URL to `<PUBLIC_API_URL>/api/auth/github/callback`. Then set
on the server:

| Variable | Meaning |
| --- | --- |
| `GITHUB_APP_CLIENT_ID` | From the App's settings page |
| `GITHUB_APP_CLIENT_SECRET` | Generated on the same page; shown once |
| `PUBLIC_API_URL` | Where GitHub returns the reviewer, if not localhost |

A reviewer then opens **Connections** and links their account. Identity is matched
on GitHub's numeric account id, which is not reused; the login is kept for
display and may change. One GitHub account can be linked to one account here, so
two reviewers cannot both answer to the same person.

The reviewer's access token is used once, to ask GitHub who they are, and is
discarded. Repository permission checks read through the App's installation
token, which the server already holds, so no second long-lived credential per
reviewer is stored.

Without these two values, linking is unavailable and reported as such. Nothing
else changes: decisions are still recorded, audited and published.

## What this does not do yet

A reviewer can now prove which GitHub account they are. Nothing yet *checks*
that account against the repository: approval does not require being a
collaborator or a code owner, and the author of a pull request is not prevented
from approving their own change. Linking is the identity half of that gap, and
the entitlement half is still open — so this remains adequate for reviewing your
own repositories and not yet sufficient for enforcing a gate on a team. See
[known limitations](./KNOWN_LIMITATIONS.md).
