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
function rankLabel(rank) { return rank === "T" ? "10" : rank; }
function cardLabel(card) {
  if (!card || card === "?") return "?";
  return rankLabel(card.slice(0, -1)) + SUIT[card.slice(-1)];
}

function cardEl(card, opts = {}) {
  const div = document.createElement("div");
  if (!card || card === "?") {
    div.className = "card-chip back";
    return div;
  }
  const suit = card.slice(-1);
  div.className = "card-chip " + (isRed(suit) ? "red" : "black");
  div.textContent = cardLabel(card);
  return div;
}

// ---------- 칩 그래픽 (진짜 카지노 포커칩처럼 위에서 본 원판 + 여러 색이 흩뿌려진 더미) ----------
// 실제 카지노 칩 색 관례를 따른 액면가별 색상
const CHIP_DENOMS = [
  { value: 1000, color: "#f4c430", edge: "#fff6d8" }, // 금색
  { value: 500, color: "#a855f7", edge: "#f1e2ff" },  // 보라
  { value: 100, color: "#1f2430", edge: "#e6e8ec" },  // 검정
  { value: 25, color: "#1f8a4c", edge: "#dbf5e4" },   // 초록
  { value: 5, color: "#e0342c", edge: "#ffd9d6" },    // 빨강
  { value: 1, color: "#e8e6e0", edge: "#8a8a86" },    // 흰색
];

// amount를 액면가 칩들로 그리디 분해 (표시용 - 실제 정산과 무관)
function denominationBreakdown(amount) {
  let remaining = Math.max(0, Math.round(amount));
  const tokens = [];
  for (const d of CHIP_DENOMS) {
    while (remaining >= d.value && tokens.length < 60) {
      tokens.push(d);
      remaining -= d.value;
    }
  }
  if (tokens.length === 0 && amount > 0) tokens.push(CHIP_DENOMS[CHIP_DENOMS.length - 1]);
  return tokens;
}

// 분해된 토큰이 표시 개수(maxChips)보다 많으면 액면가 다양성을 유지하며 고르게 샘플링
function sampleTokens(tokens, maxChips) {
  if (tokens.length <= maxChips) return tokens;
  const picked = [];
  const step = tokens.length / maxChips;
  for (let i = 0; i < maxChips; i++) picked.push(tokens[Math.floor(i * step)]);
  return picked;
}

// amount에 비례해 칩 개수를 정하고(maxAmount 기준 상대비교), 실제 카지노 칩처럼 위에서 본
// 원판(테두리 줄무늬 + 안쪽 원)들을 살짝 흩뿌려진 더미 모양으로 배치한다.
function chipStackEl(amount, maxAmount, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "chip-pile" + (opts.small ? " small" : "");
  if (!amount || amount <= 0) {
    wrap.classList.add("empty");
  } else {
    const ratio = maxAmount > 0 ? Math.max(0, Math.min(1, amount / maxAmount)) : 0;
    const maxChips = opts.maxDiscs || (opts.small ? 5 : 9);
    const chipCount = Math.max(1, Math.round(ratio * maxChips));
    const tokens = sampleTokens(denominationBreakdown(amount), chipCount);
    tokens.forEach((d, i) => {
      const chip = document.createElement("div");
      chip.className = "poker-chip";
      chip.style.setProperty("--chip-color", d.color);
      chip.style.setProperty("--chip-edge", d.edge);
      // 인덱스 기반 결정론적 "흩뿌림" - 매 렌더마다 위치가 튀지 않으면서도 제각각으로 보이게
      const jitterX = (((i * 37 + 11) % 17) - 8) * (opts.small ? 0.6 : 1);
      const jitterY = (((i * 53 + 7) % 11) - 5) * (opts.small ? 0.6 : 1);
      const rot = ((i * 29 + 13) % 50) - 25;
      const stackLift = i * (opts.small ? 1.2 : 1.8);
      chip.style.left = `calc(50% + ${jitterX}px)`;
      chip.style.top = `calc(50% + ${jitterY}px - ${stackLift}px)`;
      chip.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
      chip.style.zIndex = String(i);
      wrap.appendChild(chip);
    });
  }
  if (opts.showLabel !== false) {
    const label = document.createElement("div");
    label.className = "chip-stack-label";
    label.textContent = amount.toLocaleString();
    wrap.appendChild(label);
  }
  return wrap;
}

