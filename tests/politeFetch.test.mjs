import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chromeHeaders, jitter, pacer, cookieJar, createPoliteClient, CHROME_MAJOR,
} from '../server/politeFetch.mjs';
import { nbaHeaders, selectTransport, seasonIsFinal, cacheFresh } from '../server/nbaClient.mjs';
import { nodeTransport } from '../server/politeFetch.mjs';
import {
  buildFetchExpression, parseEvalResult, openCdp, chromeTransport,
} from '../server/chromeTransport.mjs';

// ---------------------------------------------------------------- 请求头

test('请求头：macOS Chrome，UA 与 sec-ch-ua 平台、版本一致，带 sec-fetch-*', () => {
  const h = nbaHeaders;
  assert.match(h['User-Agent'], /Macintosh; Intel Mac OS X/);
  assert.match(h['User-Agent'], new RegExp(`Chrome/${CHROME_MAJOR}\\.`));
  assert.equal(h['sec-ch-ua-platform'], '"macOS"');
  assert.match(h['sec-ch-ua'], new RegExp(`"Google Chrome";v="${CHROME_MAJOR}"`));
  assert.equal(h['sec-ch-ua-mobile'], '?0');
  assert.equal(h['sec-fetch-site'], 'same-site');
  assert.equal(h['sec-fetch-mode'], 'cors');
  assert.equal(h['sec-fetch-dest'], 'empty');
  assert.equal(h.Referer, 'https://www.nba.com/');
  assert.equal(h.Origin, 'https://www.nba.com');
  assert.equal(h['x-nba-stats-origin'], 'stats');
  assert.equal(h['x-nba-stats-token'], 'true');
  assert.ok(!('Connection' in h));
  // Chrome 的发送顺序：平台提示在最前，UA 在 sec-ch-ua 之前，Referer 在 sec-fetch-* 之后
  const keys = Object.keys(h);
  assert.equal(keys[0], 'sec-ch-ua-platform');
  assert.ok(keys.indexOf('User-Agent') < keys.indexOf('sec-ch-ua'));
  assert.ok(keys.indexOf('sec-fetch-dest') < keys.indexOf('Referer'));
});

test('请求头：按站点换 Referer/Origin，不带 NBA 专用头', () => {
  const h = chromeHeaders({ referer: 'https://www.espn.com/', origin: 'https://www.espn.com' });
  assert.equal(h.Referer, 'https://www.espn.com/');
  assert.equal(h.Origin, 'https://www.espn.com');
  assert.ok(!Object.keys(h).some((k) => k.startsWith('x-nba')));
});

// ---------------------------------------------------------------- 节奏

test('jitter 落在闭区间内，两端都取得到', () => {
  assert.equal(jitter(900, 1800, () => 0), 900);
  assert.equal(jitter(900, 1800, () => 0.999999), 1800);
  for (let i = 0; i < 500; i++) {
    const v = jitter(900, 1800);
    assert.ok(v >= 900 && v <= 1800 && Number.isInteger(v));
  }
});

test('pacer：平时在间隔区间里，每 10–20 个再加一段 5–15 秒长停顿', () => {
  const next = pacer({ gapMs: [900, 1800], pauseEvery: [10, 20], pauseMs: [5000, 15000] });
  const gaps = Array.from({ length: 200 }, next);
  const long = gaps.filter((g) => g > 1800);
  assert.ok(gaps.every((g) => g >= 900 && g <= 1800 + 15000));
  assert.ok(long.every((g) => g >= 5900));
  assert.ok(long.length >= 10 && long.length <= 20, `长停顿 ${long.length} 次`);
});

// ---------------------------------------------------------------- cookie

test('cookie 罐：记下 Set-Cookie、带回去，Max-Age=0 删除', () => {
  const jar = cookieJar();
  jar.store(['ak_bmsc=abc; Domain=.nba.com; Path=/; HttpOnly', 'bm_sv=x=y; Max-Age=7200']);
  assert.equal(jar.header(), 'ak_bmsc=abc; bm_sv=x=y');
  jar.store(['ak_bmsc=gone; Max-Age=0']);
  assert.equal(jar.header(), 'bm_sv=x=y');
});

// ---------------------------------------------------------------- 熔断、上限、状态文件

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polite-')), 'state.json');

