/**
 * server/rooms/GameRoom.js
 * Authoritative Colyseus room.
 *
 * Architecture:
 *  - Matter.js engine runs ONLY on the server at ~30 Hz.
 *  - State schema is mutated here; Colyseus diffs+sends to all clients automatically.
 *  - All client inputs are validated/sanitised before any mutation.
 *  - Arrow functions throughout to avoid `this`-binding surprises.
 *  - A lightweight "mutex" flag (_mutating) guards every state mutation to prevent
 *    concurrent handler races in Node's event loop (e.g. physics tick + message handler).
 */

const { Room } = require("@colyseus/core");
const Matter   = require("matter-js");
const { RoomState, PlayerState, BlockState } = require("../schema/State");

// ─── Constants ────────────────────────────────────────────────────────────────
const PHYSICS_HZ        = 30;                   // server tick rate
const PHYSICS_DT        = 1000 / PHYSICS_HZ;    // ms per tick
const WALL_X            = 13;                   // ±x wall position
const BLOCK_X_BOUND     = 11;                   // ±x spawn bound for block centre
const GROUND_Y          = 0;                    // ground y (blocks stack upward)
const COLLAPSE_Y        = -5;                   // any block centre below this = collapse
const NUDGE_AMOUNT      = 0.3;                  // x units per left/right keypress
const ROTATE_AMOUNT     = 0.1;                  // radians per Q/E press
const DROP_GRAVITY_SCALE = 1.2;                 // gravity multiplier after drop
const SETTLE_VEL_THRESH = 0.05;                 // speed below which block is "settled"
const SETTLE_CHECK_TICKS = 10;                  // consecutive ticks below threshold to confirm settle
const RECONNECT_TIMEOUT  = 30;                  // seconds to hold a disconnected player's slot
const MAX_NAME_LEN       = 20;
const MAX_CHAT_LEN       = 200;
const MAX_BLOCKS_PER_ROUND = 60;               // safety ceiling – prevent memory blowup

