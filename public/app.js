const socket = io({ transports: ["websocket"] });

const FALLBACK_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="%23333"/><text x="50%" y="55%" font-size="28" text-anchor="middle" fill="%23999">?</text></svg>'
  );

const VERIFIED_SVG =
  '<svg class="verified-badge" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#3897f0" d="M19.998 3.094 24.322 0l2.075 5.259 5.596-.99-.99 5.596L36.262 12l-3.594 4.318L36.262 20l-5.259 2.075.99 5.596-5.596-.99L24.322 32l-4.324-3.094L15.674 32l-2.075-5.259-5.596.99.99-5.596L3.734 20l3.594-4.318L3.734 12l5.259-2.075-.99-5.596 5.596.99z"/>' +
  '<path fill="#fff" d="M17.5 24.5 12 19l1.8-1.8 3.7 3.7 8.7-8.7L28 14.2z"/>' +
  '</svg>';
function verifiedBadge(isVerified) {
  return isVerified ? VERIFIED_SVG : "";
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

const SUIT = { c: "♣", d: "♦", h: "♥", s: "♠" };
function isRed(suit) { return suit === "d" || suit === "h"; }

function cardEl(card, opts = {}) {
  const div = document.createElement("div");
  if (!card || card === "?") {
    div.className = "card-chip back";
    return div;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  div.className = "card-chip " + (isRed(suit) ? "red" : "black");
  div.textContent = rank + SUIT[suit];
  return div;
}

// ---------- Home screen ----------
const tabBtns = document.querySelectorAll(".tab-btn");
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

function showHomeError(msg) {
  const el = document.getElementById("home-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearHomeError() {
  document.getElementById("home-error").classList.add("hidden");
}

function isTestName(name) {
  return (name || "").trim().toLowerCase() === "test";
}

async function previewProfile(igInputId, boxId, nameInputId) {
  clearHomeError();
  const ig = document.getElementById(igInputId).value.trim();
  const name = nameInputId ? document.getElementById(nameInputId).value.trim() : "";
  const box = document.getElementById(boxId);
  if (!ig && !isTestName(name)) { showHomeError("인스타그램 아이디를 입력해주세요. (테스트하려면 닉네임에 test 입력)"); return null; }
  box.classList.remove("hidden");
  box.innerHTML = "불러오는 중...";
  try {
    const res = await fetch("/api/ig-preview?u=" + encodeURIComponent(ig) + "&name=" + encodeURIComponent(name));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "조회 실패");
    box.innerHTML = "";
    const img = document.createElement("img");
    img.src = data.profile.avatarUrl || FALLBACK_AVATAR;
    img.onerror = () => (img.src = FALLBACK_AVATAR);
    const info = document.createElement("div");
    info.className = "pv-info";
    info.innerHTML =
      `<b>${data.profile.displayName}</b>${verifiedBadge(data.profile.verified)} (@${data.profile.username})<br>` +
      `게시물 ${data.profile.posts.toLocaleString()} · 팔로워 ${data.profile.followers.toLocaleString()}<br>` +
      `<span class="pv-chips">시작 칩: ${data.startingChips.toLocaleString()}</span>`;
    box.appendChild(img);
    box.appendChild(info);
    return data;
  } catch (e) {
    box.innerHTML = "";
    showHomeError(e.message);
    return null;
  }
}

document.getElementById("btn-preview-create").addEventListener("click", () =>
  previewProfile("create-ig", "preview-create", "create-name")
);
document.getElementById("btn-preview-join").addEventListener("click", () =>
  previewProfile("join-ig", "preview-join", "join-name")
);

document.getElementById("btn-create").addEventListener("click", () => {
  clearHomeError();
  const name = document.getElementById("create-name").value.trim();
  const ig = document.getElementById("create-ig").value.trim();
  if (!ig && !isTestName(name)) return showHomeError("인스타그램 아이디를 입력해주세요. (테스트하려면 닉네임에 test 입력)");
  socket.emit("room:create", { name, instagramUsername: ig }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    enterTableScreen();
  });
});

document.getElementById("btn-join").addEventListener("click", () => {
  clearHomeError();
  const roomCode = document.getElementById("join-code").value.trim().toUpperCase();
  const name = document.getElementById("join-name").value.trim();
  const ig = document.getElementById("join-ig").value.trim();
  if (!roomCode) return showHomeError("방 코드를 입력해주세요.");
  if (!ig && !isTestName(name)) return showHomeError("인스타그램 아이디를 입력해주세요. (테스트하려면 닉네임에 test 입력)");
  socket.emit("room:requestJoin", { roomCode, name, instagramUsername: ig }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    enterPendingScreen(res.profile, res.startingChips);
  });
});

