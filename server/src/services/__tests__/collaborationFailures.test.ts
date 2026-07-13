import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pool: null as any,
  redisExec: vi.fn(),
}));

const redisMock = vi.hoisted(() => ({
  multi() {
    const chain = {
      xadd: () => chain,
      publish: () => chain,
      exec: (...args: any[]) => state.redisExec(...args),
    };
    return chain;
  },
}));

vi.mock("../db.js", () => ({ getPool: () => state.pool }));
vi.mock("../redis.js", () => ({ redis: redisMock }));

import { appendCollaborationUpdate } from "../collaborationUpdates.js";

function clientThat(failsInsert: boolean) {
  return {
    query: vi.fn(async (sql: string) => {
      if (failsInsert && sql.includes("INSERT INTO board_updates")) {
        throw new Error("postgres unavailable");
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

describe("collaboration storage failure policy", () => {
  beforeEach(() => {
    state.redisExec.mockReset();
  });

  it("keeps an accepted PostgreSQL write when Redis publication is unavailable", async () => {
    state.pool = { connect: vi.fn(async () => clientThat(false)) };
    state.redisExec.mockRejectedValue(new Error("redis unavailable"));

    await expect(
      appendCollaborationUpdate("board-redis-outage", new Uint8Array([1, 2, 3]), "editor")
    ).resolves.toBeUndefined();
  });

  it("fails closed when the authoritative PostgreSQL transaction is unavailable", async () => {
    state.pool = { connect: vi.fn(async () => clientThat(true)) };
    state.redisExec.mockResolvedValue([]);

    await expect(
      appendCollaborationUpdate("board-pg-outage", new Uint8Array([4, 5, 6]), "editor")
    ).rejects.toThrow("postgres unavailable");
    expect(state.redisExec).not.toHaveBeenCalled();
  });
});
