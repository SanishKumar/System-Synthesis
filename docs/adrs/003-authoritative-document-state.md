# ADR-003: Make the durable Yjs log authoritative for collaboration

- Status: Accepted
- Date: 2026-07-13

## Context

The application stores board metadata/current graph JSON for REST reads and also maintains active Yjs documents. Without an explicit authority, these representations can disagree after restart or across instances.

## Decision

For collaboration, the document snapshot plus ordered update log is authoritative. An active server `Y.Doc` is a materialized view of that durable state. The board JSON is a read/cache representation updated after accepted collaboration changes.

On first use, the existing board JSON becomes one canonical Yjs base snapshot. A room document is installed before replay completes so a pub/sub message cannot fall into a load/install gap. Joining clients receive a full Yjs state, not a client-selected graph.

## Consequences

- Restart and new-instance joins have a defined reconstruction path.
- AI explanation, version checkpoints, and live room operations prefer the loaded authoritative document where available.
- Metadata remains a conventional row/cache concern; graph collaboration uses Yjs durability.
- Development memory mode is explicitly non-durable.

## Rejected alternatives

- Redis cache as authority: eviction and transport outages are incompatible with durable history.
- Client state as authority: violates board access and recovery invariants.
- Last debounced JSON save as authority: can lose accepted operations before the debounce fires.
