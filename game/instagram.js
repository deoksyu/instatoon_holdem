// game/instagram.js
// 인스타그램 공개 임베드 페이지(/username/embed/)의 contextJSON을 파싱해
// 정확한 팔로워/게시물 수, 프로필 사진, 인증뱃지(파란 체크) 여부를 가져온다.
// (비공식 API 대신 공개 HTML만 사용, 로그인 불필요)

const fetch = require("node-fetch");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";

function extractUsername(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/instagram\.com\/([^/?#]+)/i);
  if (urlMatch) return urlMatch[1];
  return trimmed.replace(/^@/, "");
}

// HTML 안에 JS 문자열로 이중 이스케이프된 "contextJSON":"{...}" 블록을 안전하게 추출.
function extractContextJSON(html) {
  const marker = '"contextJSON":"';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  let raw = "";
  while (i < html.length) {
    const ch = html[i];
    if (ch === "\\") {
      raw += ch + html[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') break;
    raw += ch;
    i += 1;
  }
  try {
    const jsonText = JSON.parse('"' + raw + '"'); // 이스케이프 해제
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function fetchInstagramProfile(usernameOrUrl) {
  const username = extractUsername(usernameOrUrl);
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    throw new Error("올바른 인스타그램 아이디가 아닙니다.");
  }

  const url = `https://www.instagram.com/${username}/embed/`;
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
  const parsed = extractContextJSON(html);
  const ctx = parsed?.context;

  if (!ctx || !ctx.username) {
    throw new Error("비공개 계정이거나 존재하지 않는 계정입니다.");
  }

  return {
    username: ctx.username,
    displayName: ctx.full_name || ctx.username,
    followers: ctx.followers_count ?? 0,
    posts: ctx.posts_count ?? 0,
    avatarUrl: ctx.profile_pic_url || null,
    verified: !!ctx.is_verified,
    profileUrl: `https://www.instagram.com/${ctx.username}/`,
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

module.exports = { fetchInstagramProfile, calcStartingChips, extractUsername };
