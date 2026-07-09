// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Table } = require("./game/pokerEngine");
const { fetchInstagramProfile, calcStartingChips } = require("./game/instagram");
const { drawCard } = require("./game/cheerCards");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const CHIP_RULE = { base: 1000, perPost: 50, cap: 5000 };
const BOUNTY_RATE = 0.2; // 시작 칩의 20%를 바운티로 건다

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
/**
 * room = {
 *   table: Table,
 *   hostSocketId: string,
 *   sockets: Map<socketId, {name}>              // 승인된 플레이어
 *   fans: Map<socketId, {name}>                  // 관전/응원 팬 (승인 불필요)
 *   pendingRequests: Map<socketId, {name, profile, startingChips}>  // 참가 승인 대기
 *   startingChipsMap / posts / bounties / bountyEarnings / rebuyUsed / verified: Map<playerId, ...>
 *   eliminated: Set<playerId>
 *   cheerCounts / cardInventory: Map<playerId, ...>
 *   lastCurrentPlayerId, lastResolvedHandNumber, lastCardDraw, lastAnnouncement
 * }
 */
const rooms = new Map();

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function newRoom(table) {
  return {
    table,
    hostSocketId: null,
    sockets: new Map(),
    fans: new Map(),
    pendingRequests: new Map(),
    startingChipsMap: new Map(),
    posts: new Map(),
    bounties: new Map(),
    bountyEarnings: new Map(),
    rebuyUsed: new Map(),
    verified: new Map(),
    eliminated: new Set(),
    cheerCounts: new Map(),
    cardInventory: new Map(),
    lastCurrentPlayerId: null,
    lastResolvedHandNumber: 0,
    lastCardDraw: null,
    lastAnnouncement: null,
  };
}

function registerPlayerMeta(room, profile, startingChips, playerId) {
  room.startingChipsMap.set(playerId, startingChips);
  room.posts.set(playerId, profile.posts);
  room.bounties.set(playerId, Math.round(startingChips * BOUNTY_RATE));
  room.bountyEarnings.set(playerId, 0);
  room.rebuyUsed.set(playerId, false);
  room.verified.set(playerId, !!profile.verified);
  room.cheerCounts.set(playerId, 0);
  room.cardInventory.set(playerId, []);
}

function isRebuyEligible(room, playerId) {
  if (room.posts.size === 0) return false;
  const minPosts = Math.min(...room.posts.values());
  return room.posts.get(playerId) === minPosts && !room.rebuyUsed.get(playerId);
}

// 매 액션/핸드시작 이후 호출: 턴이 바뀌었으면 새 현재 플레이어에게 응원카드 드로우
function maybeDrawCheerCard(room) {
  const table = room.table;
  const curId = table.currentPlayer()?.id || null;
  if (curId && curId !== room.lastCurrentPlayerId) {
    const count = room.cheerCounts.get(curId) || 0;
    const card = drawCard(count);
    room.cheerCounts.set(curId, 0);
    const inv = room.cardInventory.get(curId) || [];
    inv.push(card);
    room.cardInventory.set(curId, inv);
    room.lastCardDraw = {
      playerId: curId,
      playerName: table.getPlayer(curId)?.name,
      card,
      cheerCountAtDraw: count,
      at: Date.now(),
    };
  }
  room.lastCurrentPlayerId = curId;
}

