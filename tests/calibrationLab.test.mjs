import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../server/lab.mjs';
import {
  PROD, features, predictRow, tune, plattFit, plattApply, favoriteBias, disagreement, splits,
} from '../server/calibrationLab.mjs';

const IDS = [1, 2, 3, 4];
/** 4 队三循环的合成赛季（同 fusionLab 测试）：主队按固定实力差 + 小扰动赢球 */
function season(year, rating) {
  const games = [];
  let day = 0; let k = 0;
  for (let rep = 0; rep < 3; rep += 1) {
    for (const h of IDS) {
      for (const a of IDS) {
        if (h === a) continue;
        const m = Math.round(rating[h] - rating[a] + 2 + ((k * 7) % 5) - 2);
        const d = new Date(Date.UTC(year, 9, 1) + day * 86400000).toISOString().slice(0, 10);
        games.push({ i: `G${year}${String(k).padStart(3, '0')}`, d, s: [[h, 100 + Math.max(m, 0) + (m === 0 ? 1 : 0), 1], [a, 100 + Math.max(-m, 0), 0]] });
        k += 1; day += (k % 3 === 0 ? 2 : 1);
      }
    }
  }
  return games;
}
const R = { 1: 6, 2: 2, 3: -2, 4: -6 };
const dataset = { seasons: { '2021-22': season(2021, R), '2022-23': season(2022, R) }, teamAdv: {} };

test('production params reproduce lab.replay probabilities and margins exactly', () => {
  for (const elo of [{ k: 20, carryKeep: 0.75 }, { k: 30, carryKeep: 0.6 }]) {
    const lab = replay(dataset, ['2022-23'], { ...elo });
    const rows = features(dataset, ['2022-23'], elo);
    assert.equal(rows.length, lab.length);
    rows.forEach((r, i) => {
      const out = predictRow(r, PROD);
      assert.equal(r.gameId, lab[i].gameId);
      assert.ok(Math.abs(out.p - lab[i].p) < 1e-12);
      assert.ok(Math.abs(out.pred - lab[i].pred) < 1e-9);
    });
  }
});

test('eloPerPoint rescales only the Elo part; sd widens/narrows probabilities', () => {
  const row = { eloPts: 5, neutral: false, restRaw: 0.5, actual: 0, homeWin: true };
  const a = predictRow(row, { ...PROD, eloPerPoint: 28 });
  const b = predictRow(row, { ...PROD, eloPerPoint: 14 });
  assert.ok(Math.abs((b.pred - a.pred) - 5) < 1e-12); // Elo 部分翻倍，主场/休息不变
  const neutral = predictRow({ ...row, neutral: true }, PROD);
  assert.ok(Math.abs(a.pred - neutral.pred - PROD.homeAdv) < 1e-12);
  assert.ok(predictRow(row, { ...PROD, sd: 10 }).p > a.p);
});

test('tune picks the config with the lowest mean log loss on outcomes only', () => {
  const rows = features(dataset, ['2022-23'], { k: 20, carryKeep: 0.75 });
  const grid = [{ ...PROD, sd: 40 }, { ...PROD, sd: 12 }, { ...PROD, sd: 4 }];
  const best = tune({ '20:0.75': rows }, grid.map((c) => ({ ...c, k: 20, carryKeep: 0.75 })));
  assert.equal(best.cfg.sd, 4); // 合成数据几乎确定性，越自信越好
  // 市场字段被篡改不影响选择：选择只看结果
  const poisoned = rows.map((r) => ({ ...r, mktProb: 0.5 }));
  assert.deepEqual(tune({ '20:0.75': poisoned }, grid.map((c) => ({ ...c, k: 20, carryKeep: 0.75 }))).cfg, best.cfg);
});

test('plattFit recovers a known logistic map on predicted margin', () => {
  // y ~ Bernoulli(σ(0.3 + 0.12 m))，用确定性的「期望计数」代替抽样
  const rows = [];
  for (let m = -20; m <= 20; m += 0.5) {
    const p = 1 / (1 + Math.exp(-(0.3 + 0.12 * m)));
    for (let j = 0; j < 100; j += 1) rows.push({ pred: m, homeWin: j < Math.round(p * 100) });
  }
  const fit = plattFit(rows);
  assert.ok(Math.abs(fit.a - 0.3) < 0.02, `a=${fit.a}`);
  assert.ok(Math.abs(fit.b - 0.12) < 0.005, `b=${fit.b}`);
  assert.ok(Math.abs(plattApply(fit, 0) - 1 / (1 + Math.exp(-fit.a))) < 1e-12);
});

test('favoriteBias: mean predicted − actual win rate of the favorite, by chosen favorite', () => {
  const rows = [
    { p: 0.7, homeWin: true, mktProb: 0.6 },
    { p: 0.7, homeWin: false, mktProb: 0.4 },
    { p: 0.2, homeWin: false, mktProb: 0.3 },
    { p: 0.6, homeWin: true, mktProb: null },
  ];
  const byModel = favoriteBias(rows, (r) => r.p);
  assert.equal(byModel.n, 4);
  assert.ok(Math.abs(byModel.predicted - (0.7 + 0.7 + 0.8 + 0.6) / 4) < 1e-12);
  assert.ok(Math.abs(byModel.actual - 0.75) < 1e-12);
  assert.ok(Math.abs(byModel.bias - (byModel.predicted - 0.75)) < 1e-12);
  const byMkt = favoriteBias(rows, (r) => r.mktProb);
  assert.equal(byMkt.n, 3); // 无盘口的那场不计
  // 市场看好客队（第 2 场）时，模型给客队的胜率是 0.3，客队赢了
  assert.ok(Math.abs(byMkt.predicted - (0.7 + 0.3 + 0.8) / 3) < 1e-12);
  assert.ok(Math.abs(byMkt.actual - 1) < 1e-12);
});

test('disagreement counts games with |model − market| ≥ threshold among priced games', () => {
  const rows = [{ p: 0.6, mktProb: 0.56 }, { p: 0.5, mktProb: 0.52 }, { p: 0.4, mktProb: 0.37 }, { p: 0.4, mktProb: null }];
  const d = disagreement(rows, 0.03);
  assert.equal(d.n, 3);
  assert.equal(d.count, 2);
  assert.ok(Math.abs(d.rate - 2 / 3) < 1e-12);
});

test('splits: LOSO trains on the other seasons; forward trains only on earlier seasons', () => {
  const S = ['a', 'b', 'c', 'd'];
  assert.deepEqual(splits(S, 'loso'), S.map((s) => ({ test: s, train: S.filter((x) => x !== s) })));
  assert.deepEqual(splits(S, 'forward'), [
    { test: 'b', train: ['a'] }, { test: 'c', train: ['a', 'b'] }, { test: 'd', train: ['a', 'b', 'c'] },
  ]);
});
