import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { apply, features, FEATURES, MIN_GP } from '../server/impact.mjs';
import { buildSnapshot, saveSeasonSnapshot, snapshotDate, SNAPSHOT_DIR } from '../server/seasonSnapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = path.join(ROOT, 'tests/fixtures/ingest-offline.mjs');
const SNAP_REL = `${SNAPSHOT_DIR}/2026-27/2026-11-04.json.gz`;

/** 合成模型：15 个特征都有非零系数，打错任何一项输入，SPM 都会变 */
const MODEL = {
  features: FEATURES,
  mu: FEATURES.map((_, i) => 1 + i * 0.5),
  sd: FEATURES.map((_, i) => 1 + i * 0.1),
  beta: FEATURES.map((_, i) => (i % 2 ? -1 : 1) * (0.2 + i * 0.03)),
  intercept: 0.5,
  scale: 1.5,
  blendW: 0.35,
  decaySpan: 3,
  decayHalfLife: 1,
  builtAt: '2026-10-29T14:50:22.495Z',
  seasons: ['2024-25', '2025-26'],
};

const tempDir = (t, label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dc-nba-snap-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** 同 deploy/refresh.sh：把代码拷到临时目录再跑 ingest，碰不到仓库的 data/ */
function fillStage(dir) {
  for (const d of ['server', 'scripts']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.mkdirSync(path.join(dir, 'data/history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/impact-model.json'), JSON.stringify(MODEL));
  return dir;
}
const makeStage = (t, label) => fillStage(tempDir(t, label));

function runIngest(dir, { now = '2026-11-04T07:30:00Z' } = {}) {
  const countFile = path.join(dir, 'counts.json');
  const env = {
    PATH: process.env.PATH, ALLOW_NO_APM: '1', PRIOR_SEASON: '2025-26', TARGET_SEASON: '2026-27',
    OFFLINE_NOW: now, OFFLINE_COUNT_FILE: countFile,
  };
  const r = spawnSync(process.execPath, ['--import', PRELOAD, 'scripts/ingest.mjs'], { cwd: dir, env, encoding: 'utf8' });
  return { ...r, out: r.stdout + r.stderr, counts: JSON.parse(fs.readFileSync(countFile, 'utf8')) };
}

const readDoc = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());

/** data/*.json 全部内容（impact-model 是输入，也一起比） */
const outputs = (dir) => Object.fromEntries(fs.readdirSync(path.join(dir, 'data'))
  .filter((f) => f.endsWith('.json')).sort()
  .map((f) => [f, fs.readFileSync(path.join(dir, 'data', f), 'utf8')]));

/** 文档里的混合公式：K 可换，别的都用快照自己的字段 */
function recomputeImp(row, k) {
  if (row.priorImp === null) return row.seasonSpm;
  if (row.seasonSpm === null) return row.priorImp;
  return Math.round(((k * row.priorImp + row.gp * row.seasonSpm) / (k + row.gp)) * 100) / 100;
}

// ---- 一次真实形状的 ingest（合成联盟、假 fetch），下面几个测试共用，免得每个都跑一遍

const shared = {};
function ingestOnce() {
  if (!shared.dir) {
    shared.dir = fillStage(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-nba-snap-shared-')));
    shared.run = runIngest(shared.dir);
  }
  assert.equal(shared.run.status, 0, shared.run.out);
  return shared;
}
test.after(() => { if (shared.dir) fs.rmSync(shared.dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- 内容

test('ingest：快照逐人还原本季 SPM 与混合 IMP，且与 players.json 的 cur.impact 一致', () => {
  const { dir } = ingestOnce();
  const doc = readDoc(path.join(dir, 'data', SNAP_REL));
  const players = new Map(JSON.parse(fs.readFileSync(path.join(dir, 'data/players.json'), 'utf8')).map((p) => [p.playerId, p]));

  assert.equal(doc.season, '2026-27');
  assert.equal(doc.date, '2026-11-04');
  assert.equal(doc.imp.priorGames, 20);
  assert.equal(doc.model.id.length > 8, true);
  assert.deepEqual(doc.model.beta, MODEL.beta);

  // 合成联盟里 cur 非空的 11 人（Injured Vet 本季没上场，不进快照；Unrostered 进快照但不在 players.json）
  assert.equal(doc.players.length, 11);
  assert.equal(doc.players.some((r) => r.playerId === 303), false);

  for (const r of doc.players) {
    const minGp = r.priorImp === null ? doc.imp.minGpNoPrior : doc.imp.minGpWithPrior;
    assert.equal(apply(doc.model, r, { minGp }), r.seasonSpm, `SPM ${r.name}`);
    assert.equal(recomputeImp(r, doc.imp.priorGames), r.blendedImp, `IMP ${r.name}`);

    const p = players.get(r.playerId);
    if (r.playerId === 403) { assert.equal(p, undefined); continue; }
    assert.equal(p.cur.impact, r.blendedImp, `cur.impact ${r.name}`);
    assert.equal(p.impact ?? null, r.priorImp, `prior ${r.name}`);
    assert.equal(p.cur.gp, r.gp);
    assert.equal(p.cur.min, r.min);
    assert.equal(p.teamAbbr, r.teamAbbr);
    assert.deepEqual(r.features, Object.fromEntries(FEATURES.map((k) => [k, Math.round(features(p.cur)[k] * 1e4) / 1e4])), `features ${r.name}`);
  }
});

test('ingest：各种情形都按当时的规则记录（无先验不足 20 场 null、低分钟只剩先验、转队、拼抢缺失）', () => {
  const { dir } = ingestOnce();
  const by = new Map(readDoc(path.join(dir, 'data', SNAP_REL)).players.map((r) => [r.playerId, r]));

  const short = by.get(202);
  assert.deepEqual([short.priorImp, short.seasonSpm, short.blendedImp], [null, null, null]);
  assert.equal(typeof apply(MODEL, short, { minGp: 1 }), 'number', '输入还在：换门槛能重算');

  const enough = by.get(201);
  assert.equal(enough.priorImp, null);
  assert.equal(enough.blendedImp, enough.seasonSpm);
  assert.equal(enough.gp >= MIN_GP, true);

  const low = by.get(103);
  assert.equal(low.seasonSpm, null);
  assert.equal(low.blendedImp, low.priorImp);

  assert.equal(by.get(301).teamAbbr, 'CHI', '名单上的队优先于本季统计行的队');

  const noHustle = by.get(302);
  assert.deepEqual(noHustle.hustle, { deflections: null, contested: null, screenAstPts: null });
  assert.deepEqual(noHustle.featuresMissing, ['defl', 'contest', 'screen']);
  assert.deepEqual(by.get(101).featuresMissing, []);
});

test('换 K 能从快照重算：手算一例，K=20 与 K=40 不同', () => {
  const row = {
    gp: 6, min: 30, priorImp: 2, seasonSpm: 5.54, name: 'x',
    base: {}, adv: {}, hustle: {}, defend: {}, track: {},
  };
  assert.equal(recomputeImp(row, 20), 2.82); // (20×2 + 6×5.54) / 26 = 2.8169
  assert.equal(recomputeImp(row, 40), 2.46); // (40×2 + 6×5.54) / 46 = 2.4617
});

test('dSup 能从原始输入还原：-diffPct × 每 36 分钟被防出手', () => {
  const entry = {
    player: { playerId: 1, name: 'LeBron', teamId: 9, teamAbbr: 'LAL' },
    cur: {
      gp: 6, min: 30, impact: 1,
      base: { pts: 20, fga: 15 }, adv: { tsPct: 0.6, usgPct: 0.3 },
      hustle: { deflections: 2, contested: 5, screenAstPts: 1 },
      defend: { dFga: 10, diffPct: -0.1 }, track: { potentialAst: 8 },
    },
    prior: 1,
    seasonSpm: 1,
  };
  const doc = buildSnapshot({ season: '2026-27', model: MODEL, priorGames: 20, entries: [entry], now: new Date('2026-11-04T07:30:00Z') });
  assert.equal(doc.players[0].features.dSup, 1.2); // 0.1 × 10×36/30
  assert.equal(doc.players[0].defend.diffPct, -0.1);
  assert.equal(doc.players[0].defend.dFga, 10);
});

test('buildSnapshot 不改动传进来的对象', () => {
  const freeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(o); };
  const entry = freeze({
    player: { playerId: 1, name: 'A', teamId: 9, teamAbbr: 'LAL' },
    cur: { gp: 1, min: 20, impact: 1, base: {}, adv: {}, hustle: {}, defend: {}, track: {} },
    prior: 1,
    seasonSpm: 1,
  });
  assert.doesNotThrow(() => buildSnapshot({ season: 's', model: freeze(structuredClone(MODEL)), priorGames: 20, entries: [entry], now: new Date() }));
});

// ---------------------------------------------------------------- 日期

test('文件名按北京日期：GB10 在太平洋时区，北京 15:30 那边还是前一天', () => {
  assert.equal(snapshotDate(new Date('2026-11-04T07:30:00Z')), '2026-11-04');
  assert.equal(snapshotDate(new Date('2026-11-03T15:59:59Z')), '2026-11-03');
  assert.equal(snapshotDate(new Date('2026-11-03T16:00:00Z')), '2026-11-04');
});

// ---------------------------------------------------------------- 失败容忍

test('写不了快照：ingest 仍退出 0、输出逐字节不变、请求数不变，并留下一行能被 push-refresh 日志捞到的警告', (t) => {
  const normal = ingestOnce();
  const dir = makeStage(t, 'blocked');
  fs.writeFileSync(path.join(dir, 'data', SNAPSHOT_DIR), '占位：这里本该是目录'); // mkdir 必失败

  const r = runIngest(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /赛季快照.*失败/);
  assert.deepEqual(outputs(dir), outputs(normal.dir));
  assert.deepEqual(r.counts, normal.run.counts);

  const push = fs.readFileSync(path.join(ROOT, 'deploy/push-refresh.sh'), 'utf8');
  assert.match(push, /grep -E "[^"]*赛季快照[^"]*"/, 'ingest 的输出进的是临时日志，push-refresh 要把这行捞进 full-push.log');
});

test('saveSeasonSnapshot 任何异常都不外抛', (t) => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const base = { season: '2026-27', model: MODEL, priorGames: 20, now: new Date('2026-11-04T07:30:00Z'), warn, log: () => {} };
  const dataDir = tempDir(t, 'throws');
  const poison = { get player() { throw new Error('boom'); } };

  assert.equal(saveSeasonSnapshot({ ...base, dataDir, entries: [poison] }).status, 'failed');
  const entry = { player: { playerId: 1 }, cur: { gp: 1, min: 20, impact: 1 }, prior: 1, seasonSpm: 1 };
  assert.equal(saveSeasonSnapshot({ ...base, dataDir: null, entries: [entry] }).status, 'failed');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /赛季快照.*失败/);
  assert.equal(fs.existsSync(path.join(dataDir, SNAPSHOT_DIR)), false);
});

test('rename 失败：报失败，不留临时文件', (t) => {
  const dataDir = tempDir(t, 'rename');
  const target = path.join(dataDir, SNAP_REL);
  fs.mkdirSync(target, { recursive: true }); // 目标是目录，rename 必失败
  const entry = { player: { playerId: 1 }, cur: { gp: 1, min: 20, impact: 1 }, prior: 1, seasonSpm: 1 };
  const r = saveSeasonSnapshot({
    season: '2026-27', model: MODEL, priorGames: 20, dataDir, entries: [entry], now: new Date('2026-11-04T07:30:00Z'), log: () => {}, warn: () => {},
  });
  assert.equal(r.status, 'failed');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['2026-11-04.json.gz']);
});

test('没有本季出场数据或没有模型：跳过，不写文件', (t) => {
  const dataDir = tempDir(t, 'skip');
  const base = { season: '2026-27', priorGames: 20, now: new Date(), dataDir, log: () => {}, warn: () => assert.fail('跳过不算失败') };
  assert.equal(saveSeasonSnapshot({ ...base, model: MODEL, entries: [] }).status, 'skipped');
  assert.equal(saveSeasonSnapshot({ ...base, model: MODEL, entries: undefined }).status, 'skipped');
  assert.equal(saveSeasonSnapshot({ ...base, model: null, entries: [{}] }).status, 'skipped');
  assert.equal(fs.existsSync(path.join(dataDir, SNAPSHOT_DIR)), false);
});

// ---------------------------------------------------------------- 幂等

test('同一天重跑：同样的数据不改文件（连 capturedAt 也不变），且只有一个文件', (t) => {
  const dir = makeStage(t, 'rerun');
  assert.equal(runIngest(dir).status, 0);
  const file = path.join(dir, 'data', SNAP_REL);
  const first = fs.readFileSync(file);

  // 40 分钟后重跑：本季响应 1 小时内走缓存，数据不变
  const again = runIngest(dir, { now: '2026-11-04T08:10:00Z' });
  assert.equal(again.status, 0, again.out);
  assert.equal(again.counts['stats.nba.com'] ?? 0, 0, '全部命中缓存');
  assert.deepEqual(fs.readFileSync(file), first);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['2026-11-04.json.gz']);
});

