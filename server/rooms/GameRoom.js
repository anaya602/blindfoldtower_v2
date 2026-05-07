const { Room } = require('colyseus');
const planck = require('planck-js');
const { TowerState, Player, Block } = require('../schema/State');

class TowerRoom extends Room {
  onCreate() {
    this.setState(new TowerState());
    this.state.players = new Map();
    this.state.blocks = [];
    this.state.roundState = 'waiting';
    this.physicsBodies = [];
    this.world = planck.World({gravity: planck.Vec2(0, -10)});
    // Setup walls/ground
    this.setSimulationInterval((deltaTime) => this.update(deltaTime), 1000 / 30);
  }
  onJoin(client, options) { /* Implement join logic */ }
  onLeave(client, consented) { /* Implement leave logic */ }
  update(dt) { this.world.step(dt); /* Sync to state */ }
}
module.exports = TowerRoom;