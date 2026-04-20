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
const ACTION_TIMEOUT = 30000; // 30s per action

// ─── State ─────────────────────────────────────────────────────────────────────
const rooms = {};
for (let i = 1; i <= NUM_ROOMS; i++) {
  rooms[i] = {
    id: i,
    name: `Stół ${i}`,
    players: [],   // { id, name, chips, cards, bet, folded, allIn, sitOut }
    state: 'waiting', // waiting | playing | showdown
    deck: [],
    community: [],
    pot: 0,
    sidePots: [],
    currentBet: 0,
    dealerIdx: -1,
    actionIdx: -1,
    round: 'preflop', // preflop | flop | turn | river
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

function dealCard(room) {
  return room.deck.pop();
}

// ─── Hand evaluation ───────────────────────────────────────────────────────────
function handRank(cards) {
  // returns { rank: 0-8, tiebreak: [...] }
  const vals = cards.map(c => RANK_VAL[c.rank]).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const flush = suits.every(s => s === suits[0]);
  const straight = vals.every((v,i) => i===0 || vals[i-1]-v===1) ||
    (vals[0]===14 && vals[1]===5 && vals[2]===4 && vals[3]===3 && vals[4]===2);
  const lowStraight = vals[0]===14 && vals[1]===5;

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
  // C(7,5) = 21 combos
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

// ─── Game flow ─────────────────────────────────────────────────────────────────
function broadcast(roomId) {
  const room = rooms[roomId];
  io.to(`room:${roomId}`).emit('room:update', publicRoom(room));
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    state: room.state,
    pot: room.pot,
    community: room.community,
    currentBet: room.currentBet,
    round: room.round,
    dealerIdx: room.dealerIdx,
    actionIdx: room.actionIdx,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      sitOut: p.sitOut,
      cardCount: p.cards.length,
    })),
  };
}

function privateCards(room, playerId) {
  const p = room.players.find(x => x.id === playerId);
  return p ? p.cards : [];
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (room.players.length < 2) return;
  if (room.state === 'playing') return;

  room.state = 'playing';
  room.deck = buildDeck();
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.round = 'preflop';

  // Reset players
  room.players.forEach(p => { p.cards = []; p.bet = 0; p.folded = false; p.allIn = false; });

  // Move dealer button
  room.dealerIdx = (room.dealerIdx + 1) % room.players.length;

  // Deal 2 cards each
  for (let i=0;i<2;i++) room.players.forEach(p => p.cards.push(dealCard(room)));

  // Post blinds
  const sbIdx = nextActive(room, room.dealerIdx);
  const bbIdx = nextActive(room, sbIdx);
  postBlind(room, sbIdx, SMALL_BLIND);
  postBlind(room, bbIdx, BIG_BLIND);
  room.currentBet = BIG_BLIND;

  // First to act: after BB
  room.actionIdx = nextActive(room, bbIdx);

  broadcastWithCards(roomId);
  scheduleTimeout(roomId);
}

function postBlind(room, idx, amount) {
  const p = room.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  room.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

function nextActive(room, fromIdx) {
  let idx = (fromIdx + 1) % room.players.length;
  while (room.players[idx].folded || room.players[idx].allIn) {
    idx = (idx + 1) % room.players.length;
  }
  return idx;
}

function activePlayers(room) {
  return room.players.filter(p => !p.folded);
}

function canAct(room) {
  return room.players.filter(p => !p.folded && !p.allIn);
}

function bettingDone(room) {
  const active = activePlayers(room);
  if (active.length === 1) return true;
  return canAct(room).every(p => p.bet === room.currentBet);
}

function broadcastWithCards(roomId) {
  const room = rooms[roomId];
  broadcast(roomId);
  // Send each player their private cards
  room.players.forEach(p => {
    io.to(p.id).emit('player:cards', p.cards);
  });
}

function scheduleTimeout(roomId) {
  const room = rooms[roomId];
  if (room.actionTimer) clearTimeout(room.actionTimer);
  room.actionTimer = setTimeout(() => {
    // Auto-fold or check on timeout
    handleAction(roomId, room.players[room.actionIdx]?.id, 'check');
  }, ACTION_TIMEOUT);
}

function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
}

