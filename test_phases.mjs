import "dotenv/config";
import fetch from "node-fetch";
import { io } from "socket.io-client";

const API_URL = "http://localhost:4000";

async function runTests() {
  console.log("Starting Integration Tests for Phases 1-7...");
  
  let token = "";
  let userId = "";
  let boardId = "";

  // 1. Auth & Multi-Tenancy (Phase 6)
  console.log("\n--- Testing Phase 6: Auth & Multi-Tenancy ---");
  try {
    const registerRes = await fetch(`${API_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userName: "Test User",
        email: `test${Date.now()}@example.com`,
        password: "password123"
      })
    });
    
    if (registerRes.ok) {
      const data = await registerRes.json();
      token = data.token;
      userId = data.user.userId;
      console.log("✅ Register successful. Token received.");
    } else {
      console.error("❌ Register failed", await registerRes.text());
      return;
    }

    const meRes = await fetch(`${API_URL}/api/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (meRes.ok) {
      console.log("✅ /me endpoint successful.");
    } else {
      console.error("❌ /me endpoint failed");
    }
  } catch (e) {
    console.error("❌ Auth Error:", e);
  }

  // 2. Postgres Persistence (Phase 2)
  console.log("\n--- Testing Phase 2: Postgres Persistence ---");
  try {
    const createBoardRes = await fetch(`${API_URL}/api/boards`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}` 
      },
      body: JSON.stringify({
        name: "Test Board",
        description: "Integration testing board"
      })
    });

    if (createBoardRes.ok) {
      const board = await createBoardRes.json();
      boardId = board.id;
      console.log(`✅ Board created: ${boardId}`);
    } else {
      console.error("❌ Board creation failed", await createBoardRes.text());
    }

    const listBoardsRes = await fetch(`${API_URL}/api/boards`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (listBoardsRes.ok) {
      const data = await listBoardsRes.json();
      if (data.boards.length > 0) {
         console.log(`✅ Board listing successful. Found ${data.boards.length} boards.`);
      }
    }
  } catch (e) {
    console.error("❌ Board Error:", e);
  }

  // 3. Validation (Phase 3)
  console.log("\n--- Testing Phase 3: Architecture Validation ---");
  try {
    const validateRes = await fetch(`${API_URL}/api/boards/${boardId}/validate`, {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${token}` 
      }
    });

    if (validateRes.ok) {
      const data = await validateRes.json();
      console.log(`✅ Validation successful. Found ${data.issues.length} issues (Expected 0 for empty board).`);
    } else {
      console.error("❌ Validation failed", await validateRes.text());
    }
  } catch (e) {
    console.error("❌ Validation Error:", e);
  }

  // 4. Export (Phase 5)
  console.log("\n--- Testing Phase 5: IaC Export ---");
  try {
    const exportRes = await fetch(`${API_URL}/api/export/docker-compose`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}` 
      },
      body: JSON.stringify({
        nodes: [{
          id: "node1",
          type: "architectureNode",
          data: { label: "Test Service", nodeType: "service" }
        }],
        edges: []
      })
    });

    if (exportRes.ok) {
      const yaml = await exportRes.text();
      if (yaml && yaml.includes("version:")) {
        console.log(`✅ Docker Compose export successful. (Returned YAML)`);
      }
    } else {
      console.error("❌ Export failed", await exportRes.text());
    }
  } catch (e) {
    console.error("❌ Export Error:", e);
  }

  // 5. CRDT / WebSockets (Phase 1)
  console.log("\n--- Testing Phase 1: WebSockets ---");
  try {
    const socket = io(API_URL, {
      transports: ["websocket"],
      auth: { token }
    });

    await new Promise((resolve, reject) => {
      socket.on("connect", () => {
        console.log("✅ WebSocket connected with JWT auth.");
        
        socket.emit("join_board", boardId);
        
        setTimeout(() => {
          socket.disconnect();
          resolve();
        }, 1000);
      });
      socket.on("connect_error", (err) => {
        console.error("❌ WebSocket connection failed:", err);
        reject(err);
      });
    });
  } catch (e) {
    console.error("❌ WebSocket Error:", e);
  }

  console.log("\n✅ All automated tests completed.");
  process.exit(0);
}

runTests();
