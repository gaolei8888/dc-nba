import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_SCHEMA } from '../server/db.mjs';
import {
  CONSENT_VERSION, SESSION_TTL_MS, findOrCreateUser, createSession, sessionUser,
  revokeSession, bindPlayer, setPrefs, publicUser, LANGS,
} from '../server/accounts.mjs';

const T0 = Date.parse('2026-10-29T02:00:00Z');
const P = '+8613800138000';
const DAY30 = 30 * 24 * 3600e3;

function fresh() {
  const h = new DatabaseSync(':memory:');
  h.exec(ACCOUNT_SCHEMA);
  return h;
}
const mk = (h, e164 = P, now = T0) => findOrCreateUser(h, { e164, consentVersion: CONSENT_VERSION, now }).user;
function fakePlayers() {
  const p = { calls: 0, create(name) { p.calls++; return { id: 'new' + p.calls, name }; } };
  return p;
}

test('同一 E.164 只有一个账号；再次登录更新 last_login_at 与同意记录', () => {
  const h = fresh();
  const a = findOrCreateUser(h, { e164: P, consentVersion: CONSENT_VERSION, now: T0 });
  const b = findOrCreateUser(h, { e164: P, consentVersion: '2027-01-01', now: T0 + 1000 });
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(a.user.id, b.user.id);
  assert.equal(a.user.tier, 'free');
  assert.equal(b.user.last_login_at, new Date(T0 + 1000).toISOString());
  assert.equal(b.user.consent_version, '2027-01-01');
  assert.equal(h.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});

test('会话：库里只存哈希，30 天到期，吊销即失效', () => {
  const h = fresh(); const user = mk(h);
  const s = createSession(h, user.id, T0);
  assert.equal(SESSION_TTL_MS, DAY30);
  assert.equal(Date.parse(s.expiresAt) - T0, DAY30);
  assert.equal(h.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(s.token).n, 0);
  assert.equal(h.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(
    h.prepare('SELECT token_hash t FROM sessions').get().t).n, 1);
  assert.equal(sessionUser(h, s.token, T0 + 1000).id, user.id);
  assert.equal(sessionUser(h, s.token, T0 + DAY30), null);
  assert.equal(revokeSession(h, s.token, T0 + 2000), true);
  assert.equal(revokeSession(h, s.token, T0 + 2500), false);
  assert.equal(sessionUser(h, s.token, T0 + 3000), null);
  assert.equal(sessionUser(h, 'garbage', T0), null);
  assert.equal(sessionUser(h, undefined, T0), null);
  assert.equal(revokeSession(h, 'garbage', T0), false);
});

test('last_seen 距上次不足 10 分钟不写，之后才写', () => {
  const h = fresh(); const user = mk(h);
  const s = createSession(h, user.id, T0);
  const seen = () => h.prepare('SELECT last_seen x FROM sessions').get().x;
  sessionUser(h, s.token, T0 + 9 * 60e3);
  assert.equal(seen(), new Date(T0).toISOString());
  sessionUser(h, s.token, T0 + 10 * 60e3);
  assert.equal(seen(), new Date(T0 + 10 * 60e3).toISOString());
});

test('绑定：账号没有档案时绑定浏览器当前匿名档案', () => {
  const h = fresh(); const u = mk(h); const players = fakePlayers();
  assert.deepEqual(bindPlayer(h, { userId: u.id, anonPlayerId: 'pA', profileName: '玩家 1', players }), { playerId: 'pA', outcome: 'bound' });
  assert.equal(players.calls, 0);
});

test('账号已有档案时不并入', () => {
  const h = fresh(); const u = mk(h); const players = fakePlayers();
  bindPlayer(h, { userId: u.id, anonPlayerId: 'pA', profileName: 'x', players });
  assert.deepEqual(bindPlayer(h, { userId: u.id, anonPlayerId: 'pB', profileName: 'x', players }), { playerId: 'pA', outcome: 'kept' });
  assert.equal(players.calls, 0);
});

test('匿名档案已属于别的账号时不抢，改为新建', () => {
  const h = fresh(); const u1 = mk(h); const u2 = mk(h, '+8613900139000'); const players = fakePlayers();
  bindPlayer(h, { userId: u1.id, anonPlayerId: 'pA', profileName: 'x', players });
  const r = bindPlayer(h, { userId: u2.id, anonPlayerId: 'pA', profileName: '玩家 2', players });
  assert.equal(r.outcome, 'created');
  assert.notEqual(r.playerId, 'pA');
  assert.equal(players.calls, 1);
});

test('当前档案没有排行榜身份：按档案名新建并绑定；排行榜关闭（players = null）时 outcome none', () => {
  const h = fresh(); const u = mk(h); const players = fakePlayers();
  assert.deepEqual(bindPlayer(h, { userId: u.id, anonPlayerId: null, profileName: '小明', players }), { playerId: 'new1', outcome: 'created' });
  const u2 = mk(h, '+8613900139000');
  assert.deepEqual(bindPlayer(h, { userId: u2.id, anonPlayerId: null, profileName: '小明', players: null }), { playerId: null, outcome: 'none' });
  assert.equal(h.prepare('SELECT player_id p FROM users WHERE id = ?').get(u2.id).p, null);
});

test('setPrefs：只收 zh/en 与合法 IANA 时区；tz=null 表示跟随语言', () => {
  const h = fresh(); const u = mk(h);
  assert.equal(setPrefs(h, u.id, { lang: 'en', tz: 'America/New_York' }), true);
  assert.equal(setPrefs(h, u.id, { lang: 'fr' }), false);
  assert.equal(setPrefs(h, u.id, { tz: 'Mars/Base' }), false);
  assert.equal(setPrefs(h, u.id, {}), false);
  let row = h.prepare('SELECT lang, tz FROM users WHERE id = ?').get(u.id);
  assert.deepEqual({ ...row }, { lang: 'en', tz: 'America/New_York' });
  assert.equal(setPrefs(h, u.id, { tz: null }), true);
  row = h.prepare('SELECT lang, tz FROM users WHERE id = ?').get(u.id);
  assert.deepEqual({ ...row }, { lang: 'en', tz: null });
  // 非法值整体拒绝，不写入合法的那一半
  assert.equal(setPrefs(h, u.id, { lang: 'zh', tz: 'Mars/Base' }), false);
  assert.equal(h.prepare('SELECT lang x FROM users WHERE id = ?').get(u.id).x, 'en');
});

test('publicUser 不含完整手机号', () => {
  const h = fresh(); const u = mk(h);
  const p = publicUser(u);
  assert.equal(p.phone, '138****8000');
  assert.equal(JSON.stringify(p).includes('13800138000'), false);
  assert.deepEqual(Object.keys(p).sort(), ['id', 'lang', 'phone', 'tier', 'tierExpiresAt', 'tz']);
});

// 包一层句柄：让第一次「按手机号查账号」的 SELECT 返回空（模拟查完之后才被别的进程抢先插入）
function blindFirstLookup(h, e164) {
  let blinded = false;
  return new Proxy(h, {
    get(t, k) {
      if (k !== 'prepare') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
      return (sql) => {
        const st = t.prepare(sql);
        if (!blinded && /^SELECT .* FROM users WHERE phone_e164/.test(sql)) {
          blinded = true;
          return { get: () => { // 返回空之后，对方的行才出现
            t.prepare(`INSERT INTO users (id, phone_e164, tier, consent_version, consent_at, created_at, last_login_at)
              VALUES ('rival', ?, 'free', 'old', 'old', 'old', 'old')`).run(e164);
            return undefined;
          } };
        }
        return st;
      };
    },
  });
}

test('并发：SELECT 之后被抢先插入同一号码，不抛 UNIQUE，按已存在处理', () => {
  const h = fresh();
  const r = findOrCreateUser(blindFirstLookup(h, P), { e164: P, consentVersion: CONSENT_VERSION, now: T0 });
  assert.equal(r.created, false);
  assert.equal(r.user.id, 'rival');
  assert.equal(r.user.consent_version, CONSENT_VERSION);
  assert.equal(h.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});

test('bindPlayer：非 UNIQUE 的数据库错误照常抛出，不被吞掉', () => {
  const h = fresh(); const u = mk(h);
  const broken = new Proxy(h, {
    get(t, k) {
      if (k !== 'prepare') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
      return (sql) => {
        if (/^UPDATE users SET player_id/.test(sql)) return { run() { throw new Error('disk I/O error'); } };
        return t.prepare(sql);
      };
    },
  });
  assert.throws(() => bindPlayer(broken, { userId: u.id, anonPlayerId: 'pA', profileName: 'x', players: null }), /disk I\/O/);
});

test('LANGS 与 web/src/i18n/locales 下的语言文件一致', () => {
  const dir = new URL('../web/src/i18n/locales/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepEqual([...LANGS].sort(), files);
});
