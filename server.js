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

// ─── HaxBall — mechanics based on open-hax (erasmo-marin/open-hax) ────────────
// Field matches open-hax: 860x460, goals x=30/830, y=160-300
const FW = 860, FH = 460;
const GOAL_XL = 30,  GOAL_XR = 830;   // goal mouth x positions
const GOAL_Y1 = 160, GOAL_Y2 = 300;   // goal y range (height=140)
const GOAL_DEPTH = 28;                 // net depth

// Player physics — tuned for 860×460 field at 60fps
// Target feel: player crosses field in ~3s, stops in ~0.5s after key release
const PR  = 15;    // player radius px (open-hax: 15)
const PM  = 1;     // player mass
const PA  = 0.55;  // acceleration px/frame when key held
const PMS = 4.5;   // max speed px/frame (crosses 860px in ~190 frames = 3.2s)
const PF  = 0.87;  // per-frame friction (stops in ~6 frames after release)

// Ball physics — open-hax feel: rolls far, soft player bounce, kick is the weapon
const BR  = 10;    // ball radius px (open-hax: 10)
const BM  = 0.8;   // ball mass (lighter than player)
const BF  = 0.984; // per-frame friction — ball slows in ~3s
const BWB = 0.68;  // wall restitution (slightly lossy)
const BPB = 0.1;   // player-ball restitution (soft — like open-hax 0.1)
const B_MAX_SPEED = 18;

// Kick — open-hax: X key, force 4000 = instant powerful shot
const KICK_V     = 11;        // px/frame impulse on kick
const KICK_RANGE = PR + BR + 5;
const KICK_CD    = 20;        // frames cooldown

const HAX_GOAL_LIMIT = 5;
const HAX_TIME_LIMIT = 180;
const HAX_ROOMS_COUNT = 3;
const HAX_BOT_ROOMS_COUNT = 3;
const HAX_BOT_NAMES = ['Robo Rosa 🤖', 'Robo Striker 🤖', 'Robo Keeper 🤖'];

const haxRooms = {};
for (let i = 1; i <= HAX_ROOMS_COUNT; i++) {
  haxRooms[i] = { id: i, isBot: false, players: [], ball: null,
    score: { gold: 0, rose: 0 }, state: 'waiting',
    loop: null, tick: 0, startTs: 0, gcool: 0 };
}
for (let i = HAX_ROOMS_COUNT + 1; i <= HAX_ROOMS_COUNT + HAX_BOT_ROOMS_COUNT; i++) {
  haxRooms[i] = { id: i, isBot: true, players: [], ball: null,
    score: { gold: 0, rose: 0 }, state: 'waiting',
    loop: null, tick: 0, startTs: 0, gcool: 0 };
  haxSeedBots(i);
}

function haxMakeBot(rid, idx) {
  return { id: `hbot-${rid}-${idx}`, name: HAX_BOT_NAMES[idx % HAX_BOT_NAMES.length],
    team: 'rose', x: FW * 0.70, y: FH/2 + (idx - 0.5) * 70,
    vx: 0, vy: 0, keys: {}, kickCooldown: 0, isBot: true };
}

function haxSeedBots(rid) {
  const r = haxRooms[rid];
  r.players = r.players.filter(p => !p.isBot);
  for (let i = 0; i < 2; i++) r.players.push(haxMakeBot(rid, i));
}

// Bot AI: rose team attacks left goal (x < GOAL_XL)
// Strategy: get behind ball (to ball's right) and kick left toward goal
function haxBotAI(bot, ball, idx) {
  const dx = ball.x - bot.x;
  const dy = ball.y - bot.y;
  const dist = Math.hypot(dx, dy);
  const isStriker = idx === 0;

  // Target position: approach ball from the right to push it left
  let tx, ty;
  if (dist < KICK_RANGE + 5) {
    // On top of ball — kick toward left goal
    tx = ball.x;
    ty = ball.y;
  } else if (dist < 120) {
    // Close: move directly to ball
    tx = ball.x + (isStriker ? 8 : 15);
    ty = ball.y;
  } else {
    // Far: position to ball's right side
    tx = ball.x + 40;
    ty = ball.y + (bot.y - ball.y) * 0.2;
  }

  // Defender (idx=1): also cover own goal
  if (!isStriker && ball.x > FW * 0.6) {
    tx = GOAL_XR - 60;
    ty = FH / 2;
  }

  tx += (Math.random() - 0.5) * 10;
  ty += (Math.random() - 0.5) * 10;

  const kick = dist < KICK_RANGE + 2;
  return {
    left:  bot.x > tx + 6,
    right: bot.x < tx - 6,
    up:    bot.y > ty + 6,
    down:  bot.y < ty - 6,
    kick,
  };
}

