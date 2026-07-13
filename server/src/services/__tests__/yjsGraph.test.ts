import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  initializeGraphDoc,
  patchSharedRecord,
  readSharedValue,
  type SharedRecord,
} from "../yjsGraph.js";
import type { SerializedNode } from "@system-synthesis/shared";

const initialNode: SerializedNode = {
  id: "node-1",
  type: "architectureNode",
  position: { x: 10, y: 20 },
  data: {
    label: "API",
    nodeType: "service",
    status: "active",
    metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
  },
};

function readNode(doc: Y.Doc): SerializedNode {
  return readSharedValue<SerializedNode>(doc.getMap<SharedRecord>("nodes").get("node-1"));
}

describe("granular Yjs graph representation", () => {
  it("merges a concurrent label edit and position edit without whole-node loss", () => {
    const seed = new Y.Doc();
    initializeGraphDoc(seed, [initialNode], []);
    const initialUpdate = Y.encodeStateAsUpdate(seed);

    const clientA = new Y.Doc();
    const clientB = new Y.Doc();
    Y.applyUpdate(clientA, initialUpdate);
    Y.applyUpdate(clientB, initialUpdate);

    let updateA: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let updateB: Uint8Array<ArrayBufferLike> = new Uint8Array();
    clientA.once("update", (update) => { updateA = update; });
    clientB.once("update", (update) => { updateB = update; });

    clientA.transact(() => {
      const node = clientA.getMap<SharedRecord>("nodes").get("node-1")!;
      patchSharedRecord(node.get("data") as SharedRecord, { label: "Renamed API" });
    }, "client-a");
    clientB.transact(() => {
      const node = clientB.getMap<SharedRecord>("nodes").get("node-1")!;
      patchSharedRecord(node.get("position") as SharedRecord, { x: 500, y: 600 });
    }, "client-b");

    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);
    Y.applyUpdate(clientA, updateB); // duplicate delivery is idempotent

    expect(readNode(clientA)).toEqual(readNode(clientB));
    expect(readNode(clientA).data.label).toBe("Renamed API");
    expect(readNode(clientA).position).toEqual({ x: 500, y: 600 });
  });

  it("undoes only local origins and preserves a concurrent remote field change", () => {
    const doc = new Y.Doc();
    initializeGraphDoc(doc, [initialNode], []);
    const nodes = doc.getMap<SharedRecord>("nodes");
    const manager = new Y.UndoManager(nodes, { trackedOrigins: new Set(["local"]) });

    doc.transact(() => {
      patchSharedRecord(nodes.get("node-1")!.get("data") as SharedRecord, { label: "Local rename" });
    }, "local");
    doc.transact(() => {
      patchSharedRecord(nodes.get("node-1")!.get("position") as SharedRecord, { x: 900 });
    }, "remote");

    manager.undo();
    expect(readNode(doc).data.label).toBe("API");
    expect(readNode(doc).position.x).toBe(900);
  });
});
