// game/instagram.js
// 인스타그램 공개 프로필에서 og:description / og:image 메타태그를 파싱해
// 팔로워 수, 게시물 수, 프로필 사진 URL을 가져온다.
// (비공식 API 대신 공개 HTML 메타태그만 사용 - 로그인 불필요)

const fetch = require("node-fetch");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

// "34K", "1.2M", "1,234" 같은 표기를 정수로 변환
function parseCount(raw) {
  if (!raw) return 0;
  const s = raw.trim().toUpperCase().replace(/,/g, "");
  const m = s.match(/^([\d.]+)([KM]?)$/);
  if (!m) return parseInt(s, 10) || 0;
  const num = parseFloat(m[1]);
  if (m[2] === "K") return Math.round(num * 1000);
  if (m[2] === "M") return Math.round(num * 1000000);
  return Math.round(num);
}

function extractUsername(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/instagram\.com\/([^/?#]+)/i);
  if (urlMatch) return urlMatch[1];
  return trimmed.replace(/^@/, "");
}

async function fetchInstagramProfile(usernameOrUrl) {
  const username = extractUsername(usernameOrUrl);
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    throw new Error("올바른 인스타그램 아이디가 아닙니다.");
  }

  const url = `https://www.instagram.com/${username}/`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`프로필을 불러오지 못했습니다 (HTTP ${res.status}). 아이디를 확인해주세요.`);
  }

  const html = await res.text();

  const descMatch = html.match(/<meta property="og:description" content="([^"]*)"/);
  const imgMatch = html.match(/<meta property="og:image" content="([^"]*)"/);
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);

  if (!descMatch) {
    throw new Error("비공개 계정이거나 존재하지 않는 계정입니다.");
  }

  const desc = decodeEntities(descMatch[1]);
  // 언어별로 다른 포맷을 지원 (Instagram이 Accept-Language를 무시하는 경우 대비)
  // EN: "34K Followers, 413 Following, 65 Posts - ..."
  // KO: "팔로워 34K명, 팔로잉 413명, 게시물 65개 - ..."
  const enMatch = desc.match(
    /([\d.,]+[KM]?)\s*Followers,\s*([\d.,]+[KM]?)\s*Following,\s*([\d.,]+[KM]?)\s*Posts/i
  );
  const koMatch = desc.match(
    /\uD314\uB85C\uC6CC\s*([\d.,]+[KM]?)\uBA85,\s*\uD314\uB85C\uC789\s*([\d.,]+[KM]?)\uBA85,\s*\uAC8C\uC2DC\uBB3C\s*([\d.,]+[KM]?)\uAC1C/i
  );
  const statsMatch = enMatch || koMatch;

  if (!statsMatch) {
    throw new Error("프로필 통계 정보를 해석할 수 없습니다.");
  }

  const followers = parseCount(statsMatch[1]);
  const following = parseCount(statsMatch[2]);
  const posts = parseCount(statsMatch[3]);

  let displayName = username;
  if (titleMatch) {
    const t = decodeEntities(titleMatch[1]);
    const nameMatch = t.match(/^(.*?)\s*\(@/);
    if (nameMatch) displayName = nameMatch[1].trim();
  }

  const avatarUrl = imgMatch ? decodeEntities(imgMatch[1]) : null;

  return {
    username,
    displayName,
    followers,
    following,
    posts,
    avatarUrl,
    profileUrl: url,
  };
}

// 시작 칩 계산 공식 (자유롭게 조정 가능)
// 기본 1000 + 게시물당 50칩, 최대 5000칩 보너스로 캡
function calcStartingChips(profile, opts = {}) {
  const base = opts.base ?? 1000;
  const perPost = opts.perPost ?? 50;
  const cap = opts.cap ?? 5000;
  const bonus = Math.min(profile.posts * perPost, cap);
  return base + bonus;
}

module.exports = { fetchInstagramProfile, calcStartingChips, parseCount, extractUsername };