document.getElementById("btn-fan-go").addEventListener("click", () => {
  const roomCode = document.getElementById("join-code").value.trim().toUpperCase();
  const url = roomCode ? `fan.html?room=${roomCode}` : "fan.html";
  location.href = url;
});

socket.on("room:rejected", () => {
  alert("아쉽게도 방장이 참가를 거절했어요.");
  location.reload();
});

function enterTableScreen() {
  document.getElementById("screen-home").classList.add("hidden");
  document.getElementById("screen-pending").classList.add("hidden");
  document.getElementById("screen-table").classList.remove("hidden");
}

function enterPendingScreen(profile, startingChips) {
  document.getElementById("screen-home").classList.add("hidden");
  document.getElementById("screen-pending").classList.remove("hidden");
  const box = document.getElementById("pending-preview");
  box.innerHTML = "";
  const img = document.createElement("img");
  img.src = profile.avatarUrl || FALLBACK_AVATAR;
  img.onerror = () => (img.src = FALLBACK_AVATAR);
  const info = document.createElement("div");
  info.className = "pv-info";
  info.innerHTML =
    `<b>${profile.displayName}</b>${verifiedBadge(profile.verified)} (@${profile.username})<br>` +
    `게시물 ${profile.posts.toLocaleString()} · 팔로워 ${profile.followers.toLocaleString()}<br>` +
    `<span class="pv-chips">시작 칩: ${startingChips.toLocaleString()}</span>`;
  box.appendChild(img);
  box.appendChild(info);
}

// ---------- Table screen ----------
let lastState = null;

document.getElementById("btn-start").addEventListener("click", () => {
  socket.emit("room:start", (res) => {
    if (!res.ok) alert(res.error);
  });
});
document.getElementById("btn-next-hand").addEventListener("click", () => {
  socket.emit("room:nextHand", (res) => {
    if (!res.ok) alert(res.error);
  });
});

function sendAction(type, amount) {
  socket.emit("room:action", { type, amount }, (res) => {
    if (!res.ok) alert(res.error);
  });
}
document.getElementById("act-fold").addEventListener("click", () => sendAction("fold"));
document.getElementById("act-check").addEventListener("click", () => sendAction("check"));
document.getElementById("act-call").addEventListener("click", () => sendAction("call"));
document.getElementById("act-allin").addEventListener("click", () => sendAction("allin"));
document.getElementById("act-raise").addEventListener("click", () => {
  const amt = parseInt(document.getElementById("raise-amount").value, 10);
  if (!amt) return alert("레이즈 금액을 입력해주세요.");
  sendAction("raise", amt);
});

socket.on("room:state", (msg) => {
  lastState = msg;
  render(msg);
});

let lastCardDrawAt = 0;
let lastAnnouncementAt = 0;

