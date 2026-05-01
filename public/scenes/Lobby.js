/**
 * public/scenes/Lobby.js
 * Handles the pre-game lobby:
 *  - Tab switching (create / join / reconnect)
 *  - Colyseus room creation / joining / reconnecting
 *  - Transitions to the Game scene on success
 *
 * This is a Phaser Scene but we use it primarily for logic.
 * The actual UI is HTML (in index.html), kept separate from Phaser canvas
 * so it's accessible, responsive, and CSS-styled.
 */

/* global Phaser, Colyseus */

class LobbyScene extends Phaser.Scene {
  constructor() {
    super({ key: "Lobby" });
    this._client = null;  // Colyseus.Client instance
  }

  // ─── Phaser lifecycle ──────────────────────────────────────────────────────

  preload() {
    // Nothing to load for the lobby
  }

  create() {
    // Show lobby HTML, hide game container
    document.getElementById("lobby-container").style.display = "flex";
    document.getElementById("game-container").style.display  = "none";

    // Build Colyseus client pointing at current origin (works on localhost and Render)
    const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl      = `${wsProtocol}://${window.location.host}`;
    this._client     = new Colyseus.Client(wsUrl);

    this._setupTabs();
    this._setupButtons();
    this._restoreSavedInfo();
  }

  // ─── Tab switching ─────────────────────────────────────────────────────────

  _setupTabs = () => {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;

        // Update active tab button
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        // Update active tab content
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        document.getElementById(`tab-${target}`).classList.add("active");
      });
    });
  };

  // ─── Button wiring ─────────────────────────────────────────────────────────

  _setupButtons = () => {
    document.getElementById("btn-create").addEventListener("click", this._onCreate);
    document.getElementById("btn-join").addEventListener("click",   this._onJoin);
    document.getElementById("btn-reconnect").addEventListener("click", this._onReconnect);

    // Allow Enter key to submit in each tab
    ["create-name"].forEach(id => {
      document.getElementById(id).addEventListener("keydown", e => {
        if (e.key === "Enter") this._onCreate();
      });
    });
    ["join-name", "join-room-id"].forEach(id => {
      document.getElementById(id).addEventListener("keydown", e => {
        if (e.key === "Enter") this._onJoin();
      });
    });
  };

  // ─── Create room ────────────────────────────────────────────────────────────

  _onCreate = async () => {
    const nameInput = document.getElementById("create-name");
    const name      = nameInput.value.trim().slice(0, 20) || "Anon";
    const errEl     = document.getElementById("create-error");
    this._clearError(errEl);

    try {
      const room = await this._client.create("game", { name });
      this._saveSessionInfo(room.sessionId, room.id);
      this._enterGame(room, name, true);
    } catch (e) {
      this._showError(errEl, "Failed to create room: " + (e.message || "unknown error"));
    }
  };

  // ─── Join room ──────────────────────────────────────────────────────────────

  _onJoin = async () => {
    const name      = document.getElementById("join-name").value.trim().slice(0, 20) || "Anon";
    const roomId    = document.getElementById("join-room-id").value.trim();
    const errEl     = document.getElementById("join-error");
    this._clearError(errEl);

    if (!roomId) {
      this._showError(errEl, "Please enter a Room ID.");
      return;
    }

    try {
      const room = await this._client.joinById(roomId, { name });
      this._saveSessionInfo(room.sessionId, room.id);
      this._enterGame(room, name, false);
    } catch (e) {
      this._showError(errEl, "Could not join room: " + (e.message || "Check the Room ID"));
    }
  };

  // ─── Reconnect ──────────────────────────────────────────────────────────────

  _onReconnect = async () => {
    const oldSessionId = document.getElementById("reconn-session").value.trim();
    const token        = document.getElementById("reconn-token").value.trim();
    const roomId       = document.getElementById("reconn-room").value.trim();
    const errEl        = document.getElementById("reconn-error");
    this._clearError(errEl);

    if (!oldSessionId || !token || !roomId) {
      this._showError(errEl, "All three fields are required for reconnect.");
      return;
    }

    try {
      // First join with a new session, then send the reconnect message server-side
      const room = await this._client.joinById(roomId, { name: "Reconnecting…" });

      // Tell server to swap our slot
      room.send("reconnect", { oldSessionId, token });

      this._saveSessionInfo(room.sessionId, room.id);
      this._enterGame(room, null, false);
    } catch (e) {
      this._showError(errEl, "Reconnect failed: " + (e.message || "Session may have expired"));
    }
  };

  // ─── Transition to game scene ────────────────────────────────────────────────

  _enterGame = (room, name, isHost) => {
    // Hide lobby HTML
    document.getElementById("lobby-container").style.display = "none";
    document.getElementById("game-container").style.display  = "flex";

    // Launch game scene, passing the live room handle
    this.scene.start("Game", { room, name, isHost });
  };

  // ─── Persistence helpers ────────────────────────────────────────────────────

  _saveSessionInfo = (sessionId, roomId) => {
    // sessionStorage (tab-scoped) for reconnect convenience
    try {
      sessionStorage.setItem("btv2_sessionId", sessionId);
      sessionStorage.setItem("btv2_roomId",    roomId);
    } catch (_) { /* private browsing – ignore */ }
  };

  _restoreSavedInfo = () => {
    try {
      const sid = sessionStorage.getItem("btv2_sessionId");
      const rid = sessionStorage.getItem("btv2_roomId");
      if (sid) document.getElementById("reconn-session").value = sid;
      if (rid) document.getElementById("reconn-room").value    = rid;
    } catch (_) {}
  };

  // ─── Error helpers ──────────────────────────────────────────────────────────

  _showError = (el, msg) => {
    el.textContent = msg;
    el.classList.add("visible");
  };

  _clearError = (el) => {
    el.textContent = "";
    el.classList.remove("visible");
  };
}

// Will be registered in game.js
window.LobbyScene = LobbyScene;
