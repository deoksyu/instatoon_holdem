const socket = io({ transports: ["websocket"] });

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

const FALLBACK_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="%23333"/><text x="50%" y="55%" font-size="28" text-anchor="middle" fill="%23999">?</text></svg>'
  );

let lastCardDrawAt = 0;
let lastAnnouncementAt = 0;

function showFanError(msg) {
  const el = document.getElementById("fan-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

const params = new URLSearchParams(location.search);
if (params.get("room")) {
  document.getElementById("fan-code").value = params.get("room").toUpperCase();
}

document.getElementById("btn-fan-join").addEventListener("click", () => {
  const roomCode = document.getElementById("fan-code").value.trim().toUpperCase();
  const name = document.getElementById("fan-name").value.trim();
  if (!roomCode) return showFanError("방 코드를 입력해주세요.");
  socket.emit("fan:join", { roomCode, name }, (res) => {
    if (!res.ok) return showFanError(res.error);
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

    listEl.appendChild(card);
  }

  if (msg.lastCardDraw && msg.lastCardDraw.at && msg.lastCardDraw.at > lastCardDrawAt) {
    lastCardDrawAt = msg.lastCardDraw.at;
    const d = msg.lastCardDraw;
    if (d.card.rarity !== "꽝") {
      showToast(`${d.card.emoji} ${d.playerName}님이 응원 ${d.cheerCountAtDraw}회 받고 [${d.card.rarity}] ${d.card.name} 카드 획득!`);
    }
  }
  if (msg.lastAnnouncement && msg.lastAnnouncement.at && msg.lastAnnouncement.at > lastAnnouncementAt) {
    lastAnnouncementAt = msg.lastAnnouncement.at;
    const a = msg.lastAnnouncement;
    if (a.type === "bounty") {
      showToast(`💰 ${a.hunterName}님이 ${a.targetName}님을 파산시키고 현상금 ${a.amount.toLocaleString()} 획득!`);
    } else if (a.type === "rebuy") {
      showToast(`♻️ ${a.playerName}님이 무료 리바인으로 부활! (${a.amount.toLocaleString()} 칩)`);
    }
  }
}
