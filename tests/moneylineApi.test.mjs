import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMoneylineReport } from '../server/moneylineReport.mjs';
import { openLedger } from '../server/db.mjs';
import { captureRows, insertBets, settleBets } from '../server/ledger.mjs';
import { SPLITS } from '../server/betSplits.mjs';

// 全部用临时目录里的库与报告（ML_REPORT 指向提交在库里的裁剪件现算的报告），绝不碰 data/app.db 与 data/moneyline-backtest.json
const fx = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)))).toString('utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-api-'));
const reportPath = path.join(tmp, 'report.json');
const report = buildMoneylineReport({ dataset: fx('backtest-mini.json.gz'), books: fx('books/mini-cache.json.gz'), inputsSha: {} });
fs.writeFileSync(reportPath, JSON.stringify({ ...report, builtAt: '2026-10-28T00:00:00Z' }));

const NOW = Date.parse('2026-11-01T12:00:00Z');
const slate = [
  { gameId: 'F1', date: '2026-11-01', tipoff: '2026-11-01T23:30:00Z', homeId: 1, awayId: 2, pHome: 0.62, odds: { provider: 'DraftKings', homeMl: -110, awayMl: -110 } },
  { gameId: 'F2', date: '2026-11-01', tipoff: '2026-11-01T23:30:00Z', homeId: 3, awayId: 4, pHome: 0.40, odds: { provider: 'DraftKings', homeMl: -150, awayMl: 130 } },
  { gameId: 'F3', date: '2026-11-01', tipoff: '2026-11-02T00:30:00Z', homeId: 5, awayId: 6, pHome: 0.55, odds: { provider: 'DraftKings', homeMl: -200, awayMl: 170 } },
];

async function startServer(t, env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(port), ENABLE_LEADERBOARD: '0', NODE_ENV: 'test', ...env },
    stdio: 'ignore',   // 不读也不留管道，避免缓冲写满卡住子进程
  });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.ok(ready, '服务没起来');
  const base = `http://127.0.0.1:${port}`;
  return {
    get: (p) => fetch(base + p),
    post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

test('接口：meta 形状；非法情景 400 err.badFilter；前向账本关闭时说明原因', async (t) => {
  const dbPath = path.join(tmp, 'off.db');
  const s = await startServer(t, { DB_PATH: dbPath, ENABLE_LEDGER: '0', ML_REPORT: reportPath });

  let r = await s.get('/api/lab/moneyline/meta');
  assert.equal(r.status, 200);
  const meta = await r.json();
  assert.equal(meta.available, true);
  assert.equal(meta.builtAt, '2026-10-28T00:00:00Z');
  assert.deepEqual(meta.scenarios, ['close', 'open', 'closeBest', 'forward']);
  assert.deepEqual(meta.splits, JSON.parse(JSON.stringify(SPLITS)));
  assert.ok(meta.strategies.length > 0 && meta.strategies.every((x) => typeof x.id === 'string' && typeof x.family === 'string'));
  assert.ok(meta.books.includes('draftkings'));
  assert.deepEqual(meta.seasons, ['2022-23', '2023-24', '2024-25', '2025-26']);
  assert.deepEqual(meta.selected, report.selected);
  assert.equal(meta.fits.length, 4);
  assert.deepEqual(meta.integrity.map((x) => x.season), meta.seasons);
  assert.ok(meta.integrity.every((x) => typeof x.matched === 'number' && typeof x.anomalies === 'number'));
  assert.deepEqual(meta.forward, { available: false, captured: 0, pending: 0, reasonCode: 'srv.reason.ledgerOff' });

  r = await s.post('/api/lab/moneyline', { scenario: 'spread' });
  assert.equal(r.status, 400);
  let b = await r.json();
  assert.equal(b.code, 'err.badFilter');
  assert.equal(b.params.field, 'scenario');

  r = await s.post('/api/lab/moneyline', { scenario: 'forward' });
  assert.equal(r.status, 200);
  b = await r.json();
  assert.equal(b.available, false);
  assert.equal(b.reasonCode, 'srv.reason.ledgerOff');

  // 历史情景：重复请求逐字节一致；lang 不进缓存键也不影响结果；非 Filters 字段（lang）被剥掉而不是报错
  const first = await (await s.post('/api/lab/moneyline', {})).text();
  const v = JSON.parse(first);
  assert.equal(v.filters.scenario, 'close');
  assert.equal(v.filters.strategy, report.selected.close);
  assert.equal(v.labels.modelVersion, 'replay-elo-wf');
  assert.equal(await (await s.post('/api/lab/moneyline', {})).text(), first);
  assert.equal(await (await s.post('/api/lab/moneyline?lang=en', { lang: 'en', _t: 1 })).text(), first);
  assert.equal(await (await s.post('/api/lab/moneyline', { scenario: 'close', split: 'test' })).text(), first);

  // 数组 / 非法字段值仍是 400
  r = await s.post('/api/lab/moneyline', []);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).params.field, 'body');
  r = await s.post('/api/lab/moneyline', { slippagePts: 7 });
  assert.equal((await r.json()).params.field, 'slippagePts');
});

