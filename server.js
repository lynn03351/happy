const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 10000, pingInterval: 5000 });
app.use(express.static(path.join(__dirname, 'public')));

const players = {};

// ── 원카드 게임 상태 ──
const cardGame = {
  active: false,
  players: [],      // 참여자 소켓 ID 순서
  hands: {},        // { socketId: [카드,...] }
  deck: [],
  discard: [],      // 버린 패 더미 (top = 현재 낼 기준)
  currentIdx: 0,    // 현재 차례 인덱스
  direction: 1,     // 1=순방향, -1=역방향
  drawStack: 0,     // +2/+4 누적
  pendingDraw: false, // 다음 사람이 드로우 해야함
  waitingForColor: false, // 색상 선택 대기 (조커)
  chosenColor: null,
  gameType: null,   // 'onecard'
};

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  // 조커 2장
  deck.push({ suit: '🃏', rank: 'Joker' });
  deck.push({ suit: '🃏', rank: 'Joker' });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardColor(card) {
  if (card.rank === 'Joker') return 'black';
  return (card.suit === '♥' || card.suit === '♦') ? 'red' : 'black';
}

function isSpecial(card) {
  return ['A','2','3','J','K','Joker'].includes(card.rank);
}

// 카드가 낼 수 있는지 확인
function canPlay(card, top, chosenColor) {
  if (card.rank === 'Joker') return true;
  const effectiveSuit = chosenColor || top.suit;
  if (cardGame.drawStack > 0) {
    // +2/+4 연속일 때는 같은 종류만
    const topIs2 = top.rank === '2';
    const topIsJoker = top.rank === 'Joker';
    if (topIs2 && card.rank === '2') return true;
    if (topIsJoker && card.rank === 'Joker') return true;
    return false;
  }
  return card.suit === effectiveSuit || card.rank === top.rank;
}

function drawFromDeck(n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (cardGame.deck.length === 0) {
      // 버린 패 재활용
      const top = cardGame.discard[cardGame.discard.length - 1];
      cardGame.deck = shuffle(cardGame.discard.slice(0, -1));
      cardGame.discard = [top];
    }
    if (cardGame.deck.length > 0) drawn.push(cardGame.deck.pop());
  }
  return drawn;
}

function broadcastGameState() {
  const top = cardGame.discard[cardGame.discard.length - 1];
  const currentPlayer = cardGame.players[cardGame.currentIdx];
  for (const pid of cardGame.players) {
    io.to(pid).emit('game_state', {
      yourHand: cardGame.hands[pid],
      handCounts: Object.fromEntries(cardGame.players.map(p => [p, cardGame.hands[p].length])),
      topCard: top,
      currentPlayer,
      direction: cardGame.direction,
      drawStack: cardGame.drawStack,
      waitingForColor: cardGame.waitingForColor && currentPlayer === pid,
      chosenColor: cardGame.chosenColor,
      players: cardGame.players.map(p => ({ id: p, name: players[p]?.name || '?', color: players[p]?.color || '#fff' })),
    });
  }
}

function nextTurn(skip = 0) {
  const n = cardGame.players.length;
  cardGame.currentIdx = ((cardGame.currentIdx + cardGame.direction * (1 + skip)) % n + n) % n;
}

function checkWinner() {
  for (const pid of cardGame.players) {
    if (cardGame.hands[pid].length === 0) return pid;
  }
  return null;
}

function endGame(winnerId) {
  const winnerName = players[winnerId]?.name || '?';
  io.to([...cardGame.players]).emit('game_over', { winnerId, winnerName });
  // 의자 해제
  for (const pid of cardGame.players) {
    if (players[pid]) players[pid].seated = false;
  }
  cardGame.active = false;
  cardGame.players = [];
  cardGame.hands = {};
  cardGame.deck = [];
  cardGame.discard = [];
  cardGame.drawStack = 0;
  cardGame.waitingForColor = false;
  cardGame.chosenColor = null;
}

