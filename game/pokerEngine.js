// game/pokerEngine.js
// 심플 No-Limit Texas Hold'em 엔진 (2~9인, 사이드팟 지원)
const { Hand } = require("pokersolver");

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["c", "d", "h", "s"];

function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function computeSidePots(players) {
  const contributors = players.filter((p) => p.totalBetInHand > 0);
  const levels = [...new Set(contributors.map((p) => p.totalBetInHand))].sort((a, b) => a - b);
  const pots = [];
  let prevLevel = 0;
  for (const level of levels) {
    const diff = level - prevLevel;
    const eligibleContributors = contributors.filter((p) => p.totalBetInHand >= level);
    const potAmount = diff * eligibleContributors.length;
    if (potAmount > 0) {
      const eligibleWinnerIds = eligibleContributors.filter((p) => !p.folded).map((p) => p.id);
      pots.push({ amount: potAmount, eligiblePlayerIds: eligibleWinnerIds });
    }
    prevLevel = level;
  }
  return pots;
}

// 족보 판정에 쓰인 5장 중 실제로 패턴(페어/트리플/스트레이트/플러시 등)을 이루는 카드만 골라낸다.
// 예: 원페어면 5장 중 짝을 이루는 2장만, 킥커 3장은 제외.
function pickHandDefiningCards(solved) {
  const cards = solved.cards; // pokersolver가 고른 최선의 5장 (킥커 포함)
  const name = solved.name;
  const toStr = (c) => `${c.value}${c.suit}`;
  if (name === "High Card") {
    return [toStr(cards[0])];
  }
  if (name === "Straight" || name === "Flush" || name === "Straight Flush" || name === "Royal Flush") {
    return cards.map(toStr);
  }
  // Pair / Two Pair / Three of a Kind / Full House / Four of a Kind:
  // 랭크별로 묶어서 2장 이상 모인 그룹만 하이라이트 (킥커는 그룹 크기 1이라 자동 제외됨)
  const groups = new Map();
  for (const c of cards) {
    if (!groups.has(c.value)) groups.set(c.value, []);
    groups.get(c.value).push(c);
  }
  const picked = [];
  for (const group of groups.values()) {
    if (group.length >= 2) picked.push(...group);
  }
  return picked.map(toStr);
}

// 프리플랍 등, 카드가 5장 미만이라 pokersolver로 평가할 수 없을 때 쓰는 간단 판정.
// 홀카드가 페어면 "Pair", 아니면 둘 중 높은 카드 1장을 "High Card"로 알려준다.
const RANK_WORDS = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };
function rankWord(r) {
  return RANK_WORDS[r] || r;
}
function simplePreflopHandInfo(cards) {
  const rankOf = (c) => c.slice(0, -1);
  const rankIndex = (r) => RANKS.indexOf(r);
  if (cards.length === 2 && rankOf(cards[0]) === rankOf(cards[1])) {
    const r = rankOf(cards[0]);
    return {
      name: "Pair",
      descr: `Pair, ${rankWord(r)}'s`,
      cards: [...cards],
    };
  }
  let best = cards[0];
  for (const c of cards) {
    if (rankIndex(rankOf(c)) > rankIndex(rankOf(best))) best = c;
  }
  return {
    name: "High Card",
    descr: `${rankWord(rankOf(best))} High`,
    cards: [best],
  };
}

