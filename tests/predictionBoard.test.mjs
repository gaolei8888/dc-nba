import test from 'node:test';
import assert from 'node:assert/strict';
import { wilson, score, buckets, hitRateBy, buildBoard, MIN_MARKET } from '../server/predictionBoard.mjs';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// predictSchedule 的输出形状：已结束的带 hit 与比分，未结束的没有
const done = (id, date, homeId, awayId, p, hs, as, extra = {}) => ({
  gameId: id, date, homeId, awayId, homeScore: hs, awayScore: as,
  prediction: { homeWinProb: p, homeScore: 110, awayScore: 105, margin: 5 },
  hit: (p >= 0.5) === (hs > as), ...extra,
});
const next = (id, date, homeId, awayId, p) => ({
  gameId: id, date, homeId, awayId, prediction: { homeWinProb: p, homeScore: 110, awayScore: 105, margin: 5 },
});

test('wilson：已知值与边界', () => {
  const { lo, hi } = wilson(8, 10);
  near(lo, 0.4902); near(hi, 0.9433);
  assert.deepEqual(wilson(0, 0), { lo: null, hi: null });
  assert.equal(wilson(0, 5).lo, 0);
  near(wilson(5, 5).hi, 1);
});

test('score：命中数、准确率、Brier 只看主队胜率与真实胜负', () => {
  const s = score([{ p: 0.8, y: 1 }, { p: 0.6, y: 0 }, { p: 0.3, y: 0 }]);
  assert.equal(s.n, 3);
  assert.equal(s.hits, 2);
  near(s.acc, 2 / 3);
  near(s.brier, (0.04 + 0.36 + 0.09) / 3);
  assert.ok(s.ci.lo < s.acc && s.acc < s.ci.hi);
  assert.deepEqual(score([]), { n: 0, hits: 0, acc: null, ci: { lo: null, hi: null }, brier: null, logLoss: null });
});

test('buckets：按赛前信心 max(p,1-p) 分档，客队热门也按信心算', () => {
  const b = buckets([{ p: 0.55, y: 1 }, { p: 0.35, y: 1 }, { p: 0.72, y: 1 }, { p: 0.15, y: 0 }, { p: 0.85, y: 0 }]);
  assert.deepEqual(b.map((x) => x.label), ['50–60%', '60–70%', '70–80%', '80%+']);
  assert.deepEqual(b.map((x) => x.n), [1, 1, 1, 2]);
  assert.equal(b[1].hits, 0);          // 客队 65% 信心，主队却赢了
  near(b[3].conf, 0.85);               // 0.85 与 0.85 的平均
  assert.equal(b[3].hits, 1);
  assert.equal(b[0].acc, 1);
});

test('hitRateBy：一场比赛可以同时算进两支球队', () => {
  const rows = [{ keys: ['A', 'B'], hit: true }, { keys: ['A', 'C'], hit: false }];
  const t = hitRateBy(rows, (r) => r.keys);
  assert.deepEqual(t.find((x) => x.key === 'A'), { key: 'A', n: 2, hits: 1, acc: 0.5 });
  assert.equal(t.find((x) => x.key === 'C').acc, 0);
});

test('buildBoard：总结用数据说话，冷门、盘口、接下来的比赛都有', () => {
  const games = [
    done('g1', '2026-10-20', 1, 2, 0.8, 110, 100),
    done('g2', '2026-10-20', 3, 4, 0.75, 95, 101), // 高信心猜错 = 最大冷门
    done('g3', '2026-10-21', 2, 3, 0.4, 99, 108, { market: { homeProb: 0.55 } }),
    next('g4', '2026-10-22', 1, 4, 0.9),
    next('g5', '2026-10-28', 2, 4, 0.5),
    next('g6', '2026-10-29', 2, 1, 0.5), // 超出 7 天窗口
  ];
  const name = (id) => `T${id}`;
  const b = buildBoard(games, { teamName: name });
  assert.equal(b.overall.n, 3);
  assert.equal(b.overall.hits, 2);
  assert.equal(b.highConf.n, 2);
  assert.equal(b.highConf.hits, 1);
  assert.equal(b.upset.gameId, 'g2');
  assert.equal(b.market.n, 1);
  assert.equal(b.market.model.hits, 1);
  assert.equal(b.market.market.hits, 0);
  near(b.homeWinRate, 1 / 3);  // 只有 g1 主队赢
  assert.deepEqual(b.upcoming.map((g) => g.gameId), ['g4', 'g5', 'g6']);
  assert.equal(b.upcomingWeek, 2);
  assert.deepEqual(b.byDate.map((d) => [d.key, d.n]), [['2026-10-20', 2], ['2026-10-21', 1]]);
  // 已结束比赛每行带对错与盘口对错
  assert.equal(b.completed.find((g) => g.gameId === 'g3').marketHit, false);

  const text = b.summary.join('');
  assert.match(text, /已结束 3 场/);
  assert.match(text, /猜对 2 场、猜错 1 场/);
  assert.match(text, /95% 置信区间/);
  assert.match(text, /样本/);
  assert.match(text, /T4 客场击败 T3/);
  assert.match(text, /接下来 7 天/);
  assert.equal(b.market.shown, false);
  assert.match(text, /只有 1 场有盘口快照，太少/);
});

