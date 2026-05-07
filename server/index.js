const express = require('express');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const http = require('http');
const TowerRoom = require('./rooms/GameRoom');

const app = express();
const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define('tower-room', TowerRoom);
app.use(express.static('public'));
server.listen(process.env.PORT || 3000);