/** 假传输：按顺序吐出预设响应，记下每次收到的请求头 */
function fakeTransport(responses) {
  const calls = [];
  return {
    calls,
    async request(url, opts) {
      calls.push({ url, headers: opts.headers });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { setCookie: [], ...r };
    },
  };
}

function client(transport, extra = {}) {
  let t = 1_000_000;
  return createPoliteClient({
    name: 'test', headers: { A: '1' }, transport, gapMs: [0, 0], pauseEvery: null,
    now: () => t, sleep: async () => {}, log: () => {}, statePath: tmpState(), ...extra,
    ...(extra.clock ? { now: extra.clock } : {}),
  });
}

const ok = (v) => ({ status: 200, text: JSON.stringify(v) });

test('成功的请求把 Set-Cookie 带到下一次请求', async () => {
  const tr = fakeTransport([{ ...ok(1), setCookie: ['s=1; Path=/'] }, ok(2)]);
  const c = client(tr);
  assert.equal(await c.get('u1'), 1);
  assert.equal(await c.get('u2'), 2);
  assert.equal(tr.calls[0].headers.Cookie, undefined);
  assert.equal(tr.calls[1].headers.Cookie, 's=1');
});

for (const [label, resp] of [
  ['403', { status: 403, text: 'Access Denied' }],
  ['429', { status: 429, text: '' }],
  ['非 JSON', { status: 200, text: '<html>challenge</html>' }],
  ['超时', Object.assign(new Error('40000ms 内没有响应'), { code: 'TIMEOUT' })],
]) {
  test(`熔断：第一次 ${label} 就停掉整次运行，不重试、后续请求不再发出`, async () => {
    const tr = fakeTransport([resp, ok(1), ok(2)]);
    const c = client(tr, { tries: 5 });
    await assert.rejects(c.get('a'), { code: 'BLOCKED' });
    await assert.rejects(c.get('b'), { code: 'BLOCKED' });
    assert.equal(tr.calls.length, 1);
  });
}

test('熔断写进状态文件；下次运行在冷却期内一个请求都不发，过期后才放行，成功后清零', async () => {
  const statePath = tmpState();
  let t = 1_000_000;
  const clock = () => t;
  const base = { statePath, clock, backoffBaseMs: 60_000 };

  await assert.rejects(client(fakeTransport([{ status: 403, text: '' }]), base).get('x'), { code: 'BLOCKED' });
  const s1 = JSON.parse(fs.readFileSync(statePath, 'utf8')).test;
  assert.equal(s1.failures, 1);
  assert.equal(s1.nextAllowedAt, t + 60_000);

  // 冷却期内的新一次运行
  const tr2 = fakeTransport([ok(1)]);
  await assert.rejects(client(tr2, base).get('x'), /冷却中/);
  assert.equal(tr2.calls.length, 0);

  // 冷却过后又被拦：冷却翻倍
  t += 61_000;
  await assert.rejects(client(fakeTransport([{ status: 403, text: '' }]), base).get('x'), { code: 'BLOCKED' });
  const s2 = JSON.parse(fs.readFileSync(statePath, 'utf8')).test;
  assert.equal(s2.failures, 2);
  assert.equal(s2.nextAllowedAt, t + 120_000);

  // 再过冷却期，成功一次就清零
  t += 121_000;
  assert.equal(await client(fakeTransport([ok(7)]), base).get('x'), 7);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).test.failures, 0);
});

test('冷却封顶 backoffMaxMs', async () => {
  const statePath = tmpState();
  fs.writeFileSync(statePath, JSON.stringify({ test: { failures: 30, nextAllowedAt: 0 } }));
  const t = 5_000_000;
  await assert.rejects(client(fakeTransport([{ status: 403, text: '' }]), {
    statePath, clock: () => t, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000,
  }).get('x'));
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).test.nextAllowedAt, t + 3_600_000);
});

test('5xx 和连接错误缓一缓再试，不熔断', async () => {
  const tr = fakeTransport([{ status: 503, text: '' }, new Error('ECONNRESET'), ok(3)]);
  assert.equal(await client(tr, { tries: 3 }).get('x'), 3);
  assert.equal(tr.calls.length, 3);
});