test('同一天数据变了：换成最新的那份；文件坏了也能覆盖；不留临时文件', (t) => {
  const dataDir = tempDir(t, 'replace');
  const entry = (gp) => ({
    player: { playerId: 1, name: 'A', teamId: 9, teamAbbr: 'LAL' },
    cur: { gp, min: 20, impact: 1, base: {}, adv: {}, hustle: {}, defend: {}, track: {} },
    prior: 1,
    seasonSpm: 1,
  });
  const base = { season: '2026-27', model: MODEL, priorGames: 20, dataDir, log: () => {}, warn: () => assert.fail('不该失败') };
  const save = (gp, iso) => saveSeasonSnapshot({ ...base, entries: [entry(gp)], now: new Date(iso) });

  assert.equal(save(1, '2026-11-04T07:30:00Z').status, 'written');
  const file = path.join(dataDir, SNAP_REL);
  assert.equal(save(1, '2026-11-04T07:40:00Z').status, 'unchanged');
  assert.equal(readDoc(file).capturedAt, '2026-11-04T07:30:00.000Z');

  assert.equal(save(2, '2026-11-04T07:50:00Z').status, 'written');
  assert.equal(readDoc(file).players[0].gp, 2);
  assert.equal(readDoc(file).capturedAt, '2026-11-04T07:50:00.000Z');

  fs.writeFileSync(file, '坏了');
  assert.equal(save(2, '2026-11-04T07:55:00Z').status, 'written');
  assert.equal(readDoc(file).players[0].gp, 2);

  assert.equal(save(2, '2026-11-05T07:30:00Z').status, 'written');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['2026-11-04.json.gz', '2026-11-05.json.gz']);
});

