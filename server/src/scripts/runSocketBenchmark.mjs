import os from "node:os";
import { createHash } from "node:crypto";
import { io } from "socket.io-client";
import * as Y from "yjs";
import { createSharedRecord, serializeGraphDoc } from "../../dist/services/yjsGraph.js";

const apiUrl = process.env.API_URL || "http://localhost:4000";
const clientCount = Number.parseInt(process.env.BENCHMARK_CLIENTS || "10", 10);
const updateCount = Number.parseInt(process.env.BENCHMARK_UPDATES || "50", 10);
const updateIntervalMs = Number.parseInt(process.env.BENCHMARK_INTERVAL_MS || "20", 10);

function waitFor(socket, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (payload) => {
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}: ${body?.error || text}`);
  return body;
}

function hashUpdate(update) {
  return createHash("sha256").update(new Uint8Array(update)).digest("hex");
}

function hashBenchmarkState(doc) {
  const graph = serializeGraphDoc(doc);
  const ordered = graph.nodes
    .map((node) => node.id)
    .sort();
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)].toFixed(2));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  if (clientCount < 2 || updateCount < 1) throw new Error("Use at least two clients and one update");
  const guest = await request("/api/auth/guest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName: "Socket Benchmark" }),
  });
  const headers = { Authorization: `Bearer ${guest.token}`, "Content-Type": "application/json" };
  const board = await request("/api/boards", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Socket benchmark", description: "Ephemeral propagation benchmark" }),
  });

  const sockets = [];
  const docs = [];
  const sentAt = new Map();
  const latencies = [];
  let received = 0;
  const socketErrors = [];
  try {
    for (let index = 0; index < clientCount; index += 1) {
      const socket = io(apiUrl, { auth: { token: guest.token }, transports: ["websocket"] });
      await waitFor(socket, "connect");
      const fullState = waitFor(socket, "yjs_full_state");
      socket.emit("join_board", { boardId: board.id });
      const state = await fullState;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(state), "initial");
      socket.on("yjs_update", (payload) => {
        const update = new Uint8Array(payload.update);
        Y.applyUpdate(doc, update, "network");
        const started = sentAt.get(hashUpdate(update));
        if (started !== undefined) {
          latencies.push(performance.now() - started);
          received += 1;
        }
      });
      socket.on("error", (message) => socketErrors.push(String(message)));
      sockets.push(socket);
      docs.push(doc);
    }

    const source = sockets[0];
    const sourceDoc = docs[0];
    for (let index = 0; index < updateCount; index += 1) {
      let update;
      const listener = (value, origin) => {
        if (origin === "benchmark") update = value.slice();
      };
      sourceDoc.on("update", listener);
      sourceDoc.transact(() => {
        const id = `benchmark-node-${String(index).padStart(5, "0")}`;
        sourceDoc.getMap("nodes").set(id, createSharedRecord({
          id,
          type: "architectureNode",
          position: { x: index * 10, y: index * 5 },
          data: {
            label: `Benchmark node ${index}`,
            nodeType: "service",
            status: "active",
            metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
          },
        }));
      }, "benchmark");
      sourceDoc.off("update", listener);
      const hash = hashUpdate(update);
      sentAt.set(hash, performance.now());
      source.emit("yjs_update", { boardId: board.id, update: Array.from(update) });
      await sleep(updateIntervalMs);
    }

    const expected = updateCount * (clientCount - 1);
    const deadline = Date.now() + 15_000;
    while (received < expected && Date.now() < deadline) await sleep(25);

    const reconnectStarted = performance.now();
    const reconnect = io(apiUrl, { auth: { token: guest.token }, transports: ["websocket"] });
    await waitFor(reconnect, "connect");
    const restoredState = waitFor(reconnect, "yjs_full_state");
    reconnect.emit("join_board", { boardId: board.id });
    const state = await restoredState;
    const reconnectFullStateMs = performance.now() - reconnectStarted;
    const serverDoc = new Y.Doc();
    Y.applyUpdate(serverDoc, new Uint8Array(state));

    const hashes = docs.map(hashBenchmarkState);
    const serverHash = hashBenchmarkState(serverDoc);
    const droppedDeliveries = Math.max(0, expected - received);
    const result = {
      benchmark: "socket.io propagation",
      timestamp: new Date().toISOString(),
      configuration: {
        clients: clientCount,
        updates: updateCount,
        intervalMs: updateIntervalMs,
        expectedDeliveries: expected,
        storageMode: process.env.BENCHMARK_STORAGE_MODE || "unspecified",
      },
      result: {
        receivedDeliveries: received,
        droppedDeliveries,
        convergence: hashes.every((hash) => hash === serverHash),
        p50PropagationMs: percentile(latencies, 0.5),
        p95PropagationMs: percentile(latencies, 0.95),
        p99PropagationMs: percentile(latencies, 0.99),
        reconnectFullStateMs: Number(reconnectFullStateMs.toFixed(2)),
        socketErrors,
        serverHash,
      },
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      },
    };
    console.log(JSON.stringify(result, null, 2));
    reconnect.disconnect();
    serverDoc.destroy();
    if (droppedDeliveries > 0 || !result.result.convergence) process.exitCode = 1;
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    docs.forEach((doc) => doc.destroy());
    await fetch(`${apiUrl}/api/boards/${board.id}`, { method: "DELETE", headers }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