// Sanitise a string: strip HTML, trim, truncate
const sanitise = (str, maxLen) => {
  if (typeof str !== "string") return "";
  return str
    .replace(/[<>&"'`]/g, c => ({ "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;","`":"&#96;" }[c]))
    .trim()
    .slice(0, maxLen);
};

// Random float in [min, max]
const randBetween = (min, max) => Math.random() * (max - min) + min;

// Clamp a number
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class GameRoom extends Room {
  // Class-level field defaults (safe before onCreate fires)
  _engine          = null;
  _ground          = null;
  _wallL           = null;
  _wallR           = null;
  _bodyMap         = new Map();
  _heldBlock       = null;
  _settleCounter   = 0;
  _physicsInterval = null;
  _reconnectTimers = new Map();
  _blindHistory    = [];          // ordered list of sessionIds who have been blind (fairness)
  _mutating        = false;

  // ─── Colyseus lifecycle ─────────────────────────────────────────────────────

  onCreate = (options) => {
    this.setState(new RoomState());

    // Maximum 8 players per room
    this.maxClients = 8;

    // Register all message handlers
    this.onMessage("input",      this._handleInput);
    this.onMessage("chat",       this._handleChat);
    this.onMessage("startRound", this._handleStartRound);
    this.onMessage("reconnect",  this._handleReconnectMessage);

    console.log(`[GameRoom] Room ${this.roomId} created.`);
  };

  onJoin = (client, options) => {
    this._withLock(() => {
      // Idempotent: ignore if sessionId already exists (double-join guard)
      if (this.state.players.has(client.sessionId)) return;

      const p = new PlayerState();
      p.id        = client.sessionId;
      p.name      = sanitise(options?.name || "Anon", MAX_NAME_LEN) || "Anon";
      p.connected = true;

      // First player becomes host
      if (this.state.players.size === 0) {
        p.isHost = true;
        this.state.round.hostId = client.sessionId;
      }

      this.state.players.set(client.sessionId, p);

      // Send private reconnect token (not in schema)
      const token = `${client.sessionId}-${Date.now()}`;
      client.send("reconnectToken", { token, roomId: this.roomId });

      // Broadcast join notification
      this.broadcast("toast", { msg: `${p.name} joined`, kind: "info" }, { except: client });

      console.log(`[GameRoom] ${p.name} (${client.sessionId}) joined. Players: ${this.state.players.size}`);
    });
  };

  onLeave = async (client, consented) => {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;

    if (!consented) {
      // Mark disconnected, start 30-second grace window
      this._withLock(() => { p.connected = false; });

      const timer = setTimeout(() => {
        this._withLock(() => {
          this._removePlayer(client.sessionId);
        });
        this._reconnectTimers.delete(client.sessionId);
      }, RECONNECT_TIMEOUT * 1000);

      this._reconnectTimers.set(client.sessionId, timer);

      this.broadcast("toast", { msg: `${p.name} disconnected (${RECONNECT_TIMEOUT}s to reconnect)`, kind: "warn" });
    } else {
      // Voluntary leave – remove immediately
      this._withLock(() => { this._removePlayer(client.sessionId); });
    }
  };

  onDispose = () => {
    this._stopPhysics();
    for (const t of this._reconnectTimers.values()) clearTimeout(t);
    console.log(`[GameRoom] Room ${this.roomId} disposed.`);
  };

  // ─── Reconnect handling ─────────────────────────────────────────────────────

  _handleReconnectMessage = (client, data) => {
    // Client sends { oldSessionId, token } to reclaim a disconnected slot
    const { oldSessionId, token } = data || {};
    if (!oldSessionId || !token) return;

    const p = this.state.players.get(oldSessionId);
    if (!p || p.connected) return; // slot already active or gone

    // Clear the disconnect timer
    const timer = this._reconnectTimers.get(oldSessionId);
    if (timer) {
      clearTimeout(timer);
      this._reconnectTimers.delete(oldSessionId);
    }

    this._withLock(() => {
      // Move player entry to new sessionId key
      this.state.players.delete(oldSessionId);
      p.id        = client.sessionId;
      p.connected = true;
      this.state.players.set(client.sessionId, p);

      // If they were host, update hostId
      if (this.state.round.hostId === oldSessionId) {
        this.state.round.hostId = client.sessionId;
        p.isHost = true;
      }
      // If they were the active blind player, update blindId
      if (this.state.round.blindId === oldSessionId) {
        this.state.round.blindId = client.sessionId;
        p.isBlind = true;
      }

      // Resend the full blocks array so the rejoining client can rebuild tower
      client.send("fullState", {
        blocks: this.state.blocks.map(b => ({
          id: b.id, x: b.x, y: b.y, rot: b.rot,
          width: b.width, height: b.height,
          owner: b.owner, dynamic: b.dynamic, settled: b.settled
        })),
        round: {
          phase: this.state.round.phase,
          num:   this.state.round.num,
          blindId: this.state.round.blindId,
          hostId:  this.state.round.hostId,
          towerHeight: this.state.round.towerHeight
        }
      });
    });

    this.broadcast("toast", { msg: `${p.name} reconnected!`, kind: "success" });
    console.log(`[GameRoom] ${p.name} reconnected as ${client.sessionId}`);
  };

  // ─── Host start ─────────────────────────────────────────────────────────────

  _handleStartRound = (client, _data) => {
    // Only host can start; need ≥2 players; must be in lobby or scoreboard
    const p = this.state.players.get(client.sessionId);
    if (!p?.isHost) return;
    if (this.state.players.size < 2) {
      client.send("toast", { msg: "Need at least 2 players to start", kind: "warn" });
      return;
    }
    const phase = this.state.round.phase;
    if (phase !== "lobby" && phase !== "scoreboard") return;

    this._withLock(() => {
      this._startRound();
    });
  };

  _startRound = () => {
    // Clear previous physics world
    this._stopPhysics();
    this._initPhysics();

    // Clear schema blocks
    this.state.blocks.splice(0, this.state.blocks.length);

    // Reset round scores
    this.state.players.forEach(p => { p.roundScore = 0; p.isBlind = false; });

    this.state.round.num++;
    this.state.round.collapsed   = false;
    this.state.round.towerHeight = GROUND_Y;
    this.state.round.phase       = "placing";

    // Pick the blindfolded player (fairness: prefer least-recently-blind)
    const blindId = this._pickBlindPlayer();
    this.state.round.blindId = blindId;
    const bp = this.state.players.get(blindId);
    if (bp) bp.isBlind = true;

    // Spawn first block for the blind player
    this._spawnHeldBlock(blindId);

    // Start physics loop
    this._startPhysics();

    this.broadcast("toast", { msg: `Round ${this.state.round.num} started! ${bp?.name ?? "?"} is blindfolded`, kind: "info" });
    console.log(`[GameRoom] Round ${this.state.round.num} started. Blind: ${blindId}`);
  };

  // ─── Physics ─────────────────────────────────────────────────────────────────

  _initPhysics = () => {
    this._engine = Matter.Engine.create({ gravity: { y: 1.5 } });
    const world  = this._engine.world;
    this._bodyMap.clear();
    this._heldBlock    = null;
    this._settleCounter = 0;

    // Static ground  (thick slab below y=0)
    this._ground = Matter.Bodies.rectangle(0, GROUND_Y - 2, 60, 4, { isStatic: true, label: "ground" });

    // Walls (very tall)
    this._wallL = Matter.Bodies.rectangle(-WALL_X - 1, 20, 2, 100, { isStatic: true, label: "wallL" });
    this._wallR = Matter.Bodies.rectangle( WALL_X + 1, 20, 2, 100, { isStatic: true, label: "wallR" });

    Matter.World.add(world, [this._ground, this._wallL, this._wallR]);

    // Restore bodies for any blocks already in schema (mid-round reconnect scenario)
    this.state.blocks.forEach(b => {
      if (b.settled || b.dynamic) {
        const body = Matter.Bodies.rectangle(b.x, b.y, b.width, b.height, {
          isStatic: false,
          frictionAir: 0.05,
          label: b.id
        });
        Matter.Body.setPosition(body, { x: b.x, y: b.y });
        Matter.Body.setAngle(body, b.rot);
        Matter.World.add(world, body);
        this._bodyMap.set(b.id, body);
      }
    });
  };

  _startPhysics = () => {
    this._physicsInterval = setInterval(this._physicsTick, PHYSICS_DT);
  };

  _stopPhysics = () => {
    if (this._physicsInterval) {
      clearInterval(this._physicsInterval);
      this._physicsInterval = null;
    }
    if (this._engine) {
      Matter.Engine.clear(this._engine);
      this._engine = null;
    }
  };

  _physicsTick = () => {
    if (!this._engine) return;
    if (this.state.round.phase !== "placing" && this.state.round.phase !== "settling") return;

    // Step the engine
    Matter.Engine.update(this._engine, PHYSICS_DT);

    // Sync all dynamic bodies → schema (delta)
    this._bodyMap.forEach((body, id) => {
      const schemaBlock = this._findBlockById(id);
      if (!schemaBlock) return;

      const pos = body.position;
      const rot = body.angle;

      // Only write if changed (avoids unnecessary delta packets)
      const dx = Math.abs(schemaBlock.x - pos.x);
      const dy = Math.abs(schemaBlock.y - pos.y);
      const dr = Math.abs(schemaBlock.rot - rot);
      if (dx > 0.001 || dy > 0.001 || dr > 0.001) {
        schemaBlock.x   = pos.x;
        schemaBlock.y   = pos.y;
        schemaBlock.rot = rot;
      }

      // Check collapse: any settled block below threshold
      if (schemaBlock.settled && pos.y < COLLAPSE_Y) {
        this._triggerCollapse();
        return;
      }
    });

    // If we're in "settling" phase, check if held block has come to rest
    if (this.state.round.phase === "settling" && this._heldBlock) {
      const body = this._heldBlock.body;
      const vel  = body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      const angV  = Math.abs(body.angularVelocity);

      if (speed < SETTLE_VEL_THRESH && angV < SETTLE_VEL_THRESH) {
        this._settleCounter++;
        if (this._settleCounter >= SETTLE_CHECK_TICKS) {
          this._onBlockSettled();
        }
      } else {
        this._settleCounter = 0;
      }
    }

    // Update tower height
    this._updateTowerHeight();
  };

  _updateTowerHeight = () => {
    let maxY = GROUND_Y;
    this.state.blocks.forEach(b => {
      if (b.settled && b.y > maxY) maxY = b.y;
    });
    this.state.round.towerHeight = Math.round((maxY - GROUND_Y) * 100) / 100;
  };

  // ─── Block lifecycle ─────────────────────────────────────────────────────────

  _spawnHeldBlock = (ownerId) => {
    // Determine a safe spawn y above the current tower
    const spawnY = GROUND_Y + this.state.round.towerHeight + 8;

    const bSchema        = new BlockState();
    bSchema.id           = `${Date.now()}-${ownerId.slice(0, 6)}`;
    bSchema.owner        = ownerId;
    bSchema.x            = randBetween(-BLOCK_X_BOUND * 0.3, BLOCK_X_BOUND * 0.3); // start near centre
    bSchema.y            = spawnY;
    bSchema.width        = randBetween(0.5, 3);
    bSchema.height       = randBetween(0.3, 1);
    bSchema.rot          = 0;
    bSchema.dynamic      = false;  // kinematic until drop
    bSchema.settled      = false;

    this.state.blocks.push(bSchema);

    // Create a kinematic (isStatic=true) body in Matter that we manually move
    const body = Matter.Bodies.rectangle(bSchema.x, bSchema.y, bSchema.width, bSchema.height, {
      isStatic: true,
      frictionAir: 0.05,
      friction:    0.6,
      restitution: 0.1,
      label: bSchema.id
    });
    Matter.World.add(this._engine.world, body);
    this._bodyMap.set(bSchema.id, body);

    this._heldBlock     = { schemaBlock: bSchema, body };
    this._settleCounter = 0;

    console.log(`[GameRoom] Spawned block ${bSchema.id} for ${ownerId}`);
  };

  _dropHeldBlock = () => {
    if (!this._heldBlock) return;
    const { schemaBlock, body } = this._heldBlock;

    // Switch from kinematic to dynamic
    Matter.Body.setStatic(body, false);
    // Give a gentle downward nudge to start physics
    Matter.Body.setVelocity(body, { x: body.velocity.x, y: 0.1 });
    Matter.Body.setAngularVelocity(body, body.angularVelocity);

    schemaBlock.dynamic = true;
    this.state.round.phase = "settling";
    this._settleCounter    = 0;
  };

  _onBlockSettled = () => {
    if (!this._heldBlock) return;
    const { schemaBlock } = this._heldBlock;

    schemaBlock.settled = true;
    this._heldBlock     = null;
    this._settleCounter = 0;

    // Update tower height one more time
    this._updateTowerHeight();

    // Award round score to the blind player
    const bp = this.state.players.get(this.state.round.blindId);
    if (bp) {
      const h = Math.round(this.state.round.towerHeight * 10) / 10;
      bp.roundScore = h;
      bp.score     += Math.round(h);
    }

    // Safety: cap blocks
    if (this.state.blocks.length >= MAX_BLOCKS_PER_ROUND) {
      this._endRound("maxBlocks");
      return;
    }

    // Next block – same blind player for this version
    // (Could rotate blindfolded player each block for variety)
    this.state.round.phase = "placing";
    this._spawnHeldBlock(this.state.round.blindId);

    this.broadcast("blockSettled", {
      height: this.state.round.towerHeight,
      blindId: this.state.round.blindId
    });
  };

  _triggerCollapse = () => {
    if (this.state.round.collapsed) return; // idempotent
    this.state.round.collapsed = true;
    this._stopPhysics();
    this._endRound("collapse");
  };

  _endRound = (reason) => {
    this.state.round.phase = "scoreboard";

    // Build leaderboard snapshot
    const board = [];
    this.state.players.forEach(p => {
      board.push({ name: p.name, score: p.score, roundScore: p.roundScore });
    });
    board.sort((a, b) => b.score - a.score);

    this.broadcast("roundEnd", {
      reason,
      towerHeight: this.state.round.towerHeight,
      leaderboard: board
    });

    console.log(`[GameRoom] Round ended. Reason: ${reason}. Height: ${this.state.round.towerHeight}`);
  };

  // ─── Input handler ───────────────────────────────────────────────────────────

  _handleInput = (client, data) => {
    // Only the blindfolded player can move the held block
    if (this.state.round.blindId !== client.sessionId) return;
    if (this.state.round.phase !== "placing") return;
    if (!this._heldBlock) return;

    const { action } = data || {};
    if (typeof action !== "string") return;

    this._withLock(() => {
      const { schemaBlock, body } = this._heldBlock;
      let newX   = schemaBlock.x;
      let newRot = schemaBlock.rot;

      switch (action) {
        case "left":
          newX = clamp(schemaBlock.x - NUDGE_AMOUNT, -BLOCK_X_BOUND, BLOCK_X_BOUND);
          break;
        case "right":
          newX = clamp(schemaBlock.x + NUDGE_AMOUNT, -BLOCK_X_BOUND, BLOCK_X_BOUND);
          break;
        case "rotateCW":   // E key
          newRot = schemaBlock.rot + ROTATE_AMOUNT;
          break;
        case "rotateCCW":  // Q key
          newRot = schemaBlock.rot - ROTATE_AMOUNT;
          break;
        case "settle":     // S key – drop block quickly
        case "drop":       // SPACE key – same
          this._dropHeldBlock();
          return;
        default:
          return; // unknown action – ignore
      }

      // Move the kinematic body (Matter teleport for static bodies)
      Matter.Body.setPosition(body, { x: newX, y: schemaBlock.y });
      Matter.Body.setAngle(body, newRot);

      schemaBlock.x   = newX;
      schemaBlock.rot = newRot;
    });
  };

  // ─── Chat handler ────────────────────────────────────────────────────────────

  _handleChat = (client, data) => {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;

    const msg = sanitise(data?.msg ?? "", MAX_CHAT_LEN);
    if (!msg) return;

    this.broadcast("chat", {
      from:    p.name,
      msg,
      isBlind: p.isBlind,
      ts:      Date.now()
    });
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Pick the player who has been blindfolded least recently.
   * Maintains a sliding history so consecutive rounds are fair.
   */
  _pickBlindPlayer = () => {
    const ids = [];
    this.state.players.forEach((p, id) => {
      if (p.connected) ids.push(id);
    });
    if (ids.length === 0) return "";

    // Find id NOT in recent history (or least recent)
    const notYet = ids.filter(id => !this._blindHistory.includes(id));
    let chosen;
    if (notYet.length > 0) {
      // Pick randomly among those who haven't gone
      chosen = notYet[Math.floor(Math.random() * notYet.length)];
    } else {
      // Everyone has gone – pick the one who went longest ago
      chosen = this._blindHistory.find(id => ids.includes(id)) || ids[0];
    }

    // Append to history, keep only last N entries (N = player count)
    this._blindHistory.push(chosen);
    if (this._blindHistory.length > ids.length * 3) {
      this._blindHistory.splice(0, ids.length);
    }
    return chosen;
  };

  /**
   * Remove a player cleanly: reassign host if needed, end round if blindfolded.
   */
  _removePlayer = (sessionId) => {
    const p = this.state.players.get(sessionId);
    if (!p) return;

    const wasHost  = p.isHost;
    const wasBlind = p.isBlind;
    this.state.players.delete(sessionId);

    this.broadcast("toast", { msg: `${p.name} left the game`, kind: "warn" });

    // Reassign host to next connected player
    if (wasHost) {
      let newHost = null;
      this.state.players.forEach((player, id) => {
        if (!newHost && player.connected) newHost = { player, id };
      });
      if (newHost) {
        newHost.player.isHost       = true;
        this.state.round.hostId     = newHost.id;
        this.broadcast("toast", { msg: `${newHost.player.name} is the new host`, kind: "info" });
      }
    }

    // If the blind player left mid-round, end the round
    if (wasBlind && this.state.round.phase === "placing") {
      this._endRound("blindLeft");
    }

    // If fewer than 2 players remain, reset to lobby
    if (this.state.players.size < 2) {
      this._stopPhysics();
      this.state.round.phase = "lobby";
      this.broadcast("toast", { msg: "Not enough players – returning to lobby", kind: "warn" });
    }
  };

  /** Find a schema BlockState by its id string */
  _findBlockById = (id) => {
    for (let i = 0; i < this.state.blocks.length; i++) {
      if (this.state.blocks[i].id === id) return this.state.blocks[i];
    }
    return null;
  };

  /**
   * Lightweight mutex: queues a synchronous callback.
   * Prevents concurrent handler races in Node.js event loop.
   * Throws and logs on nested calls (programming error).
   */
  _withLock = (fn) => {
    if (this._mutating) {
      // Nested call – schedule it as a microtask instead of re-entering
      Promise.resolve().then(fn);
      return;
    }
    this._mutating = true;
    try {
      fn();
    } finally {
      this._mutating = false;
    }
  };
}

module.exports = { GameRoom };
