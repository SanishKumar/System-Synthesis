# Contributing

Thanks for looking at this. The guidance below is short, and most of it exists
because the product makes a specific promise — that a merge gate is deterministic
and provable — which constrains how changes are made.

## Try it before changing it

You do not need an account, a server, or any GitHub permission to see what this
does. The CLI compares two Compose files, so it works on any repository you can
clone, including one you do not own:

```bash
npm ci
npm run build --workspace=architecture-core
npm run build --workspace=architecture-cli

git show main:docker-compose.yml > /tmp/base.yml
git show my-branch:docker-compose.yml > /tmp/head.yml

node architecture-cli/dist/bin.js review \
  --base /tmp/base.yml \
  --head /tmp/head.yml \
  --source-path docker-compose.yml
```

Exit code 1 means the change introduced something blocking. `--format sarif`
and `--format json` produce the same findings in machine-readable form.

To exercise the pull-request path — the check run, the comment, the persisted
browser review — use **a repository you own**, or a fork of one you do not. A
pull request opened *into* somebody else's repository cannot exercise it: a fork
pull request receives no secrets and a read-only token by design, the App is not
installed on their repository, and the decision gate now refuses a change's own
author anyway. See [the App setup guide](./docs/GITHUB_APP_SETUP.md).

## Running everything locally

```bash
npm ci
npm run verify      # every workspace builds, every test runs
```

`npm run verify` is the gate. Run it with **no development server running**:
`next dev` and the production build both write `.next`, and the collision
surfaces as an unrelated-looking missing-module error.

PostgreSQL-backed tests are skipped unless a scratch database is available:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/scratch?sslmode=disable npm test --workspace=server
```

Continuous integration always provides one and fails if those tests skip rather
than run.

## What a change is expected to carry

**A test that fails without the change.** Not as ceremony — several defects in
this repository were introduced *with* passing tests that asserted the wrong
thing, so a test that has never been seen to fail has not been shown to test
anything. Break your own fix, watch the test go red, put it back.

**Evidence from running it, where running it is possible.** A rendered page, a
real request, a captured log. Reading the code is how the same defects survived
review the first time.

**Honest documentation.** If a change narrows what the product can claim, say so
in [`docs/KNOWN_LIMITATIONS.md`](./docs/KNOWN_LIMITATIONS.md). That file is not a
list of regrets; it is what makes the rest of the claims trustworthy.

## Things that are deliberate, not oversights

Please do not "fix" these without discussion — each is load-bearing, and the
reasoning is in the surrounding comments:

- **No LLM in the verdict path.** Findings come from deterministic rules over a
  canonical graph. An LLM may explain an existing finding; it may never create,
  remove, or alter one.
- **Formatting-only changes produce no semantic diff.** Anything that records
  *how* source was written — short versus long port syntax, line numbers, key
  order — must stay outside the content fingerprint, or reformatting starts
  failing merges.
- **A pull request cannot approve itself.** Policy is read from the base commit,
  and the decision gate refuses the change's own author.
- **Two provenance axes.** Analyzer identity answers "would today's rules still
  reach this verdict from this graph". Importer version answers "would today's
  importer still produce this graph from that source". They are fixed by
  different things and are pinned by tests that fail first, on purpose, to force
  a deliberate version decision.
- **Claim only what the evidence supports.** A port string with no host address
  is `unknown`, not `external`. A decision made where entitlement cannot be
  checked is recorded as unverified, not as verified.
- **The committed Action bundle.** `architecture-action/dist` is generated and
  committed, and CI rebuilds it and fails on any difference. If you change a
  dependency that ends up inside it, rebuild it in the same change:
  `npm run build --workspace=architecture-action`.

## Commit and pull request shape

One bounded change per pull request. Explain in the commit message *why* the
change is right, not what the diff already shows — the existing history is the
style guide.

Automated dependency updates that touch the Action bundle, or that carry a
breaking change, are taken as maintainer-owned pull requests rather than merged
as-is, so the rebuild and the fix are reviewed together.

## Reporting something broken

A security issue goes to [`SECURITY.md`](./SECURITY.md), not to a public issue.

For anything else, the most useful report says what you expected, what happened,
and the smallest Compose file that shows it. A failing case as a test is better
still.
