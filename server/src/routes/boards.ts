import { Router } from "express";
import {
  listBoards,
  getBoardState,
  createBoard,
  updateBoardMeta,
  deleteBoard,
  getMetrics,
  toggleBoardVisibility,
} from "../services/redis.js";

const router = Router();

/**
 * Extract user identity from request headers.
 */
function getUserFromHeaders(req: any): { userId: string; userName: string } {
  return {
    userId: (req.headers["x-user-id"] as string) || "",
    userName: (req.headers["x-user-name"] as string) || "Anonymous",
  };
}

/**
 * GET /api/boards/metrics — Real computed metrics (scoped to user)
 * Must be defined BEFORE /:id to avoid route conflict
 */
router.get("/metrics", async (req, res) => {
  try {
    const { userId } = getUserFromHeaders(req);
    const metrics = await getMetrics(userId || undefined);
    res.json(metrics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/boards — List boards visible to the requesting user
 */
router.get("/", async (req, res) => {
  try {
    const { userId } = getUserFromHeaders(req);
    const boards = await listBoards(userId || undefined);
    res.json({
      boards: boards
        .map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          ownerId: b.ownerId,
          ownerName: b.ownerName,
          isPublic: b.isPublic,
          nodeCount: b.nodes.length,
          edgeCount: b.edges.length,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        }))
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        ),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/boards/:id — Get a specific board (checks access)
 */
router.get("/:id", async (req, res) => {
  try {
    const { userId } = getUserFromHeaders(req);
    const board = await getBoardState(req.params.id);
    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    // Access check: must be owner or board must be public
    if (!board.isPublic && board.ownerId !== userId && board.ownerId !== "system") {
      return res.status(403).json({ error: "Access denied — this board is private" });
    }

    res.json(board);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/boards — Create a new board (owned by the requesting user)
 */
router.post("/", async (req, res) => {
  try {
    const { userId, userName } = getUserFromHeaders(req);
    const { name, description } = req.body;
    const board = await createBoard(
      name || "Untitled Board",
      description || "",
      userId || "system",
      userName
    );
    res.status(201).json(board);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/boards/:id — Update board metadata (owner only)
 */
router.put("/:id", async (req, res) => {
  try {
    const { userId } = getUserFromHeaders(req);
    const existing = await getBoardState(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Board not found" });
    }

    // Only owner can update metadata
    if (existing.ownerId !== userId && existing.ownerId !== "system") {
      return res.status(403).json({ error: "Only the board owner can update this board" });
    }

    const { name, description } = req.body;
    const board = await updateBoardMeta(req.params.id, name, description);
    res.json(board);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/boards/:id/visibility — Toggle public/private (owner only)
 * Also emits board_access_revoked to connected non-owners if going private.
 */
router.patch("/:id/visibility", async (req, res) => {
  try {
    const { userId } = getUserFromHeaders(req);
    const result = await toggleBoardVisibility(req.params.id, userId);

    if (!result) {
      return res.status(404).json({ error: "Board not found" });
    }
    if (!result.changed) {
      return res.status(403).json({ error: "Only the board owner can change visibility" });
    }

    // If the board was just made private, emit board_access_revoked to the room
    // so non-owners get kicked out in real-time
    if (!result.board.isPublic) {
      const io = req.app.get("io");
      if (io) {
        io.to(req.params.id).emit("board_access_revoked", {
          boardId: req.params.id,
          ownerId: result.board.ownerId,
        });
      }
    }

    res.json({
      id: result.board.id,
      isPublic: result.board.isPublic,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/boards/:id — Delete a board (owner only)
 */
router.delete("/:id", async (req, res) => {
  try {
    const { userId } = getUserFromHeaders(req);
    const deleted = await deleteBoard(req.params.id, userId);
    if (!deleted) {
      return res.status(403).json({ error: "Only the board owner can delete this board" });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
