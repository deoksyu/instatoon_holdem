// game/cheerCards.js
// 팬 응원 수에 따라 뽑히는 아이템 카드. 블랙잭처럼 "임계점(21)"에 정확히 맞으면 최고 등급,
// 넘기면 무조건 꽝. 카드 효과(effect)는 아직 미정 - 자리만 잡아둠(effect: null, used: false).

const THRESHOLD = 21;

const CATALOG = {
  SSR: [
    { name: "전설의 골든펜", emoji: "🖊️", color: "#ffd447" },
    { name: "인스타툰 대상 트로피", emoji: "🏆", color: "#ffd447" },
    { name: "만찢 각성카드", emoji: "🌟", color: "#ffd447" },
  ],
  SR: [
    { name: "역전의 부적", emoji: "🔮", color: "#b06bff" },
    { name: "필살기 스크롤", emoji: "📜", color: "#b06bff" },
    { name: "팬미팅 초대장", emoji: "🎫", color: "#b06bff" },
  ],
  R: [
    { name: "화이팅 부적", emoji: "🍀", color: "#4d9dff" },
    { name: "소소한 응원", emoji: "✨", color: "#4d9dff" },
    { name: "달콤한 간식", emoji: "🍬", color: "#4d9dff" },
  ],
  "꽝": [{ name: "꽝... 다음 기회에", emoji: "💨", color: "#7a7f8c" }],
};

// 응원 수(count)에 따른 등급 뽑기.
// - 0: 무조건 꽝
// - 정확히 21: 무조건 SSR
// - 21 초과: 무조건 꽝 (블랙잭 버스트)
// - 1~20: 21에 가까워질수록 좋은 등급이 나올 확률이 커짐
function rollRarity(cheerCount) {
  const count = Math.max(0, Math.floor(cheerCount));
  // 응원이 하나도 없어도 언더독에게 공정한 기회를: R/SR/SSR 동률 33.3%
  if (count === 0) return weightedPick({ R: 1, SR: 1, SSR: 1 });
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
    used: false,
    effect: null, // TODO: 카드 효과는 추후 정의
  };
}

module.exports = { THRESHOLD, rollRarity, drawCard, CATALOG, weightedPick };
