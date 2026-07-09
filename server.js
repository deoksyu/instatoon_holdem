// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Table } = require("./game/pokerEngine");
const { resolveProfile, calcStartingChips } = require("./game/instagram");
const { drawCard } = require("./game/cheerCards");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const CHIP_RULE = { base: 1000, perPost: 50, cap: 5000 };
const BOUNTY_RATE = 0.2; // 시작 칩의 20%를 바운티로 건다
const MAX_PLAYERS = 10; // 한 방 최대 동시 플레이어 수

// ---- REST: 방 만들기 전 미리보기용 인스타 프로필 조회 ----
app.get("/api/ig-preview", async (req, res) => {
  const username = (req.query.u || "").toString();
  const name = (req.query.name || "").toString();
  if (!username && name.trim().toLowerCase() !== "test") {
    return res.status(400).json({ error: "아이디를 입력해주세요." });
  }
  try {
    const profile = await resolveProfile(name, username);
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
    blindExempt: new Set(),      // 역전의 부적 사용자 - 다음 블라인드 면제 대기
    doubleWinFlags: new Set(),   // 트로피 사용자 - 이번 핸드 승리시 2배
    privatePeeks: new Map(),     // 필살기 스크롤 결과 (본인에게만 보임)
    leaveScheduled: new Set(),   // 이번 핸드 끝나고 퇴장 예약한 플레이어
    lastCurrentPlayerId: null,
    lastResolvedHandNumber: 0,
    lastCardDraw: null,
    lastAnnouncement: null,
  };
}

// 보유 중인(미사용) 패시브 기프트 개수
function countPassive(room, playerId, effectId) {
  const inv = room.cardInventory.get(playerId) || [];
  return inv.filter((c) => c.type === "passive" && c.effectId === effectId && !c.used).length;
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
    const rawCount = room.cheerCounts.get(curId) || 0;
    // 패시브 보정: 화이팅 부적(+2), 팬미팅 초대장(+5) - 중첩 가능
    const boosted =
      rawCount +
      countPassive(room, curId, "cheer_boost_2") * 2 +
      countPassive(room, curId, "cheer_boost_5") * 5;
    const card = drawCard(boosted);
    card.cheerCountAtDraw = rawCount; // 표시용은 실제 응원 수 기준
    room.cheerCounts.set(curId, 0);
    const inv = room.cardInventory.get(curId) || [];
    inv.push(card);
    room.cardInventory.set(curId, inv);
    room.lastCardDraw = {
      playerId: curId,
      playerName: table.getPlayer(curId)?.name,
      card,
      cheerCountAtDraw: rawCount,
      boostedCount: boosted,
      at: Date.now(),
    };
  }
  room.lastCurrentPlayerId = curId;
}

