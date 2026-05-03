import type {
  BoardState,
  SerializedNode,
  SerializedEdge,
} from "@system-synthesis/shared";

// In-memory store as fallback when Redis is unavailable
const memoryStore = new Map<string, string>();

// Demo board data
const demoBoardState: BoardState = {
  id: "demo-board",
  name: "Production Architecture",
  description: "Microservices production cluster",
  ownerId: "system",
  ownerName: "System Synthesis",
  isPublic: true,
  nodes: [
    {
      id: "gateway-1",
      type: "architectureNode",
      position: { x: 350, y: 50 },
      data: {
        label: "API Gateway",
        subtitle: "Kong / Nginx\nRate Limit: 10k/min",
        nodeType: "gateway",
        status: "active",
        metadata: {
          notes: "Main entry point for all client requests.",
          links: ["https://docs.konghq.com"],
          codeSnippet: "",
          attachedFiles: [],
        },
      },
    },
    {
      id: "auth-1",
      type: "architectureNode",
      position: { x: 100, y: 220 },
      data: {
        label: "Auth Service",
        subtitle: "Node.js / Express\nPods: 3/3",
        nodeType: "service",
        status: "active",
        metadata: {
          notes: "JWT-based authentication service.",
          links: [],
          codeSnippet: "",
          attachedFiles: [],
        },
      },
    },
    {
      id: "user-db",
      type: "architectureNode",
      position: { x: 100, y: 420 },
      data: {
        label: "User DB",
        subtitle: "PostgreSQL v14\nReplica: Active",
        nodeType: "database",
        status: "active",
        metadata: {
          notes: "Primary user database with read replicas.",
          links: [],
          codeSnippet: "",
          attachedFiles: [],
        },
      },
    },
  ],
  edges: [
    { id: "e-gw-auth", source: "gateway-1", target: "auth-1" },
    { id: "e-auth-db", source: "auth-1", target: "user-db" },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let redisClient: any = null;
const serverStartTime = Date.now();

/**
 * Try to connect to Redis. Falls back to in-memory store silently.
 */
export async function initRedis(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("  ⚡ Redis URL not configured — using in-memory store");
    memoryStore.set(`board:demo-board`, JSON.stringify(demoBoardState));
    return;
  }

  try {
    const Redis = (await import("ioredis")).default;
    
    const isTls = redisUrl.startsWith("rediss://");
    
    redisClient = new Redis(redisUrl, {
      family: 0, // Crucial for Upstash on Render: Force IPv4
      tls: isTls ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.log("  ⚠ Redis connection failed — falling back to in-memory store");
          redisClient = null;
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    });

    redisClient.on("connect", () => {
      console.log("  ✅ Redis connected");
    });

    redisClient.on("error", (err: Error) => {
      console.error("  ⚠ Redis error:", err.message);
    });
  } catch (err) {
    console.log("  ⚠ Redis module not available — using in-memory store");
    memoryStore.set(`board:demo-board`, JSON.stringify(demoBoardState));
  }
}

/**
 * Get board state by ID.
 */
export async function getBoardState(boardId: string): Promise<BoardState | null> {
  const key = `board:${boardId}`;

  if (redisClient) {
    try {
      const data = await redisClient.get(key);
      if (data) return migrateBoardState(JSON.parse(data));
    } catch {
      // fallback
    }
  }

  const data = memoryStore.get(key);
  if (data) return migrateBoardState(JSON.parse(data));

  if (boardId === "demo-board") {
    memoryStore.set(key, JSON.stringify(demoBoardState));
    return demoBoardState;
  }

  return null;
}

/**
 * Migrate old board state that's missing new fields.
 */
function migrateBoardState(board: any): BoardState {
  return {
    ...board,
    ownerId: board.ownerId || "system",
    ownerName: board.ownerName || "Unknown",
    isPublic: board.isPublic !== undefined ? board.isPublic : true,
  };
}

/**
 * Save board state (preserves ownership fields).
 */
export async function saveBoardState(
  boardId: string,
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): Promise<void> {
  const key = `board:${boardId}`;
  const existing = await getBoardState(boardId);

  const state: BoardState = {
    id: boardId,
    name: existing?.name || "Untitled Board",
    description: existing?.description,
    ownerId: existing?.ownerId || "system",
    ownerName: existing?.ownerName || "Unknown",
    isPublic: existing?.isPublic !== undefined ? existing.isPublic : false,
    nodes,
    edges,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(state);

  if (redisClient) {
    try {
      await redisClient.set(key, serialized);
      await redisClient.expire(key, 86400);
      return;
    } catch {
      // fallback
    }
  }

  memoryStore.set(key, serialized);
}

/**
 * Create a new board with ownership.
 */
export async function createBoard(
  name: string,
  description: string | undefined,
  ownerId: string,
  ownerName: string
): Promise<BoardState> {
  const id = `board-${Date.now()}`;
  const state: BoardState = {
    id,
    name: name || "Untitled Board",
    description: description || "",
    ownerId,
    ownerName,
    isPublic: false, // Private by default
    nodes: [],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const key = `board:${id}`;
  const serialized = JSON.stringify(state);

  if (redisClient) {
    try {
      await redisClient.set(key, serialized);
      await redisClient.expire(key, 86400);
      return state;
    } catch {
      // fallback
    }
  }

  memoryStore.set(key, serialized);
  return state;
}

/**
 * Update board metadata (name, description) without touching nodes/edges.
 */
export async function updateBoardMeta(
  boardId: string,
  name?: string,
  description?: string
): Promise<BoardState | null> {
  const existing = await getBoardState(boardId);
  if (!existing) return null;

  if (name !== undefined) existing.name = name;
  if (description !== undefined) existing.description = description;
  existing.updatedAt = new Date().toISOString();

  const key = `board:${boardId}`;
  const serialized = JSON.stringify(existing);

  if (redisClient) {
    try {
      await redisClient.set(key, serialized);
      return existing;
    } catch {
      // fallback
    }
  }

  memoryStore.set(key, serialized);
  return existing;
}

/**
 * Toggle board public/private visibility. Only the owner can do this.
 */
export async function toggleBoardVisibility(
  boardId: string,
  requesterId: string
): Promise<{ board: BoardState; changed: boolean } | null> {
  const board = await getBoardState(boardId);
  if (!board) return null;

  // Only the owner can toggle visibility
  if (board.ownerId !== requesterId && board.ownerId !== "system") {
    return { board, changed: false };
  }

  board.isPublic = !board.isPublic;
  board.updatedAt = new Date().toISOString();

  const key = `board:${boardId}`;
  const serialized = JSON.stringify(board);

  if (redisClient) {
    try {
      await redisClient.set(key, serialized);
    } catch {
      memoryStore.set(key, serialized);
    }
  } else {
    memoryStore.set(key, serialized);
  }

  return { board, changed: true };
}

/**
 * Delete a board. Only the owner can do this.
 */
export async function deleteBoard(boardId: string, requesterId?: string): Promise<boolean> {
  if (requesterId) {
    const board = await getBoardState(boardId);
    if (board && board.ownerId !== requesterId && board.ownerId !== "system") {
      return false; // Not the owner
    }
  }

  const key = `board:${boardId}`;

  if (redisClient) {
    try {
      await redisClient.del(key);
      return true;
    } catch {
      // fallback
    }
  }

  return memoryStore.delete(key);
}

/**
 * List boards visible to a specific user.
 * Returns boards where: ownerId matches OR isPublic === true.
 */
export async function listBoards(requesterId?: string): Promise<BoardState[]> {
  let allBoards: BoardState[] = [];

  if (redisClient) {
    try {
      const keys = await redisClient.keys("board:*");
      for (const key of keys) {
        const data = await redisClient.get(key);
        if (data) allBoards.push(migrateBoardState(JSON.parse(data)));
      }
    } catch {
      // fallback to memory
      for (const [key, value] of memoryStore.entries()) {
        if (key.startsWith("board:")) {
          allBoards.push(migrateBoardState(JSON.parse(value)));
        }
      }
    }
  } else {
    for (const [key, value] of memoryStore.entries()) {
      if (key.startsWith("board:")) {
        allBoards.push(migrateBoardState(JSON.parse(value)));
      }
    }
  }

  // Ensure demo board exists on first load
  if (allBoards.length === 0) {
    memoryStore.set(`board:demo-board`, JSON.stringify(demoBoardState));
    allBoards.push(demoBoardState);
  }

  // Filter by access: show user's own boards + public boards
  if (requesterId) {
    return allBoards.filter(
      (b) => b.ownerId === requesterId || b.isPublic
    );
  }

  return allBoards;
}

/**
 * Get real computed metrics across all boards visible to a user.
 */
export async function getMetrics(requesterId?: string): Promise<{
  totalBoards: number;
  totalNodes: number;
  totalEdges: number;
  uptimeSeconds: number;
}> {
  const boards = await listBoards(requesterId);
  let totalNodes = 0;
  let totalEdges = 0;

  for (const board of boards) {
    totalNodes += board.nodes.length;
    totalEdges += board.edges.length;
  }

  return {
    totalBoards: boards.length,
    totalNodes,
    totalEdges,
    uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
  };
}
