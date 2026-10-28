import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SHADOW_SCHEMA, RR_SHADOW_SCHEMA } from '../server/db.mjs';
import { insertShadow, settleShadow, shadowAll, shadowRows, shadowSummary } from '../server/injuryShadow.mjs';
import { RR_COLS, pregameStore, rrAll, rrBoard, rrRows } from '../server/rosterResultsShadow.mjs';
import { resultsUpdate, gamePred } from '../server/rosterResults.mjs';
import { normalCdf, restAdjust } from '../server/lab.mjs';
import { MINUTES_SHRINK } from '../server/impactShrink.mjs';

const PARAMS = JSON.parse(fs.readFileSync(new URL('../server/roster-results-params-v1.json', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(SHADOW_SCHEMA + RR_SHADOW_SCHEMA); return db; };

const D = '2026-10-28';
const NOW = Date.parse('2026-10-28T14:05:00Z'); // 北京 22:05
const IDS = [1, 2, 3, 4];
const IMP = { 1: 2, 2: 0, 3: -1, 4: -1 };

function store({ games = [], fetchedAt = '2026-10-28T13:50:00.000Z', impactModel = {}, teams = IDS } = {}) {
  return {
    meta: { leagueAvg: { pace: 100 }, fetchedAt },
    teams: IDS.map((teamId) => ({ teamId, adv: { pace: 100 } })),
    players: teams.flatMap((teamId) => Array.from({ length: 6 }, (_, i) => ({
      playerId: teamId * 10 + i, teamId, onRoster: true, name: `P${teamId}-${i}`,
      gp: 60, min: 20, impact: IMP[teamId], cur: { gp: 3, min: 40, impact: IMP[teamId] },
    }))),
    injuries: { fetchedAt: '2026-10-28T13:00:00.000Z', players: [] },
    impactModel,
    schedule: { games },
  };
}
const legacy = IDS.map((teamId) => ({ teamId, elo: 1500, total: 0, rank: teamId }));
const done = (date, homeId, awayId, homeScore, awayScore, o = {}) => ({
  gameId: `${date}-${homeId}-${awayId}`, type: 'regular', date, neutral: false, homeId, awayId, homeScore, awayScore, ...o,
});
const PAST = [
  done('2026-10-22', 1, 2, 100, 110), done('2026-10-22', 3, 4, 120, 95),
  done('2026-10-24', 2, 3, 99, 101), done('2026-10-24', 4, 1, 90, 115, { neutral: true }),
];
// 同一比赛日的早场已完赛：不能进晚场的评级
const SAME_DAY = done(D, 3, 4, 140, 80);
const slateOf = (tipoff = '2026-10-28T23:30:00Z', o = {}) => [{
  gameId: 'g12', date: D, tipoff, homeId: 1, awayId: 2, neutral: false, restHome: 0, restAway: 2, ...o,
}];
const board = (s, now = NOW) => rrBoard({ store: s, legacy, D, params: PARAMS, now });

test('冻结参数：K=12、近期加权 0.4/60 天、sd 12、主场 1.6、休息 1.8；IMP 收缩常数与代码一致', () => {
  assert.equal(PARAMS.version, 1);
  assert.equal(PARAMS.K, 12);
  assert.deepEqual(PARAMS.recency, { ratio: 0.4, days: 60 });
  assert.equal(PARAMS.spreadSd, 12);
  assert.equal(PARAMS.homeAdv, 1.6);
  assert.equal(PARAMS.restWeight, 1.8);
  assert.equal(PARAMS.maxDataAgeH, 36);
  assert.deepEqual(PARAMS.impShrink.minutes, MINUTES_SHRINK);
});

test('rr 行的胜率 = 回测口径：Φ((r主 − r客 + 1.6 + 休息项)/12)，r 用比赛日之前的赛果、近期加权基准 = 比赛日', () => {
  const b = board(store({ games: [...PAST, SAME_DAY] }));
  assert.equal(b.ok, true, b.reason);
  const { rows, skipped } = rrRows({ slate: slateOf(), slot: '22', now: NOW, params: PARAMS, board: b, code: 'abc' });
  assert.deepEqual(skipped, []);
  assert.deepEqual(rows.map((r) => r.variant), ['rr22']);
  const r = rows[0];
  // 回测 seasonPreds 的同一步：done = 更早日期的完赛，resultsUpdate(先验, done, K, recency asOf = 比赛日)，再 gamePred
  const priors = new Map([...b.byTeam].map(([id, x]) => [id, x.priorTotal]));
  const ref = resultsUpdate(priors, PAST.map((g) => ({
    homeId: g.homeId, awayId: g.awayId, margin: g.homeScore - g.awayScore, hca: g.neutral ? 0 : 1.6, date: g.date,
  })), PARAMS.K, { recency: { ratio: 0.4, days: 60, asOf: D }, tol: 1e-6 });
  const rh = ref.get(1).rating; const ra = ref.get(2).rating;
  const rest = (restAdjust(0) - restAdjust(2)) * 1.8;
  const want = rh - ra + 1.6 + rest;
  assert.ok(Math.abs(r.rating_home - r.prior_home) > 0.3 && Math.abs(r.rating_away - r.prior_away) > 0.3, '战绩修正确实生效');
  near(r.rating_home, rh, 0.011); near(r.rating_away, ra, 0.011); // 榜的 total 保留两位小数
  near(r.margin, r.rating_home - r.rating_away + 1.6 + rest, 1e-9);
  near(r.margin, want, 0.025);
  near(r.p_home, normalCdf(r.margin, 12), 1e-12);
  near(r.p_home, normalCdf(want, 12), 1e-3);
  assert.deepEqual(gamePred(rh, ra, 1.6, rest, 12), { margin: want, p: normalCdf(want, 12) });
  assert.equal(r.hca, 1.6);
  near(r.rest_pts, rest);
  assert.equal(r.results_through, '2026-10-24');
  assert.equal(r.results_as_of, D);
  assert.equal(r.board_fetched_at, '2026-10-28T13:50:00.000Z');
  assert.equal(r.injuries_fetched_at, '2026-10-28T13:00:00.000Z');
  assert.equal(r.params_version, 1);
  assert.equal(r.board_code, 'abc');
  assert.equal(JSON.parse(r.inputs).resultsN, PAST.length);
});

test('赛前性：比赛日当天已完赛的早场不影响评级；之后日期的比分也抹掉', () => {
  const a = board(store({ games: PAST }));
  const b = board(store({ games: [...PAST, SAME_DAY, done('2026-10-30', 1, 2, 150, 60)] }));
  assert.deepEqual([...a.byTeam], [...b.byTeam]);
  assert.equal(b.resultsThrough, '2026-10-24');
  const pre = pregameStore(store({ games: [...PAST, SAME_DAY] }), D);
  assert.equal(pre.schedule.games.find((g) => g.date === D).homeScore, null);
  assert.equal(pre.schedule.games.filter((g) => g.homeScore != null).length, PAST.length);
});

test('中立场主场项为 0；06:30 前开打的场 22:00 那次同时记 rr0630；06:30 那次只记 rr0630；已开赛不记', () => {
  const b = board(store({ games: PAST }));
  const neutral = rrRows({ slate: slateOf(undefined, { neutral: true }), slot: '22', now: NOW, params: PARAMS, board: b }).rows[0];
  assert.equal(neutral.hca, 0);
  assert.equal(neutral.neutral, 1);
  const early = rrRows({ slate: slateOf('2026-10-28T19:00:00Z'), slot: '22', now: NOW, params: PARAMS, board: b }).rows;
  assert.deepEqual(early.map((r) => r.variant), ['rr22', 'rr0630']);
  assert.equal(early[0].margin, early[1].margin);
  const late = Date.parse('2026-10-28T22:35:00Z');
  const lb = board(store({ games: PAST, fetchedAt: '2026-10-28T22:20:00.000Z' }), late);
  assert.deepEqual(rrRows({ slate: slateOf(), slot: '0630', now: late, params: PARAMS, board: lb }).rows.map((r) => r.variant), ['rr0630']);
  assert.equal(rrRows({ slate: slateOf('2026-10-28T22:00:00Z'), slot: '0630', now: late, params: PARAMS, board: lb }).rows.length, 0);
  assert.equal(rrRows({ slate: slateOf(), slot: '0630', now: NOW, params: PARAMS, board: b }).rows.length, 0, '不在时点窗口');
});

test('榜不可用只跳过 rr 行：数据超过 36 小时、缺 IMP 模型、某队没有 total、收缩常数不符、榜抛错', () => {
  const cases = [
    [store({ games: PAST, fetchedAt: '2026-10-27T01:00:00.000Z' }), /小时/],
    [store({ games: PAST, fetchedAt: '2026-10-28T15:00:00.000Z' }), /未来/],
    [store({ games: PAST, impactModel: null }), /impact-model/],
    [{ ...store(), teams: null }, /榜计算失败/],
  ];
  for (const [s, re] of cases) {
    const b = board(s);
    assert.equal(b.ok, false);
    assert.match(b.reason, re);
    const { rows, skipped } = rrRows({ slate: slateOf(), slot: '22', now: NOW, params: PARAMS, board: b });
    assert.equal(rows.length, 0);
    assert.match(skipped[0].why, re);
  }
  const bad = rrBoard({ store: store({ games: PAST }), legacy, D, params: { ...PARAMS, impShrink: { minutes: { k: 1, pivot: 1 } } }, now: NOW });
  assert.match(bad.reason, /收缩常数/);
  // 第 4 队没人：按队隔离（roster-fixes-batch1），只有 4 队 total 为 null——涉及 4 队的场跳过，其余照记
  const missing = board(store({ games: PAST, teams: [1, 2, 3] }));
  assert.equal(missing.ok, true);
  assert.equal(missing.byTeam.get(4).total, null);
  assert.ok(Number.isFinite(missing.byTeam.get(1).total));
  const r = rrRows({ slate: slateOf(undefined, { awayId: 4 }), slot: '22', now: NOW, params: PARAMS, board: missing });
  assert.equal(r.rows.length, 0);
  assert.match(r.skipped[0].why, /没有 total/);
  assert.equal(rrRows({ slate: slateOf(), slot: '22', now: NOW, params: PARAMS, board: missing }).rows.length, 1);
});

// ---------------------------------------------------------------- 库

const INJ = {
  version: 1, opts: { unknownV: -1, repl: -2 },
  slots: { 22: { beta: 0.6, pPlay: {} }, '0630': { beta: 0.65, pPlay: {} } },
};
const baseSlate = () => slateOf().map((g) => ({ ...g, margin: 2, dataAt: 'x' }));

test('隔离：rr 行被库拒或榜不可用，base 照记；base 与 rr 分在两张表', () => {
  const db = fresh();
  const base = shadowRows({ slate: baseSlate(), slot: '22', now: NOW, params: INJ, values: null, reports: [], teams: [] });
  assert.deepEqual(base.map((r) => r.variant), ['base']);
  assert.equal(insertShadow(db, base).n, 1);
  const { rows } = rrRows({ slate: slateOf(), slot: '22', now: NOW, params: PARAMS, board: board(store({ games: PAST })) });
  const res = insertShadow(db, [{ ...rows[0], game_id: 'bad', p_home: null }, ...rows], { table: 'shadow_rr_predictions', cols: RR_COLS });
  assert.equal(res.n, 1);
  assert.deepEqual(res.rejected.map((r) => r.game_id), ['bad']);
  assert.equal(shadowAll(db).length, 1);
  assert.equal(rrAll(db).length, 1);
  // 榜挂了：rr 零行，base 不受影响（调用方先插 base，再单独 try rr）
  const none = rrRows({ slate: slateOf(), slot: '22', now: NOW, params: PARAMS, board: board({ teams: null }) });
  assert.equal(none.rows.length, 0);
  assert.equal(insertShadow(db, none.rows, { table: 'shadow_rr_predictions', cols: RR_COLS }).n, 0);
  assert.equal(shadowAll(db).length, 1);
});

test('rr 表只追加：重复忽略、不能删、预测字段不能改、开赛后 / 用了当天赛果 / 未来快照的插不进；比分只写一次', () => {
  const db = fresh();
  const opt = { table: 'shadow_rr_predictions', cols: RR_COLS };
  const { rows } = rrRows({ slate: slateOf(), slot: '22', now: NOW, params: PARAMS, board: board(store({ games: PAST })) });
  assert.equal(insertShadow(db, rows, opt).n, 1);
  assert.equal(insertShadow(db, [{ ...rows[0], p_home: 0.99 }], opt).n, 0);
  assert.notEqual(rrAll(db)[0].p_home, 0.99);
  assert.throws(() => db.exec('DELETE FROM shadow_rr_predictions'), /只追加/);
  assert.throws(() => db.exec('UPDATE shadow_rr_predictions SET p_home = 0.99'), /只追加/);
  assert.throws(() => db.exec("UPDATE shadow_rr_predictions SET results_through = '2026-10-27'"), /只追加/);
  const one = (o) => insertShadow(db, [{ ...rows[0], game_id: `x${Object.keys(o).join()}${Object.values(o).join()}`, ...o }], opt).rejected;
  assert.match(one({ results_through: D })[0].why, /当天或之后/);
  assert.match(one({ results_as_of: '2026-10-29' })[0].why, /当天或之后/);
  assert.match(one({ board_fetched_at: '2026-10-28T14:30:00.000Z' })[0].why, /未来/);
  assert.match(one({ tipoff_utc: '2020-01-01T00:00:00.000Z' })[0].why, /开赛/);
  assert.match(one({ captured_at: '2026-10-29T00:00:00.000Z' })[0].why, /开赛/);
  assert.match(one({ variant: 'r22' })[0].why, /CHECK/);
  assert.equal(one({ results_through: null }).length, 0, '开季第一天没有赛果可以记');
  assert.equal(settleShadow(db, { g12: { homeScore: 100, awayScore: 90 } }, undefined, 'shadow_rr_predictions'), 1);
  assert.equal(settleShadow(db, { g12: { homeScore: 80, awayScore: 90 } }, undefined, 'shadow_rr_predictions'), 0);
  assert.throws(() => db.exec('UPDATE shadow_rr_predictions SET home_win = 0'), /只追加/);
  // 原表不受影响：rr 的变体名插不进旧表
  assert.throws(() => db.prepare(`INSERT INTO shadow_predictions (game_id, variant, params_version, captured_at, game_date, tipoff_utc, home_id, away_id, base_margin, margin, p_home)
    VALUES ('g', 'rr22', 1, '2098-01-01T00:00:00.000Z', '2098-01-01', '2099-01-01T00:00:00.000Z', 1, 2, 0, 0, 0.5)`).run(), /CHECK/);
});

test('汇总：rr22 / rr0630 与基线按同一批场次配对，rrProgress 按 rr0630', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const won = i % 3 !== 0 ? 1 : 0;
    const b = { game_id: `g${i}`, settled_at: 'x', home_win: won };
    rows.push({ ...b, variant: 'base', p_home: 0.6 });
    rows.push({ ...b, variant: 'rr0630', p_home: won ? 0.7 : 0.5 });
    if (i < 12) rows.push({ ...b, variant: 'rr22', p_home: 0.6 });
  }
  rows.push({ game_id: 'solo', variant: 'rr0630', p_home: 0.5, settled_at: 'x', home_win: 1 });
  const s = shadowSummary(rows, { B: 200 });
  const v = Object.fromEntries(s.variants.map((x) => [x.variant, x]));
  assert.deepEqual(s.variants.map((x) => x.variant), ['base', 'r22', 'r0630', 'rr22', 'rr0630']);
  assert.equal(v.rr0630.n, 31);
  assert.equal(v.rr0630.paired, 30, '没有基线的那场不进配对');
  assert.equal(s.rrProgress, 30);
  assert.equal(s.progress, 0);
  near(v.rr22.dLogLoss.mean, 0);
  assert.ok(v.rr0630.dLogLoss.mean < 0 && v.rr0630.dBrier.mean < 0);
});