function startCardGame(participantIds) {
  cardGame.active = true;
  cardGame.gameType = 'onecard';
  cardGame.players = [...participantIds];
  cardGame.direction = 1;
  cardGame.drawStack = 0;
  cardGame.waitingForColor = false;
  cardGame.chosenColor = null;
  cardGame.currentIdx = 0;

  cardGame.deck = shuffle(makeDeck());
  cardGame.hands = {};
  for (const pid of cardGame.players) {
    cardGame.hands[pid] = drawFromDeck(7);
  }
  // 첫 버린 패 (특수 카드면 다시 뽑기)
  let startCard;
  do { startCard = cardGame.deck.pop(); } while (isSpecial(startCard));
  cardGame.discard = [startCard];

  io.to(cardGame.players).emit('game_start', { gameType: 'onecard' });
  broadcastGameState();
}

// ── Socket ──
io.on('connection', (socket) => {
  const count = Object.keys(players).length;
  if (count >= 4) { socket.emit('full'); socket.disconnect(); return; }

  const colors = ['#f87171','#60a5fa','#34d399','#fbbf24'];
  const usedColors = Object.values(players).map(p => p.color);
  const color = colors.find(c => !usedColors.includes(c)) || colors[0];

  players[socket.id] = {
    id: socket.id,
    x: 270 + Math.random() * 60,
    y: 80 + Math.random() * 60,
    color, name: `플레이어${count+1}`, facing: 1,
    emote: '', jumpOffset: 0, hitCount: 0, seated: false
  };

  console.log(`접속: ${socket.id} (총 ${Object.keys(players).length}명)`);
  socket.emit('init', { id: socket.id, players: JSON.parse(JSON.stringify(players)) });
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // ── 의자 앉기 ──
  socket.on('sit_down', () => {
    if (!players[socket.id] || cardGame.active) return;
    players[socket.id].seated = true;
    io.emit('player_seated', { id: socket.id, seated: true });

    // 앉은 사람 목록
    const seated = Object.values(players).filter(p => p.seated).map(p => p.id);
    io.emit('seated_update', { seated, names: seated.map(id => players[id]?.name || '?') });

    // 2명 이상이면 게임 시작 대기 (방장=첫번째 앉은 사람이 시작 가능)
    if (seated.length >= 2) {
      io.to(seated[0]).emit('can_start_game', { seated });
    }
  });

  socket.on('stand_up', () => {
    if (!players[socket.id]) return;
    players[socket.id].seated = false;
    io.emit('player_seated', { id: socket.id, seated: false });
    const seated = Object.values(players).filter(p => p.seated).map(p => p.id);
    io.emit('seated_update', { seated, names: seated.map(id => players[id]?.name || '?') });
  });

  socket.on('start_game', () => {
    if (cardGame.active) return;
    const seated = Object.values(players).filter(p => p.seated).map(p => p.id);
    if (seated.length < 2) return;
    startCardGame(seated);
  });

  // ── 원카드 액션 ──
  socket.on('play_card', ({ cardIdx, chosenColor }) => {
    if (!cardGame.active) return;
    if (cardGame.players[cardGame.currentIdx] !== socket.id) return;

    const hand = cardGame.hands[socket.id];
    if (cardIdx < 0 || cardIdx >= hand.length) return;
    const card = hand[cardIdx];
    const top = cardGame.discard[cardGame.discard.length - 1];

    if (!canPlay(card, top, cardGame.chosenColor)) return;

    // 카드 냄
    hand.splice(cardIdx, 1);
    cardGame.discard.push(card);
    cardGame.chosenColor = null;

    // 원카드 선언 체크 (손패 1장)
    if (hand.length === 1) {
      io.to(cardGame.players).emit('one_card_declared', { playerId: socket.id, name: players[socket.id]?.name });
    }

    // 승리 체크
    if (hand.length === 0) {
      endGame(socket.id);
      return;
    }

    // 특수 카드 처리
    if (card.rank === 'A') {
      // 방향 전환
      cardGame.direction *= -1;
      nextTurn();
    } else if (card.rank === '2') {
      cardGame.drawStack += 2;
      nextTurn();
      // 다음 사람이 +2 받거나 연속 가능
    } else if (card.rank === 'Joker') {
      cardGame.drawStack += 4;
      if (chosenColor) {
        cardGame.chosenColor = chosenColor;
        nextTurn();
      } else {
        cardGame.waitingForColor = true;
        broadcastGameState();
        return;
      }
    } else if (card.rank === 'J') {
      // 한 명 건너뜀
      nextTurn(1);
    } else if (card.rank === 'K') {
      // 상대 패 가져오기 (2인 기준: 다음 사람과 패 교환)
      const nextIdx = ((cardGame.currentIdx + cardGame.direction) % cardGame.players.length + cardGame.players.length) % cardGame.players.length;
      const nextId = cardGame.players[nextIdx];
      const temp = cardGame.hands[socket.id];
      cardGame.hands[socket.id] = cardGame.hands[nextId];
      cardGame.hands[nextId] = temp;
      nextTurn();
    } else if (card.rank === '3') {
      // 다음 사람 +3 드로우
      cardGame.drawStack += 3;
      nextTurn();
    } else {
      nextTurn();
    }

    broadcastGameState();
  });

  socket.on('choose_color', ({ color }) => {
    if (!cardGame.active) return;
    if (cardGame.players[cardGame.currentIdx] !== socket.id) return;
    if (!cardGame.waitingForColor) return;
    cardGame.chosenColor = color;
    cardGame.waitingForColor = false;
    nextTurn();
    broadcastGameState();
  });

  socket.on('draw_card', () => {
    if (!cardGame.active) return;
    if (cardGame.players[cardGame.currentIdx] !== socket.id) return;

    const n = cardGame.drawStack > 0 ? cardGame.drawStack : 1;
    cardGame.drawStack = 0;
    const drawn = drawFromDeck(n);
    cardGame.hands[socket.id].push(...drawn);
    nextTurn();
    broadcastGameState();
  });

  // ── 기존 이벤트 ──
  socket.on('move', (data) => {
    if (!players[socket.id]) return;
    Object.assign(players[socket.id], { x: data.x, y: data.y, facing: data.facing, jumpOffset: data.jumpOffset||0 });
    socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
  });
  socket.on('emote', (emote) => {
    if (!players[socket.id]) return;
    socket.broadcast.emit('playerEmote', { id: socket.id, emote });
  });
  socket.on('push_hit', ({ targetId, vx, vy }) => {
    if (!players[socket.id] || !players[targetId]) return;
    const p = players[targetId];
    p.hitCount = (p.hitCount || 0) + 1;
    io.to(targetId).emit('playerPushed', { id: targetId, vx, vy, isHit: true });
    socket.broadcast.emit('playerPushed', { id: targetId, vx, vy, isHit: true });
    if (p.hitCount >= 5) {
      io.emit('respawn', { id: targetId });
      if (players[targetId]) { players[targetId].x=280; players[targetId].y=190; players[targetId].hitCount=0; }
    }
  });
  socket.on('bullet_spawn', (data) => {
    if (!players[socket.id]) return;
    socket.broadcast.emit('bullet_spawn', { ...data, id: socket.id });
  });
  socket.on('bullet_hit', ({ targetId }) => {
    if (!players[socket.id] || !players[targetId]) return;
    const vx = (players[socket.id].facing || 1) * 9;
    io.to(targetId).emit('playerPushed', { id: targetId, vx, vy: -3, isHit: true });
    socket.broadcast.emit('playerPushed', { id: targetId, vx, vy: -3, isHit: true });
    io.emit('respawn', { id: targetId });
    if (players[targetId]) { players[targetId].x=280+Math.random()*80; players[targetId].y=180+Math.random()*60; players[targetId].hitCount=0; }
  });
  socket.on('chat', (msg) => {
    if (!players[socket.id]) return;
    const p = players[socket.id];
    io.emit('chat', { id: socket.id, name: p.name, msg: String(msg).slice(0,40), color: p.color });
  });
  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    players[socket.id].name = String(name).slice(0, 8);
    io.emit('playerName', { id: socket.id, name: players[socket.id].name });
  });
  socket.on('disconnect', (reason) => {
    console.log(`퇴장: ${socket.id} (${reason})`);
    // 게임 중 나가면 게임 중단
    if (cardGame.active && cardGame.players.includes(socket.id)) {
      io.to(cardGame.players).emit('game_aborted', { reason: '플레이어가 나갔어요' });
      for (const pid of cardGame.players) { if (players[pid]) players[pid].seated = false; }
      cardGame.active = false; cardGame.players = []; cardGame.hands = {};
    }
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
