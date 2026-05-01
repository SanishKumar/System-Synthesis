# System Synthesis

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![React Flow](https://img.shields.io/badge/React_Flow-12-blue?logo=react)
![Socket.io](https://img.shields.io/badge/Socket.io-Real--time-black?logo=socket.io)
![Redis](https://img.shields.io/badge/Redis-In--memory-red?logo=redis)

A real-time, collaborative architecture whiteboard built for designing and discussing system infrastructure. Think of it as Excalidraw specifically tailored for microservices, databases, and cloud components.

## Features

- **Multiplayer Collaboration:** Real-time updates and live cursors powered by Socket.io and Redis.
- **Architecture Nodes:** Purpose-built nodes for databases, gateways, queues, caches, and services.
- **Node Inspector:** Add rich metadata to components including notes, related code snippets, and external links.
- **Zero-Friction Identity:** Device-bound stateless identity so you can share a link and start collaborating immediately without forcing users through a login wall.
- **Access Control:** Board owners can toggle visibility between public and private. Private boards actively eject unauthorized guests.
- **AI Architecture Assist:** A pluggable LLM adapter that analyzes the graph's JSON state and returns structured feedback (e.g., catching missing caching layers or single points of failure).

## Tech Stack

**Frontend**
- Next.js 15 (App Router)
- React Flow (for the canvas engine)
- Tailwind CSS (styling)
- Zustand (state management)
- Socket.io Client

**Backend**
- Node.js & Express
- Socket.io (WebSockets)
- Redis (State persistence and pub/sub for scaling)

## System Architecture

```mermaid
graph TD
    subgraph Client Application
        UI[Next.js UI & Tailwind]
        RF[React Flow Engine]
        Z[Zustand Local State]
        UI --> RF
        RF <--> Z
    end

    subgraph Server Services
        API[Express REST API]
        WS[Socket.io WebSocket]
        AI[Pluggable AI Adapter]
    end

    subgraph Data Layer
        R[(Redis)]
    end

    Z <-->|WebSockets (Sync)| WS
    Z <-->|HTTP (Stateless Auth)| API
    WS <-->|Pub/Sub Events| R
    API <-->|Persistence| R
    API -->|Graph JSON Analysis| AI
```

## Technical Decisions & Trade-offs

- **Zustand over Redux:** Chosen for its boilerplate-free, hook-based API which is crucial for managing the complex, high-frequency state updates required by a 60fps React Flow canvas.
- **Device-Bound Identity:** To maximize adoption and demonstrate a "zero-friction" UX, I opted for a UUID-in-localStorage approach rather than forcing an OAuth wall. This mimics the successful growth loops of tools like Excalidraw.
- **Pluggable AI Adapter:** The LLM integration uses an adapter pattern, allowing the backend to gracefully degrade to mock data if an API key is missing, ensuring the application remains functional in any local environment.

## Getting Started

You'll need Node.js and a running Redis instance to run the application locally.

### 1. Backend Setup

```bash
cd server
npm install
```

Create a `.env` file in the `server` directory (you can copy `.env.example` if available):
```env
PORT=4000
FRONTEND_URL=http://localhost:3000
REDIS_URL=redis://localhost:6379
# OPENAI_API_KEY=your_key_here  # Optional: for AI assist features
```

Start the backend development server:
```bash
npm run dev
```

### 2. Frontend Setup

```bash
cd frontend
npm install
```

Create a `.env.local` file in the `frontend` directory:
```env
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
```

Start the Next.js development server:
```bash
npm run dev
```

The application should now be running at [http://localhost:3000](http://localhost:3000).

## Project Structure

- `/frontend` - The Next.js application containing the React Flow canvas, UI components, and Zustand stores.
- `/server` - The Express backend handling REST routes, Socket.io event broadcasting, and Redis data persistence.
- `/shared` - Shared TypeScript interfaces (Node types, Edge types, Board states) used by both the client and server.

## License

MIT
