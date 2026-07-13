import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getBoardState: vi.fn(),
  saveBoardState: vi.fn(),
  resolveBoardRole: vi.fn(),
  recordAudit: vi.fn(),
  analyzeArchitecture: vi.fn(),
}));

vi.mock("../../middleware/auth.js", () => ({
  verifyToken: mocks.verifyToken,
}));
vi.mock("../../services/boardRepository.js", () => ({
  getBoardState: mocks.getBoardState,
  saveBoardState: mocks.saveBoardState,
}));
vi.mock("../../services/accessControl.js", () => ({
  resolveBoardRole: mocks.resolveBoardRole,
  recordAudit: mocks.recordAudit,
  roleAllows: (actual: string | null, required: string) => {
    const weight: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
    return !!actual && weight[actual] >= weight[required];
  },
}));
vi.mock("../../services/ai.js", () => ({
  analyzeArchitecture: mocks.analyzeArchitecture,
}));

import {
  MAX_YJS_UPDATE_BYTES,
  registerSocketHandlers,
} from "../../socket/handlers.js";

const board = {
  id: "board-secure",
  name: "Secure board",
  ownerId: "owner-user",
  ownerName: "Owner",
  isPublic: true,
  nodes: [],
  edges: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function createHarness(token = "valid-token") {
  let middleware: Function | undefined;
  let connectionHandler: Function | undefined;
  const io = {
    use: vi.fn((handler: Function) => {
      middleware = handler;
      return io;
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (event === "connection") connectionHandler = handler;
      return io;
    }),
  } as any;

  registerSocketHandlers(io);
  const handlers = new Map<string, Function>();
  const roomEmit = vi.fn();
  const socket: any = {
    id: `socket-${Math.random()}`,
    data: {},
    rooms: new Set<string>(),
    handshake: { auth: token ? { token } : {} },
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: vi.fn(),
    to: vi.fn(() => ({ emit: roomEmit })),
    join: vi.fn(async (room: string) => socket.rooms.add(room)),
    leave: vi.fn(async (room: string) => socket.rooms.delete(room)),
  };
  socket.rooms.add(socket.id);

  return {
    middleware: middleware!,
    connect() {
      connectionHandler!(socket);
      return socket;
    },
    socket,
    handlers,
    roomEmit,
  };
}

describe("Socket authorization and payload boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyToken.mockReturnValue({ userId: "jwt-viewer", userName: "Verified User" });
    mocks.getBoardState.mockResolvedValue(board);
    mocks.resolveBoardRole.mockResolvedValue("viewer");
    mocks.recordAudit.mockResolvedValue(undefined);
    mocks.saveBoardState.mockResolvedValue(undefined);
  });

  it("rejects a socket without a verified JWT", () => {
    mocks.verifyToken.mockReturnValue(null);
    const harness = createHarness("");
    const next = vi.fn();
    harness.middleware(harness.socket, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication required");
  });

  it("registers only the hardened event surface after authentication", () => {
    const harness = createHarness();
    const next = vi.fn();
    harness.middleware(harness.socket, next);
    expect(next).toHaveBeenCalledWith();
    harness.connect();
    expect([...harness.handlers.keys()]).toEqual(
      expect.arrayContaining([
        "join_board",
        "leave_board",
        "yjs_update",
        "cursor_moved",
        "request_ai_analysis",
        "disconnect",
      ])
    );
    expect(harness.handlers.has("board_operation")).toBe(false);
  });

  it("ignores a spoofed client identity and resolves access from the JWT user", async () => {
    const harness = createHarness();
    harness.middleware(harness.socket, vi.fn());
    harness.connect();
    await harness.handlers.get("join_board")!({
      boardId: board.id,
      identityId: "owner-user",
      userName: "Spoofed Owner",
    });
    expect(mocks.resolveBoardRole).toHaveBeenCalledWith(board, "jwt-viewer");
    expect(harness.socket.data.userId).toBe("jwt-viewer");
  });

  it("rejects a viewer mutation", async () => {
    const harness = createHarness();
    harness.middleware(harness.socket, vi.fn());
    harness.connect();
    await harness.handlers.get("join_board")!({ boardId: board.id });
    await harness.handlers.get("yjs_update")!({ boardId: board.id, update: [0] });
    expect(harness.socket.emit).toHaveBeenCalledWith(
      "error",
      "Editor role required for board mutations"
    );
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      board.id,
      "jwt-viewer",
      "mutation.denied",
      expect.any(Object)
    );
  });

  it("rejects a mutation for a board the user never joined", async () => {
    mocks.resolveBoardRole.mockResolvedValue("editor");
    const harness = createHarness();
    harness.middleware(harness.socket, vi.fn());
    harness.connect();
    await harness.handlers.get("yjs_update")!({ boardId: board.id, update: [0] });
    expect(harness.socket.emit).toHaveBeenCalledWith(
      "error",
      "Editor role required for board mutations"
    );
  });

  it("rejects malformed and oversized Yjs updates before applying them", async () => {
    mocks.resolveBoardRole.mockResolvedValue("editor");
    const harness = createHarness();
    harness.middleware(harness.socket, vi.fn());
    harness.connect();
    await harness.handlers.get("join_board")!({ boardId: board.id });

    await harness.handlers.get("yjs_update")!({ boardId: board.id, update: [999] });
    await harness.handlers.get("yjs_update")!({
      boardId: board.id,
      update: new Array(MAX_YJS_UPDATE_BYTES + 1).fill(0),
    });

    const errors = harness.socket.emit.mock.calls.filter((call: any[]) => call[0] === "error");
    expect(errors).toContainEqual(["error", "Malformed or oversized Yjs update"]);
    expect(errors.filter((call: any[]) => call[1] === "Malformed or oversized Yjs update")).toHaveLength(2);
  });

  it("accepts a valid editor Yjs update and broadcasts only to the joined room", async () => {
    mocks.resolveBoardRole.mockResolvedValue("editor");
    const harness = createHarness();
    harness.middleware(harness.socket, vi.fn());
    harness.connect();
    await harness.handlers.get("join_board")!({ boardId: board.id });

    const doc = new Y.Doc();
    doc.getMap("nodes").set("node-1", { id: "node-1" });
    const update = Array.from(Y.encodeStateAsUpdate(doc));
    await harness.handlers.get("yjs_update")!({ boardId: board.id, update });

    expect(harness.socket.to).toHaveBeenCalledWith(board.id);
    expect(harness.roomEmit).toHaveBeenCalledWith(
      "yjs_update",
      expect.objectContaining({ userId: harness.socket.id })
    );
  });
});
