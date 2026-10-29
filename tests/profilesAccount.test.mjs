import test from 'node:test';
import assert from 'node:assert/strict';

// 内存版 localStorage（profiles.js / session.js 的读写都有 try/catch）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { attachAccount, detachAccount } = await import('../web/src/lib/profiles.js');
const { SESSION_KEY, loadSession, saveSession, clearSession, authHeaders, shouldDropSession, accountsDisabled } = await import('../web/src/lib/session.js');
const { ApiError } = await import('../web/src/lib/apiError.js');

const S = (profiles, activeId) => ({ version: 1, activeId, profiles });

test('attachAccount：当前档案未入榜 → 绑到当前档案', () => {
  const s = attachAccount(S([{ id: 'l1', name: '玩家 1' }], 'l1'), { player: { id: 'pA', name: '玩家 1' }, token: 'sess' });
  assert.deepEqual(s.profiles[0].cloud, { playerId: 'pA', token: 'sess', name: '玩家 1', account: true });
  assert.equal(s.activeId, 'l1');
});

test('attachAccount：账号档案与本机档案不同时新建本地档案', () => {
  const s = attachAccount(S([{ id: 'l1', name: '我', cloud: { playerId: 'pB', token: 't' } }], 'l1'), { player: { id: 'pA', name: '小明' }, token: 'sess' });
  assert.equal(s.profiles.length, 2);
  assert.deepEqual(s.profiles[0].cloud, { playerId: 'pB', token: 't' }); // 本机匿名档案原样
  const act = s.profiles.find((p) => p.id === s.activeId);
  assert.equal(act.cloud.playerId, 'pA');
  assert.equal(act.name, '小明');
  assert.equal(act.cloud.account, true);
});

test('attachAccount：本机已有该账号的档案 → 换令牌并切过去', () => {
  const s = attachAccount(
    S([
      { id: 'l1', name: '我' },
      { id: 'l2', name: '旧', cloud: { playerId: 'pA', token: 'old', name: '旧' } },
    ], 'l1'),
    { player: { id: 'pA', name: '旧' }, token: 'sess' },
  );
  assert.equal(s.profiles.length, 2);
  assert.equal(s.activeId, 'l2');
  assert.equal(s.profiles[1].cloud.token, 'sess');
  assert.equal(s.profiles[1].cloud.account, true);
  assert.equal(s.profiles[0].cloud, undefined);
});

test('attachAccount：当前档案已绑同一玩家 → 绑到当前档案（换令牌）', () => {
  const s = attachAccount(S([{ id: 'l1', name: '我', cloud: { playerId: 'pA', token: 'old' } }], 'l1'), { player: { id: 'pA', name: '我' }, token: 'sess' });
  assert.equal(s.profiles.length, 1);
  assert.equal(s.profiles[0].cloud.token, 'sess');
});

test('attachAccount：player 为 null → 原样返回', () => {
  const st = S([{ id: 'l1', name: '我' }], 'l1');
  assert.equal(attachAccount(st, { player: null, token: 'sess' }), st);
});

test('detachAccount：只去掉账号档案的 cloud', () => {
  const st = S([
    { id: 'l1', name: 'a', cloud: { playerId: 'pB', token: 't' } },
    { id: 'l2', name: 'b', cloud: { playerId: 'pA', token: 's', account: true } },
  ], 'l2');
  const s = detachAccount(st);
  assert.deepEqual(s.profiles[0].cloud, { playerId: 'pB', token: 't' });
  assert.equal('cloud' in s.profiles[1], false);
  assert.equal(s.profiles[1].name, 'b');
});

// ---- 会话存储
const NOW = Date.parse('2026-10-29T00:00:00Z');
const sess = (over = {}) => ({ token: 'tok', expiresAt: new Date(NOW + 1000).toISOString(), user: { id: 1 }, ...over });

test('session：存取往返；过期即清除并返回 null', () => {
  mem.clear();
  assert.equal(loadSession(NOW), null);
  saveSession(sess());
  assert.equal(loadSession(NOW).token, 'tok');
  assert.equal(loadSession(NOW + 5000), null);
  assert.equal(mem.has(SESSION_KEY), false);
});

test('session：坏数据按无会话处理并清除', () => {
  mem.set(SESSION_KEY, '{oops');
  assert.equal(loadSession(NOW), null);
  mem.set(SESSION_KEY, JSON.stringify({ expiresAt: 'x' }));
  assert.equal(loadSession(NOW), null);
  assert.equal(mem.has(SESSION_KEY), false);
});

test('session：clearSession；authHeaders', () => {
  saveSession(sess());
  clearSession();
  assert.equal(loadSession(NOW), null);
  assert.deepEqual(authHeaders({ token: 'abc' }), { Authorization: 'Bearer abc' });
  assert.equal(authHeaders(null), undefined);
  assert.equal(authHeaders({}), undefined);
});

test('shouldDropSession：401 auth.sessionInvalid 或 locked 且 reason=session', () => {
  assert.equal(shouldDropSession(new ApiError({ status: 401, code: 'auth.sessionInvalid' })), true);
  assert.equal(shouldDropSession(new ApiError({ status: 401, code: 'other' })), false);
  assert.equal(shouldDropSession({ locked: true, reason: 'session' }), true);
  assert.equal(shouldDropSession({ locked: true, reason: 'anonymous' }), false);
  assert.equal(shouldDropSession({ locked: true, reason: 'tier' }), false);
  assert.equal(shouldDropSession(null), false);
});

test('ApiError：保留 body（验证码 428 带 captcha）', async () => {
  const { toApiError } = await import('../web/src/lib/apiError.js');
  const res = { status: 428, json: async () => ({ code: 'auth.captchaRequired', captcha: { id: 'c', image: 'x' } }) };
  const e = await toApiError(res);
  assert.equal(e.body.captcha.id, 'c');
  assert.equal(e.status, 428);
});

test('accountsDisabled：/api/meta 说账号关闭（或没有该字段）才算关闭；meta 还没到不算', () => {
  assert.equal(accountsDisabled({ features: { accounts: { enabled: false } } }), true);
  assert.equal(accountsDisabled({ features: {} }), true); // 旧服务端：没有账号字段
  assert.equal(accountsDisabled({ features: { accounts: { enabled: true } } }), false);
  assert.equal(accountsDisabled(null), false);
  assert.equal(accountsDisabled(undefined), false);
});
