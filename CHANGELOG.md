# Changelog

Notable user-visible changes are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.2.0 — Unreleased

The first release of the pull-request architecture review. `v0.1.0` predates the current importer, analyzer, ingestion, and synchronization contracts. Until `v0.2.0` is tagged, pin a reviewed full commit SHA.

### Added

- Deterministic architecture-change reviews for a bounded Docker Compose contract, including semantic graph diffs, source evidence, policy enforcement, Markdown, JSON, and SARIF output.
- A bundled GitHub Action, pull-request comment, check run, and authenticated browser review workflow.
- Automatic PR base/head revision detection in the Action, and unambiguous standard root Compose-path detection in the Action and Git-backed CLI. Explicit inputs remain authoritative; selected paths and resolved SHAs are exposed as Action outputs. Missing or ambiguous inputs fail instead of selecting a branch, merge commit, or arbitrary file.
- A Kubernetes manifest adapter and Kubernetes-specific policy rules in `architecture-core`. This adapter is not yet selectable from the CLI, Action, or server.
- Stable graph algorithms for reachability, trust boundaries, redundancy, cycles, and downstream blast radius.
- Base-branch policy authority, scoped and expiring suppressions, review decisions, optimistic revisions, and append-only audit events.
- Explicit, base-branch-controlled self-approval modes for solo maintainers and administrators, with live GitHub verification and distinct audit evidence.
- GitHub synchronization status and retry controls for browser review decisions.
- A collaborative architecture canvas backed by Yjs, PostgreSQL snapshots and update logs, Redis distribution, version history, and deterministic infrastructure export.
- Reproducible convergence tests, live Socket.IO benchmarks, a threat model, a failure model, ADRs, and documented limitations.

### Security

- Repository ingestion credentials now require a linked GitHub administrator and are periodically revalidated; credentials issued before that verification are rejected until reconnected.
- GitHub review decisions are tied to immutable GitHub account IDs, live repository permission, and recorded entitlement evidence.
- Accepting a finding exception now requires the same live entitlement and self-approval policy as a decision, with evidence recorded in the suppression audit event.
- Updated Next.js, Express and affected transitive production dependencies to patched versions. Configured Action ingestion refuses redirects rather than forwarding review data to a different endpoint.
- Moved CI and container images off end-of-life Node 20 to Node 24 LTS, matching the Action runtime, and added container build/start checks to CI.
- Excluded local environment files, private notes, dependencies and generated host artifacts from Docker build contexts, and scoped frontend container installation to its own workspaces.
- GitHub App permissions are checked before issuing repository credentials or authorizing private-repository decisions.
- PostgreSQL and Redis TLS verify certificates by default, with explicit controls for local plaintext development and custom certificate authorities.
- Authentication, collaboration, invitations, role changes, rate limits, and repository ownership checks fail closed at their authorization boundaries.

### Fixed

- Canvas components can be selected together and moved as one. Holding Ctrl or Cmd extends a selection and Shift-dragging draws a selection box; dragging any selected component moves the whole group, and every component's new position is saved rather than only the one under the pointer. Deleting now removes the whole selection instead of a single component.

- Corrected Docker Compose port exposure classification for loopback, host-specific, unresolved, IPv4, IPv6, range, protocol, and long-syntax bindings.
- Corrected Kubernetes NetworkPolicy selector and direction semantics, including explicit unknown coverage for selectors that cannot be evaluated safely.
- Corrected Kubernetes exposure evidence so a workload reports only the ports actually reachable from outside the cluster: an internal ClusterIP port is no longer listed because a separate Service exposes the same workload, and an Ingress publishes only the Service port it routes to. Definite reach from an Ingress or literal external address is no longer hidden by an unresolved Service property, and findings name only the Service that published the workload.
- Prevented stale GitHub synchronization attempts from overwriting newer decisions or revisions and made check-run updates idempotent per review and commit.
- Recheck the current review immediately before publishing a GitHub check. Failed or incomplete check lookups no longer create duplicate gates; lookups include older runs and pagination for the configured App.
- Corrected the bundled Action's actual error exit status to `2`, matching its output, and added dependency-free consumer smoke tests to CI.
- Distinguish failed or throttled permission refreshes from a confirmed missing GitHub App permission, and accept IPv6 loopback ingestion endpoints in development.
- Corrected workflow examples so blocking findings fail the job and unpublished release tags are not presented as usable pins.
- Prevented source-formatting changes from appearing as architecture changes and preserved legacy importer uncertainty instead of manufacturing findings.
- Improved persistence migrations, PostgreSQL compare-and-set coverage, Redis lifecycle health, deployment identity reporting, and failure diagnostics.
- Corrected analytics URL handling while continuing to remove review IDs, board IDs, invitation tokens, and query strings.

### Changed

- Repositioned the product around deterministic architecture change intelligence; the collaborative canvas is now a supporting inspection and modeling surface.
- Extracted source import, graph analysis, semantic diffing, validation, and policy into the reusable `architecture-core` workspace.
- AI-generated explanations are optional and may only explain deterministic findings; they do not create or modify policy results.
