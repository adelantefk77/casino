const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Poker constants ───────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i) => [r, i+2]));
const NUM_ROOMS = 3;
const MAX_PLAYERS = 6;
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const ACTION_TIMEOUT = 30000;

// ─── State ─────────────────────────────────────────────────────────────────────
const rooms = {};
for (let i = 1; i <= NUM_ROOMS; i++) {
  rooms[i] = {
    id: i, name: `Stół ${i}`, players: [],
    state: 'waiting', deck: [], community: [],
    pot: 0, currentBet: 0, lastRaiseSize: BIG_BLIND,
    dealerIdx: -1, actionIdx: -1,
    round: 'preflop',
    acted: new Set(),   // players who acted this betting round
    bbIdx: -1,          // index of BB (for BB option)
    actionTimer: null,
  };
}

// ─── Deck helpers ──────────────────────────────────────────────────────────────
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function dealCard(room) { return room.deck.pop(); }

// ─── Hand evaluation ───────────────────────────────────────────────────────────
function handRank(cards) {
  const vals = cards.map(c => RANK_VAL[c.rank]).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const flush = suits.every(s => s === suits[0]);
  const isStraight = vals.every((v,i) => i===0 || vals[i-1]-v===1);
  const lowStraight = vals[0]===14 && vals[1]===5 && vals[2]===4 && vals[3]===3 && vals[4]===2;
  const straight = isStraight || lowStraight;

  const freq = {};
  vals.forEach(v => freq[v] = (freq[v]||0)+1);
  const counts = Object.values(freq).sort((a,b) => b-a);
  const byCount = Object.entries(freq).sort((a,b) => b[1]-a[1]||b[0]-a[0]).map(e=>+e[0]);

  if (flush && straight) return { rank: 8, tb: lowStraight ? [5] : vals };
  if (counts[0]===4) return { rank: 7, tb: byCount };
  if (counts[0]===3 && counts[1]===2) return { rank: 6, tb: byCount };
  if (flush) return { rank: 5, tb: vals };
  if (straight) return { rank: 4, tb: lowStraight ? [5] : vals };
  if (counts[0]===3) return { rank: 3, tb: byCount };
  if (counts[0]===2 && counts[1]===2) return { rank: 2, tb: byCount };
  if (counts[0]===2) return { rank: 1, tb: byCount };
  return { rank: 0, tb: vals };
}

function bestHand(holeCards, community) {
  const all = [...holeCards, ...community];
  let best = null;
  for (let i=0;i<all.length;i++) for (let j=i+1;j<all.length;j++) {
    const five = all.filter((_,k)=>k!==i&&k!==j);
    const hr = handRank(five);
    if (!best || compareTB(hr, best) > 0) best = hr;
  }
  return best;
}

function compareTB(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i=0;i<Math.max(a.tb.length,b.tb.length);i++) {
    const d = (a.tb[i]||0) - (b.tb[i]||0);
    if (d !== 0) return d;
  }
  return 0;
}

const HAND_NAMES = ['Wysoka karta','Para','Dwie pary','Trójka','Strit','Kolor','Full','Kareta','Poker'];

// ─── Player helpers ────────────────────────────────────────────────────────────
function activePlayers(room) { return room.players.filter(p => !p.folded); }
function canAct(room)        { return room.players.filter(p => !p.folded && !p.allIn); }

function nextActive(room, fromIdx) {
  const n = room.players.length;
  let idx = (fromIdx + 1) % n;
  for (let i = 0; i < n; i++) {
    if (!room.players[idx].folded && !room.players[idx].allIn) return idx;
    idx = (idx + 1) % n;
  }
  return -1; // all folded or all-in
}

// ─── Betting done — FIX: use acted set ─────────────────────────────────────────
// A round is complete when EVERY non-folded, non-all-in player:
//   (a) has bet equal to currentBet, AND
//   (b) has had a chance to act this round (tracked in room.acted)
function bettingDone(room) {
  if (activePlayers(room).length === 1) return true;
  const actable = canAct(room);
  if (actable.length === 0) return true; // everyone all-in
  return actable.every(p => p.bet === room.currentBet && room.acted.has(p.id));
}

// ─── Game flow ─────────────────────────────────────────────────────────────────
function broadcast(roomId) {
  io.to(`room:${roomId}`).emit('room:update', publicRoom(rooms[roomId]));
}

function publicRoom(room) {
  return {
    id: room.id, name: room.name, state: room.state,
    pot: room.pot, community: room.community,
    currentBet: room.currentBet, round: room.round,
    dealerIdx: room.dealerIdx, actionIdx: room.actionIdx,
    players: room.players.map(p => ({
      id: p.id, name: p.name, chips: p.chips,
      bet: p.bet, folded: p.folded, allIn: p.allIn,
      cardCount: p.cards.length,
    })),
  };
}

function broadcastWithCards(roomId) {
  const room = rooms[roomId];
  broadcast(roomId);
  room.players.forEach(p => io.to(p.id).emit('player:cards', p.cards));
}