function render(msg) {
  if (msg.pendingApproval) {
    // 아직 방장 승인 대기중 - 대기 화면 유지, 테이블 렌더링 생략
    return;
  }
  // 승인 대기 화면에 있었는데 이제 정식 플레이어가 됐다면 테이블 화면으로 전환
  if (!document.getElementById("screen-pending").classList.contains("hidden")) {
    enterTableScreen();
  }
  document.getElementById("room-code-label").textContent = msg.roomCode;
  document.getElementById("player-count-label").textContent =
    `(인원 ${state.players.length}/${msg.maxPlayers || 10})`;
  const fanLink = `${location.origin}/fan.html?room=${msg.roomCode}`;
  const fanLinkEl = document.getElementById("fan-link");
  fanLinkEl.textContent = fanLink;
  fanLinkEl.href = fanLink;
  const { state } = msg;

  // community cards
  const commEl = document.getElementById("community-cards");
  commEl.innerHTML = "";
  const shown = state.communityCards || [];
  for (let i = 0; i < 5; i++) {
    if (i < shown.length) commEl.appendChild(cardEl(shown[i]));
    else {
      const d = document.createElement("div");
      d.className = "card-chip empty";
      commEl.appendChild(d);
    }
  }
  document.getElementById("pot-label").textContent = "Pot: " + state.pot.toLocaleString();
  const streetNames = {
    waiting: "대기 중", preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버", showdown: "쇼다운",
  };
  document.getElementById("street-label").textContent = streetNames[state.street] || state.street;

  renderSeats(state, msg.you, msg.verified);
  renderResult(state);
  renderControls(msg, state);
  renderMyStatus(msg, state);
  renderCardInventory(msg, state);
  renderNotifications(msg);
  renderPendingPanel(msg);
}

document.getElementById("btn-pending-open").addEventListener("click", () => {
  document.getElementById("pending-modal-overlay").classList.remove("hidden");
});
document.getElementById("btn-pending-close").addEventListener("click", () => {
  document.getElementById("pending-modal-overlay").classList.add("hidden");
});

