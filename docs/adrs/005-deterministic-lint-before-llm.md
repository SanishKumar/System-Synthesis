# ADR-005: Deterministic linting precedes LLM explanation

- Status: Accepted
- Date: 2026-07-13

## Context

Sending graph JSON directly to an LLM and presenting its opinion as architecture validation is non-reproducible and difficult to test. Some earlier rules were also arbitrary fan-in thresholds presented too strongly.

## Decision

Run explicit graph algorithms and versioned rules first. Findings have stable rule/finding IDs, severity, rationale, affected graph IDs, configuration, suppression-with-justification, and unit tests. JSON/SARIF outputs are deterministic.

An optional LLM receives only the authoritative finding set and may return an explanation keyed by the unchanged finding ID. The server validates this response and merges explanation text without allowing changes to finding membership or severity.

## Consequences

- The same graph/rule configuration produces the same findings without an API key.
- LLM failure falls back to unchanged deterministic descriptions.
- Rules are described as lint policy, not universal proof of correctness.
- Separate AI graph generation remains an untrusted drafting feature.

## Rejected alternatives

- Graph JSON directly to LLM validation: non-deterministic and unauditable.
- Fixed “more than N edges” correctness rules: easy to implement but weakly defensible.
- No explanation layer: reproducible, but less accessible to users unfamiliar with a rule's rationale.
