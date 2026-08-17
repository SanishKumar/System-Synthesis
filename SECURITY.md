# Security

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** on this repository:
**Security → Report a vulnerability**. That opens a channel visible only to the
maintainers.

Please do not open a public issue, pull request, or discussion for anything that
could be exploited before there is a fix.

A useful report says what an attacker gains, and how you know. A proof of
concept against your own deployment is ideal; a description of the reasoning is
fine when it is not.

This is a small project with no service-level commitment attached to it. What
you can expect is an acknowledgement, an honest assessment of whether it is
exploitable, and either a fix or a written statement of why it is accepted —
recorded in [`docs/KNOWN_LIMITATIONS.md`](./docs/KNOWN_LIMITATIONS.md) rather
than left implicit.

## What this product is trusted to do

It writes a merge gate. The interesting failures are therefore not only "data
leaks" but **"the gate said something untrue"** — a check reporting success for
a change nobody approved, an approval attributed to someone who did not make it,
or a decision that never reached the pull request while the interface claimed it
had. Those are in scope and are treated as security defects.

[`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) states the trust boundaries in
full. In summary, in scope:

- Anything that lets a decision be recorded, published, or attributed without
  the entitlement the deployment is configured to require
- Anything that lets one account read, decide on, or modify another's reviews,
  boards, or credentials
- Credential exposure: ingestion tokens, the App private key, database or Redis
  credentials, session tokens
- Transport downgrade: a connection that encrypts without verifying, or falls
  back to plaintext, where configuration said otherwise
- A deterministic finding that can be suppressed, altered, or fabricated by
  anything other than the documented policy and suppression path

Out of scope, and already written down as limitations rather than defects:

- No password recovery exists; a lost password requires database access
- JWTs expire but there is no server-side denylist, so a stolen token is valid
  until it expires
- Reviews are owned by a single account; there is no team or organisation model
- `CODEOWNERS` is not consulted — write access to the repository is the bar for
  deciding
- Audit records live in the same database as application state and are not an
  immutable external log
- A deployment without the GitHub App, or without reviewer identity configured,
  cannot check entitlement and records decisions as unverified

If you think one of those is more serious than the limitation implies, say so —
that is a judgement worth revisiting, and a good argument will change it.

## Handling credentials in this repository

- Ingestion tokens are shown once and stored as hashes. Rotate through
  `/integrations`; rotation invalidates the previous token immediately.
- The App private key signs short-lived assertions. If it is ever exposed,
  delete it in the App's settings and generate a new one — that revokes the old
  key at GitHub, which is the only thing that actually helps.
- A reviewer's GitHub access token is used once, to read their account, and is
  never stored.
- Fork pull requests deliberately receive no ingestion credential.
- The hosted frontend sends page traffic to Vercel Web Analytics. Review identifiers, board identifiers and invitation tokens are removed from the path first, because an invitation token in a URL is a credential and a review identifier says which reviews exist. If you find a path that reaches it unscrubbed, that is a reportable defect.

If a secret has been committed anywhere, treat rotation as the fix. Removing it
from the working tree is not a fix.
