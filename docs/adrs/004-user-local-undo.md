# ADR-004: Track undo by local operation origin

- Status: Accepted
- Date: 2026-07-13

## Context

A separate application history stack can reverse remote operations or conflict with Yjs state. Collaborative editors need undo to mean “undo my operation,” not “rewind the shared document.”

## Decision

Use `Y.UndoManager` over the node and edge roots. Track only the `local` origin in the browser. Remote, hydration, replay, restore, and server origins are excluded.

## Consequences

- Undo generates a normal Yjs update and converges through the same durable path.
- A user's undo preserves an independent remote edit.
- History resets when the client replaces its document after switching boards or restoring a version.
- Cross-device personal undo history is not persisted.

## Rejected alternatives

- Global snapshot rewind: reverses other users' work.
- Custom inverse-operation stack: duplicates CRDT semantics and is difficult around concurrent delete/edit.
- Server-global undo: has ambiguous ownership and authorization.
