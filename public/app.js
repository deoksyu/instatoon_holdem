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

// 실제 트럼프 카드처럼: 좌상단/우하단 코너 인덱스 + 숫자카드는 정통 핑(pip) 배열,
// A/J/Q/K는 큰 글자+수트로 표시
const PIP_LAYOUTS = {
  "2": [[1, 0], [1, 4]],
  "3": [[1, 0], [1, 2], [1, 4]],
  "4": [[0, 0], [2, 0], [0, 4], [2, 4]],
  "5": [[0, 0], [2, 0], [1, 2], [0, 4], [2, 4]],
  "6": [[0, 0], [2, 0], [0, 2], [2, 2], [0, 4], [2, 4]],
  "7": [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [0, 4], [2, 4]],
  "8": [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [1, 3], [0, 4], [2, 4]],
  "9": [[0, 0], [2, 0], [0, 1], [2, 1], [1, 2], [0, 3], [2, 3], [0, 4], [2, 4]],
  "10": [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 3], [1, 3], [2, 3], [0, 4], [2, 4]],
};

function cardEl(card, opts = {}) {
  const div = document.createElement("div");
  if (!card || card === "?") {
    div.className = "card-chip back";
    return div;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const label = rankLabel(rank);
  const suitSym = SUIT[suit];
  div.className = "card-chip playing-card " + (isRed(suit) ? "red" : "black") + (opts.highlight ? " pc-highlight" : "");

  const cornerTL = document.createElement("div");
  cornerTL.className = "pc-corner pc-corner-tl";
  cornerTL.innerHTML = `<span class="pc-rank">${label}</span><span class="pc-suit">${suitSym}</span>`;
  div.appendChild(cornerTL);

  const cornerBR = document.createElement("div");
  cornerBR.className = "pc-corner pc-corner-br";
  cornerBR.innerHTML = `<span class="pc-rank">${label}</span><span class="pc-suit">${suitSym}</span>`;
  div.appendChild(cornerBR);

  if (rank === "A" || rank === "J" || rank === "Q" || rank === "K") {
    const face = document.createElement("div");
    face.className = "pc-face" + (rank === "A" ? "" : " pc-face-jqk");
    face.innerHTML =
      rank === "A"
        ? `<span class="pc-face-suit pc-ace-suit">${suitSym}</span>`
        : `<span class="pc-face-letter">${rank}</span><span class="pc-face-suit">${suitSym}</span>`;
    div.appendChild(face);
  } else {
    const layout = PIP_LAYOUTS[label] || [];
    const pips = document.createElement("div");
    pips.className = "pc-pips" + (layout.length >= 7 ? " pc-pips-dense" : "");
    for (const [col, row] of layout) {
      const pip = document.createElement("span");
      pip.className = "pc-pip" + (row >= 3 ? " pc-pip-flip" : "");
      pip.style.gridColumn = String(col + 1);
      pip.style.gridRow = String(row + 1);
      pip.textContent = suitSym;
      pips.appendChild(pip);
    }
    div.appendChild(pips);
  }

  return div;
}

// ---------- 칩 그래픽 (10=파란/100=빨강/1000=초록, 50/30/20 비율로 넓게 흩뿌린 카지노 더미) ----------
const CHIP_COLORS = {
  blue: { value: 10, color: "#2f6fed", edge: "#dbe8ff", img: "chip_3.png" },
  red: { value: 100, color: "#e0342c", edge: "#ffd9d6", img: "chip_1.png" },
  green: { value: 1000, color: "#1f8a4c", edge: "#dbf5e4", img: "chip_2.png" },
};
const CHIP_MIX_RATIO = [["blue", 0.5], ["red", 0.3], ["green", 0.2]];

// 표시할 칩 개수(n)를 blue/red/green에 50/30/20 비율로 최대한 고르게 인터리브해서 배분
// (덩어리로 몰리지 않고 색이 골고루 섞여 보이도록 부족분이 가장 큰 색을 매번 채워나감)
function chipMixTokens(n) {
  const counts = { blue: 0, red: 0, green: 0 };
  const tokens = [];
  for (let i = 0; i < n; i++) {
    let bestKey = null;
    let bestDeficit = -Infinity;
    for (const [key, w] of CHIP_MIX_RATIO) {
      const deficit = w * (i + 1) - counts[key];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestKey = key;
      }
    }
    counts[bestKey]++;
    tokens.push(CHIP_COLORS[bestKey]);
  }
  return tokens;
}

