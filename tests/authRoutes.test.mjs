import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_SCHEMA } from '../server/db.mjs';
import { CONSENT_VERSION } from '../server/accounts.mjs';
import { createCaptchaStore, needsCaptcha } from '../server/captcha.mjs';
import { disabledSender } from '../server/sms.mjs';
import { gate, teaserPaper } from '../server/entitlements.mjs';
import { createAuthRouter, userFromRequest } from '../server/authRoutes.mjs';

const T0 = Date.parse('2026-10-29T02:00:00Z');
const DAY30 = 30 * 24 * 3600e3;
const CAPTCHA_TEXT = 'ABCD';
const FULL_PAPER = {
  backtest: { headline: { bets: 812, seasons: ['2023-24', '2024-25'] } },
  ledger: { available: true, captured: 12 },
};

function fakeSender({ fail = false } = {}) {
  const s = {
    id: 'fake', calls: [],
    async send(e164, code) { s.calls.push({ e164, code }); return fail ? { ok: false, error: 'boom' } : { ok: true, providerId: 'p' + s.calls.length }; },
  };
  return s;
}

/** 测试钩子：包一层真 captcha store，issue 时固定答案，便于带正确答案重发 */
function testCaptcha() {
  const store = createCaptchaStore();
  return { ...store, issue: (now) => store.issue(now, { text: CAPTCHA_TEXT }) };
}

function fakePlayers(map = {}) {
  const rows = new Map(Object.values(map).map((p) => [p.id, p]));
  const p = {
    created: 0,
    authenticate(tok) { return map[tok] ?? null; },
    create(name) { p.created++; const r = { id: 'new' + p.created, name, token: 'secret' }; rows.set(r.id, r); return r; },
    byId(id) { const r = rows.get(id); return r ? { id: r.id, name: r.name } : null; },
  };
  return p;
}

/** 起一个真 Express；返回 post/get 帮手与可调时钟 */
async function setup(t, { h = undefined, sender = fakeSender(), players = null, limits, rateLimitCalls = null } = {}) {
  const db = h === undefined ? new DatabaseSync(':memory:') : h;
  if (db && h === undefined) db.exec(ACCOUNT_SCHEMA);
  let now = T0;
  const clock = () => now;
  const deps = {
    h: db, senders: { mainland: sender, overseas: null, overseasOn: false },
    captcha: testCaptcha(), clock, players, ...(limits ? { limits } : {}),
  };
  if (rateLimitCalls) deps.rateLimit = (opts) => { rateLimitCalls.push(opts); return (req, res, next) => next(); };
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(deps));
  // 演示被锁接口：与 index.mjs 的接法一致
  app.get('/locked', (req, res) => {
    const { user, state } = userFromRequest(deps.h, req, clock());
    const g = gate('board.paper', { accountsOn: true, user, state, now: clock() });
    res.json(g.allowed ? FULL_PAPER : { ...teaserPaper(FULL_PAPER), reason: g.reason });
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, token, ip = '203.0.113.1') => {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return {
    deps, sender, db,
    tick: (ms) => { now += ms; },
    post: (path, body, token, ip) => call('POST', path, body ?? {}, token, ip),
    get: (path, token, ip) => call('GET', path, undefined, token, ip),
  };
}

async function login(s, phone = '13800138000', extra = {}) {
  const r = await s.post('/api/auth/code', { cc: '86', phone, consent: true }, undefined, extra.ip);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = s.sender.calls.at(-1).code;
  return s.post('/api/auth/verify', { cc: '86', phone, code, consent: true, consentVersion: CONSENT_VERSION, ...extra.body }, undefined, extra.ip);
}

test('完整流程：发码 → 验证 → 新号自动建号 → 会话可看被锁内容 → 退出后回到预告', async (t) => {
  const s = await setup(t);
  const { post, get } = s;
  assert.deepEqual((await post('/api/auth/code', { cc: '86', phone: '138 0013 8000', consent: true })).body, { ok: true, resendAfterSec: 60, ttlSec: 300 });
  const code = s.sender.calls[0].code;
  const v = await post('/api/auth/verify', { cc: '86', phone: '13800138000', code, consent: true, consentVersion: CONSENT_VERSION });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.phone, '138****8000');
  assert.equal(v.body.user.tier, 'free');
  assert.equal(typeof v.body.token, 'string');
  assert.equal(v.body.expiresAt, new Date(T0 + DAY30).toISOString());
  assert.equal(JSON.stringify(v.body).includes('13800138000'), false);
  assert.equal((await get('/locked', v.body.token)).body.ledger.captured, 12);
  assert.deepEqual((await post('/api/auth/logout', {}, v.body.token)).body, { ok: true });
  assert.deepEqual((await get('/locked', v.body.token)).body, { locked: true, reason: 'session', teaser: { backtestBets: 812, seasons: ['2023-24', '2024-25'], ledgerCaptured: 12 } });
  // 退出幂等：再退一次、无令牌退出都 ok
  assert.deepEqual((await post('/api/auth/logout', {}, v.body.token)).body, { ok: true });
  assert.deepEqual((await post('/api/auth/logout', {})).body, { ok: true });
});