// ---------------------------------------------------------------- 输出不变

/** 加快照之前的 ingest。以后 ingest 有意改了输出，把这里换成那次提交（server/ 两边用的是同一份，不受影响） */
const BASELINE_COMMIT = '112170e';

test('输出与请求数和加快照之前的 ingest 逐字节相同', (t) => {
  const normal = ingestOnce();
  let source;
  try {
    source = execFileSync('git', ['show', `${BASELINE_COMMIT}:scripts/ingest.mjs`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip(`取不到 ${BASELINE_COMMIT}（浅克隆？）`);
    return;
  }
  assert.doesNotMatch(source, /seasonSnapshot/);
  const dir = makeStage(t, 'baseline');
  fs.writeFileSync(path.join(dir, 'scripts/ingest.mjs'), source);

  const r = runIngest(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(outputs(normal.dir), outputs(dir));
  assert.deepEqual(normal.run.counts, r.counts);
  assert.equal(fs.existsSync(path.join(dir, 'data', SNAPSHOT_DIR)), false, '基线确实没写快照');
});

// ---------------------------------------------------------------- 请求数

test('快照代码本身不碰网络：不 import 客户端、不调 fetch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/seasonSnapshot.mjs'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\b|nbaGet|createPoliteClient|espn|oddsClient/i);
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./impact.mjs', './nbaClient.mjs', 'node:child_process', 'node:crypto', 'node:fs', 'node:path']);
});

test('stats.nba.com 请求数等于 master 的请求序列', () => {
  const { run } = ingestOnce();
  // master（112170e）的序列，缓存为空时：赛程 1 + 两季（积分榜 1 + 球队 4 + 球员 3 + 估计 1 + 拼抢 1 + 对位 1 + 追踪 7）
  // + 阵容 4 队 + 逐场 3 季。合成联盟 4 队；30 队时是 70，与真实响应离线重放 master 的计数相同。
  assert.equal(run.counts['stats.nba.com'], 1 + 2 * 18 + 4 + 3);
});

// ---------------------------------------------------------------- 位置

test('位置：被 gitignore、不进镜像、不被 data/*.json 推送；GB10 快进不动它', (t) => {
  execFileSync('git', ['check-ignore', '-q', `data/${SNAP_REL}`], { cwd: ROOT }); // 没被忽略会抛错
  assert.match(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'), /^data\/history$/m);
  assert.equal(SNAPSHOT_DIR.startsWith('history/'), true);

  // push-refresh.sh 与 refresh.sh --incoming 只认 data/ 顶层的 *.json
  assert.match(fs.readFileSync(path.join(ROOT, 'deploy/push-refresh.sh'), 'utf8'), /tar -c (--exclude=\S+ )*data\/\*\.json/);
  assert.match(fs.readFileSync(path.join(ROOT, 'deploy/refresh.sh'), 'utf8'), /cp "\$DIR"\/incoming\/\*\.json "\$STAGE\/data\/"/);

  // 照 push-refresh.sh 的步骤走一遍快进
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const origin = tempDir(t, 'origin');
  git(origin, 'init', '-q', '-b', 'master');
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(origin, '.gitignore'));
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'one');

  const gb10 = path.join(tempDir(t, 'gb10'), 'dc-nba');
  execFileSync('git', ['clone', '-q', origin, gb10]);
  const snap = path.join(gb10, 'data', SNAP_REL);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.writeFileSync(snap, 'x');
  assert.equal(git(gb10, 'status', '--porcelain', '--untracked-files=no'), '', '快照不算本地改动，定时器不会因此整次不跑');
  assert.equal(git(gb10, 'status', '--porcelain'), '', '连 untracked 也不算');

  fs.writeFileSync(path.join(origin, 'new.txt'), 'y');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'two');
  git(gb10, 'fetch', '-q', 'origin', 'master');
  git(gb10, 'merge', '-q', '--ff-only', 'origin/master');
  assert.equal(fs.existsSync(path.join(gb10, 'new.txt')), true);
  assert.equal(fs.readFileSync(snap, 'utf8'), 'x');
});
