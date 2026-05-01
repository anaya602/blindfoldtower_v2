/**
 * server/index.js
 * Express + Colyseus server entry point.
 *
 * - Serves static files from /public
 * - Registers Colyseus GameRoom
 * - Attaches Colyseus monitor at /colyseus (dev only)
 * - Binds to PORT env var (default 3000)
 */

const http    = require("http");
const path    = require("path");
const express = require("express");
const cors    = require("cors");
const { Server }   = require("colyseus");
const { monitor }  = require("@colyseus/monitor");
const { GameRoom } = require("./rooms/GameRoom");

const PORT = parseInt(process.env.PORT || "3000", 10);
const IS_PROD = process.env.NODE_ENV === "production";

// ─── Express setup ───────────────────────────────────────────────────────────
const app = express();

// Allow CORS in development (Phaser game client may be on different port)
if (!IS_PROD) {
  app.use(cors({ origin: "*" }));
}

app.use(express.json());

// Serve the public directory as static assets
app.use(express.static(path.join(__dirname, "..", "public")));

// Health check endpoint (Render.com / uptime monitors)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Expose Colyseus dev monitor (non-production only – shows room state, connections)
if (!IS_PROD) {
  app.use("/colyseus", monitor());
  console.log("[Server] Colyseus monitor available at http://localhost:" + PORT + "/colyseus");
}

// SPA fallback – serve index.html for any unmatched GET
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ─── Colyseus setup ──────────────────────────────────────────────────────────
const httpServer  = http.createServer(app);
const gameServer  = new Server({ server: httpServer });

// Register the game room type
gameServer.define("game", GameRoom)
  .filterBy(["roomId"])            // allow clients to find rooms by roomId
  .enableRealtimeListing();        // allow lobby listing

// ─── Start ───────────────────────────────────────────────────────────────────
gameServer.listen(PORT).then(() => {
  console.log(`[Server] Blindfold Tower v2 listening on port ${PORT}`);
  if (!IS_PROD) {
    console.log(`[Server] Open http://localhost:${PORT} in your browser`);
  }
}).catch(err => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => {
  console.log("[Server] Shutting down gracefully…");
  gameServer.gracefullyShutdown().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