function haxBallObj() { return { x: FW/2, y: FH/2, vx: 0, vy: 0 }; }

function haxSpawn(room) {
  const gold = room.players.filter(p => p.team === 'gold');
  const rose = room.players.filter(p => p.team === 'rose');
  // Gold spawns left (attacking right), rose spawns right (attacking left)
  gold.forEach((p, i) => { p.x = FW*0.30; p.y = FH/2 + (i-(gold.length-1)/2)*60; p.vx=0; p.vy=0; p.kickCooldown=0; });
  rose.forEach((p, i) => { p.x = FW*0.70; p.y = FH/2 + (i-(rose.length-1)/2)*60; p.vx=0; p.vy=0; p.kickCooldown=0; });
  room.ball = haxBallObj();
}

function haxStart(rid) {
  const r = haxRooms[rid];
  if (r.loop) clearInterval(r.loop);
  r.state = 'playing'; r.score = { gold: 0, rose: 0 };
  r.startTs = Date.now(); r.tick = 0; r.gcool = 0;
  haxSpawn(r);
  io.to(`hax:${rid}`).emit('hax:start', { score: r.score });
  r.loop = setInterval(() => haxTick(rid), 1000 / 60);
}

function haxStop(rid) {
  const r = haxRooms[rid];
  if (r.loop) { clearInterval(r.loop); r.loop = null; }
  r.state = 'waiting';
}

function haxTick(rid) {
  const r = haxRooms[rid];
  r.tick++;
  if (r.gcool > 0) { r.gcool--; haxBcast(rid); return; }

  // Bot AI (every 3 ticks ≈ 20fps)
  if (r.isBot && r.ball && r.tick % 3 === 0) {
    r.players.filter(p => p.isBot).forEach((bot, idx) => {
      bot.keys = haxBotAI(bot, r.ball, idx);
    });
  }

  const b = r.ball;

  // ── Players ───────────────────────────────────────────────────────────────
  for (const p of r.players) {
    const k = p.keys || {};

    // Movement (Phaser P2 thrust model)
    let ax = 0, ay = 0;
    if (k.up)    ay -= PA;
    if (k.down)  ay += PA;
    if (k.left)  ax -= PA;
    if (k.right) ax += PA;
    if (ax && ay) { ax *= 0.707; ay *= 0.707; }
    p.vx += ax; p.vy += ay;
    p.vx *= PF; p.vy *= PF;
    const spd = Math.hypot(p.vx, p.vy);
    if (spd > PMS) { p.vx *= PMS / spd; p.vy *= PMS / spd; }
    p.x += p.vx; p.y += p.vy;

    // Wall clamp — players stay inside field (not in nets)
    if (p.y < PR)       { p.y = PR;       p.vy =  Math.abs(p.vy) * 0.3; }
    if (p.y > FH - PR)  { p.y = FH - PR;  p.vy = -Math.abs(p.vy) * 0.3; }
    if (p.x < PR)       { p.x = PR;       p.vx =  Math.abs(p.vx) * 0.3; }
    if (p.x > FW - PR)  { p.x = FW - PR;  p.vx = -Math.abs(p.vx) * 0.3; }

    // Kick mechanic (open-hax: X key, force=4000 on ball)
    if (p.kickCooldown > 0) p.kickCooldown--;
    if (k.kick && p.kickCooldown === 0 && b) {
      const kdx = b.x - p.x, kdy = b.y - p.y;
      const kd = Math.hypot(kdx, kdy);
      if (kd < KICK_RANGE && kd > 0.1) {
        const knx = kdx / kd, kny = kdy / kd;
        b.vx += knx * KICK_V;
        b.vy += kny * KICK_V;
        const bs = Math.hypot(b.vx, b.vy);
        if (bs > B_MAX_SPEED) { b.vx *= B_MAX_SPEED / bs; b.vy *= B_MAX_SPEED / bs; }
        p.kickCooldown = KICK_CD;
      }
    }
  }

  // ── Ball ──────────────────────────────────────────────────────────────────
  b.vx *= BF; b.vy *= BF;
  b.x  += b.vx; b.y  += b.vy;

  // Top / bottom walls
  if (b.y - BR < 0)       { b.y = BR;       b.vy =  Math.abs(b.vy) * BWB; }
  if (b.y + BR > FH)      { b.y = FH - BR;  b.vy = -Math.abs(b.vy) * BWB; }

  // Left wall with goal opening (y 160-300)
  if (b.x - BR < GOAL_XL) {
    if (b.y >= GOAL_Y1 && b.y <= GOAL_Y2) {
      // Inside net: bounce off back wall
      if (b.x - BR < GOAL_XL - GOAL_DEPTH) {
        b.x = GOAL_XL - GOAL_DEPTH + BR;
        b.vx = Math.abs(b.vx) * BWB;
      }
    } else {
      b.x = GOAL_XL + BR;
      b.vx = Math.abs(b.vx) * BWB;
    }
  }

  // Right wall with goal opening
  if (b.x + BR > GOAL_XR) {
    if (b.y >= GOAL_Y1 && b.y <= GOAL_Y2) {
      if (b.x + BR > GOAL_XR + GOAL_DEPTH) {
        b.x = GOAL_XR + GOAL_DEPTH - BR;
        b.vx = -Math.abs(b.vx) * BWB;
      }
    } else {
      b.x = GOAL_XR - BR;
      b.vx = -Math.abs(b.vx) * BWB;
    }
  }

  // Goal posts (open-hax disc positions)
  haxPost(b, GOAL_XL, GOAL_Y1);
  haxPost(b, GOAL_XL, GOAL_Y2);
  haxPost(b, GOAL_XR, GOAL_Y1);
  haxPost(b, GOAL_XR, GOAL_Y2);

  // Player–ball collisions (low restitution = 0.1 like open-hax)
  for (const p of r.players) haxResolve(p, PR, PM, b, BR, BM, BPB);

  // Player–player collisions
  for (let i = 0; i < r.players.length; i++)
    for (let j = i + 1; j < r.players.length; j++)
      haxResolve(r.players[i], PR, PM, r.players[j], PR, PM, 0.85);

  // Cap ball speed
  const bspd = Math.hypot(b.vx, b.vy);
  if (bspd > B_MAX_SPEED) { b.vx *= B_MAX_SPEED / bspd; b.vy *= B_MAX_SPEED / bspd; }

  // ── Goal detection ────────────────────────────────────────────────────────
  const inY = b.y >= GOAL_Y1 && b.y <= GOAL_Y2;
  let goal = null;
  // Ball center past goal line + deep enough in net
  if (inY && b.x < GOAL_XL - GOAL_DEPTH * 0.4) goal = 'rose'; // rose attacks left goal
  if (inY && b.x > GOAL_XR + GOAL_DEPTH * 0.4) goal = 'gold'; // gold attacks right goal

  if (goal) {
    r.score[goal]++;
    r.gcool = 120;
    io.to(`hax:${rid}`).emit('hax:goal', { scorer: goal, score: r.score });
    setTimeout(() => {
      if (r.score[goal] >= HAX_GOAL_LIMIT) {
        haxStop(rid);
        io.to(`hax:${rid}`).emit('hax:gameover', { winner: goal, score: r.score });
        if (r.isBot) setTimeout(() => {
          if (r.players.some(p => !p.isBot)) { haxSeedBots(rid); haxStart(rid); }
        }, 4000);
      } else {
        if (r.isBot) haxSeedBots(rid);
        haxSpawn(r);
      }
    }, 2000);
  }

  const elapsed = (Date.now() - r.startTs) / 1000;
  if (elapsed >= HAX_TIME_LIMIT) {
    haxStop(rid);
    const w = r.score.gold > r.score.rose ? 'gold' : r.score.rose > r.score.gold ? 'rose' : 'draw';
    io.to(`hax:${rid}`).emit('hax:gameover', { winner: w, score: r.score });
    return;
  }

  haxBcast(rid, elapsed);
}

