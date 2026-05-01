/**
 * public/game.js
 * Phaser engine boot, scale configuration, and scene registration.
 *
 * We use Phaser's RESIZE scale mode so the canvas always fills the
 * game-container div without scroll bars.  The Game scene re-computes
 * world→canvas scale internally on every resize event.
 */

/* global Phaser, LobbyScene, GameScene */

// Wait for DOM ready (scripts load in <body> so this fires immediately,
// but being explicit is safer)
window.addEventListener("DOMContentLoaded", () => {

  // The Phaser canvas lives inside #game-container
  const gameContainer = document.getElementById("game-container");

  const config = {
    type: Phaser.AUTO,          // WebGL with Canvas fallback

    parent: "game-container",   // mount canvas here

    // Initial size = window; we listen for resize
    width:  window.innerWidth,
    height: window.innerHeight,

    backgroundColor: "#0d0d14",  // match --bg CSS var

    scale: {
      mode:       Phaser.Scale.RESIZE,  // canvas resizes with container
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },

    // Disable default Phaser banner (keeps console clean)
    banner: false,

    // Disable context menu on right-click
    disableContextMenu: true,

    // Input: keyboard only (no mouse/touch needed for core gameplay)
    input: {
      mouse:   { preventDefaultDown: false },  // allow chat input focus
      touch:   false,
      gamepad: false,
    },

    // Physics disabled – server handles all physics via Matter.js
    physics: { default: "none" },

    scene: [LobbyScene, GameScene],
  };

  const game = new Phaser.Game(config);

  // Expose globally for debugging
  window.__phaserGame = game;

  // Handle window resize → update Phaser scale
  window.addEventListener("resize", () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
  });

  // Prevent arrow keys / space from scrolling the page while game is focused
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
      // Only prevent default if the active element is NOT a text input
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag !== "input" && tag !== "textarea") {
        e.preventDefault();
      }
    }
  });
});
