import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedNode } from "@system-synthesis/shared";

const mocked = vi.hoisted(() => ({ pool: null as any }));
vi.mock("../db.js", () => ({
  getPool: () => mocked.pool,
  isDbAvailable: () => true,
}));
vi.mock("../redis.js", () => ({
  getBoardState: vi.fn(),
  saveBoardState: vi.fn(),
  createBoard: vi.fn(),
  updateBoardMeta: vi.fn(),
  deleteBoard: vi.fn(),
  listBoards: vi.fn(),
  getMetrics: vi.fn(),
  toggleBoardVisibility: vi.fn(),
}));

import { pgSaveSnapshot } from "../boardRepository.js";

function testNode(id: string): SerializedNode {
  return {
    id,
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      nodeType: "service",
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
    },
  };
}

describe("transactional version allocation", () => {
  beforeEach(() => {
    const committed: Array<{ version: number; data: any }> = [];
    let locked = false;
    const waiting: Array<() => void> = [];
    const acquire = async () => {
      if (!locked) {
        locked = true;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    };
    const release = () => {
      const next = waiting.shift();
      if (next) next();
      else locked = false;
    };

    mocked.pool = {
      connect: vi.fn(async () => {
        let pending: { version: number; data: any } | null = null;
        let ownsLock = false;
        return {
          query: vi.fn(async (sql: string, params: any[] = []) => {
            if (sql.includes("pg_advisory_xact_lock")) {
              await acquire();
              ownsLock = true;
              return { rows: [] };
            }
            if (sql.includes("SELECT version, data FROM board_snapshots")) {
              const latest = committed.at(-1);
              return { rows: latest ? [latest] : [] };
            }
            if (sql.includes("INSERT INTO board_snapshots")) {
              pending = { version: Number(params[1]), data: JSON.parse(params[2]) };
              return { rows: [{ created_at: new Date("2026-01-01T00:00:00.000Z") }] };
            }
            if (sql === "COMMIT") {
              if (pending) committed.push(pending);
              if (ownsLock) release();
              ownsLock = false;
              return { rows: [] };
            }
            if (sql === "ROLLBACK") {
              if (ownsLock) release();
              ownsLock = false;
              return { rows: [] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        };
      }),
    };
  });

  it("serializes simultaneous checkpoints into distinct versions", async () => {
    const [first, second] = await Promise.all([
      pgSaveSnapshot("board-race", [testNode("first")], [], { name: "First" }),
      pgSaveSnapshot("board-race", [testNode("second")], [], { name: "Second" }),
    ]);

    expect([first?.version, second?.version].sort()).toEqual([1, 2]);
    expect(second?.parentVersion).toBe(1);
  });
});