function scheduleTimeout(roomId) {
  const room = rooms[roomId];
  clearActionTimer(room);
  room.actionTimer = setTimeout(() => {
    const p = room.players[room.actionIdx];
    if (!p) return;
    // Auto-check if free, else fold
    const action = (p.bet >= room.currentBet) ? 'check' : 'fold';
    handleAction(roomId, p.id, action);
  }, ACTION_TIMEOUT);
}

function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (room.players.length < 2 || room.state === 'playing') return;

  room.state = 'playing';
  room.deck = buildDeck();
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.lastRaiseSize = BIG_BLIND;
  room.round = 'preflop';
  room.acted = new Set();

  // Reset players
  room.players.forEach(p => {
    p.cards = []; p.bet = 0; p.contributed = 0;
    p.folded = false; p.allIn = false;
  });

  // Move dealer button
  room.dealerIdx = (room.dealerIdx + 1) % room.players.length;

  // Deal 2 cards each
  for (let i=0;i<2;i++) room.players.forEach(p => p.cards.push(dealCard(room)));

  // Post blinds
  const sbIdx = nextActive(room, room.dealerIdx);
  const bbIdx = nextActive(room, sbIdx);
  room.bbIdx = bbIdx;
  postBlind(room, sbIdx, SMALL_BLIND);
  postBlind(room, bbIdx, BIG_BLIND);
  room.currentBet = BIG_BLIND;

  // Preflop: UTG acts first (player after BB)
  const utgIdx = nextActive(room, bbIdx);
  room.actionIdx = utgIdx !== -1 ? utgIdx : bbIdx;

  broadcastWithCards(roomId);
  scheduleTimeout(roomId);
}

