import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ getPool: () => null }));

import {
  acceptBoardInvitation,
  createBoardInvitation,
} from "../accessControl.js";

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
