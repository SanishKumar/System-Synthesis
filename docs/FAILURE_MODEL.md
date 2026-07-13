# Failure model

The system prefers an explicit rejection over acknowledging a mutation whose configured durability requirement was not met.

| Failure | Expected behavior | Evidence or caveat |
| --- | --- | --- |
| Browser socket disconnects | Connection state changes to disconnected and graph editing pauses. Reconnect joins the room and receives authoritative full state. | The product is deliberately not offline-first; it does not queue edits made while disconnected. |
| Duplicate update arrives | PostgreSQL ignores the same board/update hash; Yjs application is idempotent. | Unit and convergence tests deliver duplicates. |
| Updates arrive in different orders | Yjs converges for the modeled granular operations. | Seeded harness shuffles every participant independently and compares canonical hashes. |
| Backend restarts with PostgreSQL available | Room state restores from the compacted document snapshot plus ordered update tail. | Replay/compaction tests and simulated restart harness. |
| Redis publication fails while PostgreSQL commit succeeded | The mutation remains accepted and durable. Local clients receive it; other instances catch up by durable replay when Redis transport recovers. | Explicit Redis-outage unit test; reconnect callback replays loaded documents. |
| PostgreSQL transaction fails in PostgreSQL-authoritative mode | Mutation is rejected before room apply/broadcast, even if Redis is reachable. | Explicit PostgreSQL-outage unit test verifies fail-closed behavior. |
| PostgreSQL is not configured at boot | Server uses Redis-only or memory development behavior. Durable semantic history is unavailable. Redis-only compaction is deliberately disabled without a distributed snapshot lease. | This is a development/degraded mode, not the documented durable deployment. |
| Redis and PostgreSQL are both absent | Single-process memory mode accepts updates but loses them on restart. | Used only for local UI work and CI integration. |
| Persistence fails after a client submits malformed Yjs bytes | Candidate application/validation fails and the update is rejected without durable append. | Adversarial socket tests. |
| Client role is revoked while connected | The next mutation performs a fresh role check and is rejected; removal/privatization ejects unauthorized sockets. | Socket security tests and access-control flow. |
| Two checkpoint writers race | Advisory transaction lock serializes parent selection and version allocation. | Concurrent-writer repository test produces distinct versions. |
| Version restore occurs with connected clients | Restore enters the durable Yjs stream, replaces the server document state, and emits a full-state replacement so clients discard stale structures. | Collaboration restore/replay unit test and typed socket event. |
| Optional LLM fails or returns invalid JSON | Deterministic findings are returned unchanged. | LLM response is Zod-validated and never owns finding generation. |
| Export sees an unsupported node or dangling edge | Request returns an explicit unsupported-resource error; no partial file is presented as complete. | IR/export tests. |

## Recovery order

1. Establish storage connectivity.
2. Load the latest per-board document snapshot.
3. Replay updates after the snapshot sequence in order; duplicate application is safe.
4. Install the document before accepting room traffic so pub/sub cannot fall into a load/install gap.
5. On Redis subscriber recovery, replay durable state into every already-loaded room.
6. Persist a fresh compacted snapshot when the room is cleaned up or an explicit restore occurs.

## Deliberate availability choices

- PostgreSQL-authoritative deployments fail closed on PostgreSQL mutation failure. Redis is transport, not a substitute durability authority.
- Redis loss reduces immediate cross-instance propagation, not durability, when PostgreSQL is healthy.
- Memory mode favors convenience over durability and is clearly identified in health/benchmark documentation.
