# ADR-002: Use an append-only Yjs update log with snapshots

- Status: Accepted
- Date: 2026-07-13

## Context

Socket.IO broadcast or Redis pub/sub alone distributes messages but does not create recoverable authoritative state. Multiple processes also need idempotence, ordered recovery, and safe snapshot compaction.

## Decision

In durable mode, append every accepted Yjs update to PostgreSQL before room application and broadcast. Store a SHA-256 hash under a unique `(board_id, update_hash)` constraint. Use a per-board PostgreSQL advisory transaction lock for append and compaction. Restore from a document snapshot and the ordered sequence tail.

Redis Streams and pub/sub distribute accepted updates and the Socket.IO Redis adapter distributes room messages. Redis transport recovery triggers PostgreSQL/stream replay into already-loaded documents.

## Consequences

- Duplicate delivery is harmless at storage and CRDT layers.
- PostgreSQL failure rejects mutations in durable mode rather than silently lowering durability.
- Redis failure can delay cross-instance live delivery, but a committed update remains durable and is replayed after recovery.
- Redis-only mode retains its stream and does not compact without the distributed PostgreSQL snapshot lock.

## Rejected alternatives

- Plain Redis pub/sub: no replay after loss/restart.
- Debounced full JSON saves only: ordering and concurrent-writer behavior remain ambiguous.
- Independent in-memory documents per process: joining clients can receive stale state.