function renderPendingPanel(msg) {
  const openBtn = document.getElementById("btn-pending-open");
  const list = document.getElementById("pending-list");
  const emptyLabel = document.getElementById("pending-empty");
  const badge = document.getElementById("pending-count-badge");
  const reqs = msg.pendingRequests || [];

  if (!msg.isHost) {
    openBtn.classList.add("hidden");
    document.getElementById("pending-modal-overlay").classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  openBtn.classList.remove("hidden");
  if (reqs.length > 0) {
    badge.textContent = reqs.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
  list.innerHTML = "";

  if (reqs.length === 0) {
    emptyLabel.classList.remove("hidden");
    return;
  }
  emptyLabel.classList.add("hidden");
  for (const r of reqs) {
    const item = document.createElement("div");
    item.className = "pending-item";
    const img = document.createElement("img");
    img.src = r.profile.avatarUrl || FALLBACK_AVATAR;
    img.onerror = () => (img.src = FALLBACK_AVATAR);
    item.appendChild(img);

    const info = document.createElement("div");
    info.className = "pi-info";
    info.innerHTML =
      `<b>${r.name}</b>${verifiedBadge(r.profile.verified)} (@${r.profile.username})<br>` +
      `게시물 ${r.profile.posts.toLocaleString()} · 시작칩 ${r.startingChips.toLocaleString()}`;
    item.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "pi-actions";
    const approveBtn = document.createElement("button");
    approveBtn.className = "btn-approve";
    approveBtn.textContent = "승인";
    approveBtn.addEventListener("click", () => socket.emit("room:approve", { targetId: r.socketId }, (res) => {
      if (res && !res.ok) alert(res.error);
    }));
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "btn-reject";
    rejectBtn.textContent = "거절";
    rejectBtn.addEventListener("click", () => socket.emit("room:reject", { targetId: r.socketId }));
    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    item.appendChild(actions);

    list.appendChild(item);
  }
}

document.getElementById("btn-leave-open").addEventListener("click", () => {
  document.getElementById("leave-modal-overlay").classList.remove("hidden");
});
document.getElementById("btn-leave-cancel").addEventListener("click", () => {
  document.getElementById("leave-modal-overlay").classList.add("hidden");
});
document.getElementById("btn-leave-now").addEventListener("click", () => {
  socket.emit("room:leave", { mode: "immediate" }, (res) => {
    document.getElementById("leave-modal-overlay").classList.add("hidden");
    if (!res.ok) return alert(res.error);
    location.reload();
  });
});
document.getElementById("btn-leave-scheduled").addEventListener("click", () => {
  socket.emit("room:leave", { mode: "scheduled" }, (res) => {
    document.getElementById("leave-modal-overlay").classList.add("hidden");
    if (!res.ok) return alert(res.error);
    if (!res.scheduled) location.reload(); // 진행중인 핸드가 없었다면 즉시 처리됐을 것
  });
});

document.getElementById("btn-copy-fan-link").addEventListener("click", () => {
  const link = document.getElementById("fan-link").href;
  navigator.clipboard?.writeText(link).then(
    () => alert("응원 링크가 복사됐어요!"),
    () => {}
  );
});

const RARITY_STYLE = {
  SSR: { bg: "#ffd447" },
  SR: { bg: "#b06bff" },
  R: { bg: "#4d9dff" },
  "꽝": { bg: "#7a7f8c" },
};

function renderMyStatus(msg, state) {
  const box = document.getElementById("my-status");
  const me = state.players.find((p) => p.id === msg.you);
  if (!me) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  document.getElementById("ms-bounty").textContent = ((msg.bounties && msg.bounties[msg.you]) || 0).toLocaleString();
  document.getElementById("ms-bounty-earned").textContent = ((msg.bountyEarnings && msg.bountyEarnings[msg.you]) || 0).toLocaleString();
  document.getElementById("ms-cheer").textContent = (msg.cheerCounts && msg.cheerCounts[msg.you]) || 0;
  const rebuy = msg.rebuyInfo && msg.rebuyInfo[msg.you];
  document.getElementById("ms-rebuy-tag").classList.toggle("hidden", !(rebuy && rebuy.eligible));
  document.getElementById("ms-leave-tag").classList.toggle("hidden", !msg.leaveScheduled);
}

document.getElementById("btn-cancel-leave").addEventListener("click", (e) => {
  e.stopPropagation();
  socket.emit("room:cancelLeave", (res) => {
    if (res && !res.ok) alert(res.error);
  });
});

function renderCardInventory(msg, state) {
  const box = document.getElementById("card-inventory");
  box.innerHTML = "";
  const inv = (msg.myCardInventory || []).filter((c) => c.rarity !== "꽝");
  if (inv.length === 0) return;

  const passives = inv.filter((c) => c.type === "passive");
  const actives = inv.filter((c) => c.type === "active");

  if (passives.length > 0) {
    const label = document.createElement("div");
    label.className = "inv-section-label";
    label.textContent = "보유 중 (패시브 - 자동 적용)";
    box.appendChild(label);
    const row = document.createElement("div");
    row.className = "inv-row";
    for (const card of passives) {
      const el = document.createElement("div");
      el.className = "inv-card passive";
      el.style.background = RARITY_STYLE[card.rarity]?.bg || "#999";
      el.title = card.description || "";
      el.textContent = `${card.emoji} [${card.rarity}] ${card.name} (응원${card.cheerCountAtDraw ?? 0})`;
      row.appendChild(el);
    }
    box.appendChild(row);
  }

  if (actives.length > 0) {
    const label = document.createElement("div");
    label.className = "inv-section-label";
    label.textContent = "사용 가능 (액티브)";
    box.appendChild(label);
    const row = document.createElement("div");
    row.className = "inv-row";
    for (const card of actives) {
      const wrap = document.createElement("div");
      wrap.className = "inv-card active";
      wrap.style.background = RARITY_STYLE[card.rarity]?.bg || "#999";
      wrap.title = card.description || "";
      const label2 = document.createElement("span");
      label2.textContent = `${card.emoji} [${card.rarity}] ${card.name} (응원${card.cheerCountAtDraw ?? 0})`;
      wrap.appendChild(label2);
      const btn = document.createElement("button");
      btn.className = "btn-use-gift";
      btn.textContent = "사용";
      btn.addEventListener("click", () => useGift(card, state));
      wrap.appendChild(btn);
      row.appendChild(wrap);
    }
    box.appendChild(row);
  }
}

function useGift(card, state) {
  let targetPlayerId = null;
  if (card.effectId === "peek_allin_card") {
    const eligible = (state.players || []).filter((p) => p.allIn && p.id !== lastState?.you);
    if (eligible.length === 0) return alert("지금은 올인 상태인 상대가 없어요.");
    if (eligible.length === 1) {
      targetPlayerId = eligible[0].id;
    } else {
      const listText = eligible.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
      const pick = prompt(`누구의 카드를 훔쳐볼까요?\n${listText}`, "1");
      const idx = parseInt(pick, 10) - 1;
      if (!(idx >= 0 && idx < eligible.length)) return;
      targetPlayerId = eligible[idx].id;
    }
  }
  socket.emit("gift:use", { giftId: card.id, targetPlayerId }, (res) => {
    if (!res.ok) alert(res.error);
  });
}

function showFanToast(text) {
  const toast = document.getElementById("fan-toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(showFanToast._t);
  showFanToast._t = setTimeout(() => toast.classList.add("hidden"), 3500);
}

let lastPeekAt = 0;

function renderNotifications(msg) {
  if (msg.lastCardDraw && msg.lastCardDraw.at && msg.lastCardDraw.at > lastCardDrawAt) {
    lastCardDrawAt = msg.lastCardDraw.at;
    const d = msg.lastCardDraw;
    if (d.card.rarity !== "꽝") {
      showFanToast(`${d.card.emoji} ${d.playerName}님이 응원 ${d.cheerCountAtDraw}회 받고 [${d.card.rarity}] ${d.card.name} 기프트 획득!`);
    }
  }
  if (msg.lastAnnouncement && msg.lastAnnouncement.at && msg.lastAnnouncement.at > lastAnnouncementAt) {
    lastAnnouncementAt = msg.lastAnnouncement.at;
    const a = msg.lastAnnouncement;
    if (a.type === "bounty") {
      showFanToast(`💰 ${a.hunterName}님이 ${a.targetName}님을 파산시키고 현상금 ${a.amount.toLocaleString()} 획득!`);
    } else if (a.type === "rebuy") {
      showFanToast(`♻️ ${a.playerName}님이 무료 리바인으로 부활! (${a.amount.toLocaleString()} 칩)`);
    } else if (a.type === "awaken") {
      showFanToast(`🌟 ${a.playerName}님이 [만찢 각성카드]로 부활! (${a.amount.toLocaleString()} 칩)`);
    } else if (a.type === "gift") {
      showFanToast(a.text);
    }
  }
  if (msg.myPeek && msg.myPeek.at && msg.myPeek.at > lastPeekAt) {
    lastPeekAt = msg.myPeek.at;
    showFanToast(`🔍 [필살기 스크롤] ${msg.myPeek.targetName}님의 카드 한 장: ${msg.myPeek.card}`);
  }
}

function renderSeats(state, you, verifiedMap) {
  const seatsEl = document.getElementById("seats");
  seatsEl.innerHTML = "";
  const players = state.players;
  const n = players.length;
  if (n === 0) return;
  const seatVerifiedMap = verifiedMap || {};

  let myIndex = players.findIndex((p) => p.id === you);
  if (myIndex === -1) myIndex = 0;

  const rx = 42, ry = 36; // ellipse radii in %
  for (let i = 0; i < n; i++) {
    const p = players[(myIndex + i) % n];
    const angleDeg = 90 + i * (360 / n);
    const rad = (angleDeg * Math.PI) / 180;
    const left = 50 + rx * Math.cos(rad);
    const top = 50 + ry * Math.sin(rad);

    const seat = document.createElement("div");
    seat.className = "seat";
    if (p.folded) seat.classList.add("folded");
    if (p.id === state.currentPlayerId) seat.classList.add("acting");
    seat.style.left = left + "%";
    seat.style.top = top + "%";

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "avatar-wrap";
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = p.avatarUrl || FALLBACK_AVATAR;
    img.onerror = () => (img.src = FALLBACK_AVATAR);
    avatarWrap.appendChild(img);

    const dealerIdx = state.dealerSeat;
    if (players.indexOf(p) === dealerIdx) {
      const chip = document.createElement("div");
      chip.className = "dealer-chip";
      chip.textContent = "D";
      avatarWrap.appendChild(chip);
    }
    seat.appendChild(avatarWrap);

    const name = document.createElement("div");
    name.className = "name";
    name.innerHTML = escapeHtml(p.name) + verifiedBadge(seatVerifiedMap[p.id]) + (p.id === you ? " (나)" : "");
    seat.appendChild(name);

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.textContent = "칩 " + p.chips.toLocaleString();
    seat.appendChild(chips);

    if (p.betThisStreet > 0) {
      const bet = document.createElement("div");
      bet.className = "bet";
      bet.textContent = "베팅 " + p.betThisStreet.toLocaleString();
      seat.appendChild(bet);
    }

    if (p.sittingOut) {
      const tag = document.createElement("div");
      tag.className = "status-tag";
      tag.textContent = "퇴장";
      seat.appendChild(tag);
    } else if (p.folded && state.street !== "waiting") {
      const tag = document.createElement("div");
      tag.className = "status-tag";
      tag.textContent = "폴드";
      seat.appendChild(tag);
    } else if (p.allIn) {
      const tag = document.createElement("div");
      tag.className = "status-tag";
      tag.textContent = "올인";
      seat.appendChild(tag);
    }

    if (p.holeCards && p.holeCards.length) {
      const hc = document.createElement("div");
      hc.className = "hole-cards";
      p.holeCards.forEach((c) => hc.appendChild(cardEl(c)));
      seat.appendChild(hc);
    }

    seatsEl.appendChild(seat);
  }
}

function renderResult(state) {
  const banner = document.getElementById("result-banner");
  if (state.street === "showdown" && state.lastResult) {
    const r = state.lastResult;
    const winners = r.winners.map((w) => `${w.name} +${w.amount.toLocaleString()}`).join(", ");
    let text = "🏆 " + winners;
    if (r.type === "showdown" && r.hands) {
      const hands = r.hands.map((h) => `${h.name}: ${h.handName}`).join(" / ");
      text += " — " + hands;
    }
    banner.textContent = text;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function renderControls(msg, state) {
  const hostControls = document.getElementById("host-controls");
  const btnStart = document.getElementById("btn-start");
  const btnNext = document.getElementById("btn-next-hand");
  const actionControls = document.getElementById("action-controls");
  const waitingLabel = document.getElementById("waiting-label");

  hostControls.classList.add("hidden");
  actionControls.classList.add("hidden");
  waitingLabel.classList.add("hidden");
  btnStart.classList.add("hidden");
  btnNext.classList.add("hidden");

  if (msg.isHost && (state.street === "waiting" || state.street === undefined)) {
    hostControls.classList.remove("hidden");
    btnStart.classList.remove("hidden");
    return;
  }
  if (msg.isHost && state.street === "showdown") {
    hostControls.classList.remove("hidden");
    btnNext.classList.remove("hidden");
    return;
  }

  const legal = msg.legalActions || [];
  if (legal.length > 0) {
    actionControls.classList.remove("hidden");
    document.getElementById("act-check").style.display = legal.includes("check") ? "" : "none";
    document.getElementById("act-call").style.display = legal.includes("call") ? "" : "none";
    document.getElementById("act-raise").style.display = legal.includes("raise") ? "" : "none";
    document.getElementById("raise-amount").style.display = legal.includes("raise") ? "" : "none";
    document.getElementById("act-allin").style.display = legal.includes("allin") ? "" : "none";
    const me = state.players.find((p) => p.id === msg.you);
    if (me) {
      const minTo = state.currentStreetBet + (state.minRaise || state.bigBlind);
      document.getElementById("raise-amount").value = Math.min(minTo, me.chips + me.betThisStreet);
      document.getElementById("raise-amount").min = state.currentStreetBet + 1;
    }
  } else if (state.street !== "waiting" && state.street !== "showdown") {
    waitingLabel.classList.remove("hidden");
  }
}