test('未登录访问被锁接口只拿到预告', async (t) => {
  const s = await setup(t);
  const r = await s.get('/locked');
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'anonymous');
  assert.equal('ledger' in r.body, false);
  assert.equal('backtest' in r.body, false);
});

test('失效会话按未登录处理并标出 reason', async (t) => {
  const s = await setup(t);
  const bogus = await s.get('/locked', 'not-a-real-token');
  assert.equal(bogus.status, 200);
  assert.equal(bogus.body.reason, 'session');
  assert.equal('ledger' in bogus.body, false);

  const v = await login(s);
  assert.equal((await s.get('/locked', v.body.token)).body.ledger.captured, 12);
  s.tick(DAY30 + 1);
  const old = await s.get('/locked', v.body.token);
  assert.equal(old.body.reason, 'session');
  assert.equal('ledger' in old.body, false);
  assert.equal((await s.get('/api/auth/me', v.body.token)).body.code, 'auth.sessionInvalid');
});

test('userFromRequest：无效状态绝不带用户对象；h 为 null → none', async (t) => {
  const s = await setup(t);
  const v = await login(s);
  const req = (auth) => ({ get: (k) => (k.toLowerCase() === 'authorization' ? auth : undefined), headers: { authorization: auth } });
  assert.deepEqual(userFromRequest(null, req(`Bearer ${v.body.token}`), T0), { user: null, state: 'none' });
  assert.deepEqual(userFromRequest(s.db, req(undefined), T0), { user: null, state: 'none' });
  assert.deepEqual(userFromRequest(s.db, req('Basic abc'), T0), { user: null, state: 'none' });
  assert.deepEqual(userFromRequest(s.db, req('Bearer nope'), T0), { user: null, state: 'invalid' });
  const ok = userFromRequest(s.db, req(`Bearer ${v.body.token}`), T0);
  assert.equal(ok.state, 'valid');
  assert.equal(ok.user.id, v.body.user.id);
  assert.deepEqual(userFromRequest(s.db, req(`Bearer ${v.body.token}`), T0 + DAY30 + 1), { user: null, state: 'invalid' });
});

test('没勾同意：发码与验证都拒绝 auth.consentRequired；协议版本不对也拒绝', async (t) => {
  const s = await setup(t);
  for (const consent of [undefined, false, 'true']) {
    const r = await s.post('/api/auth/code', { cc: '86', phone: '13800138000', consent });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'auth.consentRequired');
  }
  assert.equal(s.sender.calls.length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sms_sends').get().n, 0);

  await s.post('/api/auth/code', { cc: '86', phone: '13800138000', consent: true });
  const code = s.sender.calls[0].code;
  const base = { cc: '86', phone: '13800138000', code };
  for (const body of [{ ...base, consentVersion: CONSENT_VERSION }, { ...base, consent: true }, { ...base, consent: true, consentVersion: '2000-01-01' }]) {
    const r = await s.post('/api/auth/verify', body);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'auth.consentRequired');
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  // 被拒的请求没烧掉验证码
  const ok = await s.post('/api/auth/verify', { ...base, consent: true, consentVersion: CONSENT_VERSION });
  assert.equal(ok.status, 200);
});

