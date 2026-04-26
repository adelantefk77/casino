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
const NUM_BOT_ROOMS = 3;            // rooms 4,5,6
const MAX_PLAYERS = 5;
const MAX_HUMANS_BOT_ROOM = 1;
const BOTS_PER_TABLE = 3;
const STARTING_CHIPS = 1000;
const BASE_SMALL_BLIND = 10;
const BASE_BIG_BLIND = 20;
const ACTION_TIMEOUT = 60000;
const BLIND_UP_INTERVAL = 5 * 60 * 1000;
const START_COUNTDOWN = 10;
const BOT_START_COUNTDOWN = 3;      // bot rooms start faster
const BOT_NAMES = ['Kazik 🤖','Bartek 🤖','Franek 🤖','Piotrek 🤖'];

// ─── State ─────────────────────────────────────────────────────────────────────
const rooms = {};
function makeRoom(i, isBot) {
  return {
    id: i, name: isBot ? `Stół ${i} 🤖` : `Stół ${i}`,
    isBot: !!isBot, players: [],
    state: 'waiting', deck: [], community: [],
    pot: 0, currentBet: 0, lastRaiseSize: BASE_BIG_BLIND,
    smallBlind: BASE_SMALL_BLIND, bigBlind: BASE_BIG_BLIND,
    blindLevel: 1,
    dealerIdx: -1, actionIdx: -1,
    round: 'preflop',
    acted: new Set(),
    bbIdx: -1,
    actionTimer: null,
    blindTimer: null,
    startTimer: null,
    startCountdown: 0,
  };
}
for (let i = 1; i <= NUM_ROOMS; i++) rooms[i] = makeRoom(i, false);
for (let i = NUM_ROOMS + 1; i <= NUM_ROOMS + NUM_BOT_ROOMS; i++) {
  rooms[i] = makeRoom(i, true);
  seedBots(i);
}

// ─── Bot helpers ──────────────────────────────────────────────────────────────
function makeBot(roomId, idx) {
  return {
    id: `bot-${roomId}-${idx}-${Date.now()}`,
    name: BOT_NAMES[idx % BOT_NAMES.length],
    chips: STARTING_CHIPS,
    cards: [], bet: 0, contributed: 0,
    folded: false, allIn: false, sitOut: false,
    isBot: true,
  };
}

function seedBots(roomId) {
  const room = rooms[roomId];
  room.players = [];
  for (let i = 0; i < BOTS_PER_TABLE; i++) room.players.push(makeBot(roomId, i));
}

function refillBots(roomId) {
  const room = rooms[roomId];
  if (!room.isBot) return;
  const bots = room.players.filter(p => p.isBot);
  const needed = BOTS_PER_TABLE - bots.length;
  for (let i = 0; i < needed; i++) room.players.push(makeBot(roomId, bots.length + i));
}

function humanCount(room) { return room.players.filter(p => !p.isBot).length; }

// ─── Bot AI ────────────────────────────────────────────────────────────────────
function evalPreflop(cards) {
  const v = cards.map(c => RANK_VAL[c.rank]);
  const suited = cards[0].suit === cards[1].suit;
  const paired = v[0] === v[1];
  const high = Math.max(...v);
  const conn = Math.abs(v[0]-v[1]) <= 2;
  if (paired && high >= 10) return 4;
  if (paired) return 3;
  if (high >= 13 && Math.min(...v) >= 10) return 3;
  if (suited && conn && high >= 9) return 2;
  if (high >= 12) return 2;
  if (high >= 10) return 1;
  return 0;
}

function botDecide(room, bot) {
  const canCheck = bot.bet >= room.currentBet;
  const callAmt = Math.min(room.currentBet - bot.bet, bot.chips);
  const rand = Math.random();

  let strength;
  if (room.community.length >= 3) {
    strength = bestHand(bot.cards, room.community)?.rank ?? 0;
  } else {
    strength = evalPreflop(bot.cards);
  }

  const minRaiseTo = Math.min(room.currentBet + room.lastRaiseSize, bot.chips + bot.bet);
  const bluff = rand < 0.08; // 8% bluff

  if (strength >= 5 || bluff) {
    if (rand < 0.55) return { action: 'raise', amount: minRaiseTo };
    return canCheck ? { action: 'check' } : { action: 'call' };
  }
  if (strength >= 3) {
    if (rand < 0.25) return { action: 'raise', amount: minRaiseTo };
    if (rand < 0.85 || canCheck) return canCheck ? { action: 'check' } : { action: 'call' };
    return { action: 'fold' };
  }
  if (strength >= 1) {
    if (canCheck) return { action: 'check' };
    if (callAmt <= room.bigBlind * 4 && rand < 0.6) return { action: 'call' };
    return { action: 'fold' };
  }
  // Weak
  if (canCheck) return rand < 0.12 ? { action: 'raise', amount: minRaiseTo } : { action: 'check' };
  if (rand < 0.15) return { action: 'call' };
  return { action: 'fold' };
}

