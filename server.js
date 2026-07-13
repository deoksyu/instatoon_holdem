// server.js
const fs = require("fs");
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

// 배포(서버 재시작)마다 바뀌는 값 - HTML이 참조하는 js/css에 쿼리스트링으로 붙여서
// 브라우저가 예전 탭에 캐시된 오래된 스크립트를 계속 쓰는 문제를 방지한다.
const ASSET_VERSION = Date.now();
function serveVersionedHtml(filePath) {
  return (req, res) => {
    fs.readFile(filePath, "utf8", (err, html) => {
      if (err) return res.status(500).send("Internal Server Error");
      const versioned = html.replace(
        /(src|href)="([^"]+\.(?:js|css))"/g,
        (m, attr, url) => `${attr}="${url}?v=${ASSET_VERSION}"`
      );
      res.type("html").send(versioned);
    });
  };
}
app.get("/", serveVersionedHtml(path.join(__dirname, "public", "index.html")));
app.get("/index.html", serveVersionedHtml(path.join(__dirname, "public", "index.html")));
app.get("/fan.html", serveVersionedHtml(path.join(__dirname, "public", "fan.html")));

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
 *   startingChipsMap / posts / bounties / bountyEarnings / verified: Map<playerId, ...>
 *   eliminated: Set<playerId>
 *   cheerCounts / cardInventory: Map<playerId, ...>
 *   lastCommunityCount, lastResolvedHandNumber, lastGiftBatch, lastAnnouncement
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
    followers: new Map(),
    bounties: new Map(),
    bountyEarnings: new Map(),
    verified: new Map(),
    eliminated: new Set(),
    cheerCounts: new Map(),
    cardInventory: new Map(),
    blindExempt: new Set(),      // 역전의 부적 사용자 - 다음 블라인드 면제 대기
    doubleWinFlags: new Set(),   // 트로피 사용자 - 이번 핸드 승리시 2배
    doubleOrNothing: new Set(),  // KODEX 선물 2배인버스 사용자 - 이번 핸드 승패에 따라 2배/추가손실
    privatePeeks: new Map(),     // 필살기 스크롤/선구안/짭륜안 결과 (본인에게만 보임)
    leaveScheduled: new Set(),   // 이번 핸드 끝나고 퇴장 예약한 플레이어
    pendingDealerClaim: null,    // 우리팀딜러뭐함? - 다음 판 딜러로 지정될 플레이어 id
    pendingPocketPairs: new Set(), // 무릎을 꿇는 것은 - 다음 판 원페어 확정 예약
    // 방장 설정(블라인드/리바인): gameSettings는 현재 적용 중인 값, pendingGameSettings는
    // 저장은 됐지만 아직 적용 전인 값(다음 핸드 시작 시 applyPendingGameSettings에서 반영).
    gameSettings: { smallBlind: table.smallBlind, bigBlind: table.bigBlind, maxRebuys: 0, rebuyAmount: 0 },
    pendingGameSettings: null,
    rebuyUsedCount: new Map(),   // 리바인: playerId -> 지금까지 사용한 리바인 횟수
    pendingRebuyOffers: new Set(), // 파산 직후 "리바인 하시겠습니까?" 응답 대기 중인 플레이어 id
    lastCommunityCount: 0,
    lastResolvedHandNumber: 0,
    lastGiftBatch: null,
    lastAnnouncement: null,
    chatMessages: [],           // 방 채팅 로그 (플레이어+팬 공용, 최근 것만 유지)
  };
}

const CHAT_HISTORY_LIMIT = 50;
const CHAT_MAX_LEN = 200;

// 보유 중인(미사용) 패시브 기프트 개수
function countPassive(room, playerId, effectId) {
  const inv = room.cardInventory.get(playerId) || [];
  return inv.filter((c) => c.type === "passive" && c.effectId === effectId && !c.used).length;
}

function registerPlayerMeta(room, profile, startingChips, playerId) {
  room.startingChipsMap.set(playerId, startingChips);
  room.posts.set(playerId, profile.posts);
  room.followers.set(playerId, Number(profile.followers) || 0);
  room.bounties.set(playerId, Math.round(startingChips * BOUNTY_RATE));
  room.bountyEarnings.set(playerId, 0);
  room.verified.set(playerId, !!profile.verified);
  room.cheerCounts.set(playerId, 0);
  room.cardInventory.set(playerId, []);
}