function haxBcast(rid, elapsed) {
  const r = haxRooms[rid];
  io.to(`hax:${rid}`).emit('hax:state', {
    players: r.players.map(p => ({ id: p.id, x: p.x, y: p.y, team: p.team, name: p.name })),
    ball:    r.ball ? { x: r.ball.x, y: r.ball.y } : { x: FW/2, y: FH/2 },
    score:   r.score,
    time:    elapsed !== undefined ? Math.max(0, HAX_TIME_LIMIT - elapsed) : HAX_TIME_LIMIT,
  });
}

// Bounce ball off a goal post disc (open-hax: disc radius=7.5)
function haxPost(b, px, py) {
  const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy);
  const minD = BR + 7.5;
  if (d < minD && d > 0.001) {
    const nx = dx / d, ny = dy / d;
    b.x = px + nx * (minD + 0.1); b.y = py + ny * (minD + 0.1);
    const dot = b.vx * nx + b.vy * ny;
    if (dot < 0) { b.vx -= 2 * dot * nx * BWB; b.vy -= 2 * dot * ny * BWB; }
  }
}

function haxRoster(r) {
  return r.players.map(p => ({ id: p.id, name: p.name, team: p.team, isBot: !!p.isBot }));
}

// Circle–circle elastic collision
function haxResolve(a, ra, ma, b, rb, mb, rest) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), md = ra + rb;
  if (d >= md || d < 0.001) return;
  const nx = dx / d, ny = dy / d, ov = md - d, tm = ma + mb;
  a.x -= nx * ov * mb / tm; a.y -= ny * ov * mb / tm;
  b.x += nx * ov * ma / tm; b.y += ny * ov * ma / tm;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy, rv = rvx * nx + rvy * ny;
  if (rv >= 0) return;
  const j = -(1 + rest) * rv / (1 / ma + 1 / mb);
  a.vx -= j / ma * nx; a.vy -= j / ma * ny;
  b.vx += j / mb * nx; b.vy += j / mb * ny;
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

  // ── HaxBall handlers ──────────────────────────────────────────────────────
  let haxRid = null;

  socket.on('hax:rooms', () => {
    socket.emit('hax:rooms', Object.values(haxRooms).map(r => ({
      id: r.id, state: r.state, score: r.score, isBot: r.isBot,
      gold: r.players.filter(p => p.team==='gold' && !p.isBot).length,
      rose: r.players.filter(p => p.team==='rose' && !p.isBot).length,
      bots: r.players.filter(p => p.isBot).length,
    })));
  });

  socket.on('hax:join', ({ roomId, team, name }) => {
    // Leave previous hax room
    if (haxRid) {
      const pr = haxRooms[haxRid];
      if (pr) {
        pr.players = pr.players.filter(p => p.id !== socket.id);
        socket.leave(`hax:${haxRid}`);
        io.to(`hax:${haxRid}`).emit('hax:roster', haxRoster(pr));
        if (pr.players.filter(p=>!p.isBot).length === 0) haxStop(haxRid);
      }
      haxRid = null;
    }
    const r = haxRooms[roomId];
    if (!r) return;

    // Bot room: human always joins gold, max 1 human
    const effectiveTeam = r.isBot ? 'gold' : team;
    if (r.isBot && r.players.filter(p => !p.isBot).length >= 1)
      return socket.emit('error', 'Arena z botami — tylko 1 gracz');
    if (!r.isBot && r.players.filter(p => p.team === effectiveTeam).length >= 3)
      return socket.emit('error', 'Drużyna pełna (max 3)');

    haxRid = roomId;
    r.players.push({ id: socket.id, name: (name||'Gracz').slice(0,14),
      team: effectiveTeam, x: effectiveTeam==='gold'?FW*0.28:FW*0.72,
      y: FH/2, vx:0, vy:0, keys:{}, isBot: false });
    socket.join(`hax:${roomId}`);
    socket.emit('hax:joined', { roomId, team: effectiveTeam });
    io.to(`hax:${roomId}`).emit('hax:roster', haxRoster(r));

    // Auto-start
    if (r.state === 'waiting') {
      if (r.isBot) {
        // Start immediately (bots already on rose team)
        setTimeout(() => { if (r.state==='waiting') haxStart(roomId); }, 1500);
      } else {
        const hasG = r.players.some(p => p.team==='gold');
        const hasR = r.players.some(p => p.team==='rose');
        if (hasG && hasR) {
          setTimeout(() => {
            if (r.state==='waiting' &&
                r.players.some(p=>p.team==='gold') &&
                r.players.some(p=>p.team==='rose'))
              haxStart(roomId);
          }, 3000);
        }
      }
    }
  });

  socket.on('hax:keys', keys => {
    if (!haxRid) return;
    const p = haxRooms[haxRid]?.players.find(pl => pl.id === socket.id);
    if (p) p.keys = keys;
  });

  socket.on('hax:leave', () => {
    if (!haxRid) return;
    const r = haxRooms[haxRid];
    if (r) {
      r.players = r.players.filter(p => p.id !== socket.id);
      socket.leave(`hax:${haxRid}`);
      const humans = r.players.filter(p => !p.isBot);
      if (humans.length === 0) {
        haxStop(haxRid);
        if (r.isBot) haxSeedBots(haxRid);
      }
      io.to(`hax:${haxRid}`).emit('hax:roster', haxRoster(r));
    }
    haxRid = null;
  });

  socket.on('disconnect', () => {
    // HaxBall cleanup
    if (haxRid) {
      const r = haxRooms[haxRid];
      if (r) {
        r.players = r.players.filter(p => p.id !== socket.id);
        const humans = r.players.filter(p => !p.isBot);
        if (humans.length === 0) {
          haxStop(haxRid);
          if (r.isBot) haxSeedBots(haxRid);
        }
        io.to(`hax:${haxRid}`).emit('hax:roster', haxRoster(r));
      }
    }
    // Poker cleanup
    if (!playerRoomId || !playerName) return;
    playerDisconnected(socket, playerRoomId, playerName);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎰  Jankowo Casino running at http://localhost:${PORT}\n`);
});
