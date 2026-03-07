const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // 재연결 시 같은 소켓 ID 유지 방지 & 핑 설정
  pingTimeout: 10000,
  pingInterval: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

const players = {};

io.on('connection', (socket) => {
  // 이미 4명이면 거절
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
    emote: '', jumpOffset: 0, hitCount: 0
  };

  console.log(`접속: ${socket.id} (총 ${Object.keys(players).length}명)`);

  // 깊은 복사로 전송해서 클라이언트가 내 캐릭터 포함 확실히 받도록
  socket.emit('init', { id: socket.id, players: JSON.parse(JSON.stringify(players)) });
  socket.broadcast.emit('playerJoined', players[socket.id]);

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
    console.log(`퇴장: ${socket.id} (${reason}) / 남은 인원: ${Object.keys(players).length - 1}명`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