// 핸드가 쇼다운/폴드승리로 끝났을 때 1회만 호출: 바운티 정산 + 무료 리바인 처리
function resolveHandEnd(room) {
  const table = room.table;
  if (table.street !== "showdown" || !table.lastResult) return;
  if (room.lastResolvedHandNumber === table.handNumber) return;
  room.lastResolvedHandNumber = table.handNumber;

  const winners = table.lastResult.winners || [];
  if (winners.length === 0) return;
  const topWinner = winners.reduce((a, b) => (b.amount > a.amount ? b : a), winners[0]);

  for (const p of table.players) {
    if (p.chips === 0 && p.totalBetInHand > 0 && !room.eliminated.has(p.id)) {
      room.eliminated.add(p.id);

      if (isRebuyEligible(room, p.id)) {
        room.rebuyUsed.set(p.id, true);
        p.chips = room.startingChipsMap.get(p.id) || 0;
        p.sittingOut = false;
        room.eliminated.delete(p.id);
        room.lastAnnouncement = {
          type: "rebuy",
          playerId: p.id,
          playerName: p.name,
          amount: p.chips,
          at: Date.now(),
        };
      } else {
        p.sittingOut = true;
        if (topWinner.id !== p.id) {
          const bounty = room.bounties.get(p.id) || 0;
          if (bounty > 0) {
            room.bountyEarnings.set(topWinner.id, (room.bountyEarnings.get(topWinner.id) || 0) + bounty);
            room.lastAnnouncement = {
              type: "bounty",
              hunterId: topWinner.id,
              hunterName: topWinner.name,
              targetId: p.id,
              targetName: p.name,
              amount: bounty,
              at: Date.now(),
            };
          }
        }
      }
    }
  }
}

function afterTableChange(room) {
  maybeDrawCheerCard(room);
  resolveHandEnd(room);
}

function roomOfSocket(socketId) {
  for (const [code, room] of rooms.entries()) {
    if (room.sockets.has(socketId) || room.fans.has(socketId) || room.pendingRequests.has(socketId)) return code;
  }
  return null;
}

function pendingListForHost(room) {
  return [...room.pendingRequests.entries()].map(([socketId, req]) => ({
    socketId,
    name: req.name,
    profile: req.profile,
    startingChips: req.startingChips,
  }));
}

