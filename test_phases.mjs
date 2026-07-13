import { io } from "socket.io-client";
import * as Y from "yjs";
import { createSharedRecord } from "./server/dist/services/yjsGraph.js";

const API_URL = process.env.API_URL || "http://localhost:4000";
let failures = 0;

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message, error) {
  failures += 1;
  console.error(`FAIL  ${message}${error ? `: ${error.message || error}` : ""}`);
}

async function check(message, task) {
  try {
    await task();
    pass(message);
  } catch (error) {
    fail(message, error);
  }
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${body?.error || text}`);
  return body;
}

function waitFor(socket, event, predicate = () => true, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(args.length > 1 ? args : args[0]);
    };
    socket.on(event, listener);
  });
}

async function issueGuest(userName) {
  return jsonRequest("/api/auth/guest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName }),
  });
}

async function main() {
  let owner;
  let viewer;
  let boardId = "";

  await check("issue verified guest identities", async () => {
    owner = await issueGuest("Integration Owner");
    viewer = await issueGuest("Integration Viewer");
    if (!owner.token || !viewer.token) throw new Error("JWT missing");
  });

  await check("create a private owner-scoped board", async () => {
    const board = await jsonRequest("/api/boards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Integration Board", description: "CI verification" }),
    });
    boardId = board.id;
    if (board.role !== "owner" || board.isPublic) throw new Error("Incorrect initial access state");
  });

  await check("deny private board access to another identity", async () => {
    const response = await fetch(`${API_URL}/api/boards/${boardId}`, {
      headers: { Authorization: `Bearer ${viewer.token}` },
    });
    if (response.status !== 403) throw new Error(`Expected 403, received ${response.status}`);
  });

  await check("make the board public and expose it as viewer-only", async () => {
    await jsonRequest(`/api/boards/${boardId}/visibility`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const board = await jsonRequest(`/api/boards/${boardId}`, {
      headers: { Authorization: `Bearer ${viewer.token}` },
    });
    if (board.role !== "viewer") throw new Error(`Expected viewer, received ${board.role}`);
  });

  await check("synchronize a granular Yjs mutation between two owner sessions", async () => {
    const first = io(API_URL, { auth: { token: owner.token }, transports: ["websocket"] });
    const second = io(API_URL, { auth: { token: owner.token }, transports: ["websocket"] });
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    try {
      await Promise.all([waitFor(first, "connect"), waitFor(second, "connect")]);
      const firstState = waitFor(first, "yjs_full_state", () => true, 10_000);
      const secondState = waitFor(second, "yjs_full_state", () => true, 10_000);
      first.emit("join_board", { boardId });
      second.emit("join_board", { boardId });
      const [fullA, fullB] = await Promise.all([firstState, secondState]);
      Y.applyUpdate(docA, new Uint8Array(fullA));
      Y.applyUpdate(docB, new Uint8Array(fullB));

      let localUpdate;
      docA.once("update", (update, origin) => {
        if (origin === "integration") localUpdate = update;
      });
      docA.transact(() => {
        docA.getMap("nodes").set(
          "integration-node",
          createSharedRecord({
            id: "integration-node",
            type: "architectureNode",
            position: { x: 100, y: 150 },
            data: {
              label: "Integration API",
              nodeType: "service",
              status: "active",
              metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
            },
          })
        );
      }, "integration");
      if (!localUpdate) throw new Error("No Yjs update captured");

      const remoteUpdate = waitFor(second, "yjs_update", () => true, 10_000);
      let rejection = "";
      const captureRejection = (message) => { rejection = String(message); };
      first.once("error", captureRejection);
      first.emit("yjs_update", { boardId, update: Array.from(localUpdate) });
      let payload;
      try {
        payload = await remoteUpdate;
      } catch (error) {
        if (rejection) throw new Error(`Server rejected owner update: ${rejection}`);
        throw error;
      } finally {
        first.off("error", captureRejection);
      }
      Y.applyUpdate(docB, new Uint8Array(payload.update));
      if (!docB.getMap("nodes").has("integration-node")) throw new Error("Second client did not converge");
    } finally {
      docA.destroy();
      docB.destroy();
      first.disconnect();
      second.disconnect();
    }
  });

  await check("reject a public viewer WebSocket mutation", async () => {
    const socket = io(API_URL, { auth: { token: viewer.token }, transports: ["websocket"] });
    await waitFor(socket, "connect");
    const fullState = waitFor(socket, "yjs_full_state");
    socket.emit("join_board", { boardId, identityId: owner.user.userId });
    await fullState;
    const error = waitFor(socket, "error", (message) => message.includes("Editor role required"));
    socket.emit("yjs_update", { boardId, update: [0] });
    await error;
    socket.disconnect();
  });

  await check("run deterministic validation and authorized export", async () => {
    const validation = await jsonRequest(`/api/boards/${boardId}/validate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    if (!Array.isArray(validation.issues)) throw new Error("Validation result missing issues");
    const response = await fetch(`${API_URL}/api/export/docker-compose`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ boardId }),
    });
    if (!response.ok || !(await response.text()).includes("services:")) {
      throw new Error("Docker Compose export failed");
    }
  });

  if (boardId) {
    await check("delete the integration board", async () => {
      await jsonRequest(`/api/boards/${boardId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${owner.token}` },
      });
    });
  }

  console.log(`\nIntegration result: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  fail("unhandled integration failure", error);
  process.exitCode = 1;
});