class Table {
  constructor({ smallBlind = 10, bigBlind = 20 } = {}) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.players = []; // {id, name, avatarUrl, chips, ...runtime fields}
    this.dealerSeat = -1; // index into this.players
    this.deck = [];
    this.communityCards = [];
    this.communityColorLock = null; // "red" | "black" | null - 선구안 위 효과용
    this.street = "waiting"; // waiting|preflop|flop|turn|river|showdown
    this.currentSeat = -1;
    this.currentStreetBet = 0;
    this.minRaise = bigBlind;
    this.handNumber = 0;
    this.lastResult = null;
    this.log = [];
  }

  addPlayer({ id, name, avatarUrl, chips }) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({
      id,
      name,
      avatarUrl,
      chips,
      holeCards: [],
      folded: true,
      allIn: false,
      betThisStreet: 0,
      totalBetInHand: 0,
      hasActed: false,
      sittingOut: false,
    });
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
  }

  activePlayersInHand() {
    return this.players.filter((p) => !p.folded);
  }

  seatOrderFrom(startIdx) {
    const n = this.players.length;
    const order = [];
    for (let i = 0; i < n; i++) order.push((startIdx + i) % n);
    return order;
  }

  // 엿보기 구멍: 특정 플레이어 기준으로 "다음 차례"(폴드하지 않은 다음 좌석)의 플레이어를 찾는다.
  getNextActivePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1 || this.players.length < 2) return null;
    const order = this.seatOrderFrom(idx + 1).filter((i) => i !== idx && !this.players[i].folded);
    if (order.length === 0) return null;
    return this.players[order[0]];
  }

  canStartHand() {
    return this.players.filter((p) => p.chips > 0 && !p.sittingOut).length >= 2;
  }

  startHand() {
    if (!this.canStartHand()) throw new Error("게임을 시작하려면 칩을 가진 플레이어가 2명 이상 필요합니다.");
    this.handNumber += 1;
    this.communityCards = [];
    this.deck = freshDeck();
    this.communityColorLock = null;
    this.street = "preflop";
    this.lastResult = null;
    this.log = [];

    const eligible = this.players.filter((p) => p.chips > 0 && !p.sittingOut);

    for (const p of this.players) {
      const inHand = eligible.includes(p);
      p.holeCards = [];
      p.folded = !inHand;
      p.allIn = false;
      p.betThisStreet = 0;
      p.totalBetInHand = 0;
      p.hasActed = false;
    }

    // move dealer button to next eligible seat
    const n = this.players.length;
    do {
      this.dealerSeat = (this.dealerSeat + 1) % n;
    } while (this.players[this.dealerSeat].folded);

    const order = this.seatOrderFrom(this.dealerSeat).filter((idx) => !this.players[idx].folded);

    // deal hole cards
    for (const idx of order) {
      this.players[idx].holeCards = [this.deck.pop(), this.deck.pop()];
    }

    // post blinds. Heads-up: dealer posts SB, other posts BB.
    let sbIdx, bbIdx;
    if (order.length === 2) {
      sbIdx = order[0];
      bbIdx = order[1];
    } else {
      sbIdx = order[1];
      bbIdx = order[2];
    }
    this._postBlind(sbIdx, this.smallBlind);
    this._postBlind(bbIdx, this.bigBlind);

    this.currentStreetBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // first to act preflop: next seat after BB (or after dealer in heads-up it's SB/dealer already acted structurally -> UTG)
    const bbPosInOrder = order.indexOf(bbIdx);
    const actingOrder = order.length === 2 ? order : order;
    const firstActorIdx =
      order.length === 2 ? sbIdx : order[(bbPosInOrder + 1) % order.length];
    this.currentSeat = firstActorIdx;

    this._advanceIfCurrentCantAct();
    this._maybeAutoResolve();
  }

  _postBlind(idx, amount) {
    const p = this.players[idx];
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.betThisStreet += pay;
    p.totalBetInHand += pay;
    if (p.chips === 0) p.allIn = true;
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  // 본인에게만 실시간으로 알려줄 현재 최고 족보.
  // 프리플랍(커뮤니티 카드 0장, 홀카드 2장뿐)에서도 페어/하이카드 정도는 바로 알려준다.
  // 폴드했거나 아직 홀카드가 없으면 null.
  getPlayerHandInfo(playerId) {
    const p = this.getPlayer(playerId);
    if (!p || p.folded || !p.holeCards || p.holeCards.length === 0) return null;
    if (p.holeCards.includes("?")) return null;
    const allCards = [...p.holeCards, ...this.communityCards];
    // pokersolver는 5장 미만은 평가 못하므로, 프리플랍 등은 간단 판정(페어/하이카드)으로 대체
    if (allCards.length < 5) return simplePreflopHandInfo(allCards);
    const solved = Hand.solve([...allCards]);
    return {
      name: solved.name,
      descr: solved.descr,
      // 킥커(패 등수와 무관한 나머지 카드)는 제외하고, 실제로 족보를 이루는 카드만 반환한다.
      cards: pickHandDefiningCards(solved),
    };
  }

  // 골든펜 기프트용: 아직 패가 살아있는 플레이어의 홀카드 2장을 전부 새로 교체
  redrawHoleCards(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) throw new Error("플레이어를 찾을 수 없습니다.");
    if (p.folded) throw new Error("이미 폴드한 상태에서는 사용할 수 없습니다.");
    if (this.street === "waiting" || this.street === "showdown") {
      throw new Error("지금은 사용할 수 없습니다.");
    }
    if (this.deck.length < 2) throw new Error("덱에 카드가 부족합니다.");
    p.holeCards = [this.deck.pop(), this.deck.pop()];
    return p.holeCards;
  }

  // 색깔 잠금(선구안 위)을 존중해서 덱에서 커뮤니티 카드 한 장을 뽑는다.
  // 잠금이 없으면 그냥 pop(). 잠금이 있으면 끝에서부터 탐색해 해당 색깔의 첫 카드를 splice.
  _popCommunityCard() {
    if (!this.communityColorLock) return this.deck.pop();
    const wantRed = this.communityColorLock === "red";
    for (let i = this.deck.length - 1; i >= 0; i--) {
      const suit = this.deck[i][1];
      const isRed = suit === "h" || suit === "d";
      if (isRed === wantRed) {
        return this.deck.splice(i, 1)[0];
      }
    }
    // 이론상 거의 발생하지 않지만, 해당 색깔 카드가 덱에 하나도 안 남았으면 그냥 pop
    return this.deck.pop();
  }

  // 다음에 커뮤니티로 공개될 카드 1장을 미리 계산 (덱은 건드리지 않음).
  // burn 카드 다음으로 나갈 카드가 "다음 커뮤니티 카드"다 (플랍이라도 그중 첫 장 기준).
  peekNextCommunityCard() {
    if (this.deck.length < 2) return null;
    const afterBurn = this.deck.slice(0, -1);
    if (afterBurn.length === 0) return null;
    if (!this.communityColorLock) return afterBurn[afterBurn.length - 1];
    const wantRed = this.communityColorLock === "red";
    for (let i = afterBurn.length - 1; i >= 0; i--) {
      const suit = afterBurn[i][1];
      const isRed = suit === "h" || suit === "d";
      if (isRed === wantRed) return afterBurn[i];
    }
    return afterBurn[afterBurn.length - 1];
  }

  // 무릎을 꿇는 것은: 다음 판 홀카드를 무조건 원페어로 강제 (숫자/기호는 랜덤).
  // 덱에서 같은 숫자 카드가 2장 이상 남아있는 랭크를 찾아 교체하고, 원래 갖고 있던 카드는 덱으로 되돌린다.
  forcePocketPair(playerId) {
    const p = this.getPlayer(playerId);
    if (!p || p.folded || !p.holeCards || p.holeCards.length !== 2) return false;
    const shuffledRanks = [...RANKS].sort(() => Math.random() - 0.5);
    for (const rank of shuffledRanks) {
      const matches = [];
      for (let i = 0; i < this.deck.length; i++) {
        if (this.deck[i][0] === rank) matches.push(i);
      }
      if (matches.length >= 2) {
        matches.sort((a, b) => b - a);
        const c1 = this.deck.splice(matches[0], 1)[0];
        const c2 = this.deck.splice(matches[1], 1)[0];
        const old = p.holeCards;
        p.holeCards = [c1, c2];
        this.deck.push(...old);
        return true;
      }
    }
    return false;
  }

  // 훌륭한 대화수단: 두 플레이어의 핸드 카드 중 각자 무작위 1장씩을 서로 교환.
  swapRandomHoleCard(playerId, targetId) {
    const p = this.getPlayer(playerId);
    const t = this.getPlayer(targetId);
    if (!p || !t) throw new Error("플레이어를 찾을 수 없습니다.");
    if (p.folded || t.folded) throw new Error("폴드한 플레이어와는 카드를 교환할 수 없습니다.");
    if (!p.holeCards.length || !t.holeCards.length) throw new Error("교환할 카드가 없습니다.");
    const pi = Math.floor(Math.random() * p.holeCards.length);
    const ti = Math.floor(Math.random() * t.holeCards.length);
    const tmp = p.holeCards[pi];
    p.holeCards[pi] = t.holeCards[ti];
    t.holeCards[ti] = tmp;
  }

  // 신라천정: 현재 깔린 커뮤니티 카드를 전부 덱으로 되돌리고 같은 장수만큼 새로 뽑는다.
  redrawCommunity() {
    if (this.communityCards.length === 0) throw new Error("아직 커뮤니티 카드가 없습니다.");
    const count = this.communityCards.length;
    this.deck.push(...this.communityCards);
    this.communityCards = [];
    for (let i = 0; i < count; i++) {
      this.communityCards.push(this._popCommunityCard());
    }
  }

  currentPlayer() {
    if (this.currentSeat < 0) return null;
    return this.players[this.currentSeat];
  }

  legalActions(playerId) {
    const p = this.getPlayer(playerId);
    if (!p || p.folded || p.allIn) return [];
    if (this.currentPlayer()?.id !== playerId) return [];
    const toCall = this.currentStreetBet - p.betThisStreet;
    const actions = ["fold"];
    if (toCall <= 0) actions.push("check");
    else actions.push("call");
    if (p.chips > toCall) actions.push("raise"); // covers bet & raise & allin-by-amount
    actions.push("allin");
    return actions;
  }

  handleAction(playerId, type, amount = 0) {
    const p = this.getPlayer(playerId);
    if (!p) throw new Error("플레이어를 찾을 수 없습니다.");
    if (this.currentPlayer()?.id !== playerId) throw new Error("당신 차례가 아닙니다.");
    if (p.folded || p.allIn) throw new Error("이미 행동할 수 없는 상태입니다.");

    const toCall = this.currentStreetBet - p.betThisStreet;

    switch (type) {
      case "fold": {
        p.folded = true;
        break;
      }
      case "check": {
        if (toCall > 0) throw new Error("체크할 수 없습니다. 콜 또는 폴드하세요.");
        break;
      }
      case "call": {
        const pay = Math.min(toCall, p.chips);
        p.chips -= pay;
        p.betThisStreet += pay;
        p.totalBetInHand += pay;
        if (p.chips === 0) p.allIn = true;
        break;
      }
      case "raise": {
        // amount = 이번 스트리트에 도달하고자 하는 총 베팅액(to-amount)
        const target = Math.floor(amount);
        const raiseIncrement = target - this.currentStreetBet;
        if (target <= this.currentStreetBet) throw new Error("레이즈 금액이 현재 베팅보다 커야 합니다.");
        if (raiseIncrement < this.minRaise && target < p.chips + p.betThisStreet) {
          throw new Error(`최소 레이즈 금액은 ${this.minRaise}입니다.`);
        }
        const pay = target - p.betThisStreet;
        if (pay > p.chips) throw new Error("보유 칩보다 많이 베팅할 수 없습니다.");
        p.chips -= pay;
        p.betThisStreet += pay;
        p.totalBetInHand += pay;
        if (p.chips === 0) p.allIn = true;
        this.minRaise = Math.max(this.minRaise, raiseIncrement);
        this.currentStreetBet = p.betThisStreet;
        this._resetActedExcept(p.id);
        break;
      }
      case "allin": {
        const pay = p.chips;
        p.chips = 0;
        p.betThisStreet += pay;
        p.totalBetInHand += pay;
        p.allIn = true;
        if (p.betThisStreet > this.currentStreetBet) {
          const raiseIncrement = p.betThisStreet - this.currentStreetBet;
          if (raiseIncrement > this.minRaise) this.minRaise = raiseIncrement;
          this.currentStreetBet = p.betThisStreet;
          this._resetActedExcept(p.id);
        }
        break;
      }
      default:
        throw new Error("알 수 없는 액션입니다.");
    }

    p.hasActed = true;
    this._afterAction();
  }

  _resetActedExcept(exceptId) {
    for (const pl of this.players) {
      if (pl.id !== exceptId && !pl.folded && !pl.allIn) pl.hasActed = false;
    }
  }

  _afterAction() {
    const remaining = this.activePlayersInHand();
    if (remaining.length === 1) {
      this._awardPotToSingleWinner(remaining[0]);
      return;
    }

    if (this._isBettingRoundComplete()) {
      this._maybeAutoResolve();
    } else {
      this._moveToNextActor();
    }
  }

  _isBettingRoundComplete() {
    const contenders = this.players.filter((p) => !p.folded && !p.allIn);
    if (contenders.length === 0) return true;
    return contenders.every((p) => p.hasActed && p.betThisStreet === this.currentStreetBet);
  }

  _moveToNextActor() {
    const n = this.players.length;
    let idx = this.currentSeat;
    for (let i = 1; i <= n; i++) {
      const next = (idx + i) % n;
      const p = this.players[next];
      if (!p.folded && !p.allIn) {
        this.currentSeat = next;
        return;
      }
    }
    // nobody left who can act
    this._maybeAutoResolve();
  }

  _advanceIfCurrentCantAct() {
    const p = this.players[this.currentSeat];
    if (!p || p.folded || p.allIn) this._moveToNextActor();
  }

  _maybeAutoResolve() {
    const contenders = this.players.filter((p) => !p.folded && !p.allIn);
    if (contenders.length > 1 && !this._isBettingRoundComplete()) return;

    // betting round is done (either everyone matched, or <=1 can still act)
    if (this.street === "river" || contenders.length <= 1) {
      this._dealRemainingBoardIfNeeded();
      this._showdown();
      return;
    }
    this._nextStreet();
  }

  _dealRemainingBoardIfNeeded() {
    if (this.communityCards.length === 0) {
      this.deck.pop(); // burn
      this.communityCards.push(this._popCommunityCard(), this._popCommunityCard(), this._popCommunityCard());
    }
    while (this.communityCards.length < 5) {
      this.deck.pop(); // burn
      this.communityCards.push(this._popCommunityCard());
    }
    this.street = "river";
  }

  _nextStreet() {
    for (const p of this.players) {
      p.betThisStreet = 0;
      p.hasActed = false;
    }
    this.currentStreetBet = 0;
    this.minRaise = this.bigBlind;

    this.deck.pop(); // burn card
    if (this.street === "preflop") {
      this.communityCards.push(this._popCommunityCard(), this._popCommunityCard(), this._popCommunityCard());
      this.street = "flop";
    } else if (this.street === "flop") {
      this.communityCards.push(this._popCommunityCard());
      this.street = "turn";
    } else if (this.street === "turn") {
      this.communityCards.push(this._popCommunityCard());
      this.street = "river";
    }

    const contenders = this.players.filter((p) => !p.folded && !p.allIn);
    if (contenders.length < 2) {
      this._maybeAutoResolve();
      return;
    }

    const order = this.seatOrderFrom(this.dealerSeat + 1).filter(
      (idx) => !this.players[idx].folded && !this.players[idx].allIn
    );
    this.currentSeat = order[0];
  }

  _awardPotToSingleWinner(winner) {
    const totalPot = this.players.reduce((sum, p) => sum + p.totalBetInHand, 0);
    winner.chips += totalPot;
    this.street = "showdown";
    this.currentSeat = -1;
    this.lastResult = {
      type: "fold-win",
      winners: [{ id: winner.id, name: winner.name, amount: totalPot }],
      board: this.communityCards.slice(),
    };
  }

  _showdown() {
    this.street = "showdown";
    this.currentSeat = -1;
    const contenders = this.activePlayersInHand();

    const solved = {};
    for (const p of contenders) {
      solved[p.id] = Hand.solve([...p.holeCards, ...this.communityCards]);
    }

    const pots = computeSidePots(this.players);
    const payouts = {}; // playerId -> amount won

    for (const pot of pots) {
      if (pot.eligiblePlayerIds.length === 0) continue;
      const hands = pot.eligiblePlayerIds.map((id) => solved[id]);
      const winningHands = Hand.winners(hands);
      const winnerIds = pot.eligiblePlayerIds.filter((id) =>
        winningHands.includes(solved[id])
      );
      const share = Math.floor(pot.amount / winnerIds.length);
      let remainder = pot.amount - share * winnerIds.length;
      for (const id of winnerIds) {
        payouts[id] = (payouts[id] || 0) + share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
      }
    }

    for (const [id, amount] of Object.entries(payouts)) {
      this.getPlayer(id).chips += amount;
    }

    this.lastResult = {
      type: "showdown",
      board: this.communityCards.slice(),
      hands: contenders.map((p) => ({
        id: p.id,
        name: p.name,
        holeCards: p.holeCards,
        handName: solved[p.id].descr,
      })),
      winners: Object.entries(payouts).map(([id, amount]) => ({
        id,
        name: this.getPlayer(id).name,
        amount,
      })),
    };
  }

  // hideShowdownHand: 쇼다운에서도 "본인 패를 상대에게 비공개"로 설정한 playerId의 Set.
  // 본인(forPlayerId)에게는 항상 실제 카드를 보여주고, 그 외 시청자(다른 플레이어/팬)에게만 가린다.
  publicState(forPlayerId, hideShowdownHand) {
    const hidden = hideShowdownHand || new Set();
    let lastResult = this.lastResult;
    if (lastResult && lastResult.type === "showdown" && hidden.size) {
      lastResult = {
        ...lastResult,
        hands: lastResult.hands.map((h) =>
          h.id !== forPlayerId && hidden.has(h.id)
            ? { ...h, holeCards: h.holeCards.map(() => "?"), handName: "비공개" }
            : h
        ),
      };
    }
    return {
      handNumber: this.handNumber,
      street: this.street,
      communityCards: this.communityCards,
      currentSeat: this.currentSeat,
      currentPlayerId: this.currentPlayer()?.id || null,
      dealerSeat: this.dealerSeat,
      currentStreetBet: this.currentStreetBet,
      minRaise: this.minRaise,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      pot: this.players.reduce((s, p) => s + p.totalBetInHand, 0),
      lastResult,
      players: this.players.map((p) => {
        const revealed =
          p.id === forPlayerId ||
          (this.street === "showdown" && !hidden.has(p.id));
        return {
          id: p.id,
          name: p.name,
          avatarUrl: p.avatarUrl,
          chips: p.chips,
          folded: p.folded,
          allIn: p.allIn,
          betThisStreet: p.betThisStreet,
          totalBetInHand: p.totalBetInHand,
          sittingOut: p.sittingOut,
          holeCards: revealed ? p.holeCards : p.holeCards.map(() => "?"),
        };
      }),
    };
  }
}

module.exports = { Table, computeSidePots, freshDeck };