// 베팅/블라인드로 칩이 늘어난 순간, 좌석 위치(%)에서 팟 중앙(50%,50%)으로 칩 몇 개가 살짝
// 시차를 두고 날아가는 연출. 색은 액면가 팔레트에서 무작위로 골라 알록달록하게.
function spawnChipThrow(fromLeftPct, fromTopPct, amount) {
  const felt = document.getElementById("table-felt");
  if (!felt) return;
  const throwCount = Math.max(1, Math.min(4, Math.round(Math.sqrt(Math.max(1, amount || 1)) / 6)));
  for (let i = 0; i < throwCount; i++) {
    setTimeout(() => {
      const el = document.createElement("div");
      el.className = "chip-throw";
      const d = CHIP_DENOMS[Math.floor(Math.random() * CHIP_DENOMS.length)];
      el.style.setProperty("--throw-color", d.color);
      el.style.setProperty("--throw-edge", d.edge);
      const jitterX = (Math.random() - 0.5) * 6;
      const jitterY = (Math.random() - 0.5) * 6;
      el.style.setProperty("--from-left", fromLeftPct + jitterX + "%");
      el.style.setProperty("--from-top", fromTopPct + jitterY + "%");
      felt.appendChild(el);
      el.addEventListener("animationend", () => el.remove());
      setTimeout(() => el.remove(), 900); // 안전장치
    }, i * 70);
  }
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

// 승인 대기 중 네트워크가 끊겼다 재연결되면(모바일/Render 특성상 종종 발생) 서버는 새 소켓ID를
// 완전히 새 연결로 취급해 이전 참가 요청을 지워버린다. 재연결 시 같은 정보로 요청을 다시 제출해서
// "이미 처리되었거나 존재하지 않는 요청입니다" 오류로 이어지는 유령 요청을 방지한다.
let pendingJoinInfo = null; // { roomCode, name, instagramUsername }
let hasConnectedOnce = false;

socket.on("connect", () => {
  if (hasConnectedOnce && pendingJoinInfo) {
    socket.emit("room:requestJoin", pendingJoinInfo, (res) => {
      if (res && res.ok) {
        enterPendingScreen(res.profile, res.startingChips);
      }
    });
  }
  hasConnectedOnce = true;
});

document.getElementById("btn-join").addEventListener("click", () => {
  clearHomeError();
  const roomCode = document.getElementById("join-code").value.trim().toUpperCase();
  const name = document.getElementById("join-name").value.trim();
  const ig = document.getElementById("join-ig").value.trim();
  if (!roomCode) return showHomeError("방 코드를 입력해주세요.");
  if (!ig && !isTestName(name)) return showHomeError("인스타그램 아이디를 입력해주세요. (테스트하려면 닉네임에 test 입력)");
  const payload = { roomCode, name, instagramUsername: ig };
  socket.emit("room:requestJoin", payload, (res) => {
    if (!res.ok) return showHomeError(res.error);
    pendingJoinInfo = payload;
    enterPendingScreen(res.profile, res.startingChips);
  });
});

document.getElementById("btn-fan-go").addEventListener("click", () => {
  const roomCode = document.getElementById("join-code").value.trim().toUpperCase();
  const url = roomCode ? `fan.html?room=${roomCode}` : "fan.html";
  location.href = url;
});

socket.on("room:rejected", () => {
  pendingJoinInfo = null;
  alert("아쉽게도 방장이 참가를 거절했어요.");
  location.reload();
});

function enterTableScreen() {
  pendingJoinInfo = null; // 승인 완료 - 더 이상 재연결시 참가 요청을 재제출할 필요 없음
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

let lastGiftBatchAt = 0;
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
  const { state } = msg;
  document.getElementById("player-count-label").textContent =
    `(인원 ${state.players.length}/${msg.maxPlayers || 10})`;
  const fanLink = `${location.origin}/fan.html?room=${msg.roomCode}`;
  const fanLinkEl = document.getElementById("fan-link");
  fanLinkEl.textContent = fanLink;
  fanLinkEl.href = fanLink;

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
  const potStackWrap = document.getElementById("pot-chip-stack");
  potStackWrap.innerHTML = "";
  if (state.pot > 0) {
    const scaleMax = Math.max(1, state.pot, ...state.players.map((p) => p.chips || 0));
    potStackWrap.appendChild(chipStackEl(state.pot, scaleMax, { maxDiscs: 12, showLabel: false }));
  }
  const streetNames = {
    waiting: "대기 중", preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버", showdown: "쇼다운",
  };
  document.getElementById("street-label").textContent = streetNames[state.street] || state.street;

  // 각 렌더 단계를 개별적으로 감싸서, 한 섹션에서 예외가 나도(예: 새 기능 버그)
  // 승인 패널 등 나머지 UI가 통째로 멈추지 않도록 방어한다.
  safeRender("renderSeats", () => renderSeats(state, msg.you, msg.verified));
  safeRender("renderResult", () => renderResult(state));
  safeRender("renderControls", () => renderControls(msg, state));
  safeRender("renderMyStatus", () => renderMyStatus(msg, state));
  safeRender("renderCardInventory", () => renderCardInventory(msg, state));
  safeRender("renderNotifications", () => renderNotifications(msg));
  safeRender("renderPendingPanel", () => renderPendingPanel(msg));
}

function safeRender(label, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`[render:${label}]`, e);
  }
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
    approveBtn.addEventListener("click", () => {
      approveBtn.disabled = true;
      approveBtn.textContent = "승인 중...";
      socket.emit("room:approve", { targetId: r.socketId }, (res) => {
        if (res && !res.ok) {
          // 그 사이 요청이 취소/처리된 경우 등 - 요란한 alert 대신 조용히 알리고 목록은
          // 곧 이어질 room:state로 자동 갱신되게 둔다 (재클릭 유도)
          approveBtn.disabled = false;
          approveBtn.textContent = "승인";
          showFanToast(`⚠️ ${r.name}님 참가 요청을 처리하지 못했어요 (${res.error}). 목록이 갱신되면 다시 시도해주세요.`);
        }
      });
    });
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
      if (card.description) el.dataset.tooltip = card.description;
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
      if (card.description) wrap.dataset.tooltip = card.description;
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