test('接口：报告缺失 → 503 err.labDataMissing（meta 为 available:false + reasonCode）', async (t) => {
  const s = await startServer(t, { DB_PATH: path.join(tmp, 'm.db'), ENABLE_LEDGER: '0', ML_REPORT: path.join(tmp, 'nope.json') });
  let r = await s.get('/api/lab/moneyline/meta');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { available: false, reasonCode: 'srv.ml.reason.noData' });
  r = await s.post('/api/lab/moneyline', {});
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'err.labDataMissing');
  // 前向账本不依赖报告
  r = await s.post('/api/lab/moneyline', { scenario: 'forward' });
  assert.equal(r.status, 200);
});

test('接口：前向账本开启时现算；账本变化（结算）后缓存失效', async (t) => {
  const dbPath = path.join(tmp, 'on.db');
  const w = openLedger(dbPath);
  assert.equal(insertBets(w, captureRows(slate, { now: NOW })), 9);
  const s = await startServer(t, { DB_PATH: dbPath, ML_REPORT: reportPath });

  let meta = await (await s.get('/api/lab/moneyline/meta')).json();
  assert.deepEqual(meta.forward, { available: true, captured: 3, pending: 3, unmatched: 0 });

  let v = await (await s.post('/api/lab/moneyline', { scenario: 'forward', split: 'all' })).json();
  assert.equal(v.labels.modelVersion, 'production-logged');
  assert.equal(v.summary.bets, 0);
  assert.equal(v.coverage.pending, 3);

  // 另一个连接结算两场；缓存键 = 行数 + 已结算数 + 最近结算时间，所以下一次请求必须看到
  settleBets(w, { F1: { homeScore: 110, awayScore: 100, close: [-120, 100] }, F2: { homeScore: 105, awayScore: 99, close: [-160, 140] } }, '2026-11-02T08:00:00Z');
  w.close();
  v = await (await s.post('/api/lab/moneyline', { scenario: 'forward', split: 'all' })).json();
  assert.equal(v.coverage.total, 2);
  assert.equal(v.coverage.pending, 1);
  meta = await (await s.get('/api/lab/moneyline/meta')).json();
  assert.deepEqual(meta.forward, { available: true, captured: 3, pending: 1, unmatched: 0 });
  // 历史情景在账本开启的部署上照常
  const h = await s.post('/api/lab/moneyline', { scenario: 'open' });
  assert.equal(h.status, 200);
});