function scheduleBotActionIfNeeded(roomId) {
  const room = rooms[roomId];
  if (room.state !== 'playing') return;
  const bot = room.players[room.actionIdx];
  if (!bot || !bot.isBot) return;
  const delay = 800 + Math.random() * 1800;
  setTimeout(() => {
    if (room.state !== 'playing') return;
    if (room.players[room.actionIdx]?.id !== bot.id) return;
    const d = botDecide(room, bot);
    handleAction(roomId, bot.id, d.action, d.amount);
  }, delay);
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
  return -1;
}

function bettingDone(room) {
  if (activePlayers(room).length === 1) return true;
  const actable = canAct(room);
  if (actable.length === 0) return true;
  return actable.every(p => p.bet === room.currentBet && room.acted.has(p.id));
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcast(roomId) {
  io.to(`room:${roomId}`).emit('room:update', publicRoom(rooms[roomId]));
}

function publicRoom(room) {
  return {
    id: room.id, name: room.name, state: room.state, isBot: room.isBot,
    pot: room.pot, community: room.community,
    currentBet: room.currentBet, round: room.round,
    dealerIdx: room.dealerIdx, actionIdx: room.actionIdx,
    smallBlind: room.smallBlind, bigBlind: room.bigBlind, blindLevel: room.blindLevel,
    lastRaiseSize: room.lastRaiseSize,
    startCountdown: room.startCountdown,
    humanCount: humanCount(room),
    players: room.players.map(p => ({
      id: p.id, name: p.name, chips: p.chips,
      bet: p.bet, folded: p.folded, allIn: p.allIn,
      cardCount: p.cards.length, isBot: p.isBot,
      disconnected: !!p.disconnected,
    })),
  };
}

function broadcastWithCards(roomId) {
  const room = rooms[roomId];
  broadcast(roomId);
  room.players.forEach(p => { if (!p.isBot) io.to(p.id).emit('player:cards', p.cards); });
  scheduleBotActionIfNeeded(roomId);
}

function scheduleTimeout(roomId) {
  const room = rooms[roomId];
  clearActionTimer(room);
  room.actionTimer = setTimeout(() => {
    const p = room.players[room.actionIdx];
    if (!p) return;
    handleAction(roomId, p.id, p.bet >= room.currentBet ? 'check' : 'fold');
  }, ACTION_TIMEOUT);
}

function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
}

// ─── Blind escalation ─────────────────────────────────────────────────────────
function startBlindTimer(roomId) {
  const room = rooms[roomId];
  if (room.blindTimer) clearInterval(room.blindTimer);
  room.blindTimer = setInterval(() => {
    room.smallBlind *= 2;
    room.bigBlind *= 2;
    room.blindLevel++;
    io.to(`room:${roomId}`).emit('blind:up', {
      level: room.blindLevel, small: room.smallBlind, big: room.bigBlind,
    });
  }, BLIND_UP_INTERVAL);
}

function stopBlindTimer(room) {
  if (room.blindTimer) { clearInterval(room.blindTimer); room.blindTimer = null; }
}

// ─── Start countdown ──────────────────────────────────────────────────────────
function beginStartCountdown(roomId, seconds) {
  const room = rooms[roomId];
  if (room.startTimer) return;
  room.startCountdown = seconds ?? START_COUNTDOWN;
  broadcast(roomId);

  room.startTimer = setInterval(() => {
    room.startCountdown--;
    broadcast(roomId);
    if (room.startCountdown <= 0) {
      clearInterval(room.startTimer);
      room.startTimer = null;
      room.startCountdown = 0;
      startGame(roomId);
    }
  }, 1000);
}