// 핸드가 쇼다운/폴드승리로 끝났을 때 1회만 호출: 트로피 정산 + 바운티 정산 + 무료 리바인/부활 처리
function resolveHandEnd(room) {
  const table = room.table;
  if (table.street !== "showdown" || !table.lastResult) return;
  if (room.lastResolvedHandNumber === table.handNumber) return;
  room.lastResolvedHandNumber = table.handNumber;

  const winners = table.lastResult.winners || [];

  // 트로피(이번 핸드 승리 2배) 정산 - 사용했던 사람은 이겼든 졌든 이번 핸드로 소모
  if (room.doubleWinFlags.size > 0) {
    for (const winner of winners) {
      if (room.doubleWinFlags.has(winner.id)) {
        const p = table.getPlayer(winner.id);
        if (p) {
          p.chips += winner.amount; // 원래 받은 만큼 한 번 더 = 2배
          room.lastAnnouncement = {
            type: "gift",
            playerId: winner.id,
            playerName: winner.name,
            text: `${winner.name}님이 [인스타툰 대상 트로피]로 이번 핸드 획득 칩이 2배가 됐어요!`,
            at: Date.now(),
          };
        }
      }
    }
    room.doubleWinFlags.clear();
  }

  if (winners.length === 0) return;
  const topWinner = winners.reduce((a, b) => (b.amount > a.amount ? b : a), winners[0]);

  for (const p of table.players) {
    if (p.chips === 0 && p.totalBetInHand > 0 && !room.eliminated.has(p.id)) {
      room.eliminated.add(p.id);

      const reviveGift = (room.cardInventory.get(p.id) || []).find(
        (c) => c.type === "passive" && c.effectId === "auto_revive" && !c.used
      );

      if (reviveGift) {
        reviveGift.used = true;
        room.cardInventory.set(p.id, (room.cardInventory.get(p.id) || []).filter((c) => c.id !== reviveGift.id));
        p.chips = room.startingChipsMap.get(p.id) || 0;
        p.sittingOut = false;
        room.eliminated.delete(p.id);
        room.lastAnnouncement = {
          type: "awaken",
          playerId: p.id,
          playerName: p.name,
          amount: p.chips,
          at: Date.now(),
        };
      } else if (isRebuyEligible(room, p.id)) {
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
          const baseBounty = room.bounties.get(p.id) || 0;
          const bonusMult = 1 + countPassive(room, topWinner.id, "bounty_bonus_10pct") * 0.1;
          const bounty = Math.round(baseBounty * bonusMult);
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

// 역전의 부적(다음 블라인드 면제) 처리: startHand 직후 호출
function applyBlindExemptions(room) {
  if (room.blindExempt.size === 0) return;
  for (const playerId of [...room.blindExempt]) {
    const p = room.table.getPlayer(playerId);
    if (!p) { room.blindExempt.delete(playerId); continue; }
    if (p.betThisStreet > 0) {
      const refund = p.betThisStreet;
      p.chips += refund;
      p.betThisStreet -= refund;
      p.totalBetInHand -= refund;
      if (p.chips > 0) p.allIn = false;
      room.blindExempt.delete(playerId);
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: p.name,
        text: `${p.name}님이 [역전의 부적]으로 이번 블라인드를 면제받았어요!`,
        at: Date.now(),
      };
    }
  }
}

// 액티브 기프트 발동
function applyActiveGift(room, playerId, item, targetPlayerId) {
  const table = room.table;
  const player = table.getPlayer(playerId);
  if (!player) throw new Error("게임에 참여 중이 아닙니다.");

  switch (item.effectId) {
    case "blind_refund": {
      player.chips += table.bigBlind;
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: player.name,
        text: `${player.name}님이 [소소한 응원]으로 ${table.bigBlind.toLocaleString()}칩을 얻었어요!`,
        at: Date.now(),
      };
      break;
    }
    case "peek_allin_card": {
      const target = table.getPlayer(targetPlayerId);
      if (!target || !target.allIn) throw new Error("올인 상태인 상대를 선택해주세요.");
      if (!target.holeCards || target.holeCards.length === 0) throw new Error("훔쳐볼 카드가 없습니다.");
      const peeked = target.holeCards[Math.floor(Math.random() * target.holeCards.length)];
      room.privatePeeks.set(playerId, {
        targetId: target.id,
        targetName: target.name,
        card: peeked,
        at: Date.now(),
      });
      break;
    }
    case "blind_exempt_next": {
      room.blindExempt.add(playerId);
      break;
    }
    case "redraw_hole_cards": {
      table.redrawHoleCards(playerId); // 유효하지 않으면 여기서 에러 throw
      break;
    }
    case "double_win_this_hand": {
      room.doubleWinFlags.add(playerId);
      break;
    }
    default:
      throw new Error("알 수 없는 기프트입니다.");
  }
}

// 플레이어를 실제로 방에서 내보냄: 진행중인 핸드에서 안전하게 빠지도록 처리
function leaveRoomNow(room, playerId) {
  const table = room.table;
  const player = table.getPlayer(playerId);
  if (player && !player.sittingOut) {
    const inLiveHand = table.street !== "waiting" && table.street !== "showdown";
    if (inLiveHand && !player.folded && !player.allIn) {
      if (table.currentPlayer()?.id === playerId) {
        // 정식 엔진 경로 - 턴 진행까지 알아서 처리됨
        try {
          table.handleAction(playerId, "fold");
        } catch {
          player.folded = true;
        }
      } else {
        player.folded = true;
        const remaining = table.activePlayersInHand();
        if (remaining.length === 1) {
          table._awardPotToSingleWinner(remaining[0]);
        }
      }
    }
    player.sittingOut = true;
  }
  room.leaveScheduled.delete(playerId);
  room.sockets.delete(playerId);
  if (room.hostSocketId === playerId) {
    room.hostSocketId = room.sockets.keys().next().value || null;
  }
}

// 핸드가 쇼다운으로 끝난 시점에 "판 끝나고 퇴장 예약"한 플레이어들을 실제로 내보냄
function processScheduledLeaves(room) {
  if (room.leaveScheduled.size === 0) return;
  if (room.table.street !== "showdown") return;
  for (const playerId of [...room.leaveScheduled]) {
    leaveRoomNow(room, playerId);
  }
}

function afterTableChange(room) {
  maybeDrawCheerCard(room);
  resolveHandEnd(room);
  processScheduledLeaves(room);
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
    maxPlayers: MAX_PLAYERS,
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
      myPeek: room.privatePeeks.get(socketId) || null,
      leaveScheduled: room.leaveScheduled.has(socketId),
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
      const profile = await resolveProfile(name, instagramUsername);
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
      const profile = await resolveProfile(name, instagramUsername);
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
    if (room.table.players.length >= MAX_PLAYERS) {
      return cb?.({ ok: false, error: `방 정원(최대 ${MAX_PLAYERS}명)이 가득 찼습니다.` });
    }

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
      applyBlindExemptions(room);
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
      applyBlindExemptions(room);
      afterTableChange(room);
      cb?.({ ok: true });
      broadcastState(roomCode);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // ---- 퇴장 ----
  socket.on("room:leave", ({ mode }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (!room.sockets.has(socket.id)) return cb?.({ ok: false, error: "플레이어가 아닙니다." });

    try {
      const table = room.table;
      const inLiveHand = table.street !== "waiting" && table.street !== "showdown";
      if (mode === "scheduled" && inLiveHand) {
        room.leaveScheduled.add(socket.id);
        room.lastAnnouncement = {
          type: "gift",
          playerId: socket.id,
          playerName: table.getPlayer(socket.id)?.name,
          text: `${table.getPlayer(socket.id)?.name}님이 이번 판이 끝나면 퇴장할 예정이에요.`,
          at: Date.now(),
        };
        cb?.({ ok: true, scheduled: true });
        broadcastState(roomCode);
        return;
      }
      leaveRoomNow(room, socket.id);
      cb?.({ ok: true, scheduled: false });
      if (room.sockets.size === 0 && room.fans.size === 0 && room.pendingRequests.size === 0) {
        rooms.delete(roomCode);
        return;
      }
      broadcastState(roomCode);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("room:cancelLeave", (cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    room.leaveScheduled.delete(socket.id);
    cb?.({ ok: true });
    broadcastState(roomCode);
  });

  // ---- 기프트 사용 (액티브) ----
  socket.on("gift:use", ({ giftId, targetPlayerId }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    const inv = room.cardInventory.get(socket.id) || [];
    const item = inv.find((c) => c.id === giftId && !c.used);
    if (!item) return cb?.({ ok: false, error: "사용할 수 없는 기프트입니다." });
    if (item.type !== "active") return cb?.({ ok: false, error: "패시브 기프트는 보유만 해도 자동으로 적용돼요." });
    try {
      applyActiveGift(room, socket.id, item, targetPlayerId);
      room.cardInventory.set(socket.id, inv.filter((c) => c.id !== giftId));
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

    leaveRoomNow(room, socket.id);
    if (room.sockets.size === 0 && room.fans.size === 0 && room.pendingRequests.size === 0) {
      rooms.delete(roomCode);
      return;
    }
    broadcastState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`인스타툰 홀덤 서버 실행 중: http://localhost:${PORT}`);
  });
}

module.exports = {
  rooms,
  newRoom,
  registerPlayerMeta,
  countPassive,
  isRebuyEligible,
  maybeDrawCheerCard,
  resolveHandEnd,
  applyBlindExemptions,
  applyActiveGift,
  afterTableChange,
  leaveRoomNow,
  processScheduledLeaves,
  MAX_PLAYERS,
  BOUNTY_RATE,
};
