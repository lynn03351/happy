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

  // 현재 접속 인원 확인
  const count = Object.keys(players).length;
  if (count >= 4) {
    socket.emit('full');
    socket.disconnect();
    return;
  }

  // 색상 배정
  const colors = ['#f87171', '#60a5fa', '#34d399', '#fbbf24'];
  const usedColors = Object.values(players).map(p => p.color);
  const color = colors.find(c => !usedColors.includes(c)) || colors[0];

  // 플레이어 등록
  players[socket.id] = {
    id: socket.id,
    x: 100 + Math.random() * 300,
    y: 150 + Math.random() * 150,
    color,
    name: `플레이어${count + 1}`,
    facing: 1,
    emote: ''
  };

  // 본인에게 자신의 id + 전체 플레이어 전송
  socket.emit('init', { id: socket.id, players });

  // 다른 사람들에게 새 플레이어 알림
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // 이동 처리
  socket.on('move', (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].facing = data.facing;
    socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y, facing: data.facing });
  });

  // 이모트 처리
  socket.on('emote', (emote) => {
    if (!players[socket.id]) return;
    socket.broadcast.emit('playerEmote', { id: socket.id, emote });
  });

  // 이름 변경
  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    players[socket.id].name = name.slice(0, 8);
    io.emit('playerName', { id: socket.id, name: players[socket.id].name });
  });

  // 접속 종료
  socket.on('disconnect', () => {
    console.log('퇴장:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