function cancelStartCountdown(room) {
  if (room.startTimer) { clearInterval(room.startTimer); room.startTimer = null; }
  room.startCountdown = 0;
}

// ─── Game flow ─────────────────────────────────────────────────────────────────
function startGame(roomId) {
  const room = rooms[roomId];
  if (room.players.length < 2 || room.state === 'playing') return;

  room.state = 'playing';
  room.deck = buildDeck();
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.lastRaiseSize = room.bigBlind;
  room.round = 'preflop';
  room.acted = new Set();

  room.players.forEach(p => {
    p.cards = []; p.bet = 0; p.contributed = 0;
    p.folded = false; p.allIn = false;
  });

  room.dealerIdx = (room.dealerIdx + 1) % room.players.length;

  for (let i=0;i<2;i++) room.players.forEach(p => p.cards.push(dealCard(room)));

  const sbIdx = nextActive(room, room.dealerIdx);
  const bbIdx = nextActive(room, sbIdx);
  room.bbIdx = bbIdx;
  postBlind(room, sbIdx, room.smallBlind);
  postBlind(room, bbIdx, room.bigBlind);
  room.currentBet = room.bigBlind;

  const utgIdx = nextActive(room, bbIdx);
  room.actionIdx = utgIdx !== -1 ? utgIdx : bbIdx;

  startBlindTimer(roomId);
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
    if (p.bet < room.currentBet) { p.folded = true; }
    room.acted.add(p.id);
  } else if (action === 'call') {
    const toCall = Math.min(room.currentBet - p.bet, p.chips);
    p.chips -= toCall; p.bet += toCall; p.contributed += toCall;
    room.pot += toCall;
    if (p.chips === 0) p.allIn = true;
    room.acted.add(p.id);
  } else if (action === 'raise') {
    const minRaiseTo = room.currentBet + room.lastRaiseSize;
    const raiseTo = Math.min(Math.max(amount || minRaiseTo, minRaiseTo), p.chips + p.bet);
    const add = raiseTo - p.bet;
    const actual = Math.min(add, p.chips);
    room.lastRaiseSize = actual;
    p.chips -= actual; p.bet += actual; p.contributed += actual;
    room.pot += actual;
    room.currentBet = p.bet;
    if (p.chips === 0) p.allIn = true;
    room.acted = new Set([p.id]);
  } else if (action === 'allin') {
    const actual = p.chips;
    if (actual > 0) {
      if (p.bet + actual > room.currentBet) {
        room.lastRaiseSize = p.bet + actual - room.currentBet;
        room.currentBet = p.bet + actual;
        room.acted = new Set([p.id]);
      } else {
        room.acted.add(p.id);
      }
      p.chips = 0; p.bet += actual; p.contributed += actual;
      room.pot += actual;
      p.allIn = true;
    } else {
      room.acted.add(p.id);
    }
  }

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
  room.lastRaiseSize = room.bigBlind;
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

  const first = nextActive(room, room.dealerIdx);
  if (first === -1) return endHand(roomId);
  room.actionIdx = first;

  if (canAct(room).length <= 1) {
    room.acted.add(room.players[room.actionIdx].id);
    return advanceRound(roomId);
  }

  broadcastWithCards(roomId);
  scheduleTimeout(roomId);
}

// ─── Side pot calculation ──────────────────────────────────────────────────────
function calcPots(players) {
  const contribs = players.map(p => ({ id: p.id, total: p.contributed, folded: p.folded }))
    .sort((a, b) => a.total - b.total);
  const pots = [];
  let prev = 0;
  for (let i = 0; i < contribs.length; i++) {
    const cap = contribs[i].total;
    if (cap === prev) continue;
    let amount = 0;
    for (const pl of players) {
      amount += Math.min(pl.contributed, cap) - Math.min(pl.contributed, prev);
    }
    const eligibleIds = contribs.slice(i).filter(c => !c.folded).map(c => c.id);
    if (amount > 0 && eligibleIds.length > 0) pots.push({ amount, eligible: eligibleIds });
    prev = cap;
  }
  return pots;
}

