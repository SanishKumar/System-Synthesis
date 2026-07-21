# Changelog

All notable changes are documented here. The project has not tagged a public release from this workspace; entries remain under Unreleased until a release is intentionally created.

## Unreleased

### Added

- Source-derived architecture reviews for a bounded Docker Compose subset, with stable graph identities and source-line provenance
- Semantic pull-request impact for component/dependency, host exposure, trust-boundary, redundancy, and downstream blast-radius changes
- Deterministic change policy with base-branch authority, scoped/expiring suppressions, Markdown/JSON/SARIF output, and merge-gating exit codes
- Standalone architecture CLI plus a tested, bundled Node 24 GitHub Action and dogfood pull-request workflow
- Authenticated browser review import, findings/evidence inspection, suppression, approve/reject decisions, optimistic revisions, and append-only events
- Reproducible base/head example fixtures and ADR-007 for the source-derived product direction
- Light-first, persisted top-navigation UI and read-only viewer/disconnected states
- Owner/editor/viewer board roles, expiring single-use invitations, and audit records
- Granular nested Yjs graph state with user-local undo
- PostgreSQL append-only collaboration updates, snapshots, compaction, Redis Streams/pub/sub distribution, and transport-recovery replay
- Adversarial socket, convergence, storage-failure, transactional-version, export, and graph-analysis tests
- Deterministic graph algorithms, configurable rules, suppression justifications, JSON and SARIF output
- Validated infrastructure IR, stable Docker Compose/Terraform output, provenance, semantic export diff, and golden tests
- Named semantic versions with attribution, graph-aware diffs, duplication, race-safe numbering, and collaboration-safe restore
- Reproducible convergence and live Socket.IO benchmark scripts
- Threat model, failure model, ADRs, benchmark report, and known limitations

### Changed

- Repositioned the product around deterministic architecture change intelligence; the collaborative canvas is now a supporting inspection/modeling surface
- Extracted canonical graph analysis, diffing, validation, source import, and review policy into the reusable `architecture-core` workspace
- Hardened the production server image so the extracted core is built, pruned, and available at runtime
- AI analysis now runs deterministic rules first; an LLM may only explain existing finding IDs
- Protected collaboration no longer accepts legacy/client-supplied identity
- Documentation no longer claims generic production readiness or unmeasured horizontal scalability
