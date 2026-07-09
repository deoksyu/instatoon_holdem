// game/cheerCards.js
// 팬 응원 수에 따라 뽑히는 "기프트". 블랙잭처럼 응원수가 임계점(21)에 정확히 맞으면 최고 등급,
// 넘기면 무조건 꽝. 기프트는 패시브(보유하는 동안 상시 적용)와 액티브(사용 버튼으로 발동, 1회 소모)로 나뉜다.

const THRESHOLD = 21;

// type: "passive" | "active" | "none"(꽝)
// effectId: 서버 로직에서 분기용 키
const CATALOG = {
  SSR: [
    {
      name: "전설의 골든펜",
      emoji: "🖊️",
      color: "#ffd447",
      type: "active",
      effectId: "redraw_hole_cards",
      description: "사용 시 내 홀카드 2장을 전부 새로 교체",
    },
    {
      name: "인스타툰 대상 트로피",
      emoji: "🏆",
      color: "#ffd447",
      type: "active",
      effectId: "double_win_this_hand",
      description: "사용 시 이번 핸드에서 이기면 획득 칩 2배",
    },
    {
      name: "만찢 각성카드",
      emoji: "🌟",
      color: "#ffd447",
      type: "passive",
      effectId: "auto_revive",
      description: "보유 중 파산해도 게시물 수와 상관없이 무조건 1회 부활 (발동 시 자동 소모)",
    },
  ],
  SR: [
    {
      name: "필살기 스크롤",
      emoji: "📜",
      color: "#b06bff",
      type: "active",
      effectId: "peek_allin_card",
      description: "사용 시 올인로 맞붙은 상대의 홀카드 1장을 훔쳐본다",
    },
    {
      name: "팬미팅 초대장",
      emoji: "🎫",
      color: "#b06bff",
      type: "passive",
      effectId: "cheer_boost_5",
      description: "보유 중 기프트 뽑기 판정에 응원수 +5 보정",
    },
    {
      name: "역전의 부적",
      emoji: "🔮",
      color: "#b06bff",
      type: "active",
      effectId: "blind_exempt_next",
      description: "사용 시 다음에 낼 블라인드 1회 면제",
    },
  ],
  R: [
    {
      name: "화이팅 부적",
      emoji: "🍀",
      color: "#4d9dff",
      type: "passive",
      effectId: "cheer_boost_2",
      description: "보유 중 기프트 뽑기 판정에 응원수 +2 보정",
    },
    {
      name: "소소한 응원",
      emoji: "✨",
      color: "#4d9dff",
      type: "active",
      effectId: "blind_refund",
      description: "사용 시 현재 블라인드 금액만큼 칩을 즉시 획득",
    },
    {
      name: "달콤한 간식",
      emoji: "🍬",
      color: "#4d9dff",
      type: "passive",
      effectId: "bounty_bonus_10pct",
      description: "보유 중 바운티 획득액 +10% (중첩 가능)",
    },
  ],
  "꽝": [
    { name: "꽝... 다음 기회에", emoji: "💨", color: "#7a7f8c", type: "none", effectId: null, description: "" },
  ],
};

// 응원 수(count)에 따른 등급 뽑기.
function rollRarity(cheerCount) {
  const count = Math.max(0, Math.floor(cheerCount));
  if (count === 0) return weightedPick({ "꽝": 20, R: 60, SR: 19, SSR: 1 }); // 응원 0이어도 아주 낮은 확률로 SSR까지 노려볼 수 있게
  if (count === THRESHOLD) return "SSR";
  if (count > THRESHOLD) return "꽝";

  const bands = [
    { max: 4, weights: { R: 30, SR: 0, "꽝": 70 } },
    { max: 9, weights: { R: 50, SR: 10, "꽝": 40 } },
    { max: 14, weights: { R: 40, SR: 40, "꽝": 20 } },
    { max: 20, weights: { R: 20, SR: 75, "꽝": 5 } },
  ];
  const band = bands.find((b) => count <= b.max) || bands[bands.length - 1];
  return weightedPick(band.weights);
}

function weightedPick(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [key, w] of Object.entries(weights)) {
    if (r < w) return key;
    r -= w;
  }
  return Object.keys(weights)[0];
}

function drawCard(cheerCount) {
  const rarity = rollRarity(cheerCount);
  const pool = CATALOG[rarity];
  const base = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rarity,
    name: base.name,
    emoji: base.emoji,
    color: base.color,
    type: base.type,
    effectId: base.effectId,
    description: base.description,
    used: false,
  };
}

module.exports = { THRESHOLD, rollRarity, drawCard, CATALOG, weightedPick };
