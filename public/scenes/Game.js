/**
 * public/scenes/Game.js
 * Main gameplay Phaser scene.
 *
 * Responsibilities:
 *  - Receive authoritative server state via Colyseus delta patches
 *  - Render tower blocks with client-side interpolation (smooth movement)
 *  - Handle keyboard input → send to server (server decides result)
 *  - Show blindfold overlay for the local player when it's their turn
 *  - Manage HUD: status bar, leaderboard, chat, toasts, scoreboard overlay
 *  - Client prediction: apply local input immediately, correct on server delta
 */

/* global Phaser, Colyseus */

// World → screen scaling constants (world coords in "units")
const WORLD_W    = 30;   // total world width  (-15 to +15)
const WORLD_H    = 40;   // total world height (visible)
const WORLD_ORIGIN_X = 15; // world x=0 maps to canvas x=WORLD_ORIGIN_X
const INTERP_ALPHA   = 0.2;  // interpolation factor per frame (0=no interp, 1=instant)

class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: "Game" });

    // Colyseus room handle
    this._room        = null;
    this._mySessionId = null;
    this._myName      = null;

    // Rendering scale (world units → pixels)
    this._scale   = 1;
    this._offsetX = 0;  // canvas x where world x=0 lands
    this._offsetY = 0;  // canvas y where world y=0 lands (ground)

    // Block render objects: blockId → { sprite, targetX, targetY, targetRot }
    this._blockSprites = new Map();

    // Keys
    this._keys = {};

    // Input repeat throttle
    this._lastInputTime = 0;
    this._inputDelay    = 80; // ms between repeated inputs

    // Local state mirror (for prediction)
    this._localBlocks  = new Map(); // blockId → { x, y, rot }
    this._myTurn       = false;
    this._heldBlockId  = null;  // the current kinematic block id

    // Graphics layer
    this._gfx = null;
  }

  // ─── Phaser lifecycle ──────────────────────────────────────────────────────

  init(data) {
    this._room        = data.room;
    this._mySessionId = this._room.sessionId;
    this._myName      = data.name;
  }

  preload() {
    // We draw blocks procedurally; no asset loading needed
  }

  create() {
    const { width, height } = this.scale;
    this._computeScale(width, height);

    // Graphics for rendering blocks
    this._gfx = this.add.graphics();

    // Background grid
    this._drawBackground();

    // Keyboard input
    this._setupKeys();

    // Hook up Colyseus state listeners
    this._hookRoomState();

    // Hook up HUD buttons
    this._hookHUD();

    // Handle canvas resize
    this.scale.on("resize", this._onResize, this);

    // Show room ID
    document.getElementById("room-id-display").textContent = `Room: ${this._room.id}`;
  }

  update(time, _delta) {
    // Handle keyboard input (rate-limited)
    if (this._myTurn && time - this._lastInputTime > this._inputDelay) {
      this._processKeys(time);
    }

    // Interpolate block sprites toward server-authoritative positions
    this._interpolateBlocks();

    // Redraw blocks
    this._renderBlocks();
  }

  // ─── Scale / resize ────────────────────────────────────────────────────────

  _computeScale = (canvasW, canvasH) => {
    // Fit the WORLD_W × WORLD_H world into the canvas minus HUD margins
    const usableW = canvasW  - 200; // right leaderboard
    const usableH = canvasH  - 80;  // top status bar + bottom chat
    const sx      = usableW / WORLD_W;
    const sy      = usableH / WORLD_H;
    this._scale   = Math.min(sx, sy);

    // Centre horizontally, push ground near bottom
    this._offsetX = canvasW / 2;
    this._offsetY = canvasH - 50; // ground y in canvas pixels
  };

  _onResize = (gameSize) => {
    this._computeScale(gameSize.width, gameSize.height);
    this._gfx.clear();
    this._drawBackground();
  };

  // ─── World ↔ canvas coord helpers ─────────────────────────────────────────

  /** World x → canvas x */
  _wx = (wx) => this._offsetX + wx * this._scale;

  /** World y → canvas y (y increases upward in world, downward in canvas) */
  _wy = (wy) => this._offsetY - wy * this._scale;

  /** World size → canvas size */
  _ws = (ws) => ws * this._scale;

  // ─── Background ────────────────────────────────────────────────────────────

  _drawBackground = () => {
    const g = this._gfx;
    g.lineStyle(1, 0x2a2a3e, 0.5);

    // Ground line
    g.strokeLineShape(new Phaser.Geom.Line(
      this._wx(-15), this._wy(0),
      this._wx(15),  this._wy(0)
    ));

    // Wall markers
    g.lineStyle(1, 0x4a3a6e, 0.6);
    g.strokeLineShape(new Phaser.Geom.Line(this._wx(-13), this._wy(0), this._wx(-13), this._wy(40)));
    g.strokeLineShape(new Phaser.Geom.Line(this._wx( 13), this._wy(0), this._wx( 13), this._wy(40)));

    // Subtle vertical centre guide
    g.lineStyle(1, 0x1e1e2e, 0.4);
    g.strokeLineShape(new Phaser.Geom.Line(this._wx(0), this._wy(0), this._wx(0), this._wy(40)));
  };

  // ─── Block rendering ───────────────────────────────────────────────────────

  _renderBlocks = () => {
    const g = this._gfx;
    // We redraw everything each frame (simple, but fine for <60 blocks)
    // For more blocks, switch to individual Graphics objects per block

    // Clear only the block region (optimisation vs full clear)
    g.fillStyle(0x0d0d14, 1);
    g.fillRect(
      this._wx(-15), this._wy(40),
      this._ws(30),  this._ws(40)
    );
    this._drawBackground();

    this._blockSprites.forEach((data, id) => {
      const { x, y, rot, width, height, dynamic, settled, owner } = data;

      // Colour coding
      let fillColor, strokeColor, alpha;
      if (!settled && !dynamic) {
        // Held kinematic block
        fillColor   = (owner === this._mySessionId) ? 0x7c5cbf : 0x444466;
        strokeColor = 0xd0b0ff;
        alpha       = 0.85;
      } else if (dynamic && !settled) {
        // Falling
        fillColor   = 0xe08c22;
        strokeColor = 0xffd080;
        alpha       = 0.9;
      } else {
        // Settled in tower
        const hue   = this._hueForOwner(owner);
        fillColor   = hue;
        strokeColor = 0xffffff;
        alpha       = 0.7;
      }

      const cx = this._wx(x);
      const cy = this._wy(y);
      const hw = this._ws(width  / 2);
      const hh = this._ws(height / 2);

      g.fillStyle(fillColor, alpha);
      g.lineStyle(1, strokeColor, 0.5);

      // Draw rotated rectangle using a matrix transform
      g.save();
      // Phaser graphics doesn't have a rotate-at-point primitive,
      // so we build the 4 corner points manually:
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const corners = [
        { x: cx + (-hw * cos - (-hh) * sin), y: cy + (-hw * sin + (-hh) * cos) },
        { x: cx + ( hw * cos - (-hh) * sin), y: cy + ( hw * sin + (-hh) * cos) },
        { x: cx + ( hw * cos - ( hh) * sin), y: cy + ( hw * sin + ( hh) * cos) },
        { x: cx + (-hw * cos - ( hh) * sin), y: cy + (-hw * sin + ( hh) * cos) },
      ];

      g.fillPoints(corners, true);
      g.strokePoints(corners, true);
      g.restore();
    });
  };

  /** Simple deterministic colour per owner id */
  _hueForOwner = (ownerId) => {
    if (!ownerId) return 0x4a9eff;
    let hash = 0;
    for (let i = 0; i < ownerId.length; i++) {
      hash = (hash << 5) - hash + ownerId.charCodeAt(i);
      hash |= 0;
    }
    const hue = ((hash & 0x7fffffff) % 360) / 360;
    // Convert hue to rough RGB (simple palette avoids dark colours)
    const h6  = hue * 6;
    const r   = Math.min(1, Math.max(0, Math.abs(h6 - 3) - 1));
    const g2  = Math.min(1, Math.max(0, 2 - Math.abs(h6 - 2)));
    const b   = Math.min(1, Math.max(0, 2 - Math.abs(h6 - 4)));
    return (Math.round(r*255) << 16) | (Math.round(g2*255) << 8) | Math.round(b*255);
  };

  // ─── Interpolation ─────────────────────────────────────────────────────────

  _interpolateBlocks = () => {
    this._blockSprites.forEach((data, _id) => {
      data.x   += (data.targetX   - data.x)   * INTERP_ALPHA;
      data.y   += (data.targetY   - data.y)   * INTERP_ALPHA;
      // Angle interpolation (handle wrap-around)
      let dRot = data.targetRot - data.rot;
      if (dRot >  Math.PI) dRot -= Math.PI * 2;
      if (dRot < -Math.PI) dRot += Math.PI * 2;
      data.rot += dRot * INTERP_ALPHA;
    });
  };

  // ─── Colyseus state hooks ──────────────────────────────────────────────────

  _hookRoomState = () => {
    const room = this._room;

    // ── Blocks ──
    room.state.blocks.onAdd((block, _index) => {
      // New block arrived from server → create local interpolation entry
      this._blockSprites.set(block.id, {
        x: block.x, y: block.y, rot: block.rot,
        targetX: block.x, targetY: block.y, targetRot: block.rot,
        width: block.width, height: block.height,
        dynamic: block.dynamic, settled: block.settled,
        owner: block.owner
      });

      // Track if this is OUR held block (for prediction)
      if (!block.settled && !block.dynamic && block.owner === this._mySessionId) {
        this._heldBlockId = block.id;
      }

      // Listen for position/rotation changes (delta patches)
      block.onChange(() => {
        const data = this._blockSprites.get(block.id);
        if (!data) return;

        // Update interpolation targets from server state
        // If we own the held block and it's kinematic, we've already applied prediction
        // – accept server correction only if it differs significantly (anti-cheat / desynce)
        const predictOwned = (block.owner === this._mySessionId && !block.dynamic);
        if (predictOwned) {
          const dx = Math.abs(data.targetX - block.x);
          const dy = Math.abs(data.targetY - block.y);
          if (dx > 1 || dy > 1) {
            // Large discrepancy – snap to server value
            data.targetX = block.x;
            data.x       = block.x;
          }
          // Accept rotation always
          data.targetRot = block.rot;
        } else {
          data.targetX   = block.x;
          data.targetY   = block.y;
          data.targetRot = block.rot;
        }

        data.dynamic  = block.dynamic;
        data.settled  = block.settled;
        data.width    = block.width;
        data.height   = block.height;
        data.owner    = block.owner;

        // Update held block id when it becomes dynamic (we dropped it)
        if (block.dynamic && block.id === this._heldBlockId) {
          this._heldBlockId = null;
        }
      });
    });

    room.state.blocks.onRemove((block, _index) => {
      this._blockSprites.delete(block.id);
      if (this._heldBlockId === block.id) this._heldBlockId = null;
    });

    // ── Round state ──
    room.state.round.onChange(() => {
      this._updateStatusBar();
      this._updateBlindOverlay();
    });

    // ── Players ──
    room.state.players.onAdd((player, _key) => {
      this._updateLeaderboard();
      player.onChange(() => {
        this._updateLeaderboard();
        this._updateStatusBar();
        this._updateBlindOverlay();
      });
    });
    room.state.players.onRemove(() => {
      this._updateLeaderboard();
    });

    // ── Messages ──
    room.onMessage("toast",       msg => this._showToast(msg.msg, msg.kind));
    room.onMessage("chat",        msg => this._addChatMessage(msg));
    room.onMessage("roundEnd",    msg => this._showScoreboard(msg));
    room.onMessage("blockSettled",msg => this._showToast(`Block settled! Height: ${msg.height}`, "success"));
    room.onMessage("fullState",   msg => this._applyFullState(msg));
    room.onMessage("reconnectToken", msg => {
      // Save token for reconnect tab
      try {
        sessionStorage.setItem("btv2_token", msg.token);
        document.getElementById("reconn-token").value   = msg.token;
        document.getElementById("reconn-session").value = this._mySessionId;
        document.getElementById("reconn-room").value    = this._room.id;
      } catch (_) {}
    });

    // ── Connection events ──
    room.onLeave(() => {
      this._showToast("Disconnected from server", "error");
    });

    this._updateStatusBar();
    this._updateBlindOverlay();
    this._updateLeaderboard();
  };

  // ─── Full state apply (mid-round reconnect) ────────────────────────────────

  _applyFullState = (data) => {
    // Server sent us a full snapshot; apply it wholesale
    this._blockSprites.clear();
    (data.blocks || []).forEach(b => {
      this._blockSprites.set(b.id, {
        x: b.x, y: b.y, rot: b.rot,
        targetX: b.x, targetY: b.y, targetRot: b.rot,
        width: b.width, height: b.height,
        dynamic: b.dynamic, settled: b.settled,
        owner: b.owner
      });
    });
  };

  // ─── Keyboard input ────────────────────────────────────────────────────────

  _setupKeys = () => {
    const kb = this.input.keyboard;
    this._keys = {
      left:      kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right:     kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      rotateCCW: kb.addKey(Phaser.Input.Keyboard.KeyCodes.Q),
      rotateCW:  kb.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      drop:      kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      settle:    kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
    };

    // Block SPACE from scrolling the page
    this.input.keyboard.addCapture(Phaser.Input.Keyboard.KeyCodes.SPACE);

    // "N" – request next block (only host can start next round)
    kb.on("keydown-N", () => {
      if (this._isHost()) this._room.send("startRound", {});
    });
  };

  _processKeys = (time) => {
    const k = this._keys;
    let action = null;

    if (Phaser.Input.Keyboard.JustDown(k.drop) || Phaser.Input.Keyboard.JustDown(k.settle)) {
      action = "drop";
    } else if (k.left.isDown)      { action = "left"; }
    else if (k.right.isDown)       { action = "right"; }
    else if (k.rotateCCW.isDown)   { action = "rotateCCW"; }
    else if (k.rotateCW.isDown)    { action = "rotateCW"; }

    if (action) {
      this._lastInputTime = time;
      this._sendInput(action);
    }
  };

  _sendInput = (action) => {
    // Client prediction: apply movement locally for instant feedback
    if (this._heldBlockId) {
      const data = this._blockSprites.get(this._heldBlockId);
      if (data) {
        const NUDGE = 0.3;
        const ROT   = 0.1;
        const BOUND = 11;
        switch (action) {
          case "left":      data.targetX   = Math.max(-BOUND, data.targetX - NUDGE); break;
          case "right":     data.targetX   = Math.min( BOUND, data.targetX + NUDGE); break;
          case "rotateCCW": data.targetRot -= ROT; break;
          case "rotateCW":  data.targetRot += ROT; break;
        }
      }
    }

    // Send to server (server is authoritative – may correct us)
    this._room.send("input", { action });
  };

  // ─── HUD wiring ────────────────────────────────────────────────────────────

  _hookHUD = () => {
    // Start round button (visible only to host in lobby/scoreboard)
    document.getElementById("btn-start-round").addEventListener("click", () => {
      this._room.send("startRound", {});
    });

    // Chat
    const chatInput = document.getElementById("chat-input");
    document.getElementById("chat-send").addEventListener("click", () => this._sendChat());
    chatInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); this._sendChat(); }
      // Stop game keys from firing while typing
      e.stopPropagation();
    });

    // Scoreboard "Next Round" button (host only)
    document.getElementById("btn-next-round").addEventListener("click", () => {
      this._room.send("startRound", {});
      document.getElementById("scoreboard-overlay").classList.remove("active");
    });
  };

  _sendChat = () => {
    const input = document.getElementById("chat-input");
    const msg   = input.value.trim().slice(0, 200);
    if (!msg) return;
    this._room.send("chat", { msg });
    input.value = "";
  };

  // ─── HUD update helpers ────────────────────────────────────────────────────

  _updateStatusBar = () => {
    const round = this._room.state.round;
    document.getElementById("round-label").textContent =
      round.num > 0 ? `Round ${round.num}` : "Lobby";

    const phaseBadge = document.getElementById("phase-badge");
    phaseBadge.textContent = round.phase;
    phaseBadge.className   = "phase-badge " + round.phase;

    document.getElementById("height-display").textContent =
      round.towerHeight > 0 ? `↑ ${round.towerHeight.toFixed(1)} u` : "";

    // Start button: show only if host + in lobby/scoreboard
    const startBtn = document.getElementById("btn-start-round");
    const canStart = this._isHost() && (round.phase === "lobby" || round.phase === "scoreboard");
    startBtn.classList.toggle("visible", canStart);
  };

  _updateBlindOverlay = () => {
    const round   = this._room.state.round;
    this._myTurn  = (round.blindId === this._mySessionId && round.phase === "placing");
    const overlay = document.getElementById("blindfold-overlay");
    overlay.classList.toggle("active", this._myTurn);
  };

  _updateLeaderboard = () => {
    const rows = [];
    this._room.state.players.forEach((p, _id) => {
      rows.push({ name: p.name, score: p.score, isBlind: p.isBlind, connected: p.connected });
    });
    rows.sort((a, b) => b.score - a.score);

    const container = document.getElementById("lb-rows");
    container.innerHTML = rows.map(p => `
      <div class="lb-row ${p.isBlind ? "blind" : ""}" style="${!p.connected ? "opacity:0.4" : ""}">
        <span class="lb-name">${this._escapeHtml(p.name)}</span>
        <span class="lb-score">${p.score}</span>
      </div>
    `).join("");
  };

  _showToast = (msg, kind = "info") => {
    const container = document.getElementById("toast-container");
    const el        = document.createElement("div");
    el.className    = `toast ${kind}`;
    el.textContent  = msg;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add("fade-out");
      setTimeout(() => el.remove(), 350);
    }, 3000);
  };

  _addChatMessage = (data) => {
    const msgs = document.getElementById("chat-messages");
    const div  = document.createElement("div");
    div.className = "chat-msg";
    div.innerHTML = `<span class="sender ${data.isBlind ? "blind" : ""}">${this._escapeHtml(data.from)}:</span> <span class="text">${this._escapeHtml(data.msg)}</span>`;
    msgs.appendChild(div);

    // Auto-scroll to bottom; cap message history at 50
    while (msgs.children.length > 50) msgs.removeChild(msgs.firstChild);
    msgs.scrollTop = msgs.scrollHeight;
  };

  _showScoreboard = (data) => {
    const overlay  = document.getElementById("scoreboard-overlay");
    const title    = document.getElementById("sb-title");
    const heightEl = document.getElementById("sb-height");
    const tbody    = document.getElementById("sb-rows");
    const nextBtn  = document.getElementById("btn-next-round");
    const waitMsg  = document.getElementById("sb-wait-msg");

    const reasons = {
      collapse:  "💥 Tower Collapsed!",
      blindLeft: "😢 Blind Player Left",
      maxBlocks: "🏆 Max Blocks Reached!"
    };
    title.textContent    = reasons[data.reason] || "Round Over";
    heightEl.textContent = data.towerHeight?.toFixed(1) ?? "0";

    tbody.innerHTML = (data.leaderboard || []).map((p, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${this._escapeHtml(p.name)}</td>
        <td>+${p.roundScore}</td>
        <td>${p.score}</td>
      </tr>
    `).join("");

    const isHost = this._isHost();
    nextBtn.style.display = isHost ? "block" : "none";
    waitMsg.style.display = isHost ? "none"  : "block";

    overlay.classList.add("active");

    // Auto-hide after 15s (in case host forgets)
    setTimeout(() => overlay.classList.remove("active"), 15000);
  };

  // ─── Utility ───────────────────────────────────────────────────────────────

  _isHost = () => {
    const me = this._room.state.players.get(this._mySessionId);
    return me?.isHost === true;
  };

  /** Basic HTML escaping – prevents chat/name injection */
  _escapeHtml = (str) => {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };
}

window.GameScene = GameScene;
