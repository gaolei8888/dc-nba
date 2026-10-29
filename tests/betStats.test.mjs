import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockBootstrap, designEffect, BUCKETS, bucketRoi, calibrationVsMarket,
  betsNeeded, perBetSd, powerAnalysis, MIN_BETS, mlVerdict,
} from '../server/betStats.mjs';

// 夹具：只含 betStats 用到的流水字段
const bet = (o) => ({
  date: '2025-11-01', season: '2025-26', gameId: 'g', side: 'home', pModel: 0.55,
  quoted: 100, american: 100, edge: 0.05, stake: 1, result: 'win', profit: 1,
  b2bSide: false, b2bOpp: false, teamGp: 20, ...o,
});
const win = (o) => bet({ result: 'win', profit: o?.american ? (o.american > 0 ? o.american / 100 : 100 / -o.american) : 1, ...o });
const loss = (o) => bet({ result: 'loss', profit: -1, ...o });

const twoDays = [
  win({ date: '2025-11-01', gameId: 'a1' }), win({ date: '2025-11-01', gameId: 'a2' }),
  loss({ date: '2025-11-02', gameId: 'b1' }), loss({ date: '2025-11-02', gameId: 'b2' }),
];

test('blockBootstrap 按日：同日注单一起被抽', () => {
  // A 日两注 +1/+1（stake 1），B 日两注 −1/−1 → 每次重抽 ROI ∈ {−1, 0, 1}
  const r = blockBootstrap(twoDays, { by: 'day', B: 500 });
  assert.equal(r.blocks, 2);
  assert.equal(r.n, 4);
  assert.equal(r.roi.est, 0);
  for (const v of [r.roi.lo, r.roi.hi]) assert.ok([-1, 0, 1].includes(v), String(v));
  assert.deepEqual([r.roi.lo, r.roi.hi], [-1, 1]);
  assert.deepEqual(blockBootstrap(twoDays, { by: 'day', B: 500 }), r);     // 固定种子可复现
  assert.equal(blockBootstrap([], {}), null);
});

test('blockBootstrap：作废注不参与；全作废 → null', () => {
  const withVoid = [...twoDays, bet({ date: '2025-11-03', gameId: 'v', result: 'void', profit: 0 })];
  const r = blockBootstrap(withVoid, { by: 'day', B: 300 });
  assert.equal(r.blocks, 2);
  assert.equal(r.n, 4);
  assert.equal(blockBootstrap([bet({ result: 'void', profit: 0 })], {}), null);
});

test('全赢：区间退化为点', () => {
  const allWin = [
    win({ date: '2025-11-01', american: 150, quoted: 150 }), win({ date: '2025-11-02', american: 150, quoted: 150 }),
    win({ date: '2025-11-03', american: 150, quoted: 150 }),
  ];
  const r = blockBootstrap(allWin, { by: 'day', B: 200 });
  assert.deepEqual([r.roi.lo, r.roi.hi], [1.5, 1.5]);
  // realizedEdge = 命中率 1 − 盈亏平衡 0.4 = 0.6
  assert.ok(Math.abs(r.realizedEdge.lo - 0.6) < 1e-12 && Math.abs(r.realizedEdge.hi - 0.6) < 1e-12);
});

test('blockBootstrap 按赛季：不足 2 个赛季 → n/a（null + reason）；≥ 2 个赛季正常', () => {
  const one = blockBootstrap(twoDays, { by: 'season', B: 100 });
  assert.deepEqual(one, { n: 4, blocks: 1, roi: null, realizedEdge: null, reason: 'fewerThan2Seasons' });
  const two = [
    win({ season: '2024-25', date: '2025-01-01' }), win({ season: '2024-25', date: '2025-01-02' }),
    loss({ season: '2025-26', date: '2025-11-01' }),
  ];
  const r = blockBootstrap(two, { by: 'season', B: 400 });
  assert.equal(r.blocks, 2);
  // 每次重抽 ROI ∈ {1（两块都是 24-25）, 1/3, −1}
  assert.deepEqual([r.roi.lo, r.roi.hi], [-1, 1]);
  assert.throws(() => blockBootstrap(twoDays, { by: 'week' }), /by/);
});

test('designEffect：同日完全相关 → 按日方差大于按注（> 1）；同 seed 可复现', () => {
  const ledger = [];
  for (let d = 1; d <= 20; d += 1) {
    const date = `2025-11-${String(d).padStart(2, '0')}`;
    const f = d % 2 ? win : loss;
    for (let k = 0; k < 4; k += 1) ledger.push(f({ date, gameId: `${d}-${k}` }));
  }
  const de = designEffect(ledger, { B: 1000 });
  assert.ok(de > 2.5 && de < 6, String(de));   // 理论值 ≈ 4（每日 4 注完全相关）
  assert.equal(designEffect(ledger, { B: 1000 }), de);
  assert.equal(designEffect([], {}), null);
});

