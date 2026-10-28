import test from 'node:test';
import assert from 'node:assert/strict';
import { expand, slices, market, SLICE_DEFS, GAP_SLICE_DEFS, EDGE_BUCKETS } from '../server/lab.mjs';

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
