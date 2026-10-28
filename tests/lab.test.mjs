import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, expand, slices, market, SLICE_DEFS, GAP_SLICE_DEFS, EDGE_BUCKETS } from '../server/lab.mjs';

test('expand：中立场两行都标客场时，主客仍是两支不同球队', () => {
  // 真实数据 0022400147（2024-11-02 巴黎赛）：两行 MATCHUP 都是 "@"
  const [g] = expand([{ i: '0022400147', d: '2024-11-02', s: [[1610612748, 118, 0], [1610612764, 98, 0]] }]);
  assert.equal(g.neutral, true);
  assert.notEqual(g.home.teamId, g.away.teamId);
  assert.deepEqual([g.home.teamId, g.away.teamId].sort(), [1610612748, 1610612764]);
  assert.equal(g.home.win !== g.away.win, true);
});

test('expand：正常主客场不受影响', () => {
  const [g] = expand([{ i: 'x', d: '2024-11-02', s: [[2, 90, 0], [1, 100, 1]] }]);
  assert.deepEqual([g.home.teamId, g.away.teamId, g.neutral, g.home.win], [1, 2, false, true]);
});

// 误差分析 / 对标盘口的切片行带稳定 key（前端按 srv.lab.* 翻译），中文 label 保留
const row = (i) => ({
  p: i % 3 ? 0.8 : 0.55, homeWin: i % 4 !== 0, pred: 4, actual: (i % 7) - 2, mktPred: (i % 5) - 1, mktProb: 0.6,
  b2bHome: i % 2 === 0, b2bAway: i % 3 === 0, restHome: i % 4, restAway: 2, eloDiff: (i % 6) * 60 - 40,
  teamGp: i % 80, neutral: i % 10 === 0, season: i % 2 ? '2023-24' : '2024-25',
});
test('slices / gapSlices / byEdge 每行带 key，key 与 label 一一对应', () => {
  const rows = Array.from({ length: 400 }, (_, i) => row(i));
  const sl = slices(rows);
  assert.equal(sl.length, SLICE_DEFS.length);
  const label = new Map(SLICE_DEFS.map(([k, l]) => [k, l]));
  for (const r of sl) assert.equal(r.label, label.get(r.key));
  assert.deepEqual(new Set(sl.map((r) => r.key)), new Set(SLICE_DEFS.map(([k]) => k)));
  const mk = market(rows);
  const gap = new Map(GAP_SLICE_DEFS.map(([k, l]) => [k, l]));
  assert.ok(mk.gapSlices.length > 0);
  for (const r of mk.gapSlices) assert.equal(r.label, gap.get(r.key));
  const edge = new Map(EDGE_BUCKETS.map(([k, l]) => [k, l]));
  assert.ok(mk.ats.byEdge.length > 0);
  for (const r of mk.ats.byEdge) assert.equal(r.label, edge.get(r.key));
  assert.deepEqual(EDGE_BUCKETS.map(([k]) => k), ['e0to1', 'e1to2', 'e2to3', 'e3to5', 'e5plus']);
});

test('replay：同一比赛日的预测只用当日开始时的评级（同日共享球队也不互相影响）', () => {
  // 预热季 + 测试季；测试季 D 日人为放两场都含 1 号队的比赛（真实数据里不会出现，用来钉住不变量）
  const prior = [{ i: 'P1', d: '2021-11-01', s: [[1, 110, 1], [2, 100, 0]] }, { i: 'P2', d: '2021-11-02', s: [[3, 105, 1], [1, 100, 0]] }];
  const day = (g1Home) => [
    { i: 'G1', d: '2022-11-01', s: [[1, g1Home, 1], [2, 100, 0]] },
    { i: 'G2', d: '2022-11-01', s: [[3, 101, 1], [1, 99, 0]] },
    { i: 'G3', d: '2022-11-02', s: [[1, 100, 1], [3, 98, 0]] },
  ];
  const run = (g1Home) => replay({ seasons: { '2021-22': prior, '2022-23': day(g1Home) }, teamAdv: {} }, ['2022-23']);
  const a = run(140); const b = run(60);           // G1 大胜 vs 大败
  const g2 = (rs) => rs.find((r) => r.gameId === 'G2');
  assert.equal(g2(a).p, g2(b).p);                   // 同日第二场不受第一场结果影响
  assert.equal(g2(a).eloDiff, g2(b).eloDiff);
  assert.notEqual(a.find((r) => r.gameId === 'G3').p, b.find((r) => r.gameId === 'G3').p); // 次日照常吸收
  assert.equal(g2(a).restAway, null);               // 同日已出场不算「前一场」
});

test('replay 记录：pred = eloPts + 主场 + restWeight·restRaw', () => {
  // 合成数据：一场正常主客场、一场休息不对等、一场中立场
  const prior = [{ i: 'P1', d: '2021-11-01', s: [[1, 110, 1], [2, 100, 0]] }, { i: 'P2', d: '2021-11-02', s: [[3, 105, 1], [1, 100, 0]] }];
  const cur = [
    { i: 'G1', d: '2022-11-01', s: [[1, 120, 1], [2, 100, 0]] },
    { i: 'G2', d: '2022-11-02', s: [[3, 101, 1], [1, 99, 0]] },
    { i: 'G3', d: '2022-11-04', s: [[2, 100, 1], [1, 98, 0]] },   // 2 号队休 2 天，1 号队休 1 天
    { i: 'G4', d: '2022-11-05', s: [[3, 90, 0], [2, 95, 0]] },    // 中立场
  ];
  const rs = replay({ seasons: { '2021-22': prior, '2022-23': cur }, teamAdv: {} }, ['2022-23'], { homeAdv: 2, restWeight: 1.5 });
  assert.equal(rs.length, 4);
  for (const r of rs) {
    assert.equal(r.pred, r.eloPts + (r.neutral ? 0 : 2) + 1.5 * r.restRaw);
  }
  const g3 = rs.find((r) => r.gameId === 'G3');
  assert.deepEqual([g3.restHome, g3.restAway], [2, 1]);
  assert.ok(Math.abs(g3.restRaw - 0.35) < 1e-12);
  assert.equal(rs.find((r) => r.gameId === 'G4').neutral, true);
  assert.notEqual(rs.find((r) => r.gameId === 'G2').eloPts, 0);
});
