# ADR-006: Export through a validated infrastructure IR

- Status: Accepted
- Date: 2026-07-13

## Context

Direct string templates over arbitrary graph JSON can produce unstable ordering, hidden unsupported behavior, embedded credentials, and outputs that are difficult to regression-test.

## Decision

Translate the graph into a Zod-validated, versioned infrastructure IR. Define the supported node subset per target. Reject dangling dependencies and unsupported resources explicitly. Sort resources/dependencies, generate stable names, pin providers/images, emit secret placeholders, and include a source provenance hash.

Docker Compose output is covered by a full golden file. Terraform output is covered by a stable per-file SHA-256 manifest and policy assertions. Semantic IR diff is available before export.

## Consequences

- Identical supported input produces byte-stable output.
- Unsupported features fail instead of being silently omitted.
- Generated files are reviewable artifacts, not a claim of complete provider coverage.
- Terraform import and general round-trip conversion remain out of scope. A bounded Docker Compose source adapter is covered separately by ADR-007.

## Rejected alternatives

- Ad hoc template generation: unstable and hard to validate.
- Attempting every cloud resource: expands claim surface without correctness evidence.
- Embedding usable default secrets: convenient for demos but unsafe and misleading.