// 커뮤니티 카드 공개 시점(3장=플랍/4장=턴/5장=리버)마다 그때 살아있는(폴드X, 관전X) 전원에게
// 동시에 기프트 지급. 응원 기준은 해당 공개 직전까지 각자 누적된 응원 수.
// 올인 런아웃처럼 한 번의 처리로 여러 스트릿이 한꺼번에 넘어가는 경우, 넘어간 체크포인트 수만큼
// (최대 3회) 모두 지급하고 하나의 배치로 묶어 클라이언트에 전달한다.
const STREET_LABELS = { 3: "플랍", 4: "턴", 5: "리버" };

// 게임 전체에서 미사용 상태로 해당 effectId를 보유 중이거나(다음 판 예약 포함), 대기 중인 사람이 있는지.
// unique 카드(우리팀딜러뭐함?)를 동시에 2명 이상 보유하지 못하게 뽑기 풀에서 걸러내는 용도.
function anyoneHoldsOrPending(room, effectId) {
  if (room.pendingDealerClaim) return true;
  for (const inv of room.cardInventory.values()) {
    if (inv.some((c) => c.effectId === effectId && !c.used)) return true;
  }
  return false;
}

// 인스타그램 패시브: 체크포인트당 보유자 중 1명에게(딜러부터 순서) 10% 확률로,
// 방금 공개된 커뮤니티 카드 중 하나를 그 사람 홀카드와 숫자가 맞는 "유리한" 카드로 바꿔치기.
function applyFavorBias(room, checkpoint) {
  const table = room.table;
  const startIdx = table.dealerSeat >= 0 ? table.dealerSeat : 0;
  const orderIdx = table.seatOrderFrom(startIdx);
  const holders = orderIdx
    .map((i) => table.players[i])
    .filter((p) => !p.folded && !p.sittingOut && countPassive(room, p.id, "favor_flop_10pct") > 0);
  if (holders.length === 0) return;
  const sliceStart = checkpoint === 3 ? 0 : checkpoint === 4 ? 3 : 4;
  const revealed = table.communityCards.slice(sliceStart, checkpoint);
  if (revealed.length === 0) return;

  for (const holder of holders) {
    if (Math.random() >= 0.25) continue; // 인스타그램: 유리한 카드 확률 25%
    const holeRanks = new Set((holder.holeCards || []).map((c) => c[0]));
    if (holeRanks.size === 0) continue;
    const alreadyFavorable = revealed.some((c) => holeRanks.has(c[0]));
    if (alreadyFavorable) continue;
    const deckIdx = table.deck.findIndex((c) => holeRanks.has(c[0]));
    if (deckIdx === -1) continue;
    const favorCard = table.deck.splice(deckIdx, 1)[0];
    const replaceLocalIdx = Math.floor(Math.random() * revealed.length);
    const globalIdx = sliceStart + replaceLocalIdx;
    const oldCard = table.communityCards[globalIdx];
    table.communityCards[globalIdx] = favorCard;
    table.deck.push(oldCard);
    room.lastAnnouncement = {
      type: "gift",
      playerId: holder.id,
      playerName: holder.name,
      text: `${holder.name}님의 [인스타그램] 효과로 커뮤니티 카드가 유리하게 바뀌었어요!`,
      at: Date.now(),
    };
    break; // 체크포인트당 최대 1회만 적용
  }
}

