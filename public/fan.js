const socket = io({ transports: ["websocket"] });
const SHOW_CHEER_UI = false; // 응원 기능 UI - 개편 전까지 임시로 숨김

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

// 실제 트럼프 카드처럼: 코너 인덱스 + 숫자카드는 정통 핍(pip) 배열, A/J/Q/K는 큰 글자+수트
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

function cardEl(card) {
  const div = document.createElement("div");
  if (!card || card === "?") {
    div.className = "card-chip back";
    return div;
  }
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const label = rankLabel(rank);
  const suitSym = SUIT[suit];
  div.className = "card-chip playing-card " + (isRed(suit) ? "red" : "black");

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

const FALLBACK_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="%23333"/><text x="50%" y="55%" font-size="28" text-anchor="middle" fill="%23999">?</text></svg>'
  );

let lastGiftBatchAt = 0;
let lastAnnouncementAt = 0;
let lastRenderedChatKey = null;

function showFanError(msg) {
  const el = document.getElementById("fan-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

const params = new URLSearchParams(location.search);
if (params.get("room")) {
  document.getElementById("fan-code").value = params.get("room").toUpperCase();
}

// 재연결(네트워크 끊김 후 자동 재접속) 시 소켓ID가 바뀌면 서버의 관전자 목록에서 빠지므로
// 응원 버튼이 조용히 먹통이 된다. 재연결되면 같은 방으로 다시 자동 참가한다.
let fanJoinInfo = null; // { roomCode, name }
let hasConnectedOnce = false;

socket.on("connect", () => {
  if (hasConnectedOnce && fanJoinInfo) {
    socket.emit("fan:join", fanJoinInfo, () => {});
  }
  hasConnectedOnce = true;
});

document.getElementById("btn-fan-join").addEventListener("click", () => {
  const roomCode = document.getElementById("fan-code").value.trim().toUpperCase();
  const name = document.getElementById("fan-name").value.trim();
  if (!roomCode) return showFanError("방 코드를 입력해주세요.");
  const payload = { roomCode, name };
  socket.emit("fan:join", payload, (res) => {
    if (!res.ok) return showFanError(res.error);
    fanJoinInfo = payload;
    document.getElementById("screen-fan-home").classList.add("hidden");
    document.getElementById("screen-fan-watch").classList.remove("hidden");
  });
});

function cheer(targetPlayerId) {
  socket.emit("fan:cheer", { targetPlayerId });
}

socket.on("room:state", (msg) => render(msg));

function showToast(text) {
  const toast = document.getElementById("fan-toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 3500);
}

function render(msg) {
  document.getElementById("fan-room-code-label").textContent = msg.roomCode;
  const { state } = msg;

  document.getElementById("fan-board-info").textContent =
    `Pot: ${state.pot.toLocaleString()} · ${state.street === "waiting" ? "게임 대기 중" : state.street === "showdown" ? "쇼다운" : "진행 중"} · 관전 ${msg.fanCount}명`;

  const commEl = document.getElementById("fan-community-cards");
  commEl.innerHTML = "";
  const shownCards = state.communityCards || [];
  for (let i = 0; i < 5; i++) {
    if (i < shownCards.length) commEl.appendChild(cardEl(shownCards[i]));
    else {
      const d = document.createElement("div");
      d.className = "card-chip empty";
      commEl.appendChild(d);
    }
  }

  const listEl = document.getElementById("fan-player-list");
  listEl.innerHTML = "";
  for (const p of state.players) {
    const card = document.createElement("div");
    card.className = "fan-player-card";
    if (p.id === state.currentPlayerId) card.classList.add("acting");
    if (p.folded && state.street !== "waiting") card.classList.add("folded");

    const img = document.createElement("img");
    img.src = p.avatarUrl || FALLBACK_AVATAR;
    img.onerror = () => (img.src = FALLBACK_AVATAR);
    card.appendChild(img);

    const name = document.createElement("div");
    name.className = "fp-name";
    name.innerHTML = escapeHtml(p.name) + verifiedBadge(msg.verified && msg.verified[p.id]);
    card.appendChild(name);

    const chips = document.createElement("div");
    chips.className = "fp-chips";
    chips.textContent = "칩 " + p.chips.toLocaleString();
    card.appendChild(chips);

    const bounty = document.createElement("div");
    bounty.className = "fp-bounty";
    const bountyAmt = (msg.bounties && msg.bounties[p.id]) || 0;
    const earned = (msg.bountyEarnings && msg.bountyEarnings[p.id]) || 0;
    bounty.textContent = `현상금 ${bountyAmt.toLocaleString()}` + (earned > 0 ? ` · 사냥 ${earned.toLocaleString()}` : "");
    card.appendChild(bounty);

    // 응원 기능은 UI 개편 전까지 잠시 숨김 (SHOW_CHEER_UI를 true로 바꾸면 원상복구)
    if (SHOW_CHEER_UI) {
      const cheerCount = (msg.cheerCounts && msg.cheerCounts[p.id]) || 0;
      const threshold = msg.cheerThreshold || 21;
      const pct = Math.min(100, Math.round((cheerCount / threshold) * 100));

      const bar = document.createElement("div");
      bar.className = "fp-cheer-bar";
      const fill = document.createElement("div");
      fill.className = "fp-cheer-fill";
      fill.style.width = pct + "%";
      if (cheerCount > threshold) fill.style.background = "#ff5c5c";
      bar.appendChild(fill);
      card.appendChild(bar);

      const countLabel = document.createElement("div");
      countLabel.className = "fp-cheer-count";
      countLabel.textContent = `응원 ${cheerCount} / ${threshold}` + (cheerCount > threshold ? " (버스트!)" : "");
      card.appendChild(countLabel);

      const btn = document.createElement("button");
      btn.className = "btn-cheer";
      btn.textContent = "📣 응원하기";
      btn.disabled = p.sittingOut || (p.folded && state.street !== "waiting" && state.street !== "showdown");
      btn.addEventListener("click", () => cheer(p.id));
      card.appendChild(btn);
    }

    listEl.appendChild(card);
  }

  if (msg.lastGiftBatch && msg.lastGiftBatch.at && msg.lastGiftBatch.at > lastGiftBatchAt) {
    lastGiftBatchAt = msg.lastGiftBatch.at;
    for (const d of msg.lastGiftBatch.draws) {
      if (d.card.rarity !== "꽝") {
        showToast(`${d.card.emoji} ${d.playerName}님이 [${d.streetLabel}] 응원 ${d.cheerCountAtDraw}회 받고 [${d.card.rarity}] ${d.card.name} 기프트 획득!`);
      }
    }
  }
  if (msg.lastAnnouncement && msg.lastAnnouncement.at && msg.lastAnnouncement.at > lastAnnouncementAt) {
    lastAnnouncementAt = msg.lastAnnouncement.at;
    const a = msg.lastAnnouncement;
    if (a.type === "bounty") {
      showToast(`💰 ${a.hunterName}님이 ${a.targetName}님을 파산시키고 현상금 ${a.amount.toLocaleString()} 획득!`);
    } else if (a.type === "awaken") {
      showToast(`🌟 ${a.playerName}님이 [만찢 각성카드]로 부활! (${a.amount.toLocaleString()} 칩)`);
    } else if (a.type === "gift") {
      showToast(a.text);
    }
  }

  renderChat(msg);
}

// 방 채팅(플레이어+팬 공용) 렌더링. 새 메시지가 없으면 다시 그리지 않아 스크롤 위치가 유지된다.
function renderChat(msg) {
  const box = document.getElementById("chat-messages");
  if (!box) return;
  const messages = msg.chatMessages || [];
  const key = messages.length + ":" + (messages.length ? messages[messages.length - 1].id : "");
  if (key === lastRenderedChatKey) return;
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
    document.getElementById("chat-input")?.focus();
  });
  collapseBtn?.addEventListener("click", () => {
    panel.classList.add("collapsed");
    toggleBtn.classList.remove("hidden");
  });
})();
