import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAgeCurves } from '../server/impactAging.mjs';
import { apply, ageShiftOf, FEATURES } from '../server/impact.mjs';

const row = (id, age, pts, extra = {}) => ({
  playerId: id, age, gp: 60, min: 30, pts, fga: 15, ast: 4, tov: 2, oreb: 1, dreb: 5, stl: 1, blk: 0.5, pf: 2,
  tsPct: 0.57, usgPct: 0.22, deflections: 2, contested: 5, screenAstPts: 1, dFga: 8, diffPct: 0, potentialAst: 7, ...extra,
});

test('fitAgeCurves：年轻人得分涨、老将得分跌，曲线能还原', () => {
  const from = []; const to = [];
  for (let i = 0; i < 200; i++) {
    const age = 20 + (i % 16);
    // 每场得分的一年变化：23 岁前 +1，23→31 线性降到 −1，之后 −1（per36 = pts×36/30，所以 ×1.2）
    const d = 1 - 0.25 * Math.max(0, age - 23) + 0.25 * Math.max(0, age - 31);
    from.push(row(i, age, 20));
    to.push(row(i, age + 1, 20 + d));
  }
  const c = fitAgeCurves([{ from, to }]);
  assert.ok(Math.abs(ageShiftOf(c, 22).pts - 1.2) < 0.05);
  assert.ok(Math.abs(ageShiftOf(c, 33).pts + 1.2) < 0.05);
  assert.ok(Math.abs(ageShiftOf(c, 27).pts) < 0.05);
  assert.ok(Math.abs(ageShiftOf(c, 30).ast) < 1e-6);
});

test('apply aged：有曲线时只在 aged=true 时平移，没曲线时与原来相同', () => {
  const model = {
    features: FEATURES, mu: FEATURES.map(() => 0), sd: FEATURES.map(() => 1),
    beta: FEATURES.map((k) => (k === 'pts' ? 0.5 : 0)), intercept: 0,
  };
  const p = row(1, 33, 20);
  const base = apply(model, p);
  assert.equal(apply(model, p, { aged: true }), base); // 没有 ageCurves
  const withCurves = { ...model, ageCurves: { knots: [27], clip: [19, 38], coef: { pts: [0, 0, -1] } } }; // 27 岁后每岁 −1
  assert.equal(apply(withCurves, p), base);
  assert.equal(apply(withCurves, p, { aged: true }), Math.round((base - 0.5 * 6) * 100) / 100);
});