function drawGiftsForCommunityReveal(room) {
  const table = room.table;
  const count = table.communityCards.length;
  if (count < room.lastCommunityCount) {
    // 새 핸드 시작 등으로 카드 수가 줄어든 경우 - 카운터만 리셋
    room.lastCommunityCount = count;
    return;
  }
  const checkpoints = [3, 4, 5].filter((c) => c > room.lastCommunityCount && c <= count);
  room.lastCommunityCount = count;
  if (checkpoints.length === 0) return;

  const allDraws = [];
  for (const checkpoint of checkpoints) {
    applyFavorBias(room, checkpoint);

    // 딜러부터 순서대로 1명씩 지급 (우리팀딜러뭐함? 유니크 제약이 같은 체크포인트 내에서도 정확히 반영되도록)
    const startIdx = table.dealerSeat >= 0 ? table.dealerSeat : 0;
    const orderIdx = table.seatOrderFrom(startIdx);
    const eligible = orderIdx.map((i) => table.players[i]).filter((p) => !p.folded && !p.sittingOut);

    for (const p of eligible) {
      const rawCount = room.cheerCounts.get(p.id) || 0;
      // 패시브 보정: 화이팅 부적(+2), 팬미팅 초대장(+5) - 중첩 가능
      const boosted =
        rawCount +
        countPassive(room, p.id, "cheer_boost_2") * 2 +
        countPassive(room, p.id, "cheer_boost_5") * 5;

      const excludeEffectIds = new Set();
      if (anyoneHoldsOrPending(room, "claim_dealer")) excludeEffectIds.add("claim_dealer");

      const invBefore = room.cardInventory.get(p.id) || [];
      const boostItem = invBefore.find((c) => c.effectId === "next_draw_sr_boost" && !c.used);
      const srBoost = boostItem ? 25 : 0; // 매직 드로우: 다음 뽑기 SR 확률 +25%p

      const card = drawCard(boosted, { excludeEffectIds, srBoost });
      card.cheerCountAtDraw = rawCount; // 표시용은 실제 응원 수 기준
      room.cheerCounts.set(p.id, 0);

      let inv = room.cardInventory.get(p.id) || [];
      inv.push(card);
      if (boostItem) inv = inv.filter((c) => c.id !== boostItem.id); // 매직 드로우는 적용 후 소모
      room.cardInventory.set(p.id, inv);

      allDraws.push({
        playerId: p.id,
        playerName: p.name,
        card,
        cheerCountAtDraw: rawCount,
        boostedCount: boosted,
        streetLabel: STREET_LABELS[checkpoint],
      });
    }
  }
  if (allDraws.length > 0) {
    room.lastGiftBatch = { draws: allDraws, at: Date.now() };
  }
}

