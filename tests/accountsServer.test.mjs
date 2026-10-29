import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONSENT_VERSION } from '../server/accounts.mjs';

// 用户系统接进 server/index.mjs 的端到端测试：起真实服务进程，库一律放临时目录，绝不碰 data/app.db
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-srv-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 起服务：PORT=0 由系统分配端口；stdout 全程收集（console 短信通道把验证码打在这里） */
async function startServer(t, env) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env, PORT: '0', NODE_ENV: 'test', ENABLE_ACCOUNTS: '', ENABLE_OVERSEAS_SMS: '',
      SMS_PROVIDER: '', SMS_DAILY_CAP: '', SMS_IP_HOURLY: '', SMS_IP_DAILY: '', TRUST_PROXY: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => child.kill());
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务没起来（20 秒内没打印端口）')), 20000);
    const poll = setInterval(() => {
      const m = /API: http:\/\/localhost:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); clearInterval(poll); resolve(Number(m[1])); }
    }, 50);
    child.once('exit', (code) => { clearTimeout(timer); clearInterval(poll); reject(new Error(`服务提前退出 code=${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, { body, token, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const r = await fetch(base + p, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, headers: r.headers, body: json, text };
  };
  return {
    log: () => out,
    get: (p, o) => call('GET', p, o),
    post: (p, body, o = {}) => call('POST', p, { ...o, body }),
    postRaw: (p, raw) => call('POST', p, { raw }),
  };
}

/** console 通道打印的最后一条验证码（日志里号码已脱敏） */
async function codeFromLog(s, masked) {
  for (let i = 0; i < 50; i++) {
    const all = [...s.log().matchAll(/\[sms:console\] (\S+) 验证码 (\d{6})/g)].filter((m) => m[1] === masked);
    if (all.length) return all.at(-1)[2];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('日志里没等到验证码');
}

async function login(s, phone, extraBody = {}) {
  const c = await s.post('/api/auth/code', { cc: '86', phone, consent: true });
  assert.equal(c.status, 200, c.text);
  const code = await codeFromLog(s, `${phone.slice(0, 3)}****${phone.slice(-4)}`);
  const v = await s.post('/api/auth/verify', { cc: '86', phone, code, consent: true, consentVersion: CONSENT_VERSION, ...extraBody });
  assert.equal(v.status, 200, v.text);
  return v.body;
}

test('账号关闭（默认）：三个接口与现状一样全量公开；/api/auth 503；meta 报 enabled=false；坏 JSON 回 400 err.badJson', async (t) => {
  const s = await startServer(t, { DB_PATH: path.join(tmp, 'off.db'), ENABLE_LEADERBOARD: '0' });
  const paper = await s.get('/api/paper');
  assert.equal(paper.status, 200);
  assert.ok('backtest' in paper.body && 'ledger' in paper.body);
  assert.equal('locked' in paper.body, false);
  assert.equal(paper.headers.get('cache-control'), null);
  // 关闭时连会话 / 随便什么令牌都不影响
  const withTok = await s.get('/api/paper', { token: 'whatever' });
  assert.deepEqual(Object.keys(withTok.body).sort(), ['backtest', 'ledger']);

  const sum = await s.get('/api/predictions/summary');
  assert.equal(sum.status, 200);
  assert.equal('locked' in sum.body, false);
  assert.ok(Array.isArray(sum.body.summary) && sum.body.summary.length > 1, '全量总结不止一句');
  assert.ok(sum.body.overall);

  const sh = await s.get('/api/shadow');
  assert.equal(sh.status, 200);
  assert.equal('locked' in sh.body, false);

  const meta = (await s.get('/api/meta')).body;
  assert.deepEqual(meta.features.accounts, {
    enabled: false, overseas: false, countries: [{ cc: '86', iso: 'CN' }], consentVersion: CONSENT_VERSION,
  });

  const a = await s.post('/api/auth/code', { cc: '86', phone: '13800138000', consent: true });
  assert.equal(a.status, 503);
  assert.equal(a.body.code, 'auth.unavailable');

  const bad = await s.postRaw('/api/predict', '{"homeId": 1,');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'err.badJson');
  assert.deepEqual(bad.body.params, {});

  const h = await s.get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.sms, null);
  assert.deepEqual(h.body.alarms, []);
  assert.equal(typeof h.body.proxy.ip, 'string');
  assert.equal(h.body.proxy.cookieSeen, false);
  assert.match(s.log(), /用户系统：关闭/);

  // 关闭且没设 TRUST_PROXY：不设 trust proxy（Express 默认），伪造的 X-Forwarded-For 被忽略，proxy.ip 是套接字地址
  const fwd = await s.get('/api/health', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.notEqual(fwd.body.proxy.ip, '1.2.3.4');
  assert.match(fwd.body.proxy.ip, /127\.0\.0\.1$/);
  // 关闭时预测总表不建对象缓存（与上线前一样只有预压缩那一层）
  assert.equal(h.body.caches.predBoard, undefined);
});

test('账号关闭但显式设了 TRUST_PROXY：按设置信任代理', async (t) => {
  const s = await startServer(t, { DB_PATH: path.join(tmp, 'off-tp.db'), ENABLE_LEADERBOARD: '0', TRUST_PROXY: 'loopback' });
  const fwd = await s.get('/api/health', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(fwd.body.proxy.ip, '1.2.3.4');
});

test('账号开启但库打不开：health 报 accounts.dbUnavailable，ok 与 HTTP 状态不变', async (t) => {
  // DB_PATH 的上级是个普通文件：mkdir 失败 → 库打不开
  const blocker = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const s = await startServer(t, {
    DB_PATH: path.join(blocker, 'x.db'), ENABLE_LEADERBOARD: '0', ENABLE_LEDGER: '0', ENABLE_ACCOUNTS: '1', SMS_PROVIDER: 'console',
  });
  assert.match(s.log(), /用户系统：开启（库不可用/);
  const h = await s.get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.deepEqual(h.body.alarms, ['accounts.dbUnavailable']);
  assert.equal(h.body.sms, null);
});

test('账号开启（排行榜关）：未登录只拿预告；登录后全量；全站上限按环境变量、报警不改健康状态', async (t) => {
  const s = await startServer(t, {
    DB_PATH: path.join(tmp, 'on.db'), ENABLE_LEADERBOARD: '0', ENABLE_ACCOUNTS: '1', SMS_PROVIDER: 'console', SMS_DAILY_CAP: '1',
  });
  assert.match(s.log(), /用户系统：开启；国内短信 console；海外 off/);

  const meta = (await s.get('/api/meta')).body;
  assert.equal(meta.features.accounts.enabled, true);
  assert.equal(meta.features.accounts.overseas, false);

  // 未登录：三个接口都只有预告，且不进共享缓存、按 Authorization 区分
  const paper = await s.get('/api/paper');
  assert.equal(paper.status, 200);
  assert.equal(paper.body.locked, true);
  assert.equal(paper.body.reason, 'anonymous');
  assert.equal('ledger' in paper.body, false);
  assert.equal('backtest' in paper.body, false);
  assert.equal(paper.headers.get('cache-control'), 'private, no-store');
  assert.match(paper.headers.get('vary') ?? '', /Authorization/i);

  const sum = await s.get('/api/predictions/summary');
  assert.equal(sum.body.locked, true);
  assert.equal(sum.body.reason, 'anonymous');
  assert.ok(sum.body.summary.length <= 1);
  assert.equal('games' in sum.body, false);
  assert.equal('overall' in sum.body, false);
  assert.match(sum.headers.get('vary') ?? '', /Authorization/i);
  assert.equal(sum.headers.get('cache-control'), 'private, no-store');

  const sh = await s.get('/api/shadow');
  assert.equal(sh.body.locked, true);
  assert.equal(sh.body.reason, 'anonymous');
  assert.deepEqual(Object.keys(sh.body).sort(), ['available', 'locked', 'reason']);

  // 假令牌：会话失效
  assert.equal((await s.get('/api/paper', { token: 'bogus' })).body.reason, 'session');

  const { token } = await login(s, '13800138000');
  assert.doesNotMatch(s.log(), /13800138000/, '日志里不能有完整号码');
  const full = await s.get('/api/paper', { token });
  assert.ok('backtest' in full.body && 'ledger' in full.body);
  assert.equal('locked' in full.body, false);
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  const fullSum = await s.get('/api/predictions/summary', { token, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(fullSum.status, 200);
  assert.ok(fullSum.body.overall);
  assert.equal('locked' in fullSum.body, false);
  const vary = fullSum.headers.get('vary') ?? '';
  assert.match(vary, /Authorization/i);
  assert.match(vary, /Accept-Encoding/i);
  assert.equal('locked' in (await s.get('/api/shadow', { token })).body, false);

  // SMS_DAILY_CAP=1：第二个号码被全站上限挡住；health 报警，但 ok 与 HTTP 状态不变
  const cap = await s.post('/api/auth/code', { cc: '86', phone: '13900139000', consent: true });
  assert.equal(cap.status, 503);
  assert.equal(cap.body.code, 'auth.smsDailyCap');
  const h = await s.get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.deepEqual(h.body.alarms, ['sms.dailyCapReached']);
  assert.equal(h.body.sms.sentToday, 1);
  assert.equal(h.body.sms.cap, 1);
  assert.equal(h.body.sms.mainland, 'console');
  assert.equal(h.body.sms.overseas, 'off');
  // 开启时预测总表走对象缓存（锁定预告与放行全量共用）
  assert.ok(h.body.caches.predBoard >= 1);

  // 回环代理被信任：X-Forwarded-For 生效
  const fwd = await s.get('/api/health', { headers: { 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(fwd.body.proxy.ip, '9.9.9.9');
});

test('账号开启（排行榜开）：排行榜令牌访问被锁接口按未登录；会话令牌兼作玩家身份', async (t) => {
  const s = await startServer(t, { DB_PATH: path.join(tmp, 'lb.db'), ENABLE_ACCOUNTS: '1', SMS_PROVIDER: 'console' });
  const anon = (await s.post('/api/players', { name: '小明' })).body;
  assert.equal(typeof anon.token, 'string');

  // 排行榜匿名令牌不是会话：anonymous，不是 session
  const p = await s.get('/api/paper', { token: anon.token });
  assert.equal(p.body.locked, true);
  assert.equal(p.body.reason, 'anonymous');

  // 登录时带上匿名令牌 → 绑定该档案；之后会话令牌在 requireAuth / 本季实战里都认作这个玩家
  const v = await login(s, '13700137000', { anonToken: anon.token });
  assert.equal(v.outcome, 'bound');
  assert.equal(v.player.id, anon.id);
  const me = await s.get('/api/me', { token: v.token });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body.id, anon.id);
  const live = await s.get('/api/live', { token: v.token });
  assert.equal(live.body.signedIn, true);
  // 匿名令牌照旧可用
  assert.equal((await s.get('/api/me', { token: anon.token })).body.id, anon.id);
  // 退出后会话令牌不再是玩家身份
  await s.post('/api/auth/logout', {}, { token: v.token });
  assert.equal((await s.get('/api/me', { token: v.token })).status, 401);
});
