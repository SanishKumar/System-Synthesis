import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("../db.js", () => ({ getPool: () => null }));
vi.mock("../redis.js", () => ({ redis: null }));

import {
  appendCollaborationUpdate,
  compactCollaborationDocument,
  loadCollaborationUpdates,
  replaceCollaborationState,
  replayCollaborationUpdates,
} from "../collaborationUpdates.js";
import { initializeGraphDoc, serializeGraphDoc } from "../yjsGraph.js";
import type { SerializedNode } from "@system-synthesis/shared";

describe("durable collaboration update log", () => {
  it("deduplicates updates and restores a document by replay", async () => {
    const boardId = `board-replay-${Date.now()}`;
    const source = new Y.Doc();
    source.getMap("state").set("value", 42);
    const update = Y.encodeStateAsUpdate(source);

    await appendCollaborationUpdate(boardId, update, "editor-user");
    await appendCollaborationUpdate(boardId, update, "editor-user");

    const stored = await loadCollaborationUpdates(boardId);
    expect(stored).toHaveLength(1);

    const restored = new Y.Doc();
    await expect(replayCollaborationUpdates(boardId, restored)).resolves.toBe(1);
    expect(restored.getMap("state").get("value")).toBe(42);
  });

  it("restores the same state after snapshot compaction", async () => {
    const boardId = `board-compact-${Date.now()}`;
    const source = new Y.Doc();
    source.getMap("state").set("beforeRestart", true);
    const first = Y.encodeStateAsUpdate(source);
    await appendCollaborationUpdate(boardId, first, "editor-user");
    await compactCollaborationDocument(boardId, source);

    source.getMap("state").set("afterSnapshot", "tail");
    const tail = Y.encodeStateAsUpdate(source);
    await appendCollaborationUpdate(boardId, tail, "editor-user");

    const restored = new Y.Doc();
    await replayCollaborationUpdates(boardId, restored);
    expect(restored.getMap("state").toJSON()).toEqual({
      beforeRestart: true,
      afterSnapshot: "tail",
    });
  });

  it("durably replaces graph state for a semantic version restore", async () => {
    const makeNode = (id: string): SerializedNode => ({
      id,
      type: "architectureNode",
      position: { x: 0, y: 0 },
      data: {
        label: id,
        nodeType: "service",
        status: "active",
        metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
      },
    });
    const boardId = `board-restore-${Date.now()}`;
    const current = { nodes: [makeNode("old")], edges: [] };
    const target = { nodes: [makeNode("restored")], edges: [] };
    const base = new Y.Doc();
    initializeGraphDoc(base, current.nodes, current.edges);

    const replacement = await replaceCollaborationState(boardId, current, target, "owner");
    const connectedClient = new Y.Doc();
    Y.applyUpdate(connectedClient, replacement.fullState);
    expect(serializeGraphDoc(connectedClient).nodes.map((node) => node.id)).toEqual(["restored"]);

    const restartedServer = new Y.Doc();
    await replayCollaborationUpdates(boardId, restartedServer);
    expect(serializeGraphDoc(restartedServer).nodes.map((node) => node.id)).toEqual(["restored"]);
    base.destroy();
    connectedClient.destroy();
    restartedServer.destroy();
  });
});