// amount에 비례해 칩 개수를 정하고(maxAmount 기준 상대비교), 실제 카지노 칩처럼 위에서 본
// 원판(테두리 줄무늬 + 안쪽 원)들을 넓게 흩뿌려진 더미 모양으로 배치한다.
function chipStackEl(amount, maxAmount, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "chip-pile" + (opts.small ? " small" : "");
  if (!amount || amount <= 0) {
    wrap.classList.add("empty");
  } else {
    const ratio = maxAmount > 0 ? Math.max(0, Math.min(1, amount / maxAmount)) : 0;
    const maxChips = opts.maxDiscs || (opts.small ? 6 : 11);
    const chipCount = Math.max(1, Math.round(ratio * maxChips));
    const tokens = chipMixTokens(chipCount);
    const spread = opts.small ? 11 : 19; // 흩뿌림 반경(px) - 넓게
    tokens.forEach((d, i) => {
      const chip = document.createElement("div");
      chip.className = "poker-chip";
      chip.style.setProperty("--chip-color", d.color);
      chip.style.setProperty("--chip-edge", d.edge);
      chip.style.setProperty("--chip-img", `url(${d.img})`);
      // 인덱스 기반 결정론적 "흩뿌림" - 매 렌더마다 위치가 튀지 않으면서도 넓게 제각각으로 보이게
      const jitterX = (((i * 41 + 11) % (spread * 2 + 1)) - spread);
      const jitterY = (((i * 67 + 23) % (spread * 2 + 1)) - spread) * 0.65;
      const rot = ((i * 29 + 13) % 70) - 35;
      chip.style.left = `calc(50% + ${jitterX}px)`;
      chip.style.top = `calc(50% + ${jitterY}px)`;
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
      const r = Math.random();
      const d = r < 0.5 ? CHIP_COLORS.blue : r < 0.8 ? CHIP_COLORS.red : CHIP_COLORS.green;
      el.style.setProperty("--throw-color", d.color);
      el.style.setProperty("--throw-edge", d.edge);
      el.style.setProperty("--throw-img", `url(${d.img})`);
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
  const inwonsuCount = Math.max(1, Math.min(10, state.players.length));
  document.getElementById("player-count-label").src = `inwonsu_${inwonsuCount}.png`;
  const fanLink = `${location.origin}/fan.html?room=${msg.roomCode}`;
  const fanLinkEl = document.getElementById("fan-link");
  fanLinkEl.textContent = fanLink;
  fanLinkEl.href = fanLink;

  // community cards
  const commEl = document.getElementById("community-cards");
  commEl.innerHTML = "";
  const shown = state.communityCards || [];
  const myBestCards = (msg.myHandInfo && msg.myHandInfo.cards) || [];
  for (let i = 0; i < 5; i++) {
    if (i < shown.length) commEl.appendChild(cardEl(shown[i], { highlight: myBestCards.includes(shown[i]) }));
    else {
      const d = document.createElement("div");
      d.className = "card-chip empty";
      commEl.appendChild(d);
    }
  }
  document.getElementById("pot-label").textContent = "현재 배팅금: " + state.pot.toLocaleString();
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
  safeRender("renderSeats", () => renderSeats(state, msg.you, msg.verified, msg.followers));
  safeRender("renderMyHoleCards", () => renderMyHoleCards(state, msg.you, msg.myHandInfo));
  safeRender("renderResult", () => renderResult(state));
  safeRender("renderControls", () => renderControls(msg, state));
  safeRender("renderMyStatus", () => renderMyStatus(msg, state));
  safeRender("renderMyGiftPanel", () => renderMyGiftPanel(msg, state));
  safeRender("renderChat", () => renderChat(msg));
  safeRender("renderNotifications", () => renderNotifications(msg));
  safeRender("renderPendingPanel", () => renderPendingPanel(msg));
  safeRender("renderRebuyOffer", () => renderRebuyOffer(msg));
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
document.getElementById("btn-handranks-open").addEventListener("click", () => {
  document.getElementById("handranks-modal-overlay").classList.remove("hidden");
});
document.getElementById("btn-handranks-close").addEventListener("click", () => {
  document.getElementById("handranks-modal-overlay").classList.add("hidden");
});

// 설정 모달 (임시 스캐폴드): 방장/일반 참가자에 따라 보이는 메뉴가 달라야 하므로,
// 열 때마다 lastState.isHost를 기준으로 내용을 다시 그린다. 실제 설정 항목은 추후 추가 예정.
// 방장/참가자 공통 설정(브라우저별 개인 취향, 서버 왕복 없이 즉시 저장/적용).
function renderCommonSettingsSection(body) {
  const section = document.createElement("div");
  section.className = "settings-section";
  section.innerHTML = `
    <div class="settings-section-title">공통 설정</div>
    <div class="settings-form-row">
      <label for="settings-showdown-reveal">쇼다운 시 내 패 공개</label>
      <input type="checkbox" id="settings-showdown-reveal">
    </div>
  `;
  body.appendChild(section);
  const checkbox = section.querySelector("#settings-showdown-reveal");
  // 서버가 나에 대해 기억하는 현재 값(기본값: 공개=켜짐) - 다른 사람에게는 영향 없이 내 패에만 적용된다.
  checkbox.checked = lastState?.myShowdownRevealEnabled !== false;
  checkbox.addEventListener("change", () => {
    socket.emit("player:settings:showdownReveal", { enabled: checkbox.checked });
  });
}

function renderSettingsModalBody() {
  const body = document.getElementById("settings-modal-body");
  if (!body) return;
  const isHost = !!lastState?.isHost;
  body.innerHTML = "";

  renderCommonSettingsSection(body);

  if (!isHost) {
    const section = document.createElement("div");
    section.className = "settings-section";
    const title = document.createElement("div");
    title.className = "settings-section-title";
    title.textContent = "참가자 설정";
    const placeholder = document.createElement("div");
    placeholder.className = "settings-placeholder";
    placeholder.textContent = "여기에 참가자용 설정 항목이 추가될 예정입니다.";
    section.appendChild(title);
    section.appendChild(placeholder);
    body.appendChild(section);
    return;
  }

  // 방장 설정: 블라인드 액수 / 리바인 횟수·액수. 저장 버튼을 눌러야 반영되며,
  // 그 즉시가 아니라 "다음 핸드가 시작되는 시점"부터 실제로 적용된다 (server.js applyPendingGameSettings).
  const gs = lastState?.gameSettings || {};
  const pending = lastState?.pendingGameSettings || null;
  const curSb = gs.smallBlind ?? 10;
  const curBb = gs.bigBlind ?? 20;
  const curMr = gs.maxRebuys ?? 0;
  const curRa = gs.rebuyAmount ?? 0;

  const wrap = document.createElement("div");
  wrap.className = "settings-section";
  wrap.innerHTML = `
    <div class="settings-section-title">블라인드 / 리바인</div>
    <div class="settings-form-row">
      <label for="settings-sb">스몰 블라인드</label>
      <input type="number" id="settings-sb" min="1" step="1" value="${pending?.smallBlind ?? curSb}">
    </div>
    <div class="settings-form-row">
      <label for="settings-bb">빅 블라인드</label>
      <input type="number" id="settings-bb" min="1" step="1" value="${pending?.bigBlind ?? curBb}">
    </div>
    <div class="settings-form-row">
      <label for="settings-rebuy-count">리바인 횟수</label>
      <input type="number" id="settings-rebuy-count" min="0" step="1" value="${pending?.maxRebuys ?? curMr}">
    </div>
    <div class="settings-form-row">
      <label for="settings-rebuy-amount">리바인 액수</label>
      <input type="number" id="settings-rebuy-amount" min="0" step="1" value="${pending?.rebuyAmount ?? curRa}">
    </div>
    <div id="settings-save-status" class="settings-save-status"></div>
    <button id="btn-settings-save" class="btn-primary" style="margin:12px 0 0;">설정 저장</button>
  `;
  body.appendChild(wrap);

  const statusEl = wrap.querySelector("#settings-save-status");
  const describe = (v) =>
    `SB ${v.smallBlind.toLocaleString()} / BB ${v.bigBlind.toLocaleString()} / 리바인 ${v.maxRebuys}회 / ${v.rebuyAmount.toLocaleString()}칩`;
  if (pending) {
    statusEl.textContent = `저장됨 - 다음 판부터 적용됩니다 (${describe(pending)})`;
    statusEl.classList.add("pending");
  } else {
    statusEl.textContent = `현재 적용 중: ${describe({ smallBlind: curSb, bigBlind: curBb, maxRebuys: curMr, rebuyAmount: curRa })}`;
    statusEl.classList.remove("pending");
  }

  wrap.querySelector("#btn-settings-save").addEventListener("click", () => {
    const smallBlind = parseInt(wrap.querySelector("#settings-sb").value, 10);
    const bigBlind = parseInt(wrap.querySelector("#settings-bb").value, 10);
    const maxRebuys = parseInt(wrap.querySelector("#settings-rebuy-count").value, 10);
    const rebuyAmount = parseInt(wrap.querySelector("#settings-rebuy-amount").value, 10);
    if (![smallBlind, bigBlind, maxRebuys, rebuyAmount].every(Number.isFinite)) {
      alert("모든 값을 숫자로 입력해주세요.");
      return;
    }
    socket.emit("room:settings:save", { smallBlind, bigBlind, maxRebuys, rebuyAmount }, (res) => {
      if (!res.ok) {
        alert(res.error);
        return;
      }
      statusEl.textContent = `저장됨 - 다음 판부터 적용됩니다 (${describe({ smallBlind, bigBlind, maxRebuys, rebuyAmount })})`;
      statusEl.classList.add("pending");
    });
  });
}
document.getElementById("btn-settings-open")?.addEventListener("click", () => {
  renderSettingsModalBody();
  document.getElementById("settings-modal-overlay").classList.remove("hidden");
});
document.getElementById("btn-settings-close")?.addEventListener("click", () => {
  document.getElementById("settings-modal-overlay").classList.add("hidden");
});

// 내 홀카드를 화면 하단에 크게 표시 (모서리 정보가 또렷하게 보이도록)
const HAND_NAME_KO = {
  "Royal Flush": "로열 플러시",
  "Straight Flush": "스트레이트 플러시",
  "Four of a Kind": "포카드",
  "Full House": "풀하우스",
  "Flush": "플러시",
  "Straight": "스트레이트",
  "Three of a Kind": "트리플",
  "Two Pair": "투페어",
  "Pair": "원페어",
  "High Card": "하이카드",
};

function renderMyHoleCards(state, you, myHandInfo) {
  const box = document.getElementById("my-hole-cards");
  if (!box) return;
  box.innerHTML = "";
  const me = state.players.find((p) => p.id === you);
  if (!me || !me.holeCards || me.holeCards.length === 0 || me.holeCards[0] === "?") {
    box.classList.add("hidden");
  } else {
    box.classList.remove("hidden");
    const myBestCards = (myHandInfo && myHandInfo.cards) || [];
    me.holeCards.forEach((c) => box.appendChild(cardEl(c, { highlight: myBestCards.includes(c) })));
  }

  const badge = document.getElementById("my-hand-badge");
  if (badge) {
    if (myHandInfo) {
      badge.textContent = "✨ " + (HAND_NAME_KO[myHandInfo.name] || myHandInfo.name);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

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

// 파산 직후 "리바인 하시겠습니까?" 모달. 서버가 msg.rebuyOffer를 내려주는 동안(응답 전까지)만 표시.
let rebuyResponding = false;
function renderRebuyOffer(msg) {
  const overlay = document.getElementById("rebuy-modal-overlay");
  if (!overlay) return;
  if (!msg.rebuyOffer) {
    overlay.classList.add("hidden");
    rebuyResponding = false;
    return;
  }
  if (rebuyResponding) return; // 이미 예/아니오를 누르고 응답 대기 중이면 다시 그리지 않음
  document.getElementById("rebuy-amount-label").textContent = msg.rebuyOffer.rebuyAmount.toLocaleString();
  document.getElementById("rebuy-remaining-label").textContent = msg.rebuyOffer.remaining;
  overlay.classList.remove("hidden");
}
document.getElementById("btn-rebuy-yes")?.addEventListener("click", () => {
  rebuyResponding = true;
  socket.emit("player:rebuy", { accept: true }, (res) => {
    document.getElementById("rebuy-modal-overlay").classList.add("hidden");
    rebuyResponding = false;
    if (!res.ok) alert(res.error);
  });
});
document.getElementById("btn-rebuy-no")?.addEventListener("click", () => {
  rebuyResponding = true;
  socket.emit("player:rebuy", { accept: false }, (res) => {
    document.getElementById("rebuy-modal-overlay").classList.add("hidden");
    rebuyResponding = false;
    if (!res.ok) alert(res.error);
  });
});

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
  document.getElementById("ms-leave-tag").classList.toggle("hidden", !msg.leaveScheduled);
}

document.getElementById("btn-cancel-leave").addEventListener("click", (e) => {
  e.stopPropagation();
  socket.emit("room:cancelLeave", (res) => {
    if (res && !res.ok) alert(res.error);
  });
});

// 화면 우하단에 항상 떠있는 고정 인벤토리 패널: 반투명 사각형 안에 3칸으로 나뉜 슬롯,
// 보유한 기프트가 있으면 각 슬롯에 썸네일(이모지)로 채워 넣는다. 슬롯 수는 최소 3개,
// 그보다 많이 들고 있으면(드문 경우) 그만큼 슬롯을 늘려서 전부 보여준다.
// 패시브는 눌러도 아무 일 없고(자동 적용), 액티브는 눌러서 바로 사용.
function renderMyGiftPanel(msg, state) {
  const panel = document.getElementById("my-gift-panel");
  if (!panel) return;
  panel.innerHTML = "";
  const inv = (msg.myCardInventory || []).filter((c) => c.rarity !== "꽝");
  const slotCount = Math.max(3, inv.length);
  for (let i = 0; i < slotCount; i++) {
    const card = inv[i];
    const slot = document.createElement("div");
    slot.className = "gift-slot";
    if (card) {
      slot.classList.add("filled");
      slot.style.background = RARITY_STYLE[card.rarity]?.bg || "#999";
      const emojiEl = document.createElement("span");
      emojiEl.className = "gift-emoji";
      emojiEl.textContent = card.emoji || "🎁";
      slot.appendChild(emojiEl);

      // 마우스오버 시 뜨는 상세 툴팁: 희귀도는 해당 등급 색으로, 패시브/액티브 구분 라벨 포함
      const tip = document.createElement("div");
      tip.className = "gift-tooltip";
      const rarityColor = RARITY_STYLE[card.rarity]?.bg || "#999";
      const header = document.createElement("div");
      header.className = "gt-header";
      const rarityEl = document.createElement("span");
      rarityEl.className = "gt-rarity";
      rarityEl.style.color = rarityColor;
      rarityEl.textContent = `[${card.rarity}]`;
      header.appendChild(rarityEl);
      const typeEl = document.createElement("span");
      typeEl.className = "gt-type";
      typeEl.textContent = card.type === "active" ? "액티브" : "패시브";
      header.appendChild(typeEl);
      tip.appendChild(header);
      const nameEl = document.createElement("div");
      nameEl.className = "gt-name";
      nameEl.textContent = card.name;
      tip.appendChild(nameEl);
      const cheerEl = document.createElement("div");
      cheerEl.className = "gt-cheer";
      cheerEl.textContent = `응원 ${card.cheerCountAtDraw ?? 0}회 달성`;
      tip.appendChild(cheerEl);
      if (card.description) {
        const descEl = document.createElement("div");
        descEl.className = "gt-desc";
        descEl.textContent = card.description;
        tip.appendChild(descEl);
      }
      slot.appendChild(tip);

      if (card.type === "active") {
        slot.classList.add("usable");
        slot.addEventListener("click", () => useGift(card, state));
      }
    }
    panel.appendChild(slot);
  }
}

// 방 채팅(플레이어+팬 공용) 렌더링. 매 상태 브로드캐스트마다 호출되지만, 새 메시지가
// 없으면 다시 그리지 않아서 스크롤 위치나 입력 중이던 텍스트가 흔들리지 않게 한다.
let lastRenderedChatKey = null;
function renderChat(msg) {
  const box = document.getElementById("chat-messages");
  if (!box) return;
  const messages = msg.chatMessages || [];
  const key = messages.length + ":" + (messages.length ? messages[messages.length - 1].id : "");
  if (key === lastRenderedChatKey) return;
  // 아예 처음 렌더(입장 직후)가 아니라 세션 도중 새로 도착한 메시지일 때만 안 읽음 알림 대상으로 취급
  const isNewIncoming = lastRenderedChatKey !== null && messages.length > 0;
  lastRenderedChatKey = key;

  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = "";
  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "아직 채팅이 없어요. 첫 메시지를 남겨보세요!";
    box.appendChild(empty);
  } else {
    for (const m of messages) {
      const row = document.createElement("div");
      row.className = "chat-msg " + (m.isFan ? "cm-fan" : "cm-player") + (m.isHost ? " cm-host" : "");
      const nameEl = document.createElement("span");
      nameEl.className = "cm-name";
      nameEl.textContent = m.senderName + (m.isFan ? "(팬)" : "") + ":";
      const textEl = document.createElement("span");
      textEl.className = "cm-text";
      textEl.textContent = m.text;
      row.appendChild(nameEl);
      row.appendChild(textEl);
      box.appendChild(row);
    }
  }
  if (wasNearBottom) box.scrollTop = box.scrollHeight;

  if (isNewIncoming) {
    const panel = document.getElementById("chat-panel");
    if (panel && panel.classList.contains("collapsed")) {
      document.getElementById("chat-toggle-btn")?.classList.add("has-unread");
    }
  }
}

document.getElementById("chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const text = (input.value || "").trim();
  if (!text) return;
  input.disabled = true;
  socket.emit("chat:send", { text }, (res) => {
    input.disabled = false;
    input.focus();
    if (res && !res.ok) {
      alert(res.error);
      return;
    }
    input.value = "";
  });
});

// 채팅 접기/펼치기 토글 (좌하단 아이콘 <-> 패널)
(() => {
  const toggleBtn = document.getElementById("chat-toggle-btn");
  const panel = document.getElementById("chat-panel");
  const collapseBtn = document.getElementById("chat-collapse-btn");
  if (!toggleBtn || !panel) return;
  toggleBtn.addEventListener("click", () => {
    panel.classList.remove("collapsed");
    toggleBtn.classList.add("hidden");
    toggleBtn.classList.remove("has-unread");
    document.getElementById("chat-input")?.focus();
  });
  collapseBtn?.addEventListener("click", () => {
    panel.classList.add("collapsed");
    toggleBtn.classList.remove("hidden");
  });
})();

// ---------- 화면 암전 후 프로필을 직접 클릭해서 상대를 지정하는 타겟팅 모드 ----------
// (검정 50% 오버레이로 화면을 어둡게 하고, 지정 가능한 상대 프로필만 오버레이 위로 밝게 노출)
let activeTargeting = null; // { eligibleIds: Set<string>, onPick: fn(playerId) }

function seatClickHandler(e) {
  const seatEl = e.currentTarget;
  const pid = seatEl.dataset.playerId;
  const onPick = activeTargeting?.onPick;
  exitTargetingMode();
  if (onPick) onPick(pid);
}

function exitTargetingMode() {
  activeTargeting = null;
  document.getElementById("targeting-overlay")?.remove();
  document.getElementById("targeting-hint")?.remove();
  applyTargetingToSeats();
}

// renderSeats가 매번 DOM을 새로 그리기 때문에, 렌더 직후마다 이 함수로 현재 활성화된
// 타겟팅 상태를 좌석 DOM에 다시 입혀준다 (그렇지 않으면 타겟팅 도중 상태 갱신이 오면 풀려버림).
function applyTargetingToSeats() {
  const seats = document.querySelectorAll("#seats .seat");
  seats.forEach((seatEl) => {
    seatEl.classList.remove("targetable");
    seatEl.removeEventListener("click", seatClickHandler);
  });
  if (!activeTargeting) return;
  let anyEligible = false;
  seats.forEach((seatEl) => {
    if (activeTargeting.eligibleIds.has(seatEl.dataset.playerId)) {
      seatEl.classList.add("targetable");
      seatEl.addEventListener("click", seatClickHandler);
      anyEligible = true;
    }
  });
  // 타겟팅 도중 대상이 전부 사라지면(폴드/퇴장 등) 자동으로 취소
  if (!anyEligible) exitTargetingMode();
}

// 화면을 50% 검정으로 암전시키고, 지정 가능한 상대 프로필만 오버레이 위로 노출해서
// 클릭으로 상대를 고르게 한다. 후보가 1명뿐이면 오버레이 없이 즉시 선택.
function enterTargetingMode(state, hintText, onPick) {
  const eligible = (state.players || []).filter((p) => !p.folded && p.id !== lastState?.you);
  if (eligible.length === 0) {
    alert("지금 지정할 수 있는 상대가 없어요.");
    return;
  }
  if (eligible.length === 1) {
    onPick(eligible[0].id);
    return;
  }
  activeTargeting = { eligibleIds: new Set(eligible.map((p) => p.id)), onPick };

  const overlay = document.createElement("div");
  overlay.id = "targeting-overlay";
  overlay.className = "targeting-overlay";
  overlay.addEventListener("click", () => exitTargetingMode());
  document.body.appendChild(overlay);

  const hint = document.createElement("div");
  hint.id = "targeting-hint";
  hint.className = "targeting-hint";
  hint.textContent = hintText + " (배경을 누르면 취소)";
  document.body.appendChild(hint);

  applyTargetingToSeats();
}

// 상대 플레이어 1명을 프롬프트로 선택. 후보가 1명뿐이면 자동 선택, 없으면 null.
function pickOpponent(state, promptText) {
  const eligible = (state.players || []).filter((p) => !p.folded && p.id !== lastState?.you);
  if (eligible.length === 0) {
    alert("지금 지정할 수 있는 상대가 없어요.");
    return null;
  }
  if (eligible.length === 1) return eligible[0].id;
  const listText = eligible.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const pick = prompt(`${promptText}\n${listText}`, "1");
  const idx = parseInt(pick, 10) - 1;
  if (!(idx >= 0 && idx < eligible.length)) return null;
  return eligible[idx].id;
}

function useGift(card, state) {
  let targetPlayerId = null;
  let option = null;

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
  } else if (card.effectId === "card_swap_random") {
    targetPlayerId = pickOpponent(state, "누구와 카드를 교환할까요?");
    if (!targetPlayerId) return;
  } else if (card.effectId === "steal_delete_gift") {
    // 화면을 암전시키고 상대 프로필을 직접 클릭해서 지정 -> 서버가 그 사람 보유품 중 하나를 랜덤 파괴
    enterTargetingMode(state, "파괴할 상대를 선택하세요", (pickedId) => {
      socket.emit("gift:use", { giftId: card.id, targetPlayerId: pickedId, option: null }, (res) => {
        if (!res.ok) alert(res.error);
      });
    });
    return;
  } else if (card.effectId === "peek_next_attr") {
    const pick = prompt("무엇을 미리 볼까요? (1=숫자, 2=기호)", "1");
    option = pick === "2" ? "suit" : "rank";
  } else if (card.effectId === "lock_community_color") {
    const pick = prompt("어떤 색깔로 봉인할까요? (1=검정, 2=빨강)", "1");
    if (pick !== "1" && pick !== "2") return;
    option = pick === "2" ? "red" : "black";
  }

  socket.emit("gift:use", { giftId: card.id, targetPlayerId, option }, (res) => {
    if (!res.ok) alert(res.error);
  });
}

function showFanToast(text) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const item = document.createElement("div");
  item.className = "toast-item";
  item.textContent = text;
  stack.appendChild(item);
  setTimeout(() => {
    item.classList.add("toast-fade");
    setTimeout(() => item.remove(), 250);
  }, 2000);
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
    // 상대가 뭘 뽑았는지는 알려주지 않는다(정보 비공개) - 내 것만 모아서 대형 연출로 보여준다
    const myDraws = msg.lastGiftBatch.draws.filter((d) => d.playerId === msg.you);
    if (myDraws.length > 0) queueGiftReveals(myDraws);
  }
  if (msg.lastAnnouncement && msg.lastAnnouncement.at && msg.lastAnnouncement.at > lastAnnouncementAt) {
    lastAnnouncementAt = msg.lastAnnouncement.at;
    const a = msg.lastAnnouncement;
    if (a.type === "bounty") {
      showFanToast(`💰 ${a.hunterName}님이 ${a.targetName}님을 파산시키고 현상금 ${a.amount.toLocaleString()} 획득!`);
    } else if (a.type === "awaken") {
      showFanToast(`🌟 ${a.playerName}님이 [만찢 각성카드]로 부활! (${a.amount.toLocaleString()} 칩)`);
    } else if (a.type === "gift") {
      showFanToast(a.text);
    }
  }
  if (msg.myPeek && msg.myPeek.at && msg.myPeek.at > lastPeekAt) {
    lastPeekAt = msg.myPeek.at;
    const peek = msg.myPeek;
    if (peek.kind === "next_color") {
      showFanToast(`🔴 [선구안] 다음 커뮤니티 카드 색깔: ${peek.value}`);
    } else if (peek.kind === "next_attr") {
      const label = peek.attr === "suit" ? "기호" : "숫자";
      showFanToast(`🩸 [짭륜안] 다음 커뮤니티 카드 ${label}: ${peek.value}`);
    } else if (peek.kind === "next_turn_card") {
      showFanToast(`🕳️ [엿보기 구멍] ${peek.targetName}님의 카드 한 장: ${cardLabel(peek.card)}`);
    } else {
      showFanToast(`🔍 [필살기 스크롤] ${peek.targetName}님의 카드 한 장: ${cardLabel(peek.card)}`);
    }
  }
}

let prevBetThisStreet = {};
let prevHandNumberForChips = null;

// 팔로워 수 -> 프로필 테두리 등급 이미지 파일명. 기준 미만이면 null(테두리 없음).
function followerRingImg(followers) {
  const n = Number(followers) || 0;
  if (n >= 1000000) return "ring_5.png";
  if (n >= 100000) return "ring_4.png";
  if (n >= 50000) return "ring_3.png";
  if (n >= 10000) return "ring_2.png";
  if (n >= 1000) return "ring_1.png";
  return null;
}

function renderSeats(state, you, verifiedMap, followersMap) {
  const seatsEl = document.getElementById("seats");
  seatsEl.innerHTML = "";
  const players = state.players;
  const n = players.length;
  if (n === 0) return;
  const seatVerifiedMap = verifiedMap || {};
  const seatFollowersMap = followersMap || {};

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
    seat.dataset.playerId = p.id;
    if (p.folded) seat.classList.add("folded");
    if (p.id === state.currentPlayerId) seat.classList.add("acting");
    if (p.id === you) seat.classList.add("me");
    seat.style.left = left + "%";
    seat.style.top = top + "%";

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "avatar-wrap";
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = p.avatarUrl || FALLBACK_AVATAR;
    img.onerror = () => (img.src = FALLBACK_AVATAR);
    avatarWrap.appendChild(img);
    const ringImg = followerRingImg(seatFollowersMap[p.id]);
    if (ringImg) {
      const ring = document.createElement("div");
      ring.className = "avatar-follower-ring";
      ring.style.backgroundImage = `url(${ringImg})`;
      avatarWrap.appendChild(ring);
    }

    const dealerIdx = state.dealerSeat;
    if (players.indexOf(p) === dealerIdx) {
      const chip = document.createElement("div");
      chip.className = "dealer-chip";
      chip.textContent = "D";
      avatarWrap.appendChild(chip);
    }
    // 상대 카드는 뒷면(?) 상태일 땐 굳이 보여주지 않고, 쇼다운으로 실제 카드가 공개됐을 때만 표시한다.
    // 좌석 하단(이름/칩/배지 아래)이 아니라 프로필 사진 바로 옆에 붙여서, 좌석이 테이블 중앙(보드) 쪽에
    // 가깝게 배치되더라도 커뮤니티 카드 쪽으로 밀려 겹치지 않게 한다.
    if (p.id !== you && p.holeCards && p.holeCards.length && p.holeCards[0] !== "?") {
      const hc = document.createElement("div");
      hc.className = "avatar-hole-cards";
      p.holeCards.forEach((c) => hc.appendChild(cardEl(c)));
      avatarWrap.appendChild(hc);
    }
    seat.appendChild(avatarWrap);

    const name = document.createElement("div");
    name.className = "name";
    name.innerHTML = escapeHtml(p.name) + verifiedBadge(seatVerifiedMap[p.id]) + (p.id === you ? " (나)" : "");
    seat.appendChild(name);

    seat.appendChild(chipStackEl(p.chips, chipScaleMax));

    // 현재 베팅액은 좌석 우측 상단에 큼직한 배지로 표시 (하단 잔더미 대신)
    if (p.betThisStreet > 0) {
      const betBadge = document.createElement("div");
      betBadge.className = "seat-bet-badge";
      betBadge.textContent = p.betThisStreet.toLocaleString();
      seat.appendChild(betBadge);
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

    // 내 카드는 화면 하단에 크게 별도로 보여주므로 좌석 안에서는 중복 표시하지 않는다.
    seatsEl.appendChild(seat);
  }
  applyTargetingToSeats();
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