function endHand(roomId) {
  const room = rooms[roomId];
  clearActionTimer(room);
  stopBlindTimer(room);
  room.state = 'showdown';

  const active = activePlayers(room);
  const showdownPlayers = [];
  const revealCards = active.length > 1; // only reveal at true showdown

  if (active.length === 1) {
    active[0].chips += room.pot;
    showdownPlayers.push({ player: active[0], hand: 'Wszyscy spasowali' });
  } else {
    const pots = calcPots(room.players);
    const handMap = {};
    active.forEach(p => { handMap[p.id] = bestHand(p.cards, room.community); });

    for (const pot of pots) {
      const contenders = active.filter(p => pot.eligible.includes(p.id));
      if (!contenders.length) continue;
      contenders.sort((a,b) => compareTB(handMap[b.id], handMap[a.id]));
      const bestH = handMap[contenders[0].id];
      const winners = contenders.filter(p => compareTB(handMap[p.id], bestH) === 0);
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach(p => { p.chips += share; });
      winners[0].chips += pot.amount - share * winners.length;
      winners.forEach(w => {
        if (!showdownPlayers.find(x => x.player.id === w.id))
          showdownPlayers.push({ player: w, hand: HAND_NAMES[bestH.rank] });
      });
    }
  }

  io.to(`room:${roomId}`).emit('showdown', {
    winners: showdownPlayers.map(w => ({ id: w.player.id, name: w.player.name, hand: w.hand })),
    // Only send revealed cards at true showdown
    players: revealCards ? active.map(p => ({ id: p.id, name: p.name, cards: p.cards })) : [],
    pot: room.pot,
    community: room.community,
  });

  // Remove busted non-bot players; busted bots get replaced
  room.players = room.players.filter(p => p.isBot || p.chips > 0);
  if (room.isBot) refillBots(roomId);

  setTimeout(() => {
    const canStart = room.isBot
      ? humanCount(room) >= 1 && room.players.length >= 2
      : room.players.length >= 2;
    if (canStart) {
      room.pot = 0;
      startGame(roomId);
    } else {
      room.state = 'waiting';
      broadcast(roomId);
    }
  }, 5000);
}

// ─── Reconnect cache ──────────────────────────────────────────────────────────
// nick → { roomId, removeTimer }
const dcPlayers = {};

function playerDisconnected(socket, playerRoomId, playerName) {
  const room = rooms[playerRoomId];
  if (!room) return;

  const p = room.players.find(pl => pl.id === socket.id);
  if (!p || p.isBot) return;

  // Mark disconnected — keep in room
  p.disconnected = true;
  p.dcSocketId = socket.id; // remember old id for action matching

  // If it was their turn, auto-fold them quickly so game continues
  if (room.state === 'playing' && room.players[room.actionIdx]?.id === socket.id) {
    clearActionTimer(room);
    setTimeout(() => {
      // Still disconnected and still their turn?
      if (p.disconnected && room.players[room.actionIdx]?.id === socket.id) {
        handleAction(playerRoomId, socket.id, 'fold');
      }
    }, 1500);
  }

  broadcast(playerRoomId);

  // Schedule removal after 90s if they don't come back
  if (dcPlayers[playerName]) clearTimeout(dcPlayers[playerName].removeTimer);
  dcPlayers[playerName] = {
    roomId: playerRoomId,
    removeTimer: setTimeout(() => {
      delete dcPlayers[playerName];
      const r = rooms[playerRoomId];
      if (!r) return;
      r.players = r.players.filter(pl => pl.name !== playerName || !pl.disconnected);
      checkRoomAfterLeave(playerRoomId);
      broadcast(playerRoomId);
    }, 90000),
  };
}

function checkRoomAfterLeave(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const active = room.players.filter(p => !p.isBot && !p.disconnected);
  if (room.isBot) {
    if (active.length === 0) {
      clearActionTimer(room); cancelStartCountdown(room); stopBlindTimer(room);
      room.state = 'waiting';
      room.players = room.players.filter(p => p.isBot);
      refillBots(roomId);
    }
  } else {
    const total = room.players.filter(p => !p.disconnected);
    if (total.length < 2) {
      clearActionTimer(room); cancelStartCountdown(room); stopBlindTimer(room);
      room.state = 'waiting';
    }
  }
}

