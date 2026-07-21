# ADR-007: Source-derived architecture review is the primary workflow

- Status: Accepted
- Date: 2026-07-19

## Context

A collaborative canvas demonstrates graph editing but does not put architecture analysis in a team's daily path. Manual diagrams also drift from source and make reviewers trust the author to keep them synchronized.

Comparing YAML text is insufficient because formatting, key order, and source-line changes create noise while topology changes remain implicit.

## Decision

Make source-derived pull-request review the primary product workflow:

1. Import a deliberately supported source subset into a canonical graph.
2. Preserve stable source identities and file/line evidence.
3. Compare base and head graphs semantically.
4. Run deterministic rules and graph algorithms on both.
5. Gate newly introduced findings by configurable policy.
6. Publish JSON, Markdown, SARIF, a PR check, and a readable comment.
7. Let the browser persist, justify, and decide the same review model.

Docker Compose is the first adapter. Terraform import is deferred until a similarly explicit supported subset and test corpus exist.

The base-branch policy governs pull requests. Exceptions require justification and support expiry. Browser review writes use optimistic concurrency and append-only events.

## Consequences

- The product answers a concrete engineering question: “What architecture changed in this pull request, and does it violate an accepted policy?”
- Source formatting no longer appears as architecture change.
- Findings remain reproducible without an LLM or external API key.
- The canvas becomes a supporting inspection/collaboration surface rather than the sole product story.
- The initial source coverage is intentionally limited and must not be marketed as general Compose/Terraform understanding.

## Rejected alternatives

- Keep the canvas as the primary product: visually broad, but detached from merge decisions.
- Send source or graph JSON directly to an LLM: non-deterministic and difficult to gate safely.
- Support several infrastructure formats shallowly: larger claim surface with weaker evidence.
- Let the head branch provide policy: a pull request could disable its own guard.
