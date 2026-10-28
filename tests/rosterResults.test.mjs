import test from 'node:test';
import assert from 'node:assert/strict';
import { resultsUpdate, RESULTS } from '../server/rosterResults.mjs';
import { liveRosterRankings, seasonResults } from '../server/liveRosterRankings.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const priors = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

test('没有比赛或 K=∞：强度就是先验', () => {
  const p = priors({ 1: 3, 2: -1 });
  const none = resultsUpdate(p, [], 10);
  assert.equal(none.get(1).rating, 3);
  assert.equal(none.get(1).n, 0);
  assert.equal(none.get(1).adjResult, null);
  const inf = resultsUpdate(p, [{ homeId: 1, awayId: 2, margin: -30, hca: 1.6 }], Infinity);
  assert.equal(inf.get(1).rating, 3);
  assert.equal(inf.get(2).rating, -1);
  assert.equal(inf.get(1).n, 1);
});

test('两队一场中立场、先验都为 0：解析解 r = m/(K+2)', () => {
  const K = 10;
  const r = resultsUpdate(priors({ 1: 0, 2: 0 }), [{ homeId: 1, awayId: 2, margin: 12, hca: 0 }], K);
  close(r.get(1).rating, 12 / (K + 2));
  close(r.get(2).rating, -12 / (K + 2));
});

test('主场项先扣掉：主队恰好赢主场优势那么多，强度不动', () => {
  const r = resultsUpdate(priors({ 1: 0, 2: 0 }), [{ homeId: 1, awayId: 2, margin: 1.6, hca: 1.6 }], 5);
  close(r.get(1).rating, 0);
  close(r.get(2).rating, 0);
});

test('每队都满足 r = (K·先验 + n·对手调整净胜分)/(K+n)', () => {
  const p = priors({ 1: 4, 2: 1, 3: -2, 4: -3 });
  const games = [
    { homeId: 1, awayId: 2, margin: -7, hca: 1.6 }, { homeId: 3, awayId: 4, margin: 15, hca: 1.6 },
    { homeId: 2, awayId: 3, margin: 3, hca: 0 }, { homeId: 4, awayId: 1, margin: -20, hca: 1.6 },
    { homeId: 1, awayId: 3, margin: 2, hca: 1.6 },
  ];
  const K = 7;
  const r = resultsUpdate(p, games, K);
  for (const [id, x] of r) close(x.rating, (K * p.get(id) + x.n * x.adjResult) / (K + x.n));
  // 净胜分零和、先验均值为 0 时，后验均值也为 0
  close([...r.values()].reduce((s, x) => s + x.rating, 0), [...p.values()].reduce((s, v) => s + v, 0));
});

test('战绩越多先验权重越低：同样的表现重复 n 场，强度越来越接近表现', () => {
  const at = (n) => resultsUpdate(priors({ 1: 0, 2: 0, 3: 0 }),
    Array.from({ length: n }, () => ({ homeId: 1, awayId: 3, margin: 10, hca: 0 })), 10).get(1).rating;
  assert.ok(at(1) < at(5));
  assert.ok(at(5) < at(40));
});

test('对手调整：同样净胜 10 分，赢强队比赢弱队加得多', () => {
  const p = priors({ 1: 0, 2: 6, 3: -6 });
  const vsStrong = resultsUpdate(p, [{ homeId: 1, awayId: 2, margin: 10, hca: 0 }], 10).get(1).rating;
  const vsWeak = resultsUpdate(p, [{ homeId: 1, awayId: 3, margin: 10, hca: 0 }], 10).get(1).rating;
  assert.ok(vsStrong > vsWeak);
});

test('cap：单场净胜分截断（只做敏感性）', () => {
  const p = priors({ 1: 0, 2: 0 });
  const g = [{ homeId: 1, awayId: 2, margin: 40, hca: 0 }];
  close(resultsUpdate(p, g, 10, { cap: 20 }).get(1).rating, 20 / 12);
});

test('floor：先验权重不低于下限；不触及下限时与基础版相同', () => {
  const p = priors({ 1: 5, 2: -5 });
  const many = Array.from({ length: 200 }, () => ({ homeId: 2, awayId: 1, margin: 10, hca: 0 }));
  const r = resultsUpdate(p, many, 4, { floor: 0.2 }).get(1);
  close(r.priorWeight, 0.2);
  close(r.rating, 0.2 * 5 + 0.8 * r.adjResult);
  const few = many.slice(0, 3);
  close(resultsUpdate(p, few, 4, { floor: 0.2 }).get(1).rating, resultsUpdate(p, few, 4).get(1).rating);
});

test('recency：旧比赛权重按 ratio^(天数/days) 衰减，近期比赛影响更大', () => {
  const p = priors({ 1: 0, 2: 0 });
  const rec = { ratio: 0.4, days: 60, asOf: '2026-12-20' };
  const old = { homeId: 1, awayId: 2, margin: 20, hca: 0, date: '2026-10-21' }; // 60 天前
  const recent = { homeId: 1, awayId: 2, margin: -20, hca: 0, date: '2026-12-19' };
  const r = resultsUpdate(p, [old, recent], 8, { recency: rec }).get(1);
  close(r.weight, 0.4 + 0.4 ** (1 / 60));
  assert.ok(r.rating < 0, '近期输 20 分的权重大于 60 天前赢 20 分');
  close(r.rating, (r.weight * r.adjResult) / (8 + r.weight));
});