test('betsNeeded：sd 1、ROI 5% → 3140 注；设计效应 2 → 6280；ROI ≤ 0 → null', () => {
  assert.equal(betsNeeded({ sd: 1, roi: 0.05 }), 3140);
  assert.equal(betsNeeded({ sd: 1, roi: 0.05, deff: 2 }), 6280);
  assert.equal(betsNeeded({ sd: 1, roi: -0.01 }), null);
  assert.equal(betsNeeded({ sd: 1, roi: 0 }), null);
});

test('perBetSd / powerAnalysis：用该流水自己的方差', () => {
  // 单位 stake、±1 各半 → 每注收益率 sd = 1（总体标准差 n−1 版 ≈ 1.069）
  assert.ok(Math.abs(perBetSd(twoDays) - Math.sqrt(4 / 3)) < 1e-12);
  assert.equal(perBetSd([twoDays[0]]), null);
  const pa = powerAnalysis(twoDays, { roi: 0.05, B: 200 });
  assert.equal(pa.bets, 4);
  assert.equal(pa.roi, 0.05);
  assert.equal(pa.sd, perBetSd(twoDays));
  assert.equal(pa.betsNeeded, betsNeeded({ sd: pa.sd, roi: 0.05, deff: pa.deff }));
  // 不给目标 → 用观测 ROI；观测 ROI 0 → betsNeeded null
  assert.equal(powerAnalysis(twoDays, { B: 200 }).betsNeeded, null);
});

test('mlVerdict：下界 > 0 且 ≥ 300 注才是 evidence', () => {
  assert.equal(MIN_BETS, 300);
  assert.equal(mlVerdict({ roi: 0.02, bets: 300, ci: { lo: 0.001, hi: 0.05 } }).code, 'srv.ml.verdict.evidence');
  assert.equal(mlVerdict({ roi: 0.02, bets: 299, ci: { lo: 0.001, hi: 0.05 } }).code, 'srv.ml.verdict.tooFew');
  assert.equal(mlVerdict({ roi: 0.01, bets: 1000, ci: { lo: -0.01, hi: 0.03 } }).code, 'srv.ml.verdict.noEvidence');
  assert.equal(mlVerdict({ roi: 0.01, bets: 1000, ci: { lo: 0, hi: 0.03 } }).code, 'srv.ml.verdict.noEvidence');
  assert.equal(mlVerdict({ roi: null, bets: 0, ci: null }).code, 'srv.ml.verdict.tooFew');
  assert.equal(mlVerdict({ roi: 0.1, bets: 500, ci: null }).code, 'srv.ml.verdict.noEvidence');
  assert.deepEqual(mlVerdict({ roi: 0.02, bets: 300, ci: { lo: 0.001, hi: 0.05 } }).params,
    { bets: 300, roi: 0.02, lo: 0.001, hi: 0.05, min: 300 });
  assert.deepEqual(mlVerdict({ roi: null, bets: 0, ci: null }).params, { bets: 0, roi: null, lo: null, hi: null, min: 300 });
});

