# Changelog

Notable user-visible changes are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.2.0 — 2026-08-27

The first release of the pull-request architecture review. `v0.1.0` predates the current importer, analyzer, ingestion, and synchronization contracts; pin `v0.2.0` or later.

### Added

- Deterministic architecture-change reviews for a bounded Docker Compose contract, including semantic graph diffs, source evidence, policy enforcement, Markdown, JSON, and SARIF output.
- A bundled GitHub Action, pull-request comment, check run, and authenticated browser review workflow.
- A Kubernetes manifest adapter and Kubernetes-specific policy rules in `architecture-core`. This adapter is not yet selectable from the CLI, Action, or server.
- Stable graph algorithms for reachability, trust boundaries, redundancy, cycles, and downstream blast radius.
- Base-branch policy authority, scoped and expiring suppressions, review decisions, optimistic revisions, and append-only audit events.
- GitHub synchronization status and retry controls for browser review decisions.
- A collaborative architecture canvas backed by Yjs, PostgreSQL snapshots and update logs, Redis distribution, version history, and deterministic infrastructure export.
- Reproducible convergence tests, live Socket.IO benchmarks, a threat model, a failure model, ADRs, and documented limitations.

### Security

- Repository ingestion credentials now require a linked GitHub administrator and are periodically revalidated; credentials issued before that verification are rejected until reconnected.
- GitHub review decisions are tied to immutable GitHub account IDs, live repository permission, and recorded entitlement evidence.
- GitHub App permissions are checked before issuing repository credentials or authorizing private-repository decisions.
- PostgreSQL and Redis TLS verify certificates by default, with explicit controls for local plaintext development and custom certificate authorities.
- Authentication, collaboration, invitations, role changes, rate limits, and repository ownership checks fail closed at their authorization boundaries.

### Fixed

- Canvas components can be selected together and moved as one. Holding Ctrl or Cmd extends a selection and Shift-dragging draws a selection box; dragging any selected component moves the whole group, and every component's new position is saved rather than only the one under the pointer. Deleting now removes the whole selection instead of a single component.

- Corrected Docker Compose port exposure classification for loopback, host-specific, unresolved, IPv4, IPv6, range, protocol, and long-syntax bindings.
- Corrected Kubernetes NetworkPolicy selector and direction semantics, including explicit unknown coverage for selectors that cannot be evaluated safely.
- Corrected Kubernetes exposure evidence so a workload reports only the ports actually reachable from outside the cluster: an internal ClusterIP port is no longer listed because a separate Service exposes the same workload, and an Ingress publishes only the Service port it routes to. Definite reach from an Ingress or literal external address is no longer hidden by an unresolved Service property, and findings name only the Service that published the workload.
- Prevented stale GitHub synchronization attempts from overwriting newer decisions or revisions and made check-run updates idempotent per review and commit.
- Prevented source-formatting changes from appearing as architecture changes and preserved legacy importer uncertainty instead of manufacturing findings.
- Improved persistence migrations, PostgreSQL compare-and-set coverage, Redis lifecycle health, deployment identity reporting, and failure diagnostics.
- Corrected analytics URL handling while continuing to remove review IDs, board IDs, invitation tokens, and query strings.

### Changed

- Repositioned the product around deterministic architecture change intelligence; the collaborative canvas is now a supporting inspection and modeling surface.
- Extracted source import, graph analysis, semantic diffing, validation, and policy into the reusable `architecture-core` workspace.
- AI-generated explanations are optional and may only explain deterministic findings; they do not create or modify policy results.
