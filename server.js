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
  const room = { code, game: 'dice', round: 1, players: [], rolls: {}, activeIds: null, amida: null, updatedAt: Date.now() };
  rooms.set(code, room);
  return room;
}

function publicState(room) {
  return {
    code: room.code,
    game: room.game,
    round: room.round,
    players: room.players,
    rolls: room.rolls,
    activeIds: room.activeIds,
    amida: room.amida,
  };
}

function buildAmidaLadder(columnCount) {
  const rows = Math.max(40, Math.min(90, columnCount * 10));
  const rungs = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < columnCount - 1) {
      if (Math.random() < 0.35) {
        rungs.push({ row: r, col: c });
        c += 2; // the node at c+1 is now spoken for this row — skip it
      } else {
        c += 1;
      }
    }
  }
  return { rows, rungs };
}

function traceAmidaColumn(rows, rungs, startCol) {
  let pos = startCol;
  for (let r = 0; r < rows; r++) {
    const right = rungs.some((rg) => rg.row === r && rg.col === pos);
    const left = rungs.some((rg) => rg.row === r && rg.col === pos - 1);
    if (right) pos += 1;
    else if (left) pos -= 1;
  }
  return pos;
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
  if (room.amida && room.amida.phase === 'picking') {
    const idx = room.amida.slots.indexOf(pid);
    if (idx !== -1) room.amida.slots[idx] = null;
  }
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

  socket.on('switch_game', ({ game }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    if (game !== 'dice' && game !== 'amida') return;
    room.game = game;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_setup', ({ labels, slotCount }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;

    slotCount = Math.round(Number(slotCount));
    if (!Number.isInteger(slotCount) || slotCount < 2 || slotCount > 30) return;

    let finalLabels = Array.isArray(labels)
      ? labels.map((l) => String(l || '').slice(0, 20).trim()).filter(Boolean)
      : [];
    if (finalLabels.length !== slotCount) {
      finalLabels = Array.from({ length: slotCount }, (_, i) => String(i + 1));
    }

    room.amida = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      phase: 'picking',
      labels: finalLabels,
      slotCount,
      slots: new Array(slotCount).fill(null),
    };
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_pick_slot', ({ slot }) => {
    if (!joinedCode || !playerId) return;
    const room = rooms.get(joinedCode);
    if (!room || !room.amida || room.amida.phase !== 'picking') return;
    slot = Number(slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= room.amida.slotCount) return;

    const slots = room.amida.slots;
    if (slots[slot] !== null && slots[slot] !== playerId) return; // someone else already has it

    const currentIndex = slots.indexOf(playerId);
    if (currentIndex !== -1) slots[currentIndex] = null; // release any slot I already held
    if (slot !== currentIndex) slots[slot] = playerId; // re-clicking my own slot just releases it

    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_begin', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || !room.amida || room.amida.phase !== 'picking') return;
    const { slots, labels } = room.amida;
    if (slots.some((s) => s === null)) return;

    const columns = slots.slice();
    const { rows, rungs } = buildAmidaLadder(columns.length);
    const resultsByPid = {};
    columns.forEach((pid, i) => {
      const endCol = traceAmidaColumn(rows, rungs, i);
      resultsByPid[pid] = labels[endCol];
    });

    room.amida.phase = 'ladder';
    room.amida.columns = columns;
    room.amida.rows = rows;
    room.amida.rungs = rungs;
    room.amida.resultsByPid = resultsByPid;
    room.amida.revealed = false;
    room.amida.revealedCols = [];
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_reveal', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || !room.amida || room.amida.phase !== 'ladder') return;
    room.amida.revealed = true;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_trace', ({ col }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || !room.amida || room.amida.phase !== 'ladder' || !room.amida.revealed) return;
    col = Number(col);
    if (!Number.isInteger(col) || col < 0 || col >= room.amida.columns.length) return;
    if (!room.amida.revealedCols.includes(col)) {
      room.amida.revealedCols.push(col);
      room.updatedAt = Date.now();
      broadcast(joinedCode);
    }
  });

  socket.on('amida_reveal_all', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || !room.amida || room.amida.phase !== 'ladder' || !room.amida.revealed) return;
    room.amida.revealedCols = room.amida.columns.map((_, i) => i);
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_reset', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.amida = null;
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
