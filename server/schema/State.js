/**
 * server/schema/State.js
 * Colyseus Schema definitions for authoritative server state.
 * All mutations happen server-side; clients receive delta patches automatically.
 *
 * Schema hierarchy:
 *   RoomState
 *     ├── players: MapSchema<PlayerState>
 *     ├── blocks:  ArraySchema<BlockState>
 *     └── round:   RoundState
 */

const { Schema, MapSchema, ArraySchema, type } = require("@colyseus/schema");

// ─── BlockState ────────────────────────────────────────────────────────────────
// Represents one physical block in the tower.
class BlockState extends Schema {
  constructor() {
    super();
    this.x        = 0;       // centre x position (world units)
    this.y        = 0;       // centre y position (world units)
    this.rot      = 0;       // rotation in radians
    this.width    = 1;       // block half-extent width (0.5–3)
    this.height   = 0.5;     // block half-extent height (0.3–1)
    this.owner    = "";      // sessionId of the player who placed this block
    this.dynamic  = false;   // false = kinematic (held), true = physics active
    this.settled  = false;   // true once velocity is near-zero post-drop
    this.id       = "";      // unique block id (timestamp + owner slice)
  }
}

// Decorate fields for Colyseus delta serialisation
type("float32")(BlockState.prototype, "x");
type("float32")(BlockState.prototype, "y");
type("float32")(BlockState.prototype, "rot");
type("float32")(BlockState.prototype, "width");
type("float32")(BlockState.prototype, "height");
type("string") (BlockState.prototype, "owner");
type("boolean")(BlockState.prototype, "dynamic");
type("boolean")(BlockState.prototype, "settled");
type("string") (BlockState.prototype, "id");

// ─── PlayerState ───────────────────────────────────────────────────────────────
// One entry per connected (or reconnecting) player.
class PlayerState extends Schema {
  constructor() {
    super();
    this.id           = "";      // Colyseus sessionId
    this.name         = "Anon"; // display name (max 20 chars, sanitised)
    this.score        = 0;       // cumulative score across rounds
    this.roundScore   = 0;       // score for the current round (tower height at settle)
    this.isBlind      = false;   // true while it is this player's blindfolded turn
    this.isHost       = false;   // true for the room host
    this.connected    = true;    // false while in 30-second reconnect window
    this.reconnectToken = "";    // opaque token sent to client for reconnect (not synced to others)
  }
}

type("string") (PlayerState.prototype, "id");
type("string") (PlayerState.prototype, "name");
type("int32")  (PlayerState.prototype, "score");
type("int32")  (PlayerState.prototype, "roundScore");
type("boolean")(PlayerState.prototype, "isBlind");
type("boolean")(PlayerState.prototype, "isHost");
type("boolean")(PlayerState.prototype, "connected");
// reconnectToken is intentionally NOT decorated – it is sent via a private message only

// ─── RoundState ────────────────────────────────────────────────────────────────
// Tracks the lifecycle of one game round.
class RoundState extends Schema {
  constructor() {
    super();
    this.num         = 0;    // round number (0 = lobby)
    this.blindId     = "";   // sessionId of currently blindfolded player
    this.hostId      = "";   // sessionId of the room host
    this.phase       = "lobby"; // "lobby" | "placing" | "settling" | "scoreboard"
    this.towerHeight = 0;    // current max block y (authoritative)
    this.collapsed   = false; // true if collapse detected this round
  }
}

type("int32") (RoundState.prototype, "num");
type("string")(RoundState.prototype, "blindId");
type("string")(RoundState.prototype, "hostId");
type("string")(RoundState.prototype, "phase");
type("float32")(RoundState.prototype, "towerHeight");
type("boolean")(RoundState.prototype, "collapsed");

// ─── RoomState (root) ──────────────────────────────────────────────────────────
class RoomState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();  // sessionId → PlayerState
    this.blocks  = new ArraySchema(); // ordered list of BlockState
    this.round   = new RoundState();
  }
}

type({ map: PlayerState })  (RoomState.prototype, "players");
type([BlockState])           (RoomState.prototype, "blocks");
type(RoundState)             (RoomState.prototype, "round");

module.exports = { RoomState, RoundState, PlayerState, BlockState };