function handleAction(roomId, playerId, action, amount) {
  const room = rooms[roomId];
  if (room.state !== 'playing') return;
  const p = room.players[room.actionIdx];
  if (!p || p.id !== playerId) return;

  clearActionTimer(room);

  if (action === 'fold') {
    p.folded = true;
  } else if (action === 'check') {
    // Only valid if no bet to call
    if (p.bet < room.currentBet) { p.folded = true; } // treat as fold if can't check
  } else if (action === 'call') {
    const toCall = Math.min(room.currentBet - p.bet, p.chips);
    p.chips -= toCall;
    p.bet += toCall;
    room.pot += toCall;
    if (p.chips === 0) p.allIn = true;
  } else if (action === 'raise') {
    const minRaise = room.currentBet * 2 || BIG_BLIND;
    const raiseTo = Math.min(Math.max(amount || minRaise, minRaise), p.chips + p.bet);
    const add = raiseTo - p.bet;
    const actual = Math.min(add, p.chips);
    p.chips -= actual;
    p.bet += actual;
    room.pot += actual;
    room.currentBet = p.bet;
    if (p.chips === 0) p.allIn = true;
  }

  // Check if only 1 active
  if (activePlayers(room).length === 1) {
    return endHand(roomId);
  }

  // Advance action or next round
  if (bettingDone(room)) {
    advanceRound(roomId);
  } else {
    room.actionIdx = nextActive(room, room.actionIdx);
    broadcastWithCards(roomId);
    scheduleTimeout(roomId);
  }
}

function advanceRound(roomId) {
  const room = rooms[roomId];
  // Reset bets for new round
  room.players.forEach(p => { p.bet = 0; });
  room.currentBet = 0;

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

  // Action starts left of dealer
  room.actionIdx = nextActive(room, room.dealerIdx);
  broadcastWithCards(roomId);
  scheduleTimeout(roomId);
}

function endHand(roomId) {
  const room = rooms[roomId];
  clearActionTimer(room);
  room.state = 'showdown';

  const active = activePlayers(room);
  let winners = [];

  if (active.length === 1) {
    winners = [{ player: active[0], reason: 'Wszyscy spasowali' }];
    active[0].chips += room.pot;
  } else {
    // Evaluate hands
    const ranked = active.map(p => ({
      player: p,
      hand: bestHand(p.cards, room.community),
    }));
    ranked.sort((a,b) => compareTB(b.hand, a.hand));
    const best = ranked[0].hand;
    const topPlayers = ranked.filter(r => compareTB(r.hand, best) === 0);
    const share = Math.floor(room.pot / topPlayers.length);
    topPlayers.forEach(r => { r.player.chips += share; });
    // remainder to first winner
    topPlayers[0].player.chips += room.pot - share * topPlayers.length;
    winners = topPlayers.map(r => ({
      player: r.player,
      hand: HAND_NAMES[r.hand.rank],
      reason: HAND_NAMES[r.hand.rank],
    }));
  }

  // Send showdown info with revealed cards
  const showdown = {
    winners: winners.map(w => ({ id: w.player.id, name: w.player.name, hand: w.reason })),
    players: active.map(p => ({ id: p.id, name: p.name, cards: p.cards })),
    pot: room.pot,
    community: room.community,
  };
  io.to(`room:${roomId}`).emit('showdown', showdown);

  // Remove busted players
  room.players = room.players.filter(p => p.chips > 0);

  // Reset for next hand after delay
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

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let playerRoomId = null;
  let playerName = null;

  socket.on('rooms:list', () => {
    socket.emit('rooms:list', Object.values(rooms).map(r => ({
      id: r.id,
      name: r.name,
      state: r.state,
      playerCount: r.players.length,
      maxPlayers: MAX_PLAYERS,
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
      id: socket.id,
      name: playerName,
      chips: STARTING_CHIPS,
      cards: [],
      bet: 0,
      folded: false,
      allIn: false,
      sitOut: false,
    });

    socket.join(`room:${roomId}`);
    socket.emit('room:joined', { roomId, name: playerName, chips: STARTING_CHIPS });
    socket.emit('player:cards', []);
    broadcast(roomId);

    // Auto-start if 2+ players and game waiting
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
