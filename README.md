# 🗼 Blindfold Tower v2

A real-time multiplayer block-stacking game where **one player is blindfolded** — they can't see the tower but must drop blocks onto it by feel and instinct.

---

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS | WebSocket support, free tier everywhere |
| Multiplayer | Colyseus 0.15 | Delta-state sync, room lifecycle, reconnect tokens |
| Server Physics | Matter.js 0.19 | Pure JS, no native deps, stable stacking |
| Client Engine | Phaser 3.60 | Scene system, input, canvas rendering |
| Deploy | Render.com (free) | Persistent Node process, WebSocket support |

---

## Installation (Local)

```bash
# 1. Clone / unzip
cd blindfold-tower-v2

# 2. Install dependencies
npm install

# 3. Start development server
npm run dev        # uses nodemon for auto-restart

# 4. Open browser
open http://localhost:3000
```

**Multi-client local test:**
Open 3 separate browser tabs (or windows) at `http://localhost:3000`.
- Tab 1: Create a room → note the Room ID displayed top-right
- Tab 2: Join → paste Room ID
- Tab 3: Join → paste Room ID
- Tab 1 (host): Click **▶ Start Round**

---

## Deployment (Render.com — Free)

### One-click via render.yaml:

1. Push repository to GitHub (public or private)
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` → click **Apply**
5. Wait ~2 minutes for build → your URL is `https://blindfold-tower-v2.onrender.com`

### Manual setup:
| Field | Value |
|---|---|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| PORT env var | `3000` (Render overrides this automatically) |

> ⚠️ **Free tier note:** Render free plans spin down after 15 minutes of inactivity. The first player to connect may wait 20–30 seconds for the server to wake up.

---

## How to Play

### Lobby
| Tab | Action |
|---|---|
| **Create** | Enter name → create a new room → share the Room ID |
| **Join** | Enter name + Room ID → join existing room |
| **Reconnect** | Paste Session ID + Token + Room ID → reclaim disconnected slot (30s window) |

### In-game
- **Host** sees a **▶ Start Round** button (needs ≥2 players)
- One player is randomly chosen as **blindfolded** (fair rotation across rounds)
- **Blindfolded player's screen goes black** with keyboard hints

### Blindfold Controls
| Key | Action |
|---|---|
| `A` | Nudge block left |
| `D` | Nudge block right |
| `Q` | Rotate counter-clockwise |
| `E` | Rotate clockwise |
| `SPACE` | Drop block (kinematic → physics gravity) |
| `S` | Settle block (same as drop) |
| `N` | (Host) Start next round |

### Scoring
- Score = **tower height** when each block settles
- Cumulative across rounds — shown in leaderboard top-right
- Round ends on **collapse** (any block falls below y < -5) or host starts next round

---

## Architecture Notes

```
┌─────────────────────────────────────────┐
│  Browser (Phaser 3)                     │
│  ┌──────────────────────────────────┐   │
│  │ LobbyScene  → GameScene         │   │
│  │ Client prediction + interp       │   │
│  │ HUD HTML overlay (chat/lb/toast) │   │
│  └──────────────────────────────────┘   │
│           ↕ Colyseus WS (delta patches) │
└─────────────────────────────────────────┘
           ↕
┌─────────────────────────────────────────┐
│  Server (Node.js + Colyseus)            │
│  ┌──────────────────────────────────┐   │
│  │ GameRoom                         │   │
│  │  ├── Matter.js ~30Hz tick        │   │
│  │  ├── RoomState schema            │   │
│  │  ├── Input handlers (sanitised)  │   │
│  │  └── Reconnect / host swap       │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Delta sync:** Colyseus only sends changed fields. A block moving left sends 4 bytes (float32 x), not the full block object.

**Client prediction:** When the blindfolded player presses A/D, the block moves instantly on-screen. The server validates and corrects large discrepancies.

**Interpolation:** All block positions are interpolated at `α=0.2` per frame toward server-authoritative targets, eliminating jitter from network latency.

---

## Troubleshoot

| Problem | Fix |
|---|---|
| Blank screen on load | Check browser console for CSP errors; verify CDN scripts loaded |
| "Failed to create room" | Server not running? `npm run dev` and check port 3000 |
| Blocks not moving | Only the **blindfolded** player's A/D/Q/E keys move the held block |
| Chat input captures game keys | Click outside chat input to return keyboard focus to game |
| Render sleeps | Free tier; wait 30s on first visit or upgrade to paid |
| Physics explosion | Rare; refresh to start new round. Lower `PHYSICS_HZ` in GameRoom.js if it persists |
| Reconnect token expired | 30s window only; after that you must join as a new player |

---

## v1 (Socket.IO) → v2 (Colyseus) Improvements

| Feature | v1 Socket.IO | v2 Colyseus |
|---|---|---|
| State sync | Manual JSON broadcast every tick | Schema delta patches (Colyseus built-in) |
| Bandwidth | Full state each tick (~2KB/s/client) | Delta only (~100-300B/s/client) |
| Reconnect | Custom token store in JS Map | Colyseus `allowReconnection` + custom token |
| Room lifecycle | Custom room Map + cleanup timers | Colyseus Room class manages lifecycle |
| Schema validation | None (raw JSON) | Colyseus Schema type decorators |
| Monitor / debug | None | `/colyseus` monitor dashboard (dev) |
| Physics mutex | None (race conditions) | `_withLock` guard on all mutations |
| Client prediction | None (server-only positions) | Local prediction + server correction |
| Interpolation | None (jitter on slow connections) | Per-frame lerp toward server targets |
| Host reassignment | Manual | Explicit `_removePlayer` with host swap |

---

## File Structure

```
blindfold-tower-v2/
├── package.json
├── .gitignore
├── render.yaml              ← free deploy config
├── README.md
├── assets/
│   └── favicon.ico
├── server/
│   ├── index.js             ← Express + Colyseus server
│   ├── schema/
│   │   └── State.js         ← RoomState / PlayerState / BlockState schemas
│   └── rooms/
│       └── GameRoom.js      ← Authoritative physics + game logic
└── public/                  ← Static files served to browser
    ├── index.html
    ├── style.css
    ├── game.js              ← Phaser boot
    └── scenes/
        ├── Lobby.js         ← Create/join/reconnect UI
        └── Game.js          ← Rendering + input + HUD
```

---

## Local Multi-Client Test Plan

1. `npm run dev`
2. Open `http://localhost:3000` in **Tab A** → Create → name "Alice"
3. Copy Room ID from top-right
4. Open Tab B → Join → name "Bob" → paste Room ID
5. Open Tab C → Join → name "Carol" → paste Room ID
6. Tab A: Click **▶ Start Round** → one player gets blindfolded
7. Switch to the blindfolded player's tab → screen should be black
8. Press A/D/Q/E in the black tab → block should move (visible in non-blind tabs)
9. Press SPACE → block drops; watch it land on tower
10. Tab A chat: type "hello" → should appear in all tabs
11. Close Tab B (simulate disconnect) → toast in A and C: "Bob disconnected (30s to reconnect)"
12. Reopen Tab B → Reconnect tab → paste saved Session ID + Token + Room ID → reconnect
13. Close Tab B again, wait 31s → "Bob left the game" toast
14. If A is the blind player, close Tab A → host reassigns to C; round ends ("blind player left")