// 핸드가 쇼다운/폴드승리로 끝났을 때 1회만 호출: 트로피 정산 + 바운티 정산 + 부활 처리
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

  // KODEX 선물 2배인버스 정산: 승리 시 2배, 패배(쇼다운까지 남았지만 못 이김) 시 추가 손실. 올인 상태였으면 무효.
  if (room.doubleOrNothing.size > 0) {
    for (const playerId of [...room.doubleOrNothing]) {
      const p = table.getPlayer(playerId);
      if (!p) { room.doubleOrNothing.delete(playerId); continue; }
      if (p.allIn) { room.doubleOrNothing.delete(playerId); continue; } // 올인 시 무효
      const won = winners.find((w) => w.id === playerId);
      if (won) {
        p.chips += won.amount;
        room.lastAnnouncement = {
          type: "gift",
          playerId,
          playerName: p.name,
          text: `${p.name}님이 [KODEX 선물 2배인버스]로 이번 핸드 획득 칩이 2배가 됐어요!`,
          at: Date.now(),
        };
      } else if (!p.folded) {
        const penalty = Math.min(p.chips, p.totalBetInHand);
        if (penalty > 0) {
          p.chips -= penalty;
          room.lastAnnouncement = {
            type: "gift",
            playerId,
            playerName: p.name,
            text: `${p.name}님이 [KODEX 선물 2배인버스]로 패배하며 칩을 추가로 잃었어요...`,
            at: Date.now(),
          };
        }
      }
      room.doubleOrNothing.delete(playerId);
    }
  }

  const topWinner = winners.length > 0 ? winners.reduce((a, b) => (b.amount > a.amount ? b : a), winners[0]) : null;

  for (const p of table.players) {
    if (topWinner && p.chips === 0 && p.totalBetInHand > 0 && !room.eliminated.has(p.id)) {
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
      } else {
        p.sittingOut = true;
        if (topWinner && topWinner.id !== p.id) {
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
        // 방장이 리바인을 설정해뒀고 아직 한도가 남았다면, 본인에게 "리바인 하시겠습니까?" 선택지를 띄운다.
        const usedRebuys = room.rebuyUsedCount.get(p.id) || 0;
        if (room.gameSettings.maxRebuys > 0 && usedRebuys < room.gameSettings.maxRebuys) {
          room.pendingRebuyOffers.add(p.id);
        }
      }
    }
  }

  // 다음 판까지 이어져야 하는 패시브(우리팀딜러뭐함?/무릎을 꿇는 것은)는 소멸 전에 예약으로 이관.
  for (const p of table.players) {
    const inv = room.cardInventory.get(p.id) || [];
    if (inv.some((c) => c.effectId === "claim_dealer" && !c.used)) {
      room.pendingDealerClaim = p.id;
    }
    if (inv.some((c) => c.effectId === "force_pocket_pair" && !c.used)) {
      room.pendingPocketPairs.add(p.id);
    }
  }

  // 패가 까지는 순간(쇼다운/폴드승리로 핸드 종료) 미사용 기프트는 전부 소멸.
  // 다음 핸드를 노리고 쌓아두지 못하게, 그 핸드 안에서 못 쓴 건 날아간다.
  for (const p of table.players) {
    room.cardInventory.set(p.id, []);
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

// 우리팀딜러뭐함? 예약 처리: startHand() 호출 "직전"에 불러서 dealerSeat를 미리 세팅해둔다.
// startHand() 내부의 do-while이 (dealerSeat+1)로 이동하므로, 목표 인덱스보다 1 작게 세팅.
function applyPendingDealerClaim(room) {
  if (!room.pendingDealerClaim) return;
  const table = room.table;
  const idx = table.players.findIndex(
    (p) => p.id === room.pendingDealerClaim && p.chips > 0 && !p.sittingOut
  );
  if (idx !== -1) {
    const n = table.players.length;
    table.dealerSeat = (idx - 1 + n) % n;
  }
  room.pendingDealerClaim = null;
}

// 방장 설정(블라인드/리바인) 예약 처리: startHand() 호출 "직전"에 불러서 다음 판 블라인드부터
// 새 값이 반영되게 한다. (저장 시점이 아니라 다음 핸드 시작 시점에 적용)
function applyPendingGameSettings(room) {
  if (!room.pendingGameSettings) return;
  const { smallBlind, bigBlind, maxRebuys, rebuyAmount } = room.pendingGameSettings;
  room.table.smallBlind = smallBlind;
  room.table.bigBlind = bigBlind;
  room.gameSettings = { smallBlind, bigBlind, maxRebuys, rebuyAmount };
  room.pendingGameSettings = null;
}

// 무릎을 꿇는 것은 예약 처리: startHand() 호출 "직후"(홀카드가 이미 배분된 다음)에 불러서 강제 원페어 적용.
function applyPendingPocketPairs(room) {
  if (room.pendingPocketPairs.size === 0) return;
  const table = room.table;
  for (const playerId of [...room.pendingPocketPairs]) {
    const p = table.getPlayer(playerId);
    if (p && !p.folded && !p.sittingOut) {
      // 판 시작 시 자동 발동이라 알림은 띄우지 않는다 (요청에 따라 무음 처리).
      table.forcePocketPair(playerId);
    }
  }
  room.pendingPocketPairs.clear();
}

// 액티브 기프트 발동
function applyActiveGift(room, playerId, item, targetPlayerId, option) {
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
        kind: "steal_card",
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
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: player.name,
        text: `${player.name}님이 [샤이닝 드로우]로 핸드 카드를 새로 뽑았어요!`,
        at: Date.now(),
      };
      break;
    }
    case "double_win_this_hand": {
      room.doubleWinFlags.add(playerId);
      break;
    }
    case "double_or_nothing": {
      room.doubleOrNothing.add(playerId);
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: player.name,
        text: `${player.name}님이 [KODEX 선물 2배인버스]를 사용했어요! (핸드 종료 시 정산)`,
        at: Date.now(),
      };
      break;
    }
    case "peek_next_color": {
      if (table.street === "waiting" || table.communityCards.length >= 5) {
        throw new Error("지금은 미리 볼 다음 커뮤니티 카드가 없습니다.");
      }
      const next = table.peekNextCommunityCard();
      if (!next) throw new Error("덱에 남은 카드가 부족합니다.");
      const isRed = next[1] === "h" || next[1] === "d";
      room.privatePeeks.set(playerId, {
        kind: "next_color",
        value: isRed ? "빨강" : "검정",
        at: Date.now(),
      });
      break;
    }
    case "peek_next_attr": {
      if (table.street === "waiting" || table.communityCards.length >= 5) {
        throw new Error("지금은 미리 볼 다음 커뮤니티 카드가 없습니다.");
      }
      const next = table.peekNextCommunityCard();
      if (!next) throw new Error("덱에 남은 카드가 부족합니다.");
      const attr = option === "suit" ? "suit" : "rank";
      const SUIT_NAMES = { c: "클로버", d: "다이아", h: "하트", s: "스페이드" };
      const value = attr === "suit" ? SUIT_NAMES[next[1]] || next[1] : next[0] === "T" ? "10" : next[0];
      room.privatePeeks.set(playerId, {
        kind: "next_attr",
        attr,
        value,
        at: Date.now(),
      });
      break;
    }
    case "peek_next_turn_card": {
      const next = table.getNextActivePlayer(playerId);
      if (!next) throw new Error("엿볼 수 있는 다음 차례 상대가 없습니다.");
      if (!next.holeCards || next.holeCards.length === 0) throw new Error("엿볼 카드가 없습니다.");
      const peeked = next.holeCards[Math.floor(Math.random() * next.holeCards.length)];
      room.privatePeeks.set(playerId, {
        kind: "next_turn_card",
        targetId: next.id,
        targetName: next.name,
        card: peeked,
        at: Date.now(),
      });
      break;
    }
    case "steal_delete_gift": {
      // 클라이언트에서 화면 암전 후 프로필 클릭으로 상대만 지정하고, 삭제할 항목은 서버가
      // 그 사람이 실제로 보유 중인 것 중에서 랜덤으로 고른다 (빈 칸을 고를 일이 없음).
      const target = table.getPlayer(targetPlayerId);
      if (!target || target.id === playerId) throw new Error("상대 플레이어를 선택해주세요.");
      const targetInv = room.cardInventory.get(target.id) || [];
      if (targetInv.length > 0) {
        const removed = targetInv[Math.floor(Math.random() * targetInv.length)];
        room.cardInventory.set(target.id, targetInv.filter((c) => c.id !== removed.id));
        room.lastAnnouncement = {
          type: "gift",
          playerId,
          playerName: player.name,
          text: `${player.name}님이 [이건 이제 제껍니다]로 ${target.name}님의 기프트를 파괴했어요!`,
          at: Date.now(),
        };
      } else {
        room.lastAnnouncement = {
          type: "gift",
          playerId,
          playerName: player.name,
          text: `${player.name}님이 [이건 이제 제껍니다]를 사용했지만 ${target.name}님은 보유한 기프트가 없었어요 (허탕)`,
          at: Date.now(),
        };
      }
      break;
    }
    case "card_swap_random": {
      const target = table.getPlayer(targetPlayerId);
      if (!target || target.id === playerId) throw new Error("상대 플레이어를 선택해주세요.");
      table.swapRandomHoleCard(playerId, target.id); // 유효하지 않으면 여기서 에러 throw
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: player.name,
        text: `${player.name}님이 [훌륭한 대화수단]으로 ${target.name}님과 카드를 교환했어요!`,
        at: Date.now(),
      };
      break;
    }
    case "redraw_community": {
      table.redrawCommunity(); // 유효하지 않으면 여기서 에러 throw
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: player.name,
        text: `${player.name}님이 [신라천정]으로 커뮤니티 카드를 새로 뽑았어요!`,
        at: Date.now(),
      };
      break;
    }
    case "lock_community_color": {
      const color = option === "red" ? "red" : option === "black" ? "black" : null;
      if (!color) throw new Error("검정 또는 빨강을 선택해주세요.");
      table.communityColorLock = color;
      room.lastAnnouncement = {
        type: "gift",
        playerId,
        playerName: player.name,
        text: `${player.name}님이 [선구안 위]로 이번 판 커뮤니티 카드를 ${color === "red" ? "빨강" : "검정"}으로 봉인했어요!`,
        at: Date.now(),
      };
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
  room.pendingRebuyOffers.delete(playerId);
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
  drawGiftsForCommunityReveal(room);
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
  const followers = Object.fromEntries(room.followers);
  const fanNames = [...room.fans.values()].map((f) => f.name);

  const commonExtra = {
    cheerCounts,
    bounties,
    bountyEarnings,
    verified,
    followers,
    fanNames,
    fanCount: room.fans.size,
    lastGiftBatch: room.lastGiftBatch,
    lastAnnouncement: room.lastAnnouncement,
    cheerThreshold: 21,
    maxPlayers: MAX_PLAYERS,
    chatMessages: room.chatMessages,
    gameSettings: room.gameSettings,
    pendingGameSettings: room.pendingGameSettings,
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
      myHandInfo: room.table.getPlayerHandInfo(socketId),
      rebuyOffer: room.pendingRebuyOffers.has(socketId)
        ? {
            rebuyAmount: room.gameSettings.rebuyAmount,
            remaining: room.gameSettings.maxRebuys - (room.rebuyUsedCount.get(socketId) || 0),
          }
        : null,
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
      console.log(`[requestJoin] room=${code} socket=${socket.id} name=${name} pendingKeys=${[...room.pendingRequests.keys()]}`);
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
    if (!req) {
      console.log(`[approve] MISS room=${roomCode} targetId=${targetId} pendingKeys=${[...room.pendingRequests.keys()]} hostSocketId=${room.hostSocketId} callerSocket=${socket.id}`);
      return cb?.({ ok: false, error: "이미 처리되었거나 존재하지 않는 요청입니다." });
    }
    console.log(`[approve] OK room=${roomCode} targetId=${targetId} name=${req.name}`);
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

  // ---- 채팅: 방에 있는 플레이어+팬 전원이 함께 쓰는 공용 채팅 ----
  socket.on("chat:send", ({ text }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });

    const isFan = room.fans.has(socket.id);
    const isPlayer = room.sockets.has(socket.id);
    if (!isFan && !isPlayer) {
      return cb?.({ ok: false, error: "채팅은 참가 승인 후 이용할 수 있어요." });
    }

    const trimmed = (text || "").trim();
    if (!trimmed) return cb?.({ ok: false, error: "메시지를 입력해주세요." });
    if (trimmed.length > CHAT_MAX_LEN) {
      return cb?.({ ok: false, error: `메시지는 ${CHAT_MAX_LEN}자 이하로 입력해주세요.` });
    }

    const senderName = isFan
      ? room.fans.get(socket.id)?.name || "이름없는 팬"
      : room.sockets.get(socket.id)?.name || room.table.getPlayer(socket.id)?.name || "플레이어";

    const message = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      senderId: socket.id,
      senderName,
      isFan,
      isHost: room.hostSocketId === socket.id,
      text: trimmed,
      at: Date.now(),
    };
    room.chatMessages.push(message);
    if (room.chatMessages.length > CHAT_HISTORY_LIMIT) {
      room.chatMessages.splice(0, room.chatMessages.length - CHAT_HISTORY_LIMIT);
    }
    cb?.({ ok: true });
    broadcastState(roomCode);
  });

  // 방장 설정(블라인드/리바인) 저장. 즉시 적용되지 않고 다음 핸드 시작 시점에 반영된다.
  socket.on("room:settings:save", ({ smallBlind, bigBlind, maxRebuys, rebuyAmount }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 설정을 변경할 수 있습니다." });

    const sb = parseInt(smallBlind, 10);
    const bb = parseInt(bigBlind, 10);
    const mr = parseInt(maxRebuys, 10);
    const ra = parseInt(rebuyAmount, 10);

    if (!Number.isFinite(sb) || sb <= 0) return cb?.({ ok: false, error: "스몰 블라인드를 올바르게 입력해주세요." });
    if (!Number.isFinite(bb) || bb <= 0) return cb?.({ ok: false, error: "빅 블라인드를 올바르게 입력해주세요." });
    if (bb < sb) return cb?.({ ok: false, error: "빅 블라인드는 스몰 블라인드보다 작을 수 없습니다." });
    if (!Number.isFinite(mr) || mr < 0) return cb?.({ ok: false, error: "리바인 횟수를 올바르게 입력해주세요." });
    if (!Number.isFinite(ra) || ra < 0) return cb?.({ ok: false, error: "리바인 액수를 올바르게 입력해주세요." });

    room.pendingGameSettings = { smallBlind: sb, bigBlind: bb, maxRebuys: mr, rebuyAmount: ra };
    cb?.({ ok: true });
    broadcastState(roomCode);
  });

  // 파산 후 리바인 제안에 대한 응답 (예/아니오)
  socket.on("player:rebuy", ({ accept }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (!room.pendingRebuyOffers.has(socket.id)) {
      return cb?.({ ok: false, error: "리바인 대기 상태가 아닙니다." });
    }
    room.pendingRebuyOffers.delete(socket.id);

    if (accept) {
      const p = room.table.getPlayer(socket.id);
      if (p) {
        p.chips = room.gameSettings.rebuyAmount;
        p.sittingOut = false;
        room.eliminated.delete(socket.id);
        room.rebuyUsedCount.set(socket.id, (room.rebuyUsedCount.get(socket.id) || 0) + 1);
        room.lastAnnouncement = {
          type: "gift",
          playerId: socket.id,
          playerName: p.name,
          text: `${p.name}님이 리바인으로 복귀했어요! (${room.gameSettings.rebuyAmount.toLocaleString()}칩)`,
          at: Date.now(),
        };
      }
    }
    cb?.({ ok: true });
    broadcastState(roomCode);
  });

  // ---- 게임 진행 ----
  socket.on("room:start", (cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.hostSocketId !== socket.id) return cb?.({ ok: false, error: "방장만 시작할 수 있습니다." });
    try {
      applyPendingGameSettings(room);
      applyPendingDealerClaim(room);
      room.table.startHand();
      room.lastCommunityCount = 0;
      applyBlindExemptions(room);
      applyPendingPocketPairs(room);
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
      applyPendingGameSettings(room);
      applyPendingDealerClaim(room);
      room.table.startHand();
      room.lastCommunityCount = 0;
      applyBlindExemptions(room);
      applyPendingPocketPairs(room);
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
  socket.on("gift:use", ({ giftId, targetPlayerId, option }, cb) => {
    const roomCode = roomOfSocket(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "방을 찾을 수 없습니다." });
    if (room.table.street === "showdown") {
      return cb?.({ ok: false, error: "핸드가 끝나서 이번 판 기프트를 사용할 수 없습니다." });
    }
    const inv = room.cardInventory.get(socket.id) || [];
    const item = inv.find((c) => c.id === giftId && !c.used);
    if (!item) return cb?.({ ok: false, error: "사용할 수 없는 기프트입니다." });
    if (item.type !== "active") return cb?.({ ok: false, error: "패시브 기프트는 보유만 해도 자동으로 적용돼요." });
    // 모든 액티브 기프트는 본인 턴(행동 차례)에만 사용 가능
    if (room.table.currentPlayer()?.id !== socket.id) {
      return cb?.({ ok: false, error: "본인 턴에만 기프트를 사용할 수 있어요." });
    }
    try {
      applyActiveGift(room, socket.id, item, targetPlayerId, option);
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
    console.log(`덕슈의템전홀덤 서버 실행 중: http://localhost:${PORT}`);
  });
}

module.exports = {
  rooms,
  newRoom,
  registerPlayerMeta,
  countPassive,
  drawGiftsForCommunityReveal,
  resolveHandEnd,
  applyBlindExemptions,
  applyActiveGift,
  afterTableChange,
  applyPendingDealerClaim,
  applyPendingPocketPairs,
  applyPendingGameSettings,
  leaveRoomNow,
  processScheduledLeaves,
  MAX_PLAYERS,
  BOUNTY_RATE,
};