test('404：notFoundOk 时返回 null；400 报错但不熔断', async () => {
  const c = client(fakeTransport([{ status: 404, text: '' }, { status: 400, text: '' }, ok(1)]));
  assert.equal(await c.get('x', { notFoundOk: true }), null);
  await assert.rejects(c.get('y'), /HTTP 400/);
  assert.equal(await c.get('z'), 1);
});

test('单次运行上限：到了就抛 CAP，不再发请求', async () => {
  const tr = fakeTransport([ok(1), ok(2), ok(3)]);
  const c = client(tr, { maxPerRun: 2 });
  await c.get('a');
  await c.get('b');
  await assert.rejects(c.get('c'), { code: 'CAP' });
  assert.equal(tr.calls.length, 2);
});

test('单日上限跨运行累计，换一天清零', async () => {
  const statePath = tmpState();
  let t = Date.parse('2026-10-27T10:00:00Z');
  const base = { statePath, clock: () => t, maxPerDay: 2 };
  await client(fakeTransport([ok(1)]), base).get('a');
  const c2 = client(fakeTransport([ok(1), ok(2)]), base);
  await c2.get('b');
  await assert.rejects(c2.get('c'), { code: 'CAP' });
  t = Date.parse('2026-10-28T10:00:00Z');
  assert.equal(await client(fakeTransport([ok(9)]), base).get('d'), 9);
});

// ---------------------------------------------------------------- 传输选择与缓存

test('NBA_TRANSPORT 选传输：默认 node，chrome 走浏览器，其他值报错', () => {
  assert.equal(selectTransport({}), nodeTransport);
  assert.equal(selectTransport({ NBA_TRANSPORT: 'node' }), nodeTransport);
  const ct = selectTransport({ NBA_TRANSPORT: 'chrome' });
  assert.notEqual(ct, nodeTransport);
  assert.equal(typeof ct.request, 'function');
  assert.throws(() => selectTransport({ NBA_TRANSPORT: 'curl' }), /node 或 chrome/);
});

test('往季接口缓存永久有效，本季只在 TTL 内', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const prior = 'https://stats.nba.com/stats/x?LeagueID=00&Season=2025-26';
  const cur = 'https://stats.nba.com/stats/x?LeagueID=00&Season=2026-27';
  assert.equal(seasonIsFinal(prior, now), true);
  assert.equal(seasonIsFinal(cur, now), false);
  assert.equal(seasonIsFinal('https://stats.nba.com/stats/x?LeagueID=00', now), false);
  // 7 月前，刚打完的季后赛那一季还算当季
  assert.equal(seasonIsFinal(prior, new Date('2026-05-01T12:00:00Z')), false);
  const old = { fetchedAt: now.getTime() - 3 * 3600_000 };
  assert.equal(cacheFresh(old, prior, now.getTime()), true);
  assert.equal(cacheFresh(old, cur, now.getTime()), false);
  assert.equal(cacheFresh({ fetchedAt: now.getTime() - 60_000 }, cur, now.getTime()), true);
  assert.equal(cacheFresh(null, prior, now.getTime()), false);
});

// ---------------------------------------------------------------- CDP

test('页面内 fetch 表达式：不带 credentials（include 过不了 CORS）、只带 x- 自定义头、带超时', () => {
  const expr = buildFetchExpression('https://stats.nba.com/stats/a?b=1', nbaHeaders, 30000);
  assert.match(expr, /^fetch\("https:\/\/stats\.nba\.com\/stats\/a\?b=1"/);
  assert.doesNotMatch(expr, /credentials/);
  assert.match(expr, /"x-nba-stats-origin":"stats"/);
  assert.match(expr, /AbortSignal\.timeout\(30000\)/);
  assert.doesNotMatch(expr, /User-Agent|Referer|sec-ch-ua/);
});

test('解析 Runtime.evaluate 结果：正常、超时、被拦（Failed to fetch）、其他异常', () => {
  assert.deepEqual(parseEvalResult({ result: { value: { status: 200, text: '{}' } } }), { status: 200, text: '{}', setCookie: [] });
  assert.throws(() => parseEvalResult({ exceptionDetails: { exception: { description: 'TimeoutError: signal timed out' } } }), { code: 'TIMEOUT' });
  assert.equal(parseEvalResult({ exceptionDetails: { exception: { description: 'TypeError: Failed to fetch' } } }).status, 0);
  assert.throws(() => parseEvalResult({ exceptionDetails: { text: 'SyntaxError' } }), /页面内执行出错/);
});

/** 假 WebSocket：自动应答 CDP 命令，navigate 之后补发 loadEventFired */
class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.handlers = {};
    FakeWS.last = this;
    setImmediate(() => this.emit('open'));
  }
  addEventListener(ev, fn) { (this.handlers[ev] ??= []).push(fn); }
  emit(ev, data) { for (const fn of this.handlers[ev] ?? []) fn(data); }
  reply(obj) { setImmediate(() => this.emit('message', { data: JSON.stringify(obj) })); }
  send(raw) {
    const m = JSON.parse(raw);
    this.sent.push(m);
    if (m.method === 'Page.navigate') this.reply({ method: 'Page.loadEventFired', params: {} });
    if (m.method === 'Runtime.evaluate' && !m.params.awaitPromise) {
      this.reply({ id: m.id, result: { result: { value: { title: 'NBA Stats', url: 'https://www.nba.com/stats', webdriver: false } } } });
    } else if (m.method === 'Runtime.evaluate') {
      this.reply({ id: m.id, result: { result: { value: { status: 200, text: '{"resultSets":[]}' } } } });
    } else {
      this.reply({ id: m.id, result: {} });
    }
  }
  close() { this.closed = true; }
}

