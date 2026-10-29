// 账号、会话与玩家档案绑定。
// 手机号按 E.164 唯一；会话令牌只存 SHA-256 哈希；一个账号对应一个玩家档案。
import crypto from 'node:crypto';
import { maskPhone } from './phone.mjs';

export const CONSENT_VERSION = '2026-10-29';
export const SESSION_TTL_MS = 30 * 24 * 3600e3;
/** last_seen 至少隔这么久才写一次，避免每个请求都写库 */
const SEEN_THROTTLE_MS = 10 * 60e3;
/** 与 web/src/i18n/locales 保持一致 */
export const LANGS = Object.freeze(['zh', 'en']);

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

const USER_COLS = 'id, phone_e164, player_id, tier, tier_expires_at, lang, tz, consent_version, consent_at, created_at, last_login_at';

/** 已存在则更新登录时间与同意记录；否则新建（tier 默认 free） */
export function findOrCreateUser(h, { e164, consentVersion, now }) {
  const at = iso(now);
  const found = h.prepare(`SELECT ${USER_COLS} FROM users WHERE phone_e164 = ?`).get(e164);
  if (found) {
    h.prepare('UPDATE users SET last_login_at = ?, consent_version = ?, consent_at = ? WHERE id = ?')
      .run(at, consentVersion, at, found.id);
    const user = h.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(found.id);
    return { user, created: false };
  }
  const id = crypto.randomBytes(9).toString('base64url');
  // ON CONFLICT DO NOTHING：SELECT 与 INSERT 之间被别的进程抢先插入同一号码时不抛错
  const ins = h.prepare(
    `INSERT INTO users (id, phone_e164, tier, consent_version, consent_at, created_at, last_login_at)
     VALUES (?, ?, 'free', ?, ?, ?, ?) ON CONFLICT(phone_e164) DO NOTHING`,
  ).run(id, e164, consentVersion, at, at, at);
  if (ins.changes === 0) {
    // 输掉竞争：对方已建好账号，按「已存在」处理
    const row = h.prepare('SELECT id FROM users WHERE phone_e164 = ?').get(e164);
    h.prepare('UPDATE users SET last_login_at = ?, consent_version = ?, consent_at = ? WHERE id = ?')
      .run(at, consentVersion, at, row.id);
    return { user: h.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(row.id), created: false };
  }
  const user = h.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
  return { user, created: true };
}

/** 令牌只在这里返回一次，库里只存哈希 */
export function createSession(h, userId, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = iso(now + SESSION_TTL_MS);
  h.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, iso(now), expiresAt, iso(now));
  return { token, expiresAt };
}

/** 未吊销且未过期才返回用户；last_seen 距上次 ≥ 10 分钟才写 */
export function sessionUser(h, token, now) {
  if (typeof token !== 'string' || !token) return null;
  const hash = sha256(token);
  const s = h.prepare('SELECT user_id, expires_at, revoked_at, last_seen FROM sessions WHERE token_hash = ?').get(hash);
  if (!s || s.revoked_at || Date.parse(s.expires_at) <= now) return null;
  const user = h.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(s.user_id);
  if (!user) return null;
  const seen = s.last_seen ? Date.parse(s.last_seen) : 0;
  if (!(now - seen < SEEN_THROTTLE_MS)) {
    h.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(iso(now), hash);
  }
  return user;
}

/** 退出：吊销后立即失效；令牌不存在或早已吊销返回 false */
export function revokeSession(h, token, now) {
  if (typeof token !== 'string' || !token) return false;
  const r = h.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(iso(now), sha256(token));
  return r.changes > 0;
}

/**
 * 登录时绑定玩家档案。顺序：账号已有档案 → kept（以账号为准，不并入匿名记录）；
 * 匿名档案没被别的账号占用 → bound；players 可用 → 新建并绑定 created；否则 none。
 * 占用靠 users.player_id UNIQUE 兜底（并发下 UNIQUE 冲突视为被占用，其它错误向上抛）。
 * 安全：anonPlayerId 必须由服务端从匿名令牌解析得出，绝不能直接取自请求体，
 * 否则任何人都能把别人的匿名档案绑到自己账号上。
 */
export function bindPlayer(h, { userId, anonPlayerId, profileName, players }) {
  const me = h.prepare('SELECT player_id FROM users WHERE id = ?').get(userId);
  if (!me) return { playerId: null, outcome: 'none' };
  if (me.player_id) return { playerId: me.player_id, outcome: 'kept' };

  const tryBind = (pid) => {
    try {
      return h.prepare('UPDATE users SET player_id = ? WHERE id = ? AND player_id IS NULL').run(pid, userId).changes > 0;
    } catch (e) {
      // 只吞 UNIQUE 冲突（档案已被别的账号占用）；其余错误照常抛出
      if (/UNIQUE constraint failed/i.test(String(e?.message))) return false;
      throw e;
    }
  };

  if (anonPlayerId && tryBind(String(anonPlayerId))) return { playerId: String(anonPlayerId), outcome: 'bound' };
  if (players) {
    const p = players.create(profileName || '玩家');
    if (p?.id && tryBind(p.id)) return { playerId: p.id, outcome: 'created' };
  }
  return { playerId: null, outcome: 'none' };
}

const validTz = (tz) => {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

/**
 * 设置偏好 { lang, tz }；只改传入的键。lang 只收 LANGS；tz 须为合法 IANA 时区，
 * 传 null 表示「跟随语言」。任一非法则整体拒绝、不写。
 */
export function setPrefs(h, userId, prefs = {}) {
  const sets = []; const vals = [];
  if ('lang' in prefs) {
    if (!LANGS.includes(prefs.lang)) return false;
    sets.push('lang = ?'); vals.push(prefs.lang);
  }
  if ('tz' in prefs) {
    if (prefs.tz !== null && !validTz(prefs.tz)) return false;
    sets.push('tz = ?'); vals.push(prefs.tz);
  }
  if (!sets.length) return false;
  return h.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, userId).changes > 0;
}

/** 对外可见的用户信息：手机号脱敏，不含完整号码 */
export function publicUser(user) {
  return {
    id: user.id,
    phone: maskPhone(user.phone_e164),
    tier: user.tier,
    tierExpiresAt: user.tier_expires_at ?? null,
    lang: user.lang ?? null,
    tz: user.tz ?? null,
  };
}
