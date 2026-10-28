import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { msg, codedError, sendError, publicCode } from '../server/messages.mjs';
import { lookup } from '../web/src/i18n/core.js';

const dir = path.resolve('web/src/i18n/locales');
const locales = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  locales[f.replace(/\.js$/, '')] = (await import(pathToFileURL(path.join(dir, f)).href)).default;
}

const fakeRes = () => {
  const r = { status(s) { r.code = s; return r; }, json(b) { r.body = b; return r; } };
  return r;
};

test('msg 默认 params 为空对象', () => {
  assert.deepEqual(msg('err.sameTeams'), { code: 'err.sameTeams', params: {} });
  assert.deepEqual(msg('err.unknownTeam', { teamId: 9 }), { code: 'err.unknownTeam', params: { teamId: 9 } });
});

test('codedError 带 code 与参数，message 仍是中文', () => {
  const e = codedError('err.unknownTeam', '未知球队: 9', { teamId: 9 });
  assert.equal(e.code, 'err.unknownTeam');
  assert.deepEqual(e.params, { teamId: 9 });
  assert.match(e.message, /未知球队/);
  assert.ok(e instanceof Error);
});

test('sendError：error 保留中文，extra 并入但不能覆盖 code', () => {
  const r = fakeRes();
  sendError(r, 503, 'err.storageUnavailable', '服务端存储不可用', {}, { reason: 'R', log: 'L', code: 'evil' });
  assert.equal(r.code, 503);
  assert.deepEqual(r.body, { reason: 'R', log: 'L', error: '服务端存储不可用', code: 'err.storageUnavailable', params: {} });
});

test('publicCode：只转发 err.* ，Node 内部码与缺省都变 err.internal', () => {
  assert.equal(publicCode(codedError('err.unknownTeam', 'x')), 'err.unknownTeam');
  for (const c of ['ENOENT', 'ERR_SQLITE_ERROR', 'TIMEOUT', 'errx', undefined, 42]) {
    const e = new Error('boom'); e.code = c;
    assert.equal(publicCode(e), 'err.internal', String(c));
  }
  assert.equal(publicCode(new Error('plain')), 'err.internal');
  assert.equal(publicCode(null), 'err.internal');
});

test('index.mjs 不再直接写 json({ error: … })，一律走 sendError', () => {
  const src = fs.readFileSync('server/index.mjs', 'utf8');
  assert.deepEqual(src.match(/\.json\(\{\s*error\s*:/g) ?? [], []);
});

// 扫 server/*.mjs 里出现的消息码字面量
function serverCodes() {
  const out = new Set();
  for (const f of fs.readdirSync('server').filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join('server', f), 'utf8');
    for (const m of src.matchAll(/(?:msg|codedError)\(\s*'((?:err|srv)\.[\w.]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/sendError\(\s*\w+\s*,\s*\d+\s*,\s*'((?:err|srv)\.[\w.]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/(?:reasonCode|ReasonCode|REASON_CODE)\b[^\n]*/g)) {
      for (const k of m[0].matchAll(/'(srv\.[\w.]+)'/g)) out.add(k[1]);
    }
    for (const m of src.matchAll(/disabledReason\)\s*\?\s*'(srv\.[\w.]+)'/g)) out.add(m[1]);
  }
  return out;
}

test('服务端出现的每个消息码在所有语言里都有', () => {
  const codes = serverCodes();
  // 扫描器自检：确实扫到了关键码，避免正则失效后空转通过
  for (const c of ['err.rateLimited', 'err.sameTeams', 'err.unknownTeam', 'err.refreshFailed', 'srv.reason.leaderboardOff',
    'srv.reason.ledgerOff', 'srv.reason.liveOff', 'srv.reason.dbUnavailable', 'srv.reason.ledgerUnavailable']) {
    assert.ok(codes.has(c), `扫描器漏了 ${c}`);
  }
  assert.ok(codes.size >= 18, `只扫到 ${codes.size} 个`);
  for (const code of codes) {
    for (const [lang, dict] of Object.entries(locales)) {
      assert.equal(typeof lookup(dict, code), 'string', `${lang} 缺 ${code}`);
    }
  }
  assert.equal(typeof lookup(locales.en, 'err.internal'), 'string');
});

test('接口：错误响应带 code/params 且保留中文 error（真实进程）', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(port), ENABLE_LEADERBOARD: '0', ENABLE_LEDGER: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.ok(ready, '服务没起来');
  const post = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let r = await post('/api/predict', { homeId: 1, awayId: 1 });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: '两队不能相同', code: 'err.sameTeams', params: {} });
  r = await post('/api/predict', {});
  assert.deepEqual(await r.json(), { error: '需要 homeId 与 awayId', code: 'err.needTeams', params: {} });
  r = await post('/api/predict', { homeId: 999999, awayId: 1 });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.code, 'err.unknownTeam');
  assert.deepEqual(b.params, { teamId: 999999 });
  r = await fetch(`http://127.0.0.1:${port}/api/meta`);
  const meta = await r.json();
  assert.equal(meta.features.leaderboardReasonCode, 'srv.reason.leaderboardOff');
  assert.match(meta.features.leaderboardReason, /ENABLE_LEADERBOARD=0/);
  r = await fetch(`http://127.0.0.1:${port}/api/paper`);
  const paper = await r.json();
  assert.equal(paper.ledger.reasonCode, 'srv.reason.ledgerOff');
  assert.equal(paper.ledger.reason, 'ENABLE_LEDGER=0');
});
