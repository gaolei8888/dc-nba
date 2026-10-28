import test from 'node:test';
import assert from 'node:assert/strict';
import {
  possShare, blendToward, momentPadding, padValue, hingeBasis, fitHinge, lopoPick, verdict, seasonWeights,
} from '../server/impImproveLab.mjs';

test('possShare：c=0 为常数，回合越多越接近 wmax', () => {
  assert.equal(possShare(500, { wmax: 0.35, c: 0 }), 0.35);
  assert.equal(possShare(10000, { wmax: 1, c: 10000 }), 0.5);
  assert.equal(possShare(0, { wmax: 1, c: 1000 }), 0);
  assert.ok(possShare(1e9, { wmax: 0.7, c: 1000 }) > 0.6999);
});

test('blendToward：缺 APM 退回 SPM，缺 SPM 返回 null', () => {
  assert.equal(blendToward(2, 4, 0.25), 2.5);
  assert.equal(blendToward(2, null, 0.25), 2);
  assert.equal(blendToward(null, 4, 0.25), null);
});

test('momentPadding：从模拟数据还原 σ² 与噪声系数', () => {
  // 真值方差 4，噪声方差 = 2000/m → pad = 500
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const obs = [];
  for (let i = 0; i < 20000; i++) {
    const m = 100 + rnd() * 2900;
    obs.push({ f: 10 + 2 * gauss() + Math.sqrt(2000 / m) * gauss(), m });
  }
  const r = momentPadding(obs);
  assert.ok(Math.abs(r.sigma2 - 4) < 0.4, `sigma2=${r.sigma2}`);
  assert.ok(Math.abs(r.pad - 500) < 120, `pad=${r.pad}`);
  assert.ok(Math.abs(r.mean - 10) < 0.1);
});

test('momentPadding：无噪声时 pad=0；纯噪声时取上限', () => {
  const flat = Array.from({ length: 50 }, (_, i) => ({ f: i % 5, m: 100 + i * 10 }));
  // 方差与 1/m 无关（近似），c 接近 0 → pad 很小
  assert.ok(momentPadding(flat).pad < 2000);
  const noise = Array.from({ length: 200 }, (_, i) => ({ f: (i % 2 ? 1 : -1) * Math.sqrt(1000 / (100 + i * 10)), m: 100 + i * 10 }));
  assert.equal(momentPadding(noise, { maxPad: 9999 }).pad, 9999);
});

test('padValue', () => {
  assert.equal(padValue(10, 300, 100, 6), 9);
  assert.equal(padValue(10, 300, 0, 6), 10);
});

test('hingeBasis / fitHinge：还原分段线性曲线', () => {
  assert.deepEqual(hingeBasis(30, [23, 27], [19, 38]), [1, 30, 7, 3]);
  assert.deepEqual(hingeBasis(45, [23], [19, 38]), [1, 38, 15]);
  const truth = (x) => (x < 27 ? 0.5 * (x - 27) : -0.8 * (x - 27));
  const samples = [];
  for (let x = 19; x <= 38; x += 0.5) samples.push({ x, y: truth(x), w: 1 });
  const g = fitHinge(samples, [23, 27, 31], [19, 38]);
  for (const x of [20, 25, 27, 30, 35]) assert.ok(Math.abs(g.at(x) - truth(x)) < 1e-4, `x=${x}`);
});

test('lopoPick：在其余对上选，只报留出对成绩', () => {
  const table = [
    { cfg: 'a', s: [{ apm: 1, onoff: 1 }, { apm: 0, onoff: 0 }, { apm: 0, onoff: 0 }] },
    { cfg: 'b', s: [{ apm: 0, onoff: 0 }, { apm: 0.5, onoff: 0.5 }, { apm: 0.5, onoff: 0.5 }] },
  ];
  const r = lopoPick(table);
  assert.equal(r[0].cfg, 'b'); // 留出 0：其余对上 b 更好
  assert.equal(r[1].cfg, 'a'); // 留出 1：a 平均 0.5 = b 平均 0.5 平局取先出现的
  assert.deepEqual(r[0].s, { apm: 0, onoff: 0 });
});

test('verdict：预注册规则', () => {
  assert.equal(verdict([0.01, 0.01, -0.001, -0.001], [0.01, 0.01, 0.01, 0.01]).adopt, true);
  assert.equal(verdict([0.03, -0.001, -0.001, -0.001], [0.01, 0.01, 0.01, 0.01]).adopt, false); // 输 3 对
  assert.equal(verdict([0.01, 0.01, 0.01, 0.01], [0.01, -0.05, 0.01, 0.01]).adopt, false); // 平均变差
});

test('seasonWeights：Marcel 与指数衰减', () => {
  assert.deepEqual(seasonWeights({ mode: 'marcel' }, 3), [1, 0.8, 0.6]);
  assert.deepEqual(seasonWeights({ mode: 'exp', h: 1 }, 3), [1, 0.5, 0.25]);
  assert.deepEqual(seasonWeights({ mode: 'equal' }, 2), [1, 1]);
  assert.deepEqual(seasonWeights({ mode: 'single' }, 3), [1, 0, 0]);
});

test('multiSeasonAvg：按 d·m 加权，伤病短季权重小，缺季跳过', async () => {
  const { multiSeasonAvg } = await import('../server/impImproveLab.mjs');
  // 第 N 季 20 场×28 分钟=560 分钟打得差，往季两个满季打得好
  const r = multiSeasonAvg([{ v: -1, m: 560 }, { v: 3, m: 1600 }, null], [1, 0.8, 0.6]);
  assert.ok(Math.abs(r.v - (560 * -1 + 1280 * 3) / (560 + 1280)) < 1e-12);
  assert.equal(r.mEff, 560 + 1280);
  const vec = multiSeasonAvg([{ v: [1, 2], m: 100 }, { v: [3, 4], m: 100 }], [1, 1]);
  assert.deepEqual(vec.v, [2, 3]);
  assert.equal(multiSeasonAvg([null, { v: 1, m: 0 }], [1, 1]), null);
  assert.deepEqual(multiSeasonAvg([{ v: 2, m: 10 }, { v: 9, m: 10 }], [1, 0]).v, 2);
});

test('cumShift：累计年龄增量，反向取负', async () => {
  const { cumShift } = await import('../server/impImproveLab.mjs');
  const g = (a) => (a < 27 ? 0.5 : -1);
  assert.equal(cumShift(g, 25, 28), 0.5 + 0.5 - 1);
  assert.equal(cumShift(g, 28, 25), -(0.5 + 0.5 - 1));
  assert.equal(cumShift(g, 30, 30), 0);
  assert.equal(cumShift(g, 33, 36), -3);
});
