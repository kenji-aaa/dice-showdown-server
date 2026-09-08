const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

function randomCode() {
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function randomFace() {
  return 1 + Math.floor(Math.random() * 6);
}

function createRoom() {
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  const room = { code, round: 1, players: [], rolls: {}, activeIds: null, updatedAt: Date.now() };
  rooms.set(code, room);
  return room;
}

function publicState(room) {
  return { code: room.code, round: room.round, players: room.players, rolls: room.rolls, activeIds: room.activeIds };
}

function broadcast(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('state', publicState(room));
}

function removePlayer(code, pid) {
  const room = rooms.get(code);
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== pid);
  if (room.activeIds) room.activeIds = room.activeIds.filter((id) => id !== pid);
  room.updatedAt = Date.now();
  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    broadcast(code);
  }
}

function sweepStaleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}
setInterval(sweepStaleRooms, 30 * 60 * 1000);

io.on('connection', (socket) => {
  let joinedCode = null;
  let playerId = null;

  socket.on('create_room', ({ name, pid }) => {
    name = String(name || '').slice(0, 16).trim();
    pid = String(pid || '').slice(0, 64);
    if (!name || !pid) { socket.emit('join_error', { code: 'bad_input' }); return; }
    const room = createRoom();
    room.players.push({ id: pid, name });
    room.updatedAt = Date.now();
    socket.join(room.code);
    joinedCode = room.code;
    playerId = pid;
    socket.emit('joined', { code: room.code });
    broadcast(room.code);
  });

  socket.on('join_room', ({ code, name, pid }) => {
    code = String(code || '').toUpperCase().slice(0, 8);
    name = String(name || '').slice(0, 16).trim();
    pid = String(pid || '').slice(0, 64);
    const room = rooms.get(code);
    if (!room) { socket.emit('join_error', { code: 'not_found' }); return; }
    if (!name || !pid) { socket.emit('join_error', { code: 'bad_input' }); return; }
    const existing = room.players.find((p) => p.id === pid);
    if (existing) existing.name = name;
    else room.players.push({ id: pid, name });
    room.updatedAt = Date.now();
    socket.join(code);
    joinedCode = code;
    playerId = pid;
    socket.emit('joined', { code });
    broadcast(code);
  });

  socket.on('roll', () => {
    if (!joinedCode || !playerId) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    const isActive = !room.activeIds || room.activeIds.includes(playerId);
    if (!isActive) return;
    const existing = room.rolls[playerId];
    if (existing && existing.round === room.round) return;

    const values = [randomFace(), randomFace(), randomFace()];
    const sum = values[0] + values[1] + values[2];
    room.rolls[playerId] = { values, sum, round: room.round };
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('next_round', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;

    const activeIds = room.activeIds;
    const contenders = room.players.filter((p) => !activeIds || activeIds.includes(p.id));
    if (contenders.length === 0) return;
    const allRolled = contenders.every((p) => room.rolls[p.id] && room.rolls[p.id].round === room.round);
    if (!allRolled) return;

    const maxSum = Math.max(...contenders.map((p) => room.rolls[p.id].sum));
    const winners = contenders.filter((p) => room.rolls[p.id].sum === maxSum);

    room.round += 1;
    room.activeIds = winners.length > 1 ? winners.map((p) => p.id) : null;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('leave_room', () => {
    if (!joinedCode || !playerId) return;
    removePlayer(joinedCode, playerId);
    socket.leave(joinedCode);
    joinedCode = null;
    playerId = null;
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Dice showdown server listening on port ' + PORT);
});