test('bucketRoi：每桶 n 之和 = 非作废注数；键齐全', () => {
  const ledger = [
    win({ date: '2025-11-01', edge: -0.01, pModel: 0.45, quoted: -250, american: -250, side: 'away', teamGp: 5, b2bSide: true }),
    loss({ date: '2025-11-01', edge: 0.0, pModel: 0.52, quoted: -150, american: -150, teamGp: 10, b2bOpp: true }),
    win({ date: '2025-11-02', edge: 0.025, pModel: 0.62, quoted: -100, american: -100, teamGp: 39, b2bSide: true, b2bOpp: true }),
    loss({ date: '2025-11-02', edge: 0.03, pModel: 0.38, quoted: 100, american: 100, side: 'away', teamGp: 40 }),
    win({ date: '2025-11-03', edge: 0.10, pModel: 0.75, quoted: 200, american: 200, teamGp: 80 }),
    bet({ date: '2025-11-03', result: 'void', profit: 0, edge: 0.05 }),
  ];
  const nonVoid = 5;
  const sumN = (rows) => rows.reduce((s, r) => s + r.n, 0);

  const edge = bucketRoi(ledger, 'edge', { B: 200 });
  assert.deepEqual(edge.map((r) => r.key), ['<0', '0-2', '2-3', '3-5', '5-7', '7-10', '10+']);
  assert.deepEqual(edge.map((r) => r.n), [1, 1, 1, 1, 0, 0, 1]);
  assert.equal(sumN(edge), nonVoid);
  assert.deepEqual(edge[4], { key: '5-7', n: 0, roi: null, hitRate: null, ci: null });
  assert.equal(edge[0].roi, 0.4);   // −250 赢：100/250
  assert.equal(edge[0].hitRate, 1);

  const odds = bucketRoi(ledger, 'odds', { B: 200 });
  assert.deepEqual(odds.map((r) => r.key), ['<-200', '-200~-100', '+100~+200', '>=+200']);
  // −100 与 +100 等价，归入 +100~+200
  assert.deepEqual(odds.map((r) => r.n), [1, 1, 2, 1]);

  const prob = bucketRoi(ledger, 'prob', { B: 200 });
  assert.deepEqual(prob.map((r) => r.key), ['0-40', '40-50', '50-60', '60-70', '70-100']);
  assert.deepEqual(prob.map((r) => r.n), [1, 1, 1, 1, 1]);

  const ha = bucketRoi(ledger, 'homeAway', { B: 200 });
  assert.deepEqual(ha.map((r) => [r.key, r.n]), [['home', 3], ['away', 2]]);

  const b2b = bucketRoi(ledger, 'b2b', { B: 200 });
  assert.deepEqual(b2b.map((r) => [r.key, r.n]), [['side', 1], ['opp', 1], ['both', 1], ['neither', 2]]);

  const phase = bucketRoi(ledger, 'phase', { B: 200 });
  assert.deepEqual(phase.map((r) => [r.key, r.n]), [['early', 1], ['mid', 2], ['late', 2]]);

  for (const rows of [edge, odds, prob, ha, b2b, phase]) assert.equal(sumN(rows), nonVoid);
  assert.ok(edge[6].ci && typeof edge[6].ci.lo === 'number');
  assert.throws(() => bucketRoi(ledger, 'nope'), /dim/);
  assert.equal(BUCKETS.edge.length, 8);   // 8 个切点 → 7 桶
});

test('bucketRoi：缺字段的非作废注进 n/a 桶，n 之和仍等于非作废注数', () => {
  const rows = bucketRoi([win({ teamGp: null }), loss({ teamGp: 3 })], 'phase', { B: 50 });
  assert.deepEqual(rows.map((r) => [r.key, r.n]), [['early', 1], ['mid', 0], ['late', 0], ['n/a', 1]]);
});

test('calibrationVsMarket：市场概率用同一价两侧去水', () => {
  const r = calibrationVsMarket([{ pHome: 0.7, ml: [-150, 130], homeWin: true }]);
  assert.equal(r.n, 1);
  const pm = 0.6 / (0.6 + 100 / 230);
  assert.ok(Math.abs(pm - 0.5798319) < 1e-7);
  assert.ok(Math.abs(r.market.brier - (1 - pm) ** 2) < 1e-12);
  assert.ok(Math.abs(r.market.logloss + Math.log(pm)) < 1e-12);
  assert.ok(Math.abs(r.model.brier - 0.09) < 1e-12);
  assert.ok(Math.abs(r.model.logloss + Math.log(0.7)) < 1e-12);
  assert.deepEqual(r.reliability.model, [{ lo: 70, hi: 80, n: 1, predicted: 0.7, actual: 1 }]);
  assert.deepEqual(r.reliability.market, [{ lo: 50, hi: 60, n: 1, predicted: 0.5798, actual: 1 }]);
});

test('calibrationVsMarket：同一批比赛（缺价/无结果的两边都剔除）；对数损失截断 1e-9；分档 n 之和 = n', () => {
  const cands = [
    { pHome: 1, ml: [-150, 130], homeWin: false },        // 模型 p=1 判错 → 截断到 −log(1e-9)
    { pHome: 0.3, ml: [120, -140], homeWin: false },
    { pHome: 0.5, ml: null, homeWin: true },              // 缺价 → 剔除
    { pHome: 0.5, ml: [-110, -110], homeWin: null },      // 无结果（作废）→ 剔除
    { pHome: 0.5, ml: [50, -110], homeWin: true },        // 非法价 → 剔除
  ];
  const r = calibrationVsMarket(cands);
  assert.equal(r.n, 2);
  const expModel = (-Math.log(1e-9) - Math.log(0.7)) / 2;
  assert.ok(Math.abs(r.model.logloss - expModel) < 1e-9);
  for (const k of ['model', 'market']) assert.equal(r.reliability[k].reduce((s, b) => s + b.n, 0), 2);
  assert.deepEqual(calibrationVsMarket([]), { n: 0, model: null, market: null, reliability: { model: [], market: [] } });
});
