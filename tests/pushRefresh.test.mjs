// deploy/push-refresh.sh 的推送集合与日志行：直接从脚本里取出那一行用 sh 跑，测的是真实的 tar / grep 参数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'deploy/push-refresh.sh'), 'utf8');

/** 脚本里以 prefix 开头的那一行（去掉前导空白）；必须恰好一行 */
const line = (prefix) => {
  const hits = SCRIPT.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(prefix));
  assert.equal(hits.length, 1, `push-refresh.sh 里应恰好有一行以 ${prefix} 开头`);
  return hits[0];
};

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-nba-push-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const sh = (cwd, script, env = {}) => spawnSync('sh', ['-eu', '-c', script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

// 线上 data/ 顶层的全部文件（2026-11-05 服务器实际列表）
const LIVE = [
  'backtest.json', 'gameday.json', 'impact-model.json', 'injuries.json', 'meta.json', 'moneyline-backtest.json',
  'odds.json', 'paper-backtest.json', 'player-values.json', 'players.json', 'positions.json', 'results.json',
  'schedule.json', 'teams.json',
];
// 只由别的途径维护、全量推送永远不带的
const NEVER_PUSHED = ['backtest.json', 'player-values.json'];

test('推送集合：data/ 顶层 *.json 去掉 backtest.json 与 player-values.json，其余一个不少', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'data/history'), { recursive: true });
  for (const f of LIVE) fs.writeFileSync(path.join(dir, 'data', f), '{}');
  fs.writeFileSync(path.join(dir, 'data/history/gamelog_2025-26.json'), '[]');

  // 取到管道之前：tar -c ... data/*.json
  const tarCmd = line('tar -c ').split('|')[0].trim();
  const r = sh(dir, `${tarCmd} | tar -t`);
  assert.equal(r.status, 0, r.stderr);
  const pushed = r.stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(pushed, LIVE.filter((f) => !NEVER_PUSHED.includes(f)).map((f) => `data/${f}`).sort());
});

test('推送集合：GB10 那份 101 字节的空壳 backtest.json 也不会进包', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/backtest.json'),
    '{"seasons":{},"teamAdv":{},"odds":{"seasons":{},"providers":{}},"builtAt":"2026-11-04T07:31:00.000Z"}');
  fs.writeFileSync(path.join(dir, 'data/teams.json'), '[]');
  const r = sh(dir, `${line('tar -c ').split('|')[0].trim()} | tar -t`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n').filter(Boolean), ['data/teams.json']);
});

test('ingest 日志摘要：一行都没匹配上也不让 set -e 退出；匹配上就照印', (t) => {
  const dir = tmp(t);
  const grepCmd = line('grep -E ');
  assert.match(grepCmd, /\|\| true$/);
  const log = path.join(dir, 'dc-nba-ingest.log');

  fs.writeFileSync(log, '· 其他输出\n');
  let r = sh(dir, `${grepCmd}; echo 之后照跑`, { TMPDIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '之后照跑\n');

  fs.writeFileSync(log, '完成，用时 1.0s\n  已吸收 2026-27 赛季 3 场\n  赛季快照写入失败：x\n无关\n');
  r = sh(dir, `${grepCmd}; echo 之后照跑`, { TMPDIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '完成，用时 1.0s\n  已吸收 2026-27 赛季 3 场\n  赛季快照写入失败：x\n之后照跑\n');

  // 日志文件不在（grep 退出 2）也一样不中断
  fs.rmSync(log);
  r = sh(dir, `${grepCmd} 2>/dev/null; echo 之后照跑`, { TMPDIR: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '之后照跑\n');
});
