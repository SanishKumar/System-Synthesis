# ADR-001: Use Yjs with field-level graph records

- Status: Accepted
- Date: 2026-07-13

## Context

The original graph representation stored an entire serialized node as one `Y.Map` value. Two users changing different properties of the same node could each replace the whole object, weakening the intended collaboration semantics.

## Decision

Use one Yjs document per board with `nodes` and `edges` root maps. Each entity is a nested `Y.Map`; nested records such as position, data, configuration, and metadata are shared records as well. Mutations patch the smallest meaningful field.

## Consequences

- A simultaneous label edit and position edit can merge.
- Deleting an entity and editing it concurrently still follows Yjs semantics and may not match every user's intent.
- Two writes to the same scalar field are deterministically resolved by Yjs; both values are not preserved as separate semantic alternatives.
- Serialization helpers and tests must preserve React Flow containment/style fields.

## Rejected alternatives

- Whole-object values: simpler but too coarse for the stated guarantee.
- Operational transformation built in-house: larger correctness surface with no demonstrated advantage for this graph model.
- Last-write-wins JSON documents: insufficient for independent concurrent field edits.
