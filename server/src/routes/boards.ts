import { Router } from "express";
import {
  listBoards,
  getBoardState,
  createBoard,
  updateBoardMeta,
  deleteBoard,
  getMetrics,
  toggleBoardVisibility,
  listBoardVersions,
  getBoardVersion,
  restoreBoardVersion,
} from "../services/boardRepository.js";
import { validateArchitecture } from "../services/validation.js";

const router = Router();

/**
 * Extract user identity from req.user (set by auth middleware)
 * or legacy headers as fallback.
 */
function getUserFromRequest(req: any): { userId: string; userName: string } {
  if (req.user) {
    return { userId: req.user.userId, userName: req.user.userName };
  }
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
    const { userId } = getUserFromRequest(req);
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
    const { userId } = getUserFromRequest(req);
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
    const { userId } = getUserFromRequest(req);
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
    const { userId, userName } = getUserFromRequest(req);
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
    const { userId } = getUserFromRequest(req);
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
    const { userId } = getUserFromRequest(req);
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
    const { userId } = getUserFromRequest(req);
    const deleted = await deleteBoard(req.params.id, userId);
    if (!deleted) {
      return res.status(403).json({ error: "Only the board owner can delete this board" });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Version History Endpoints
// ============================================================

/**
 * GET /api/boards/:id/versions — List all snapshots for a board
 */
router.get("/:id/versions", async (req, res) => {
  try {
    const { userId } = getUserFromRequest(req);
    const board = await getBoardState(req.params.id);
    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    // Access check
    if (!board.isPublic && board.ownerId !== userId && board.ownerId !== "system") {
      return res.status(403).json({ error: "Access denied" });
    }

    const versions = await listBoardVersions(req.params.id);
    res.json({ versions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/boards/:id/versions/:version — Get a specific snapshot
 */
router.get("/:id/versions/:version", async (req, res) => {
  try {
    const { userId } = getUserFromRequest(req);
    const board = await getBoardState(req.params.id);
    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    // Access check
    if (!board.isPublic && board.ownerId !== userId && board.ownerId !== "system") {
      return res.status(403).json({ error: "Access denied" });
    }

    const version = parseInt(req.params.version, 10);
    if (isNaN(version)) {
      return res.status(400).json({ error: "Invalid version number" });
    }

    const snapshot = await getBoardVersion(req.params.id, version);
    if (!snapshot) {
      return res.status(404).json({ error: "Version not found" });
    }

    res.json(snapshot);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/boards/:id/versions/:version/restore — Restore a previous version
 */
router.post("/:id/versions/:version/restore", async (req, res) => {
  try {
    const { userId } = getUserFromRequest(req);
    const board = await getBoardState(req.params.id);
    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    // Only owner can restore
    if (board.ownerId !== userId && board.ownerId !== "system") {
      return res.status(403).json({ error: "Only the board owner can restore versions" });
    }

    const version = parseInt(req.params.version, 10);
    if (isNaN(version)) {
      return res.status(400).json({ error: "Invalid version number" });
    }

    const restored = await restoreBoardVersion(req.params.id, version, userId);
    if (!restored) {
      return res.status(404).json({ error: "Version not found" });
    }

    // Broadcast the restored state to all connected clients
    const io = req.app.get("io");
    if (io) {
      io.to(req.params.id).emit("board_state", restored);
    }

    res.json({ success: true, board: restored });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
// ============================================================
// Validation Endpoints
// ============================================================

/**
 * POST /api/boards/:id/validate — Run validation on a board's current state
 */
router.post("/:id/validate", async (req, res) => {
  try {
    const { userId } = getUserFromRequest(req);
    const board = await getBoardState(req.params.id);
    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    // Access check
    if (!board.isPublic && board.ownerId !== userId && board.ownerId !== "system") {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = validateArchitecture(board.nodes, board.edges);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/boards/validate — Run validation on arbitrary node/edge data (client-side)
 * Body: { nodes: SerializedNode[], edges: SerializedEdge[] }
 */
router.post("/validate", async (req, res) => {
  try {
    const { nodes, edges } = req.body;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return res.status(400).json({ error: "nodes and edges arrays required" });
    }

    const result = validateArchitecture(nodes, edges);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
