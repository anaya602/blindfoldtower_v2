const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');
class Block extends Schema {}
type('number')(Block.prototype, 'x');
type('number')(Block.prototype, 'y');
type('number')(Block.prototype, 'rotation');
type('number')(Block.prototype, 'width');
type('number')(Block.prototype, 'height');
type('string')(Block.prototype, 'placedBy');

class Player extends Schema {}
type('string')(Player.prototype, 'id');
type('string')(Player.prototype, 'name');
type('number')(Player.prototype, 'score');
type('boolean')(Player.prototype, 'isBlindfolded');
type('boolean')(Player.prototype, 'connected');

class TowerState extends Schema {}
MapSchema.define(TowerState, 'players', Player);
ArraySchema.define(TowerState, 'blocks', Block);
type('number')(TowerState.prototype, 'towerHeight');
type('string')(TowerState.prototype, 'roundState');
type('string')(TowerState.prototype, 'blindfoldedId');
type('string')(TowerState.prototype, 'hostId');

module.exports = { TowerState, Player, Block };
