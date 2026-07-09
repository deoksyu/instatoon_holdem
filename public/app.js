const socket = io();

const FALLBACK_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="%23333"/><text x="50%" y="55%" font-size="28" text-anchor="middle" fill="%23999">?</text></svg>'
  );

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

async function previewProfile(igInputId, boxId) {
  clearHomeError();
  const ig = document.getElementById(igInputId).value.trim();
  const box = document.getElementById(boxId);
  if (!ig) { showHomeError("인스타그램 아이디를 입력해주세요."); return null; }
  box.classList.remove("hidden");
  box.innerHTML = "불러오는 중...";
  try {
    const res = await fetch("/api/ig-preview?u=" + encodeURIComponent(ig));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "조회 실패");
    box.innerHTML = "";
    const img = document.createElement("img");
    img.src = data.profile.avatarUrl || FALLBACK_AVATAR;
    img.onerror = () => (img.src = FALLBACK_AVATAR);
    const info = document.createElement("div");
    info.className = "pv-info";
    info.innerHTML =
      `<b>${data.profile.displayName}</b> (@${data.profile.username})<br>` +
      `게시물 ${data.profile.posts} · 팔로워 ${data.profile.followers}<br>` +
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
  previewProfile("create-ig", "preview-create")
);
document.getElementById("btn-preview-join").addEventListener("click", () =>
  previewProfile("join-ig", "preview-join")
);

document.getElementById("btn-create").addEventListener("click", () => {
  clearHomeError();
  const name = document.getElementById("create-name").value.trim();
  const ig = document.getElementById("create-ig").value.trim();
  if (!ig) return showHomeError("인스타그램 아이디를 입력해주세요.");
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
  if (!ig) return showHomeError("인스타그램 아이디를 입력해주세요.");
  socket.emit("room:join", { roomCode, name, instagramUsername: ig }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    enterTableScreen();
  });
});

function enterTableScreen() {
  document.getElementById("screen-home").classList.add("hidden");
  document.getElementById("screen-table").classList.remove("hidden");
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

function render(msg) {
  document.getElementById("room-code-label").textContent = msg.roomCode;
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

  renderSeats(state, msg.you);
  renderResult(state);
  renderControls(msg, state);
}

function renderSeats(state, you) {
  const seatsEl = document.getElementById("seats");
  seatsEl.innerHTML = "";
  const players = state.players;
  const n = players.length;
  if (n === 0) return;

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
    name.textContent = p.name + (p.id === you ? " (나)" : "");
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