function postBlind(room, idx, amount) {
  const p = room.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  p.contributed += actual;
  room.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

function handleAction(roomId, playerId, action, amount) {
  const room = rooms[roomId];
  if (room.state !== 'playing') return;
  const p = room.players[room.actionIdx];
  if (!p || p.id !== playerId) return;

  clearActionTimer(room);

  if (action === 'fold') {
    p.folded = true;
    room.acted.add(p.id);
  } else if (action === 'check') {
    if (p.bet < room.currentBet) {
      // Illegal check — treat as fold
      p.folded = true;
    }
    room.acted.add(p.id);
  } else if (action === 'call') {
    const toCall = Math.min(room.currentBet - p.bet, p.chips);
    p.chips -= toCall;
    p.bet += toCall;
    p.contributed += toCall;
    room.pot += toCall;
    if (p.chips === 0) p.allIn = true;
    room.acted.add(p.id);
  } else if (action === 'raise') {
    const minRaiseTo = room.currentBet + room.lastRaiseSize;
    const raiseTo = Math.min(Math.max(amount || minRaiseTo, minRaiseTo), p.chips + p.bet);
    const add = raiseTo - p.bet;
    const actual = Math.min(add, p.chips);
    room.lastRaiseSize = actual; // track raise size for next min-raise
    p.chips -= actual;
    p.bet += actual;
    p.contributed += actual;
    room.pot += actual;
    room.currentBet = p.bet;
    if (p.chips === 0) p.allIn = true;
    // Raise reopens action — clear acted so everyone must respond
    room.acted = new Set([p.id]);
  }

  // Only one player left — they win
  if (activePlayers(room).length === 1) return endHand(roomId);

  if (bettingDone(room)) {
    advanceRound(roomId);
  } else {
    const next = nextActive(room, room.actionIdx);
    if (next === -1) { advanceRound(roomId); return; }
    room.actionIdx = next;
    broadcastWithCards(roomId);
    scheduleTimeout(roomId);
  }
}

function advanceRound(roomId) {
  const room = rooms[roomId];
  room.players.forEach(p => { p.bet = 0; });
  room.currentBet = 0;
  room.lastRaiseSize = BIG_BLIND;
  room.acted = new Set();

  if (room.round === 'preflop') {
    room.round = 'flop';
    room.community.push(dealCard(room), dealCard(room), dealCard(room));
  } else if (room.round === 'flop') {
    room.round = 'turn';
    room.community.push(dealCard(room));
  } else if (room.round === 'turn') {
    room.round = 'river';
    room.community.push(dealCard(room));
  } else {
    return endHand(roomId);
  }

  // Post-flop: action starts left of dealer
  const first = nextActive(room, room.dealerIdx);
  if (first === -1) return endHand(roomId);
  room.actionIdx = first;

  // If only one player can act (rest are all-in), run board automatically
  if (canAct(room).length <= 1) {
    room.acted.add(room.players[room.actionIdx].id);
    return advanceRound(roomId);
  }

  broadcastWithCards(roomId);
  scheduleTimeout(roomId);
}

// ─── Side pot calculation ──────────────────────────────────────────────────────
function calcPots(players) {
  // players = all non-folded players with .contributed totals
  // Returns [{amount, eligible:[id,...]}]
  const eligible = players.filter(p => !p.folded);
  const contributions = eligible.map(p => ({ id: p.id, total: p.contributed }))
    .sort((a, b) => a.total - b.total);

  const pots = [];
  let prev = 0;

  for (let i = 0; i < contributions.length; i++) {
    const cap = contributions[i].total;
    if (cap === prev) continue;

    let amount = 0;
    // Each player (including folded) contributes up to cap
    for (const pl of players) {
      amount += Math.min(pl.contributed, cap) - Math.min(pl.contributed, prev);
    }

    const eligibleIds = contributions.slice(i).map(c => c.id);
    if (amount > 0) pots.push({ amount, eligible: eligibleIds });
    prev = cap;
  }

  return pots;
}

function endHand(roomId) {
  const room = rooms[roomId];
  clearActionTimer(room);
  room.state = 'showdown';

  const active = activePlayers(room);
  const showdownPlayers = [];

  if (active.length === 1) {
    active[0].chips += room.pot;
    showdownPlayers.push({ player: active[0], hand: 'Wszyscy spasowali' });
  } else {
    // Calculate side pots
    const pots = calcPots(room.players);
    const totalFromPots = pots.reduce((s, p) => s + p.amount, 0);

    // Evaluate each active player's best hand
    const handMap = {};
    active.forEach(p => { handMap[p.id] = bestHand(p.cards, room.community); });

    for (const pot of pots) {
      const contenders = active.filter(p => pot.eligible.includes(p.id));
      if (contenders.length === 0) continue;

      contenders.sort((a,b) => compareTB(handMap[b.id], handMap[a.id]));
      const bestH = handMap[contenders[0].id];
      const winners = contenders.filter(p => compareTB(handMap[p.id], bestH) === 0);
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach(p => { p.chips += share; });
      winners[0].chips += pot.amount - share * winners.length; // remainder

      winners.forEach(w => {
        if (!showdownPlayers.find(x => x.player.id === w.id)) {
          showdownPlayers.push({ player: w, hand: HAND_NAMES[bestH.rank] });
        }
      });
    }

    // If pot calculation missed anything (rounding), correct
    const distributed = pots.reduce((s,p) => s + p.amount, 0);
    const undistributed = room.pot - distributed;
    if (undistributed > 0) showdownPlayers[0]?.player && (showdownPlayers[0].player.chips += undistributed);
  }

  const showdown = {
    winners: showdownPlayers.map(w => ({ id: w.player.id, name: w.player.name, hand: w.hand })),
    players: active.map(p => ({ id: p.id, name: p.name, cards: p.cards })),
    pot: room.pot,
    community: room.community,
  };
  io.to(`room:${roomId}`).emit('showdown', showdown);

  room.players = room.players.filter(p => p.chips > 0);

  setTimeout(() => {
    if (room.players.length >= 2) {
      room.pot = 0;
      startGame(roomId);
    } else {
      room.state = 'waiting';
      broadcast(roomId);
    }
  }, 5000);
}

// ─── Global chat ──────────────────────────────────────────────────────────────
const chatHistory = [];
function chatPush(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > 80) chatHistory.shift();
}

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let playerRoomId = null;
  let playerName = null;

  socket.emit('chat:history', chatHistory);

  socket.on('chat:message', ({ nick, text }) => {
    if (!nick || !text || text.trim().length === 0 || text.length > 300) return;
    const msg = { nick: nick.slice(0, 20), text: text.trim(), ts: Date.now() };
    chatPush(msg);
    io.emit('chat:message', msg);
  });

  socket.on('rooms:list', () => {
    socket.emit('rooms:list', Object.values(rooms).map(r => ({
      id: r.id, name: r.name, state: r.state,
      playerCount: r.players.length, maxPlayers: MAX_PLAYERS,
    })));
  });

  socket.on('room:join', ({ roomId, name }) => {
    if (!name || name.trim().length < 2) return socket.emit('error', 'Podaj nickname (min 2 znaki)');
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Pokój nie istnieje');
    if (room.players.length >= MAX_PLAYERS) return socket.emit('error', 'Stolik pełny');
    if (room.players.find(p => p.name === name.trim())) return socket.emit('error', 'Nick zajęty w tym pokoju');

    playerRoomId = roomId;
    playerName = name.trim();

    room.players.push({
      id: socket.id, name: playerName,
      chips: STARTING_CHIPS, cards: [],
      bet: 0, contributed: 0,
      folded: false, allIn: false, sitOut: false,
    });

    socket.join(`room:${roomId}`);
    socket.emit('room:joined', { roomId, name: playerName, chips: STARTING_CHIPS });
    socket.emit('player:cards', []);
    broadcast(roomId);

    if (room.players.length >= 2 && room.state === 'waiting') {
      setTimeout(() => startGame(roomId), 2000);
    }
  });

  socket.on('action', ({ action, amount }) => {
    if (!playerRoomId) return;
    handleAction(playerRoomId, socket.id, action, amount);
  });

  socket.on('disconnect', () => {
    if (!playerRoomId) return;
    const room = rooms[playerRoomId];
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    if (room.players.length < 2 && room.state === 'playing') {
      clearActionTimer(room);
      room.state = 'waiting';
    }
    broadcast(playerRoomId);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎰  Jankowo Casino running at http://localhost:${PORT}\n`);
});
