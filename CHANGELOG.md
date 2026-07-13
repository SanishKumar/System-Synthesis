# Changelog

All notable changes are documented here. The project has not tagged a public release from this workspace; entries remain under Unreleased until a release is intentionally created.

## Unreleased

### Added

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

- AI analysis now runs deterministic rules first; an LLM may only explain existing finding IDs
- Protected collaboration no longer accepts legacy/client-supplied identity
- Documentation no longer claims generic production readiness or unmeasured horizontal scalability
