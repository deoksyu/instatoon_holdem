// game/cheerCards.js
// 팬 응원 수에 따라 뽑히는 "기프트". 블랙잭처럼 응원수가 임계점(21)에 정확히 맞으면 최고 등급,
// 넘기면 무조건 꽝. 기프트는 패시브(보유하는 동안 상시 적용)와 액티브(사용 버튼으로 발동, 1회 소모)로 나뉜다.
// 액티브 기프트는 전부 1회용이며, 본인 턴(행동 차례)에만 사용할 수 있다 (server.js에서 검증).

const THRESHOLD = 21;

// type: "passive" | "active" | "none"(꽝)
// effectId: 서버 로직에서 분기용 키
// unique: true면 게임 전체에서 미사용 상태로 동시에 1명만 보유 가능 (다른 사람은 뽑을 수 없음)
const CATALOG = {
  SSR: [
    {
      name: "훌륭한 대화수단",
      emoji: "🤝",
      color: "#ffd447",
      type: "active",
      effectId: "card_swap_random",
      description: "사용 시 상대 1명을 지정해서 그 사람과 핸드 카드 1장을 무작위로 교환",
    },
    {
      name: "신라천정",
      emoji: "⛩️",
      color: "#ffd447",
      type: "active",
      effectId: "redraw_community",
      description: "사용 시 커뮤니티 카드 전체를 다시 뽑는다 (베팅 상태는 그대로 유지)",
    },
  ],
  SR: [
    {
      name: "선구안 위",
      emoji: "🀄",
      color: "#b06bff",
      type: "active",
      effectId: "lock_community_color",
      description:
        "사용 시 검정/빨강 중 하나를 고르면, 이번 판 남은 커뮤니티 카드는 그 색깔로만 나온다",
    },
    {
      name: "우리팀딜러뭐함?",
      emoji: "🎩",
      color: "#b06bff",
      type: "passive",
      effectId: "claim_dealer",
      unique: true,
      description: "보유 중 다음 판 딜러를 내가 맡는다 (동시에 1명만 보유 가능)",
    },
    {
      name: "짭륜안",
      emoji: "🩸",
      color: "#b06bff",
      type: "active",
      effectId: "peek_next_attr",
      description: "사용 시 다음 커뮤니티 카드 1장의 숫자 또는 기호 중 하나를 선택해 미리 본다",
    },
    {
      name: "무릎을 꿇는 것은",
      emoji: "🙇",
      color: "#b06bff",
      type: "passive",
      effectId: "force_pocket_pair",
      description: "보유 중 다음 판 홀카드가 무조건 원페어로 확정된다 (숫자/기호는 랜덤)",
    },
  ],
  R: [
    {
      name: "KODEX 선물 2배인버스",
      emoji: "📉",
      color: "#4d9dff",
      type: "active",
      effectId: "double_or_nothing",
      description:
        "사용 시 이번 핸드 승리하면 획득 칩 2배, 패배하면 칩을 추가로 잃는다 (올인 시 무효)",
    },
    {
      name: "인스타그램",
      emoji: "📸",
      color: "#4d9dff",
      type: "passive",
      effectId: "favor_flop_10pct",
      description: "보유 중 이번 판 커뮤니티 카드가 나에게 유리한 카드로 나올 확률 +10%",
    },
    {
      name: "매직 드로우",
      emoji: "🪄",
      color: "#4d9dff",
      type: "passive",
      effectId: "next_draw_sr_boost",
      description: "보유 중 바로 다음에 뽑는 기프트가 SR일 확률 +10% (적용 후 소모)",
    },
    {
      name: "선구안",
      emoji: "🔴",
      color: "#4d9dff",
      type: "active",
      effectId: "peek_next_color",
      description: "사용 시 바로 다음 커뮤니티 카드 1장의 색깔(검정/빨강)을 미리 본다",
    },
    {
      name: "이건 이제 제껍니다",
      emoji: "🖐️",
      color: "#4d9dff",
      type: "active",
      effectId: "steal_delete_gift",
      description: "사용 시 상대 1명을 지정하고, 그 사람의 기프트 인벤토리 3칸 중 1칸을 지목해 삭제",
    },
  ],
  "꽝": [
    { name: "꽝... 다음 기회에", emoji: "💨", color: "#7a7f8c", type: "none", effectId: null, description: "" },
  ],
};

// 응원 수(count)에 따른 등급 뽑기. srBoost는 SR 가중치에 더해지는 보정치(매직 드로우용).
function rollRarity(cheerCount, srBoost = 0) {
  const count = Math.max(0, Math.floor(cheerCount));
  if (count === THRESHOLD) return "SSR"; // 정확히 임계값 - 확정, 부스트 무관
  if (count > THRESHOLD) return "꽝";

  let weights;
  if (count === 0) {
    weights = { "꽝": 5, R: 85, SR: 19, SSR: 1 }; // 응원 0이어도 아주 낮은 확률로 SSR까지 노려볼 수 있게
  } else {
    const bands = [
      { max: 4, weights: { R: 30, SR: 0, "꽝": 70 } },
      { max: 9, weights: { R: 50, SR: 10, "꽝": 40 } },
      { max: 14, weights: { R: 40, SR: 40, "꽝": 20 } },
      { max: 20, weights: { R: 20, SR: 75, "꽝": 5 } },
    ];
    const band = bands.find((b) => count <= b.max) || bands[bands.length - 1];
    weights = { ...band.weights };
  }
  if (srBoost > 0) {
    weights = { ...weights, SR: (weights.SR || 0) + srBoost };
  }
  return weightedPick(weights);
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

// options: { excludeEffectIds?: Set<string>, srBoost?: number }
function drawCard(cheerCount, options = {}) {
  const { excludeEffectIds, srBoost = 0 } = options;
  const rarity = rollRarity(cheerCount, srBoost);
  let pool = CATALOG[rarity];
  if (excludeEffectIds && excludeEffectIds.size > 0) {
    const filtered = pool.filter((c) => !excludeEffectIds.has(c.effectId));
    if (filtered.length > 0) pool = filtered;
  }
  const base = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rarity,
    name: base.name,
    emoji: base.emoji,
    color: base.color,
    type: base.type,
    effectId: base.effectId,
    unique: !!base.unique,
    description: base.description,
    used: false,
  };
}

module.exports = { THRESHOLD, rollRarity, drawCard, CATALOG, weightedPick };
