// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Table } = require("./game/pokerEngine");
const { fetchInstagramProfile, calcStartingChips } = require("./game/instagram");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const CHIP_RULE = { base: 1000, perPost: 50, cap: 5000 };

// ---- REST: 방 만들기 전 미리보기용 인스타 프로필 조회 ----
app.get("/api/ig-preview", async (req, res) => {
  const username = (req.query.u || "").toString();
  if (!username) return res.status(400).json({ error: "아이디를 입력해주세요." });
  try {
    const profile = await fetchInstagramProfile(username);
    const startingChips = calcStartingChips(profile, CHIP_RULE);
    res.json({ profile, startingChips });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 인메모리 방 저장소 ----
/** @type {Map<string, { table: Table, hostSocketId: string, sockets: Map<string, {name:string}> }>} */
const rooms = new Map();

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function broadcastState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const socketId of room.sockets.keys()) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit("room:state", {
      roomCode,
      hostId: room.hostSocketId,
      isHost: socketId === room.hostSocketId,
      chipRule: CHIP_RULE,
      state: room.table.publicState(socketId),
      legalActions: room.table.legalActions(socketId),
      you: socketId,
    });
  }
}

function roomOfSocket(socketId) {
  for (const [code, room] of rooms.entries()) {
    if (room.sockets.has(socketId)) return code;
  }
  return null;
}

io.on("connection", (socket) => {
  socket.on("room:create", async ({ name, instagramUsername }, cb) => {
    try {
      const profile = await fetchInstagramProfile(instagramUsername);
      const startingChips = calcStartingChips(profile, CHIP_RULE);
      const roomCode = genRoomCode();
      const table = new Table({ smallBlind: 10, bigBlind: 20 });
      table.addPlayer({
        id: socket.id,
        name: name || profile.displayName,
        avatarUrl: profile.avatarUrl,
        chips: startingChips,
      });
      rooms.set(roomCode, {
        table,
        hostSocketId: socket.id,
        sockets: new Map([[socket.id, { name }]]),
      });
      socket.join(roomCode);
      cb({ ok: true, roomCode, profile, startingChips });
      broadcastState(roomCode);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  socket.on("room:join", async ({ roomCode, name, instagramUsername }, cb) => {
    try {
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) return cb({ ok: false, error: "존재하지 않는 방 코드입니다." });
      const profile = await fetchInstagramProfile(instagramUsername);
      const startingChips = calcStartingChips(profile, CHIP_RULE);
      room.table.addPlayer({
        id: socket.id,
        name: name || profile.displayName,
        avatarUrl: profile.avatarUrl,
        chips: startingChips,
      });
      room.sockets.set(socket.id, { name });
      socket.join(roomCode.toUpperCase());
      cb({ ok: true, roomCode: roomCode.toUpperCase(), profile, startingChips });
      broadcastState(roomCode.toUpperCase());
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  socket.on("room:start", (cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 시작할 수 있습니다." });
    try {
      room.table.startHand();
      cb?.({ ok: true });
      broadcastState(roomCode);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("room:action", ({ type, amount }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    try {
      room.table.handleAction(socket.id, type, amount);
      cb?.({ ok: true });
      broadcastState(roomCode);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("room:nextHand", (cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 다음 핸드를 시작할 수 있습니다." });
    try {
      room.table.startHand();
      cb?.({ ok: true });
      broadcastState(roomCode);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("disconnect", () => {
    const roomCode = roomOfSocket(socket.id);
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.table.getPlayer(socket.id);
    if (player) {
      player.sittingOut = true;
      player.folded = true;
    }
    room.sockets.delete(socket.id);
    if (room.sockets.size === 0) {
      rooms.delete(roomCode);
      return;
    }
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = room.sockets.keys().next().value;
    }
    broadcastState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`인스타툰 홀덤 서버 실행 중: http://localhost:${PORT}`);
});
