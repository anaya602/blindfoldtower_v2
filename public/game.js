import Lobby from './scenes/Lobby.js';
import Game from './scenes/Game.js';
const config = { type: Phaser.AUTO, scale: { mode: Phaser.Scale.FIT }, scene: [Lobby, Game] };
new Phaser.Game(config);