test('buildBoard：没有已结束比赛、没有盘口时如实说', () => {
  const b = buildBoard([next('g1', '2026-10-20', 1, 2, 0.6)], { teamName: String });
  assert.equal(b.overall.n, 0);
  assert.equal(b.upset, null);
  const text = b.summary.join('');
  assert.match(text, /还没有已结束/);
  assert.doesNotMatch(text, /NaN|null|undefined/);
});

test('buildBoard：盘口覆盖够了才作为参考对照', () => {
  const games = Array.from({ length: MIN_MARKET }, (_, i) =>
    done(`m${i}`, '2026-10-20', 1, 2, 0.6, 100, 90, { market: { homeProb: i ? 0.7 : 0.4 } }));
  const b = buildBoard(games, { teamName: String });
  assert.equal(b.market.shown, true);
  assert.equal(b.market.market.hits, MIN_MARKET - 1);
  assert.match(b.summary.join(''), new RegExp(`仅作参考：其中 ${MIN_MARKET} 场有盘口`));
});

test('buildBoard：全面统计——误差、基准线、切片、爆冷清单、累计命中、未开打分布', () => {
  const g = (id, date, p, hs, as, pred = {}, extra = {}) => ({
    ...done(id, date, 1, 2, p, hs, as, extra),
    prediction: { homeWinProb: p, homeScore: 110, awayScore: 100, margin: 10, total: 210, restHome: 1, restAway: 1, ...pred },
  });
  const games = [
    g('a', '2026-10-20', 0.7, 112, 100, {}, { preElo: { home: 1600, away: 1500 } }),            // 中，分差 12
    g('b', '2026-10-20', 0.66, 100, 104, { restHome: 0 }, { preElo: { home: 1500, away: 1600 } }), // 错（≥65%），背靠背，分差 4
    g('c', '2026-10-21', 0.4, 90, 110, {}, { preElo: { home: 1400, away: 1500 } }),             // 中，看好客队，分差 20
    next('u1', '2026-10-22', 1, 2, 0.52),
    next('u2', '2026-10-22', 1, 2, 0.9),
  ];
  const b = buildBoard(games, { teamName: String });
  // 预测分差 10、总分 210；实际分差 12/-4/-20，总分 212/204/200
  near(b.errors.marginMae, (2 + 14 + 30) / 3);
  near(b.errors.marginBias, (-2 + 14 + 30) / 3);
  near(b.errors.totalMae, (2 + 6 + 10) / 3);
  near(b.errors.totalBias, (-2 + 6 + 10) / 3);
  near(b.errors.scoreMae, (2 + 0 + 10 + 4 + 20 + 10) / 6); // 主 110 vs 112/100/90，客 100 vs 100/104/110
  assert.ok(b.overall.logLoss > 0);

  const base = Object.fromEntries(b.baselines.map((x) => [x.key, x]));
  assert.equal(base.model.hits, 2);
  assert.equal(base.home.hits, 1);
  assert.equal(base.elo.hits, 3);   // a 主队 Elo 高且赢；b 客队高且赢；c 客队高且赢

  const split = (title) => Object.fromEntries(b.splits.find((s) => s.title === title).rows.map((r) => [r.label, r]));
  assert.equal(split('看好哪边')['看好主队'].n, 2);
  assert.equal(split('看好哪边')['看好客队'].hits, 1);
  assert.equal(split('实际分差')['≤5 分'].n, 1);
  assert.equal(split('实际分差')['≥15 分'].n, 1);
  assert.equal(split('休息情况')['有一方背靠背'].hits, 0);

  assert.deepEqual(b.misses.map((m) => m.gameId), ['b']);
  assert.deepEqual(b.byDate.map((d) => [d.cumN, d.cumHits]), [[2, 1], [3, 2]]);
  assert.equal(b.upcomingDist.n, 2);
  assert.equal(b.upcomingDist.tossups, 1);
  assert.deepEqual(b.upcomingDist.buckets.map((x) => x.n), [1, 0, 0, 1]);
});