test('CDP 会话：命令带递增 id，按 id 配对响应，error 变成 reject', async () => {
  const cdp = await openCdp('ws://x', FakeWS);
  const ws = FakeWS.last;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true });
  assert.deepEqual(ws.sent.map((m) => m.id), [1, 2]);
  assert.equal(ws.sent[1].method, 'Runtime.evaluate');
  ws.send = (raw) => { const m = JSON.parse(raw); ws.reply({ id: m.id, error: { message: 'boom' } }); };
  await assert.rejects(cdp.send('X.y'), /CDP X\.y: boom/);
});

test('浏览器传输：连上现有 nba.com 标签页、预热一次、页面内 fetch 拿到结果', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'http://127.0.0.1:9999/json/list');
    return { json: async () => [{ type: 'page', url: 'https://www.nba.com/', webDebuggerUrl: '', webSocketDebuggerUrl: 'ws://tab' }] };
  };
  const t = chromeTransport({ port: 9999, fetchImpl, WebSocketImpl: FakeWS, log: () => {} });
  const r1 = await t.request('https://stats.nba.com/stats/a', { headers: nbaHeaders, timeoutMs: 1000 });
  const r2 = await t.request('https://stats.nba.com/stats/b', { headers: nbaHeaders, timeoutMs: 1000 });
  assert.equal(r1.status, 200);
  assert.equal(r2.text, '{"resultSets":[]}');
  const ws = FakeWS.last;
  assert.equal(ws.url, 'ws://tab');
  assert.equal(ws.sent.filter((m) => m.method === 'Page.navigate').length, 1);
  assert.equal(ws.sent.find((m) => m.method === 'Page.navigate').params.url, 'https://www.nba.com/stats');
  const fetches = ws.sent.filter((m) => m.method === 'Runtime.evaluate' && m.params.awaitPromise);
  assert.equal(fetches.length, 2);
  assert.ok(fetches.every((m) => m.params.returnByValue));
});

test('浏览器传输：Chrome 没开时给出能照做的报错', async () => {
  const t = chromeTransport({ port: 9999, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, WebSocketImpl: FakeWS });
  await assert.rejects(t.request('u', { headers: {}, timeoutMs: 1 }), /scripts\/nba-chrome\.sh/);
});

test('浏览器传输：预热页面就被 403，报 BLOCKED', async () => {
  class Denied extends FakeWS {
    send(raw) {
      const m = JSON.parse(raw);
      if (m.method === 'Runtime.evaluate') { this.reply({ id: m.id, result: { result: { value: { title: 'Access Denied' } } } }); return; }
      super.send(raw);
    }
  }
  const fetchImpl = async () => ({ json: async () => [{ type: 'page', url: 'https://www.nba.com/stats', webSocketDebuggerUrl: 'ws://t' }] });
  const t = chromeTransport({ port: 9999, fetchImpl, WebSocketImpl: Denied, log: () => {} });
  await assert.rejects(t.request('u', { headers: {}, timeoutMs: 1 }), { code: 'BLOCKED' });
});