test('线程池：worker 里抛的 err.* 码带着 params 回到调用方', async () => {
  process.env.ML_REPORT = path.join(tmp, 'nope.json');
  const pool = await import('../server/pool.mjs');
  assert.ok(pool.initPool());
  try {
    await assert.rejects(
      pool.run('labMoneyline', { filters: { scenario: 'close', split: 'test', season: null, from: null, to: null, book: 'chain', strategy: 'B-edge7', slippagePts: 0, feeOnWin: 0 } }),
      (e) => e.code === 'err.labDataMissing' && e.params.scenario === 'close',
    );
  } finally { delete process.env.ML_REPORT; }
});

test('接口：报告文件重建后（mtime 变）主线程与 worker 都读新报告，缓存不返回旧结果', async (t) => {
  const p = path.join(tmp, 'rebuilt.json');
  fs.writeFileSync(p, JSON.stringify({ ...report, builtAt: 'v1' }));
  fs.utimesSync(p, new Date(1_000_000), new Date(1_000_000));
  const s = await startServer(t, { DB_PATH: path.join(tmp, 'r.db'), ENABLE_LEDGER: '0', ML_REPORT: p });
  const other = report.selected.close === 'B-edge3' ? 'B-edge5' : 'B-edge3';
  let meta = await (await s.get('/api/lab/moneyline/meta')).json();
  assert.equal(meta.builtAt, 'v1');
  let v = await (await s.post('/api/lab/moneyline', {})).json();
  assert.equal(v.strategy, report.selected.close);

  fs.writeFileSync(p, JSON.stringify({ ...report, builtAt: 'v2', selected: { ...report.selected, close: other } }));
  fs.utimesSync(p, new Date(2_000_000), new Date(2_000_000));
  meta = await (await s.get('/api/lab/moneyline/meta')).json();
  assert.equal(meta.builtAt, 'v2');
  v = await (await s.post('/api/lab/moneyline', {})).json();
  assert.equal(v.strategy, other);
  assert.equal(v.selected, other);
});

test('接口：已结算行晚回填收盘价 / CLV 也让前向缓存失效；captured 含只有 edge3 的孤立场次', async (t) => {
  const dbPath = path.join(tmp, 'late.db');
  const w = openLedger(dbPath);
  insertBets(w, captureRows(slate, { now: NOW }));
  // 孤立：只有 edge3 行、没有同次 edge0 行
  const orphan = captureRows([{ ...slate[0], gameId: 'F9' }], { now: NOW }).filter((r) => r.rule === 'edge3');
  assert.equal(insertBets(w, orphan), 1);
  settleBets(w, { F1: { homeScore: 110, awayScore: 100, close: null } }, '2026-11-02T08:00:00Z');
  const s = await startServer(t, { DB_PATH: dbPath, ML_REPORT: reportPath });
  const q = { scenario: 'forward', split: 'all' };
  let v = await (await s.post('/api/lab/moneyline', q)).json();
  assert.equal(v.bets.length, 1);
  assert.equal(v.bets[0].clv, null);
  const meta = await (await s.get('/api/lab/moneyline/meta')).json();
  assert.deepEqual(meta.forward, { available: true, captured: 4, pending: 2, unmatched: 1 });

  // 同一场、已结算，仅回填收盘价：行数 / 已结算数 / 最近结算时间都不变
  settleBets(w, { F1: { homeScore: 110, awayScore: 100, close: [-120, 100] } }, '2026-11-02T08:00:00Z');
  w.close();
  v = await (await s.post('/api/lab/moneyline', q)).json();
  assert.equal(typeof v.bets[0].clv, 'number');
});

test('实验室：既有接口照常；线程池错误只对独赢盘直接抛出，其余仍退回主线程兜底', async (t) => {
  const s = await startServer(t, { DB_PATH: path.join(tmp, 'lab.db'), ENABLE_LEDGER: '0', ML_REPORT: reportPath });
  const r = await s.post('/api/lab/backtest', { seasons: ['2025-26'] });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).summary);
  const src = fs.readFileSync('server/index.mjs', 'utf8');
  assert.match(src, /type === 'labMoneyline' && typeof e\?\.code === 'string'/);
});