// ---------- 기프트 획득 대형 연출 (유희왕 카드 소환 스타일) ----------
let giftRevealQueue = [];
let giftRevealShowing = false;
let giftRevealTimer = null;

function rarityClass(rarity) {
  if (rarity === "SSR") return "ssr";
  if (rarity === "SR") return "sr";
  if (rarity === "R") return "r";
  return "bust";
}

function queueGiftReveals(draws) {
  giftRevealQueue.push(...draws);
  if (!giftRevealShowing) showNextGiftReveal();
}

function showNextGiftReveal() {
  const next = giftRevealQueue.shift();
  if (!next) {
    giftRevealShowing = false;
    return;
  }
  giftRevealShowing = true;
  const overlay = document.getElementById("gift-reveal-overlay");
  const cardEl = document.getElementById("gift-reveal-card");
  if (!overlay || !cardEl) { giftRevealShowing = false; return; }

  cardEl.className = "gift-reveal-card rarity-" + rarityClass(next.card.rarity);
  document.getElementById("grc-rarity").textContent = next.card.rarity;
  document.getElementById("grc-emoji").textContent = next.card.emoji || "🎁";
  document.getElementById("grc-name").textContent = next.card.name;
  document.getElementById("grc-type").textContent =
    next.card.type === "passive" ? "패시브" : next.card.type === "active" ? "액티브" : "";
  document.getElementById("grc-desc").textContent = next.card.description || "";
  document.getElementById("grc-street").textContent = `[${next.streetLabel}] 응원 ${next.cheerCountAtDraw}회 달성`;

  overlay.classList.remove("hidden");
  cardEl.classList.remove("grc-anim");
  void cardEl.offsetWidth; // reflow to restart animation
  cardEl.classList.add("grc-anim");
  // 자동으로 안 넘어가고 클릭해야만 다음 기프트(또는 닫기)로 진행
}

