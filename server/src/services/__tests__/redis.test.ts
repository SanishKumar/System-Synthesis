import { describe, it, expect, vi, beforeEach } from "vitest";
import { getBoardState, saveBoardState, deleteBoard, listBoards, toggleBoardVisibility, createBoard } from "../../services/redis.js";

// Mock redis client entirely
vi.mock("ioredis", () => {
  return {
    Redis: vi.fn().mockImplementation(() => {
      return {
        on: vi.fn(),
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        keys: vi.fn(),
      };
    })
  };
});

describe("Redis Service (Fallback to MemoryStore)", () => {
  it("can save and retrieve a board state", async () => {
    const board = await createBoard("Test Board", "Description", "user1", "User 1");
    
    // Save some nodes
    await saveBoardState(board.id, [{ id: "n1", type: "architectureNode", position: {x:0, y:0}, data: { label: "N1", nodeType: "service", status: "active", metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] } } }], []);
    
    const retrieved = await getBoardState(board.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe("Test Board");
    expect(retrieved?.nodes.length).toBe(1);
  });

  it("can list boards and filter by visibility", async () => {
    const b1 = await createBoard("B1", "", "user1", "U1");
    await new Promise(r => setTimeout(r, 2));
    const b2 = await createBoard("B2", "", "user2", "U2");
    await new Promise(r => setTimeout(r, 2));
    const b3 = await createBoard("B3", "", "user2", "U2");

    await toggleBoardVisibility(b2.id, "user2"); // Make B2 public

    // user1 should see b1 (owned) and b2 (public), plus potentially the demo board
    const user1Boards = await listBoards("user1");
    const user1Ids = user1Boards.map(b => b.id);
    expect(user1Ids).toContain(b1.id);
    expect(user1Ids).toContain(b2.id);
    expect(user1Ids).not.toContain(b3.id);
    
    // user2 should see b2, b3 (owned)
    const user2Boards = await listBoards("user2");
    const user2Ids = user2Boards.map(b => b.id);
    expect(user2Ids).toContain(b2.id);
    expect(user2Ids).toContain(b3.id);
    expect(user2Ids).not.toContain(b1.id);
  });

  it("toggles public status correctly", async () => {
    const b = await createBoard("Toggle", "", "u1", "U1");
    
    const result1 = await toggleBoardVisibility(b.id, "u1");
    expect(result1!.changed).toBe(true);
    expect(result1!.board!.isPublic).toBe(true);
    
    const result2 = await toggleBoardVisibility(b.id, "u1");
    expect(result2!.changed).toBe(true);
    expect(result2!.board!.isPublic).toBe(false);
  });

  it("prevents non-owners from deleting a board", async () => {
    const b = await createBoard("Del", "", "u1", "U1");
    
    const success = await deleteBoard(b.id, "u2");
    expect(success).toBe(false);
    
    const stillExists = await getBoardState(b.id);
    expect(stillExists).not.toBeNull();
  });

  it("allows owner to delete a board", async () => {
    const b = await createBoard("Del2", "", "u1", "U1");
    
    const success = await deleteBoard(b.id, "u1");
    expect(success).toBe(true);
    
    const exists = await getBoardState(b.id);
    expect(exists).toBeNull();
  });
});
