import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerSocketHandlers } from "./socket/handlers.js";
import { initRedis } from "./services/redis.js";
import { initDatabase, isDbAvailable } from "./services/db.js";
import { optionalAuth } from "./middleware/auth.js";
import { apiLimiter, boardCreateLimiter, aiLimiter, exportLimiter } from "./middleware/rateLimit.js";
import { logger, requestLogger } from "./middleware/logger.js";
import { metricsHandler, metrics } from "./middleware/metrics.js";
import boardsRouter from "./routes/boards.js";
import aiRouter from "./routes/ai.js";
import templatesRouter from "./routes/templates.js";
import exportRouter from "./routes/export.js";
import authRouter, { ensureUsersTable } from "./routes/auth.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

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
        // Echo back the requesting origin to allow flexible Vercel deployments
        // while still supporting credentials: true
        callback(null, origin || true);
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: "10mb" }));

  // Request logging
  app.use(requestLogger);

  // Global middleware: optional auth on all routes (attaches req.user if token present)
  app.use(optionalAuth);

  // Global rate limit
  app.use("/api/", apiLimiter);

  // REST routes with targeted rate limits
  app.use("/api/auth", authRouter);
  app.use("/api/boards", boardsRouter);
  app.use("/api/ai", aiLimiter, aiRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/export", exportLimiter, exportRouter);

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
      origin: [FRONTEND_URL, "http://localhost:3000", "http://localhost:3001"],
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Expose Socket.io to Express routes (for active ejection)
  app.set("io", io);

  // Register socket handlers
  registerSocketHandlers(io);

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