function dismissGiftReveal() {
  clearTimeout(giftRevealTimer);
  const overlay = document.getElementById("gift-reveal-overlay");
  if (overlay) overlay.classList.add("hidden");
  setTimeout(showNextGiftReveal, 200);
}

document.addEventListener("DOMContentLoaded", () => {
  const overlay = document.getElementById("gift-reveal-overlay");
  if (overlay) overlay.addEventListener("click", dismissGiftReveal);
});

function renderNotifications(msg) {
  if (msg.lastGiftBatch && msg.lastGiftBatch.at && msg.lastGiftBatch.at > lastGiftBatchAt) {
    lastGiftBatchAt = msg.lastGiftBatch.at;
    const myDraws = [];
    for (const d of msg.lastGiftBatch.draws) {
      if (d.playerId === msg.you) {
        myDraws.push(d);
      } else if (d.card.rarity !== "꽝") {
        showFanToast(`${d.card.emoji} ${d.playerName}님이 [${d.streetLabel}] 응원 ${d.cheerCountAtDraw}회 받고 [${d.card.rarity}] ${d.card.name} 기프트 획득!`);
      }
    }
    if (myDraws.length > 0) queueGiftReveals(myDraws);
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
    showFanToast(`🔍 [필살기 스크롤] ${msg.myPeek.targetName}님의 카드 한 장: ${cardLabel(msg.myPeek.card)}`);
  }
}

let prevBetThisStreet = {};
let prevHandNumberForChips = null;

function renderSeats(state, you, verifiedMap) {
  const seatsEl = document.getElementById("seats");
  seatsEl.innerHTML = "";
  const players = state.players;
  const n = players.length;
  if (n === 0) return;
  const seatVerifiedMap = verifiedMap || {};

  // 새 핸드가 시작되면 베팅 증가분 추적을 리셋 (칩 던지기 애니메이션 오작동 방지)
  if (state.handNumber !== prevHandNumberForChips) {
    prevBetThisStreet = {};
    prevHandNumberForChips = state.handNumber;
  }

  // 좌석/팟 칩 그래픽을 같은 기준으로 비교할 수 있도록 공통 최댓값 사용
  const chipScaleMax = Math.max(1, state.pot || 0, ...players.map((pp) => pp.chips || 0));

  let myIndex = players.findIndex((p) => p.id === you);
  if (myIndex === -1) myIndex = 0;

  const rx = 42, ry = 36; // ellipse radii in %
  for (let i = 0; i < n; i++) {
    const p = players[(myIndex + i) % n];
    const angleDeg = 90 + i * (360 / n);
    const rad = (angleDeg * Math.PI) / 180;
    const left = 50 + rx * Math.cos(rad);
    const top = 50 + ry * Math.sin(rad);

    const prevBet = prevBetThisStreet[p.id] || 0;
    if (p.betThisStreet > prevBet) {
      spawnChipThrow(left, top, p.betThisStreet - prevBet);
    }
    prevBetThisStreet[p.id] = p.betThisStreet;

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

    seat.appendChild(chipStackEl(p.chips, chipScaleMax));

    if (p.betThisStreet > 0) {
      const betWrap = document.createElement("div");
      betWrap.className = "bet";
      betWrap.appendChild(chipStackEl(p.betThisStreet, chipScaleMax, { small: true }));
      seat.appendChild(betWrap);
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