// ---------------------------------------------------------------- 接入阵容榜

function store(games = []) {
  return {
    meta: { leagueAvg: { pace: 100 }, fetchedAt: '2026-10-27T15:00:00Z' },
    teams: [1, 2].map((teamId) => ({ teamId, adv: { pace: 100 } })),
    players: [1, 2].flatMap((teamId) => Array.from({ length: 6 }, (_, i) => ({
      playerId: teamId * 10 + i, teamId, onRoster: true, name: `Player ${teamId}-${i}`,
      gp: 60, min: 20, impact: teamId === 1 ? 1 : 0,
      cur: { gp: 3, min: 40, impact: teamId === 1 ? 1 : 0 },
    }))),
    injuries: { fetchedAt: '2026-10-27T15:00:00Z', players: [] },
    schedule: { games },
  };
}
const legacy = [1, 2].map((teamId) => ({ teamId, elo: 1500, total: 0, rank: teamId, turnoverAdj: 0 }));
const game = (o) => ({ type: 'regular', date: '2026-10-21', neutral: false, homeId: 2, awayId: 1, homeScore: null, awayScore: null, ...o });

test('阵容榜：只计已完赛常规赛，季前赛与未开赛不算', () => {
  const g = seasonResults(store([
    game({ homeScore: 130, awayScore: 100 }),
    game({ type: 'preseason', homeScore: 150, awayScore: 80 }),
    game({}),
    game({ neutral: true, homeScore: 100, awayScore: 110 }),
  ]));
  assert.deepEqual(g, [
    { homeId: 2, awayId: 1, date: '2026-10-21', margin: 30, hca: 1.6 },
    { homeId: 2, awayId: 1, date: '2026-10-21', margin: -10, hca: 0 },
  ]);
});

test('阵容榜：没有赛果时 total = priorTotal；有赛果时按 K 修正并可改变名次', () => {
  const before = liveRosterRankings(store(), legacy);
  assert.equal(before[0].teamId, 1);
  // 先验数值由 roster-fixes-batch1 的分钟口径决定（6 人 × 40 分钟 → 单人上限 38），这里只验 total = priorTotal
  assert.ok(before[0].priorTotal > 0);
  assert.equal(before[0].total, before[0].priorTotal);
  assert.equal(before[0].resultsAdj, 0);
  assert.equal(before[0].rosterProjection.results.games, 0);
  assert.equal(before[0].rosterProjection.results.k, RESULTS.K);
  assert.deepEqual(before[0].rosterProjection.results.recency, RESULTS.recency);

  // 2 队主场连赢 1 队 4 场、每场 30 分
  const games = Array.from({ length: 4 }, () => game({ homeScore: 130, awayScore: 100 }));
  const after = liveRosterRankings(store(games), legacy, { results: { K: 2 } });
  const t1 = after.find((r) => r.teamId === 1); const t2 = after.find((r) => r.teamId === 2);
  assert.equal(after[0].teamId, 2);
  assert.equal(t1.priorTotal, before[0].priorTotal);
  close(t1.total, t1.priorTotal + t1.resultsAdj, 0.011);
  assert.ok(t1.resultsAdj < 0 && t2.resultsAdj > 0);
  assert.equal(t1.rosterProjection.results.games, 4);
  close(t1.rosterProjection.results.priorWeight, 2 / 6, 0.01);
  assert.equal(t1.modelDelta, t1.total);
  assert.equal(t1.legacyTotal, 0);
});

test('阵容榜：线上近期加权以美东今天为基准，记录有效场数', () => {
  const games = [game({ date: '2026-08-28', homeScore: 130, awayScore: 100 })];
  const rows = liveRosterRankings(store(games), legacy, { now: new Date('2026-10-28T03:00:00Z') });
  const res = rows.find((r) => r.teamId === 1).rosterProjection.results;
  assert.equal(res.asOf, '2026-10-27');
  close(res.effectiveGames, 0.4 ** (60 / 60), 0.01);
  assert.equal(res.games, 1);
});

test('阵容榜：某队先验算不出来 → 该队 total/priorTotal 为 null，与它的比赛不进战绩修正，其余照常', () => {
  const s = store([game({ homeScore: 130, awayScore: 100 })]);
  s.teams.push({ teamId: 3, adv: { pace: 0 } }); // 节奏无效 → 该队先验失败
  s.players.push({ playerId: 30, teamId: 3, onRoster: true, name: 'P3', gp: 60, min: 30, impact: 5, cur: { gp: 3, min: 30, impact: 5 } });
  s.schedule.games.push(game({ homeId: 3, awayId: 1, homeScore: 140, awayScore: 90 }));
  const rows = liveRosterRankings(s, [...legacy, { teamId: 3, elo: 1500, total: 0, rank: 3, turnoverAdj: 0 }]);
  const t3 = rows.find((r) => r.teamId === 3); const t1 = rows.find((r) => r.teamId === 1);
  assert.equal(t3.total, null); assert.equal(t3.priorTotal, null); assert.equal(t3.rank, null);
  assert.ok(t3.rosterProjection.error);
  assert.ok(Number.isFinite(t1.total));
  assert.equal(t1.rosterProjection.results.games, 1, '与 3 队的比赛不计入');
  assert.deepEqual(rows.filter((r) => r.rank != null).map((r) => r.rank).sort(), [1, 2]);
});
