import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerSocketHandlers } from "./socket/handlers.js";
import { initRedis } from "./services/redis.js";
import boardsRouter from "./routes/boards.js";
import aiRouter from "./routes/ai.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

async function main() {
  console.log("\n🚀 System Synthesis — Backend Server");
  console.log("─".repeat(40));

  // Initialize Redis (or fallback to in-memory)
  await initRedis();

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

  // REST routes
  app.use("/api/boards", boardsRouter);
  app.use("/api/ai", aiRouter);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

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
    console.log(`  🌐 HTTP server running on http://localhost:${PORT}`);
    console.log(`  🔌 WebSocket server ready`);
    console.log(`  📡 CORS allowed: ${FRONTEND_URL}`);
    console.log("─".repeat(40));
    console.log("  Ready for connections!\n");
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  🛑 Shutting down gracefully...");
    io.close();
    httpServer.close(() => {
      console.log("  Server closed.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
