import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  acceptBoardInvitation,
  createBoardInvitation,
  resolveBoardRole,
} from "../accessControl.js";
import type { BoardState } from "@system-synthesis/shared";

const demoBoard: BoardState = {
  id: "demo-ecommerce",
  name: "Global E-Commerce Platform",
  ownerId: "system",
  ownerName: "System Synthesis",
  isPublic: true,
  nodes: [],
  edges: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("board role resolution", () => {
  it("keeps the built-in public demo read-only for visitors", async () => {
    await expect(resolveBoardRole(demoBoard, "guest-visitor")).resolves.toBe("viewer");
  });

  it("keeps the system owner as the only demo owner", async () => {
    await expect(resolveBoardRole(demoBoard, "system")).resolves.toBe("owner");
  });
});

describe("time-limited board invitations", () => {
  it("rejects an expired invitation token", async () => {
    const invitation = await createBoardInvitation(
      "board-expired",
      "viewer",
      "owner-user",
      -1
    );
    await expect(acceptBoardInvitation(invitation.token, "viewer-user")).resolves.toBeNull();
  });

  it("accepts a valid token once and rejects replay", async () => {
    const invitation = await createBoardInvitation(
      "board-once",
      "editor",
      "owner-user",
      1
    );
    await expect(acceptBoardInvitation(invitation.token, "editor-user")).resolves.toEqual({
      boardId: "board-once",
      role: "editor",
    });
    await expect(acceptBoardInvitation(invitation.token, "another-user")).resolves.toBeNull();
  });
});