// ─── HaxBall — pure Socket.io relay (physics = Phaser 2 P2.js client-side) ──
// Matches open-hax architecture: server is only a message relay, no physics.
const HAX_ROOMS = 3, HAX_BOT_ROOMS = 3, HAX_GOAL_LIMIT = 5;
const haxRooms = {};
for (let i = 1; i <= HAX_ROOMS + HAX_BOT_ROOMS; i++) {
  haxRooms[i] = {
    id: i, isBot: i > HAX_ROOMS,
    players: [],      // {id, name, team}
    state: 'waiting',
    score: { gold: 0, rose: 0 },
    host: null,       // socket ID of host (runs ball physics + goals)
    goalLock: false,
  };
}
function haxRoster(r) {
  return r.players.map(p => ({ id: p.id, name: p.name, team: p.team }));
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
      id: r.id, name: r.name, state: r.state, isBot: r.isBot,
      playerCount: r.players.length,
      humanCount: humanCount(r),
      maxPlayers: r.isBot ? BOTS_PER_TABLE + MAX_HUMANS_BOT_ROOM : MAX_PLAYERS,
    })));
  });

  socket.on('room:join', ({ roomId, name }) => {
    if (!name || name.trim().length < 2) return socket.emit('error', 'Podaj nickname (min 2 znaki)');
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Pokój nie istnieje');
    const maxP = room.isBot ? BOTS_PER_TABLE + MAX_HUMANS_BOT_ROOM : MAX_PLAYERS;
    if (room.players.length >= maxP) return socket.emit('error', 'Stolik pełny');
    if (room.isBot && humanCount(room) >= MAX_HUMANS_BOT_ROOM)
      return socket.emit('error', 'Stolik botów — tylko 1 gracz');
    if (room.players.find(p => p.name === name.trim() && !p.isBot)) return socket.emit('error', 'Nick zajęty w tym pokoju');

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

    // Start countdown
    if (room.state === 'waiting') {
      if (room.isBot && humanCount(room) >= 1) {
        beginStartCountdown(roomId, BOT_START_COUNTDOWN);
      } else if (!room.isBot && room.players.length >= 2) {
        beginStartCountdown(roomId, START_COUNTDOWN);
      }
    }
  });

  socket.on('room:rejoin', ({ name }) => {
    if (!name) return;
    const entry = dcPlayers[name];
    if (!entry) return socket.emit('rejoin:failed', 'Sesja wygasła — dołącz ponownie');

    const room = rooms[entry.roomId];
    if (!room) return socket.emit('rejoin:failed', 'Pokój nie istnieje');

    const p = room.players.find(pl => pl.name === name && pl.disconnected);
    if (!p) return socket.emit('rejoin:failed', 'Nie znaleziono gracza');

    // Clear removal timer
    clearTimeout(entry.removeTimer);
    delete dcPlayers[name];

    // Restore player's socket ID
    const oldId = p.id;
    p.id = socket.id;
    p.disconnected = false;
    p.dcSocketId = null;

    // Update acted set if they were in it
    if (room.acted.has(oldId)) { room.acted.delete(oldId); room.acted.add(socket.id); }

    // Update actionIdx target if it was pointing to them
    // (actionIdx is numeric index, still valid)

    playerRoomId = entry.roomId;
    playerName = name;

    socket.join(`room:${entry.roomId}`);
    socket.emit('room:joined', { roomId: entry.roomId, name, chips: p.chips, rejoin: true });
    socket.emit('player:cards', p.cards);
    broadcast(entry.roomId);
  });

  socket.on('action', ({ action, amount }) => {
    if (!playerRoomId) return;
    handleAction(playerRoomId, socket.id, action, amount);
  });

  // ── HaxBall relay (pure relay, no server physics — like open-hax app.js) ──
  let haxRid = null;

  socket.on('hax:rooms', () => {
    socket.emit('hax:rooms', Object.values(haxRooms).map(r => ({
      id: r.id, isBot: r.isBot, state: r.state, score: r.score,
      gold: r.players.filter(p => p.team === 'gold').length,
      rose: r.players.filter(p => p.team === 'rose').length,
    })));
  });

  socket.on('hax:join', ({ roomId, team, name }) => {
    if (haxRid) {
      const pr = haxRooms[haxRid];
      if (pr) {
        pr.players = pr.players.filter(p => p.id !== socket.id);
        socket.leave(`hax:${haxRid}`);
        if (pr.host === socket.id) pr.host = pr.players[0]?.id || null;
        if (pr.players.length === 0) { pr.state='waiting'; pr.score={gold:0,rose:0}; pr.goalLock=false; }
        io.to(`hax:${haxRid}`).emit('hax:roster', haxRoster(pr));
      }
      haxRid = null;
    }
    const r = haxRooms[roomId];
    if (!r) return;
    const effectiveTeam = r.isBot ? 'gold' : team;
    if (r.isBot && r.players.length >= 1) return socket.emit('error', 'Arena z botami — tylko 1 gracz');
    if (!r.isBot && r.players.filter(p => p.team === effectiveTeam).length >= 3)
      return socket.emit('error', 'Drużyna pełna (max 3)');

    haxRid = roomId;
    const isHost = r.players.length === 0;
    if (isHost) r.host = socket.id;
    r.players.push({ id: socket.id, name: (name||'Gracz').slice(0,14), team: effectiveTeam });
    socket.join(`hax:${roomId}`);
    socket.emit('hax:joined', { roomId, team: effectiveTeam, isHost, isBotRoom: r.isBot });
    io.to(`hax:${roomId}`).emit('hax:roster', haxRoster(r));

    const ready = () => r.isBot
      ? r.players.length >= 1
      : r.players.some(p=>p.team==='gold') && r.players.some(p=>p.team==='rose');
    if (r.state === 'waiting' && ready()) {
      setTimeout(() => {
        if (r.state === 'waiting' && ready()) {
          r.state = 'playing';
          io.to(`hax:${roomId}`).emit('hax:start', { score: r.score });
        }
      }, r.isBot ? 1500 : 3000);
    }
  });

  // Relay player position to room peers
  socket.on('hax:pos', data => {
    if (!haxRid) return;
    socket.to(`hax:${haxRid}`).emit('hax:pos', { id: socket.id, ...data });
  });

  // Host relays ball position to non-hosts
  socket.on('hax:ball', data => {
    if (!haxRid) return;
    if (haxRooms[haxRid]?.host !== socket.id) return;
    socket.to(`hax:${haxRid}`).emit('hax:ball', data);
  });

  // Host reports goal → server tracks score
  socket.on('hax:goal', ({ scorer }) => {
    if (!haxRid) return;
    const r = haxRooms[haxRid];
    if (!r || r.host !== socket.id || r.goalLock) return;
    r.goalLock = true;
    r.score[scorer] = (r.score[scorer]||0) + 1;
    io.to(`hax:${haxRid}`).emit('hax:goal', { scorer, score: r.score });
    setTimeout(() => {
      r.goalLock = false;
      if (r.score[scorer] >= HAX_GOAL_LIMIT) {
        const winner = scorer;
        r.score = {gold:0,rose:0};
        r.state = r.isBot ? 'playing' : 'waiting';
        io.to(`hax:${haxRid}`).emit('hax:gameover', { winner });
      } else {
        // Tell clients which team conceded (they get kickoff)
      var conceded = scorer === 'gold' ? 'rose' : 'gold';
      io.to(`hax:${haxRid}`).emit('hax:respawn', { kickoffTeam: conceded });
      }
    }, 2500);
  });

  socket.on('hax:leave', () => {
    if (!haxRid) return;
    const r = haxRooms[haxRid];
    if (r) {
      r.players = r.players.filter(p => p.id !== socket.id);
      socket.leave(`hax:${haxRid}`);
      if (r.host === socket.id) {
        r.host = r.players[0]?.id || null;
        if (r.host) io.to(r.host).emit('hax:became-host');
      }
      if (r.players.length === 0) { r.state='waiting'; r.score={gold:0,rose:0}; r.goalLock=false; }
      io.to(`hax:${haxRid}`).emit('hax:roster', haxRoster(r));
    }
    haxRid = null;
  });

  socket.on('disconnect', () => {
    if (haxRid) {
      const r = haxRooms[haxRid];
      if (r) {
        r.players = r.players.filter(p => p.id !== socket.id);
        if (r.host === socket.id) {
          r.host = r.players[0]?.id || null;
          if (r.host) io.to(r.host).emit('hax:became-host');
        }
        if (r.players.length === 0) { r.state='waiting'; r.score={gold:0,rose:0}; r.goalLock=false; }
        io.to(`hax:${haxRid}`).emit('hax:roster', haxRoster(r));
      }
    }
    if (!playerRoomId || !playerName) return;
    playerDisconnected(socket, playerRoomId, playerName);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎰  Jankowo Casino running at http://localhost:${PORT}\n`);
});
