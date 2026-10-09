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
  const room = { code, game: 'dice', round: 1, players: [], rolls: {}, activeIds: null, hostId: null, amida: null, roulette: null, rouletteWon: [], rouletteExclude: true, updatedAt: Date.now() };
  rooms.set(code, room);
  return room;
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    game: room.game,
    round: room.round,
    players: room.players,
    rolls: room.rolls,
    activeIds: room.activeIds,
    amida: publicAmida(room.amida),
    roulette: room.roulette,
    rouletteWon: room.rouletteWon,
    rouletteExclude: room.rouletteExclude,
  };
}

function publicAmida(a) {
  if (!a) return null;
  if (a.phase === 'ladder' && !a.revealed) {
    const { labels, resultsByPid, atariSlot, winnerCol, ...rest } = a;
    return rest;
  }
  return a;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
    room.amida.rungs = room.amida.rungs.filter((r) => r.by !== pid);
  }
  room.updatedAt = Date.now();
  if (room.hostId === pid && room.players.length > 0) room.hostId = room.players[0].id;
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

  socket.on('create_room', ({ name, pid, game }) => {
    name = String(name || '').slice(0, 16).trim();
    pid = String(pid || '').slice(0, 64);
    if (!name || !pid) { socket.emit('join_error', { code: 'bad_input' }); return; }
    const room = createRoom();
    if (game === 'dice' || game === 'amida' || game === 'roulette') room.game = game;
    room.players.push({ id: pid, name });
    room.hostId = pid;
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
    if (room && room.hostId !== playerId) return;
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

  socket.on('amida_setup', ({ slotCount }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    if (!room) return;

    slotCount = Math.round(Number(slotCount));
    if (!Number.isInteger(slotCount) || slotCount < 2 || slotCount > 30) return;

    room.amida = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      phase: 'picking',
      slotCount,
      rows: Math.max(40, Math.min(90, slotCount * 10)),
      slots: new Array(slotCount).fill(null),
      rungs: [],
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
    if (slots[slot] !== null && slots[slot] !== playerId) return;

    const currentIndex = slots.indexOf(playerId);
    if (currentIndex !== -1) slots[currentIndex] = null;
    if (slot !== currentIndex) slots[slot] = playerId;
    // Giving up your slot also takes back the rung you drew.
    if (!slots.includes(playerId)) room.amida.rungs = room.amida.rungs.filter((r) => r.by !== playerId);

    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  // Each seated player may add ONE rung; tapping the same spot again removes it.
  socket.on('amida_add_rung', ({ row, col }) => {
    if (!joinedCode || !playerId) return;
    const room = rooms.get(joinedCode);
    const a = room && room.amida;
    if (!a || a.phase !== 'picking' || !a.slots.includes(playerId)) return;
    row = Number(row);
    col = Number(col);
    if (!Number.isInteger(row) || row < 0 || row >= a.rows) return;
    if (!Number.isInteger(col) || col < 0 || col > a.slotCount - 2) return;

    const mineIdx = a.rungs.findIndex((r) => r.by === playerId);
    const sameSpot = mineIdx !== -1 && a.rungs[mineIdx].row === row && a.rungs[mineIdx].col === col;
    if (!sameSpot) {
      const clash = a.rungs.some((r) => r.by !== playerId && r.row === row && Math.abs(r.col - col) <= 1);
      if (clash) return;
    }
    if (mineIdx !== -1) a.rungs.splice(mineIdx, 1);
    if (!sameSpot) a.rungs.push({ row, col, by: playerId });

    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_begin', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    const a = room && room.amida;
    if (!a || a.phase !== 'picking' || a.slots.some((x) => x === null)) return;

    const columns = a.slots.slice();
    const n = columns.length;
    const rungs = a.rungs.map((r) => ({ row: r.row, col: r.col, by: r.by }));
    for (let r = 0; r < a.rows; r++) {
      const used = new Array(n).fill(false);
      rungs.filter((g) => g.row === r).forEach((g) => { used[g.col] = true; used[g.col + 1] = true; });
      let c = 0;
      while (c < n - 1) {
        if (!used[c] && !used[c + 1] && Math.random() < 0.35) {
          rungs.push({ row: r, col: c });
          used[c] = true;
          used[c + 1] = true;
          c += 2;
        } else {
          c += 1;
        }
      }
    }

    const labels = shuffle(['当たり'].concat(new Array(n - 1).fill('はずれ')));
    const resultsByPid = {};
    let winnerCol = 0;
    columns.forEach((pid, i) => {
      const endCol = traceAmidaColumn(a.rows, rungs, i);
      resultsByPid[pid] = labels[endCol];
      if (labels[endCol] === '当たり') winnerCol = i;
    });

    a.phase = 'ladder';
    a.columns = columns;
    a.rungs = rungs;
    a.labels = labels;
    a.resultsByPid = resultsByPid;
    a.atariSlot = labels.indexOf('当たり');
    a.winnerCol = winnerCol;
    a.revealed = false;
    a.done = false;
    delete a.slots;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('amida_reveal_winner', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    const a = room && room.amida;
    if (!a || a.phase !== 'ladder' || a.revealed) return;
    a.revealed = true;
    a.done = false;
    a.revealMs = Math.min(14000, 9000 + a.columns.length * 150);
    room.updatedAt = Date.now();
    broadcast(joinedCode);

    const code = joinedCode;
    setTimeout(() => {
      const r = rooms.get(code);
      if (!r || r.amida !== a) return;
      a.done = true;
      broadcast(code);
    }, a.revealMs + 5000);
  });

  socket.on('amida_reset', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    if (!room) return;
    room.amida = null;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('switch_game', ({ game }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || room.hostId !== playerId) return;
    if (game !== 'dice' && game !== 'amida' && game !== 'roulette') return;
    room.game = game;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('roulette_exclude', ({ value }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    if (!room) return;
    room.rouletteExclude = !!value;
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('roulette_clear_won', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    if (!room || (room.roulette && !room.roulette.done)) return;
    room.rouletteWon = [];
    room.updatedAt = Date.now();
    broadcast(joinedCode);
  });

  socket.on('roulette_spin', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (room && room.hostId !== playerId) return;
    if (!room) return;
    if (room.roulette && !room.roulette.done) return;

    let pool = room.players.filter((p) => !room.rouletteExclude || !room.rouletteWon.includes(p.id));
    if (pool.length === 0) { room.rouletteWon = []; pool = room.players.slice(); }
    if (pool.length === 0) return;

    const winnerIndex = Math.floor(Math.random() * pool.length);
    const spinMs = 6000;
    const roulette = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      entries: pool.map((p) => ({ id: p.id, name: p.name })),
      winnerIndex,
      spinMs,
      done: false,
    };
    room.roulette = roulette;
    room.updatedAt = Date.now();
    broadcast(joinedCode);

    const code = joinedCode;
    setTimeout(() => {
      const r = rooms.get(code);
      if (!r || r.roulette !== roulette) return;
      roulette.done = true;
      r.rouletteWon.push(roulette.entries[winnerIndex].id);
      r.updatedAt = Date.now();
      broadcast(code);
    }, spinMs + 300);
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
