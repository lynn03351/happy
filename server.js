const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {};

io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  const count = Object.keys(players).length;
  if (count >= 4) { socket.emit('full'); socket.disconnect(); return; }

  const colors = ['#f87171','#60a5fa','#34d399','#fbbf24'];
  const usedColors = Object.values(players).map(p => p.color);
  const color = colors.find(c => !usedColors.includes(c)) || colors[0];

  players[socket.id] = {
    id: socket.id,
    x: 100 + Math.random() * 300,
    y: 150 + Math.random() * 150,
    color, name: `플레이어${count+1}`, facing: 1,
    emote: '', jumpOffset: 0
  };

  socket.emit('init', { id: socket.id, players });
  socket.broadcast.emit('playerJoined', players[socket.id]);

  socket.on('move', (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].facing = data.facing;
    players[socket.id].jumpOffset = data.jumpOffset || 0;
    socket.broadcast.emit('playerMoved', {
      id: socket.id, x: data.x, y: data.y,
      facing: data.facing, jumpOffset: data.jumpOffset || 0
    });
  });

  socket.on('emote', (emote) => {
    if (!players[socket.id]) return;
    socket.broadcast.emit('playerEmote', { id: socket.id, emote });
  });

  socket.on('push', ({ targetId, vx, vy }) => {
    if (!players[socket.id] || !players[targetId]) return;
    // 대상 클라이언트에게 밀쳐짐 전달
    io.to(targetId).emit('playerPushed', { id: targetId, vx, vy });
    // 나머지에게도 시각적으로 전달
    socket.broadcast.emit('playerPushed', { id: targetId, vx, vy });
  });

  socket.on('chat', (msg) => {
    if (!players[socket.id]) return;
    const p = players[socket.id];
    const clean = String(msg).slice(0, 40);
    io.emit('chat', { id: socket.id, name: p.name, msg: clean, color: p.color });
  });

  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    players[socket.id].name = String(name).slice(0, 8);
    io.emit('playerName', { id: socket.id, name: players[socket.id].name });
  });

  socket.on('disconnect', () => {
    console.log('퇴장:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