function broadcastState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const cheerCounts = Object.fromEntries(room.cheerCounts);
  const bounties = Object.fromEntries(room.bounties);
  const bountyEarnings = Object.fromEntries(room.bountyEarnings);
  const verified = Object.fromEntries(room.verified);
  const fanNames = [...room.fans.values()].map((f) => f.name);
  const rebuyInfo = {};
  for (const id of room.posts.keys()) {
    rebuyInfo[id] = { eligible: isRebuyEligible(room, id), used: !!room.rebuyUsed.get(id) };
  }

  const commonExtra = {
    cheerCounts,
    bounties,
    bountyEarnings,
    verified,
    fanNames,
    fanCount: room.fans.size,
    rebuyInfo,
    lastCardDraw: room.lastCardDraw,
    lastAnnouncement: room.lastAnnouncement,
    cheerThreshold: 21,
  };

  for (const socketId of room.sockets.keys()) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit("room:state", {
      roomCode,
      hostId: room.hostSocketId,
      isHost: socketId === room.hostSocketId,
      isFan: false,
      pendingApproval: false,
      chipRule: CHIP_RULE,
      state: room.table.publicState(socketId),
      legalActions: room.table.legalActions(socketId),
      you: socketId,
      myCardInventory: room.cardInventory.get(socketId) || [],
      pendingRequests: socketId === room.hostSocketId ? pendingListForHost(room) : [],
      ...commonExtra,
    });
  }

  for (const socketId of room.fans.keys()) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit("room:state", {
      roomCode,
      hostId: room.hostSocketId,
      isHost: false,
      isFan: true,
      pendingApproval: false,
      chipRule: CHIP_RULE,
      state: room.table.publicState(null),
      legalActions: [],
      you: socketId,
      myCardInventory: [],
      pendingRequests: [],
      ...commonExtra,
    });
  }

  for (const socketId of room.pendingRequests.keys()) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit("room:state", {
      roomCode,
      hostId: room.hostSocketId,
      isHost: false,
      isFan: false,
      pendingApproval: true,
      chipRule: CHIP_RULE,
      state: room.table.publicState(null),
      legalActions: [],
      you: socketId,
      myCardInventory: [],
      pendingRequests: [],
      ...commonExtra,
    });
  }
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
      const room = newRoom(table);
      room.hostSocketId = socket.id;
      room.sockets.set(socket.id, { name });
      registerPlayerMeta(room, profile, startingChips, socket.id);
      rooms.set(roomCode, room);
      socket.join(roomCode);
      cb({ ok: true, roomCode, profile, startingChips, bounty: room.bounties.get(socket.id) });
      broadcastState(roomCode);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 참가 신청 -> 방장 승인 대기열로 들어감 (즉시 입장 아님)
  socket.on("room:requestJoin", async ({ roomCode, name, instagramUsername }, cb) => {
    try {
      const code = (roomCode || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) return cb({ ok: false, error: "존재하지 않는 방 코드입니다." });
      const profile = await fetchInstagramProfile(instagramUsername);
      const startingChips = calcStartingChips(profile, CHIP_RULE);
      room.pendingRequests.set(socket.id, {
        name: name || profile.displayName,
        profile,
        startingChips,
      });
      socket.join(code);
      cb({ ok: true, roomCode: code, profile, startingChips, status: "pending" });
      broadcastState(code);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 방장: 참가 승인
  socket.on("room:approve", ({ targetId }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 승인할 수 있습니다." });
    const req = room.pendingRequests.get(targetId);
    if (!req) return cb?.({ ok: false, error: "이미 처리되었거나 존재하지 않는 요청입니다." });

    room.table.addPlayer({
      id: targetId,
      name: req.name,
      avatarUrl: req.profile.avatarUrl,
      chips: req.startingChips,
    });
    registerPlayerMeta(room, req.profile, req.startingChips, targetId);
    room.sockets.set(targetId, { name: req.name });
    room.pendingRequests.delete(targetId);

    cb?.({ ok: true });
    broadcastState(roomCode);
  });

  // 방장: 참가 거절
  socket.on("room:reject", ({ targetId }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 거절할 수 있습니다." });
    if (!room.pendingRequests.has(targetId)) return cb?.({ ok: false, error: "이미 처리된 요청입니다." });

    room.pendingRequests.delete(targetId);
    const targetSock = io.sockets.sockets.get(targetId);
    targetSock?.emit("room:rejected", { roomCode });
    cb?.({ ok: true });
    broadcastState(roomCode);
  });

  // ---- 팬(관전/응원) - 승인 불필요, 자유 참가 ----
  socket.on("fan:join", ({ roomCode, name }, cb) => {
    const code = (roomCode || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "존재하지 않는 방 코드입니다." });
    room.fans.set(socket.id, { name: (name || "").trim() || "이름없는 팬" });
    socket.join(code);
    cb?.({ ok: true, roomCode: code });
    broadcastState(code);
  });

  socket.on("fan:cheer", ({ targetPlayerId }) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room || !room.fans.has(socket.id)) return;
    if (!room.table.getPlayer(targetPlayerId)) return;
    const cur = room.cheerCounts.get(targetPlayerId) || 0;
    room.cheerCounts.set(targetPlayerId, cur + 1);
    broadcastState(roomCode);
  });

  // ---- 게임 진행 ----
  socket.on("room:start", (cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 시작할 수 있습니다." });
    try {
      room.table.startHand();
      afterTableChange(room);
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
      afterTableChange(room);
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
      afterTableChange(room);
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

    if (room.pendingRequests.has(socket.id)) {
      room.pendingRequests.delete(socket.id);
      broadcastState(roomCode);
      return;
    }

    if (room.fans.has(socket.id)) {
      room.fans.delete(socket.id);
      broadcastState(roomCode);
      return;
    }

    const player = room.table.getPlayer(socket.id);
    if (player) {
      player.sittingOut = true;
      player.folded = true;
    }
    room.sockets.delete(socket.id);
    if (room.sockets.size === 0 && room.fans.size === 0 && room.pendingRequests.size === 0) {
      rooms.delete(roomCode);
      return;
    }
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = room.sockets.keys().next().value || null;
    }
    broadcastState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`인스타툰 홀덤 서버 실행 중: http://localhost:${PORT}`);
});
