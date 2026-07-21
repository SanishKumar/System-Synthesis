import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  applyRemoteCollaborationUpdate,
  getLoadedCollaborationState,
  reconcileLoadedCollaborationDocuments,
  registerSocketHandlers,
} from "./socket/handlers.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { initRedis, redis } from "./services/redis.js";
import { initDatabase, isDbAvailable } from "./services/db.js";
import { optionalAuth, requireAuth } from "./middleware/auth.js";
import { apiLimiter, aiLimiter, exportLimiter } from "./middleware/rateLimit.js";
import { logger, requestLogger } from "./middleware/logger.js";
import { metricsHandler, metrics } from "./middleware/metrics.js";
import boardsRouter from "./routes/boards.js";
import aiRouter from "./routes/ai.js";
import templatesRouter from "./routes/templates.js";
import exportRouter from "./routes/export.js";
import authRouter, { ensureUsersTable } from "./routes/auth.js";
import reviewsRouter from "./routes/reviews.js";
import { initializeCollaborationSubscription } from "./services/collaborationUpdates.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const ALLOWED_ORIGINS = new Set(
  [
    FRONTEND_URL,
    "http://localhost:3000",
    "http://localhost:3001",
    ...(process.env.ADDITIONAL_FRONTEND_ORIGINS || "").split(","),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean)
);

async function main() {
  logger.info("🚀 System Synthesis — Backend Server");
  logger.info("─".repeat(40));

  // Initialize storage layers
  await initRedis();
  const dbReady = await initDatabase();

  // Create users table if DB is available
  if (dbReady) {
    try {
      await ensureUsersTable();
    } catch (err: any) {
      logger.error("Users table creation failed", { error: err.message });
    }
  }

  // Express app
  const app = express();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
        callback(new Error("Origin is not allowed by CORS policy"));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb", strict: true }));

  // Request logging
  app.use(requestLogger);

  // Global middleware: optional auth on all routes (attaches req.user if token present)
  app.use(optionalAuth);

  // Global rate limit
  app.use("/api/", apiLimiter);

  // REST routes with targeted rate limits
  app.use("/api/auth", authRouter);
  app.use("/api/boards", requireAuth, boardsRouter);
  app.use("/api/reviews", requireAuth, reviewsRouter);
  app.use("/api/ai", requireAuth, aiLimiter, aiRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/export", requireAuth, exportLimiter, exportRouter);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dbAvailable: isDbAvailable(),
    });
  });

  // Prometheus metrics endpoint
  app.get("/metrics", metricsHandler);

  // HTTP + Socket.io server
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: [...ALLOWED_ORIGINS],
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 256 * 1024,
  });

  // Configure Redis Adapter if Redis is available
  if (redis) {
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
  }

  // Expose Socket.io to Express routes (for active ejection)
  app.set("io", io);
  app.set("applyCollaborationUpdate", applyRemoteCollaborationUpdate);
  app.set("getCollaborationState", getLoadedCollaborationState);

  // Register socket handlers
  registerSocketHandlers(io);
  await initializeCollaborationSubscription(
    ({ boardId, update, actorId }) => {
      applyRemoteCollaborationUpdate(boardId, update, actorId);
    },
    async () => {
      await reconcileLoadedCollaborationDocuments();
    }
  );

  // Start server
  httpServer.listen(PORT, () => {
    logger.info(`🌐 HTTP server running on http://localhost:${PORT}`);
    logger.info(`🔌 WebSocket server ready`);
    logger.info(`📡 CORS allowed: ${FRONTEND_URL}`);
    logger.info(`🔒 JWT auth + rate limiting active`);
    logger.info(`📊 Prometheus metrics at /metrics`);
    logger.info("─".repeat(40));
    logger.info("Ready for connections!");
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("🛑 Shutting down gracefully...");
    io.close();
    httpServer.close(() => {
      logger.info("Server closed.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal("Failed to start server", { error: String(err) });
  process.exit(1);
});