test('号码非法：400 auth.phoneInvalid，不调发送器', async (t) => {
  const s = await setup(t);
  for (const phone of ['12345', '', 'abc']) {
    const r = await s.post('/api/auth/code', { cc: '86', phone, consent: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'auth.phoneInvalid');
  }
  assert.equal((await s.post('/api/auth/code', { cc: '999', phone: '13800138000', consent: true })).body.code, 'auth.phoneInvalid');
  assert.equal(s.sender.calls.length, 0);
});

test('海外号关闭：+1 号码 400 auth.overseasClosed，发送器没被调用', async (t) => {
  const s = await setup(t);
  const r = await s.post('/api/auth/code', { cc: '1', phone: '2025550123', consent: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'auth.overseasClosed');
  assert.equal(s.sender.calls.length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sms_sends').get().n, 0);
});

test('第 3 次发码要求图形验证（428 带图），答对才发', async (t) => {
  const s = await setup(t);
  const send = (phone, extra = {}) => s.post('/api/auth/code', { cc: '86', phone, consent: true, ...extra });
  assert.equal((await send('13800138001')).status, 200);
  s.tick(61_000);
  assert.equal((await send('13800138002')).status, 200);
  s.tick(61_000);
  const third = await send('13800138003');
  assert.equal(third.status, 428);
  assert.equal(third.body.code, 'auth.captchaRequired');
  assert.match(third.body.captcha.id, /^[0-9a-f]{32}$/);
  assert.match(third.body.captcha.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(s.sender.calls.length, 2);

  // 答错：400 auth.captchaWrong，附新图；旧图作废
  const wrong = await send('13800138003', { captchaId: third.body.captcha.id, captchaAnswer: 'ZZZZ' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'auth.captchaWrong');
  assert.notEqual(wrong.body.captcha.id, third.body.captcha.id);
  const reused = await send('13800138003', { captchaId: third.body.captcha.id, captchaAnswer: CAPTCHA_TEXT });
  assert.equal(reused.body.code, 'auth.captchaWrong');
  assert.equal(s.sender.calls.length, 2);

  // 答对（大小写不敏感）才发
  const ok = await send('13800138003', { captchaId: reused.body.captcha.id, captchaAnswer: CAPTCHA_TEXT.toLowerCase() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(s.sender.calls.length, 3);

  // 另一个 IP 不受影响
  const other = await s.post('/api/auth/code', { cc: '86', phone: '13800138004', consent: true }, undefined, '198.51.100.7');
  assert.equal(other.status, 200);
});

test('同一新 IP 并发 3 个发码（不同号码）：在途的也算数，第 3 个要求图形验证、不发送', async (t) => {
  // 发送器先挂住：前两个请求停在「已通过检查、发送器未返回」，sms_sends 里还是 0 行
  let release;
  const held = new Promise((r) => { release = r; });
  const sender = {
    id: 'fake', calls: [],
    async send(e164, code) { sender.calls.push({ e164, code }); await held; return { ok: true, providerId: 'p' }; },
  };
  const s = await setup(t, { sender });
  const ip = '192.0.2.77';
  const reqs = ['13800138011', '13800138012', '13800138013']
    .map((phone) => s.post('/api/auth/code', { cc: '86', phone, consent: true }, undefined, ip));
  // 不依赖时序猜测：等任何一个先回来（只有被拦下的那个不经过发送器）；2 秒兜底放行，失败时断言能报出来
  const timer = setTimeout(() => release(), 2000);
  await Promise.race(reqs);
  release();
  clearTimeout(timer);
  const results = await Promise.all(reqs);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 428], JSON.stringify(results.map((r) => r.body)));
  assert.equal(results.find((r) => r.status === 428).body.code, 'auth.captchaRequired');
  assert.equal(sender.calls.length, 2);
});

test('POST /captcha 取一张图；答对可直接带上发码', async (t) => {
  const s = await setup(t);
  const send = (phone, extra = {}) => s.post('/api/auth/code', { cc: '86', phone, consent: true, ...extra });
  await send('13800138001'); s.tick(61_000);
  await send('13800138002'); s.tick(61_000);
  const c = await s.post('/api/auth/captcha', {});
  assert.equal(c.status, 200);
  assert.deepEqual(Object.keys(c.body).sort(), ['id', 'image']);
  assert.match(c.body.image, /^data:image\/svg\+xml;base64,/);
  const r = await send('13800138003', { captchaId: c.body.id, captchaAnswer: CAPTCHA_TEXT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('60 秒重发冷却只回 auth.cooldown，不把该 IP 记为限频', async (t) => {
  const s = await setup(t);
  const send = (phone, extra = {}) => s.post('/api/auth/code', { cc: '86', phone, consent: true, ...extra });
  assert.equal((await send('13800138001')).status, 200);
  const again = await send('13800138001');
  assert.equal(again.status, 429);
  assert.equal(again.body.code, 'auth.cooldown');
  assert.equal(typeof again.body.params.sec, 'number');
  assert.equal(s.deps.captcha.limitedAt('203.0.113.1', T0), null);
  assert.equal(needsCaptcha({ ipSendsLastHour: 1, siteToday: 1, cap: 500, now: T0, store: s.deps.captcha, ip: '203.0.113.1' }), false);
  // 换号码不需要图形验证
  s.tick(61_000);
  assert.equal((await send('13800138002')).status, 200);
});

test('IP 每小时上限：429 auth.ipLimit 透传', async (t) => {
  const s = await setup(t, { limits: { ipHourly: 1, ipDaily: 20, siteDaily: 500 } });
  assert.equal((await s.post('/api/auth/code', { cc: '86', phone: '13800138001', consent: true })).status, 200);
  s.tick(61_000);
  const r = await s.post('/api/auth/code', { cc: '86', phone: '13800138002', consent: true });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'auth.ipLimit');
  assert.equal(s.deps.captcha.limitedAt('203.0.113.1', T0 + 61_000), T0 + 61_000);
  assert.equal(needsCaptcha({ ipSendsLastHour: 0, siteToday: 0, cap: 500, now: T0 + 61_000, store: s.deps.captcha, ip: '203.0.113.1' }), true);
});

test('发送失败：502 auth.smsFailed，之后用任何码验证都是 auth.codeExpired', async (t) => {
  const s = await setup(t, { sender: fakeSender({ fail: true }) });
  const r = await s.post('/api/auth/code', { cc: '86', phone: '13800138000', consent: true });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'auth.smsFailed');
  for (const code of [s.sender.calls[0].code, '000000']) {
    const v = await s.post('/api/auth/verify', { cc: '86', phone: '13800138000', code, consent: true, consentVersion: CONSENT_VERSION });
    assert.equal(v.status, 400);
    assert.equal(v.body.code, 'auth.codeExpired');
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
});

test('验证码错误透传剩余次数；错满 5 次作废', async (t) => {
  const s = await setup(t);
  await s.post('/api/auth/code', { cc: '86', phone: '13800138000', consent: true });
  const code = s.sender.calls[0].code;
  const bad = code === '000000' ? '111111' : '000000';
  const body = { cc: '86', phone: '13800138000', consent: true, consentVersion: CONSENT_VERSION };
  const r1 = await s.post('/api/auth/verify', { ...body, code: bad });
  assert.equal(r1.status, 400);
  assert.deepEqual([r1.body.code, r1.body.params], ['auth.codeInvalid', { left: 4 }]);
  for (let i = 0; i < 3; i++) await s.post('/api/auth/verify', { ...body, code: bad });
  assert.equal((await s.post('/api/auth/verify', { ...body, code: bad })).body.code, 'auth.codeLocked');
  assert.equal((await s.post('/api/auth/verify', { ...body, code })).body.code, 'auth.codeExpired');
});

test('没配密钥（disabled 发送器）：503 auth.smsUnavailable，sms_sends 无新行', async (t) => {
  const s = await setup(t, { sender: disabledSender('未配置') });
  const r = await s.post('/api/auth/code', { cc: '86', phone: '13800138000', consent: true });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'auth.smsUnavailable');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sms_sends').get().n, 0);
});

test('登录时绑定当前匿名档案；账号已有档案时 outcome kept', async (t) => {
  const players = fakePlayers({ anonTok: { id: 'pA', name: '小明' }, otherTok: { id: 'pB', name: '小红' } });
  const s = await setup(t, { players });
  const first = await login(s, '13800138000', { body: { anonToken: 'anonTok' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'bound');
  assert.deepEqual(first.body.player, { id: 'pA', name: '小明' });

  s.tick(61_000);
  const second = await login(s, '13800138000', { body: { anonToken: 'otherTok' }, ip: '198.51.100.9' });
  assert.equal(second.status, 200);
  assert.equal(second.body.outcome, 'kept');
  assert.deepEqual(second.body.player, { id: 'pA', name: '小明' });
  assert.equal(second.body.user.id, first.body.user.id);
  assert.notEqual(second.body.token, first.body.token);
  assert.deepEqual((await s.get('/api/auth/me', second.body.token)).body.player, { id: 'pA', name: '小明' });
});

test('请求体里的玩家 id 一律不认；匿名令牌无效则新建档案', async (t) => {
  const players = fakePlayers({ anonTok: { id: 'pA', name: '小明' } });
  const s = await setup(t, { players });
  const r = await login(s, '13800138000', { body: { anonToken: 'forged', anonPlayerId: 'pA', playerId: 'pA', profileName: '新人' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'created');
  assert.deepEqual(r.body.player, { id: 'new1', name: '新人' });
  assert.equal(JSON.stringify(r.body).includes('secret'), false);
});

test('players 为 null：outcome none，player null', async (t) => {
  const s = await setup(t);
  const r = await login(s);
  assert.equal(r.body.outcome, 'none');
  assert.equal(r.body.player, null);
});

test('prefs：登录后可存语言与时区，/me 返回', async (t) => {
  const s = await setup(t);
  const v = await login(s);
  const tok = v.body.token;
  assert.equal((await s.post('/api/auth/prefs', { lang: 'en' })).status, 401);
  assert.deepEqual((await s.post('/api/auth/prefs', { lang: 'en', tz: 'America/New_York' }, tok)).body, { ok: true });
  let me = await s.get('/api/auth/me', tok);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.lang, 'en');
  assert.equal(me.body.user.tz, 'America/New_York');
  assert.equal(me.body.user.phone, '138****8000');
  assert.equal(me.body.player, null);
  assert.deepEqual((await s.post('/api/auth/prefs', { tz: null }, tok)).body, { ok: true });
  me = await s.get('/api/auth/me', tok);
  assert.equal(me.body.user.tz, null);
  assert.equal(me.body.user.lang, 'en');
  for (const bad of [{ lang: 'fr' }, { tz: 'Mars/Base' }, {}, { locale: 'en' }, { lang: 'zh', tz: 'Nope/Nope' }]) {
    const r = await s.post('/api/auth/prefs', bad, tok);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.code, 'auth.prefsInvalid');
  }
  assert.equal((await s.get('/api/auth/me', tok)).body.user.lang, 'en');
  assert.equal((await s.get('/api/auth/me')).status, 401);
});

test('限流：/code 20 次、/verify 30 次每 10 分钟', async (t) => {
  const calls = [];
  await setup(t, { rateLimitCalls: calls });
  const byMax = Object.fromEntries(calls.map((c) => [c.key, c]));
  assert.deepEqual([byMax['auth-code'].max, byMax['auth-code'].windowMs], [20, 600_000]);
  assert.deepEqual([byMax['auth-verify'].max, byMax['auth-verify'].windowMs], [30, 600_000]);
});

test('库不可用：h = null 时 503 auth.unavailable', async (t) => {
  const s = await setup(t, { h: null });
  for (const [m, p] of [['POST', '/api/auth/captcha'], ['POST', '/api/auth/code'], ['POST', '/api/auth/verify'], ['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/prefs']]) {
    const r = m === 'GET' ? await s.get(p, 'x') : await s.post(p, { cc: '86', phone: '13800138000', consent: true }, 'x');
    assert.equal(r.status, 503, p);
    assert.equal(r.body.code, 'auth.unavailable', p);
  }
  assert.equal(s.sender.calls.length, 0);
  const anon = await s.get('/locked');
  assert.equal(anon.body.reason, 'anonymous');
});
