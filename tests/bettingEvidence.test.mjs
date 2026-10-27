import test from 'node:test';
import assert from 'node:assert/strict';
import { profitOf, impliedOf, flatStake, evaluate } from '../server/bettingEvidence.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// replay 记录的形状：p 模型主队胜率，mktProb 去抽水后的市场胜率，ml = [主队钱线, 客队钱线]
const row = (p, mktProb, homeWin, ml = [-110, -110], season = '2024-25') => ({
  season, p, mktProb, homeWin, ml, pred: 0, actual: homeWin ? 5 : -5, mktPred: 0,
});

test('钱线换算：赢一注的净利与含抽水的隐含概率', () => {
  near(profitOf(-110), 100 / 110);
  near(profitOf(150), 1.5);
  near(impliedOf(-110), 110 / 210);
  near(impliedOf(150), 0.4);
});

test('flatStake：分歧超过门槛才下注，按真实钱线结算，打平线取下注价格的隐含概率', () => {
  const rows = [
    row(0.6, 0.5, true),                 // 押主队 +10%，赢 0.909
    row(0.4, 0.5, true),                 // 押客队 +10%，输 1
    row(0.52, 0.5, false),               // 分歧 2%：门槛 5% 时不下
    row(0.7, 0.4, true, [150, -170]),    // 押主队 +30%，赢 1.5
  ];
  const s = flatStake(rows, 0.05, { B: 200 });
  assert.equal(s.bets, 3);
  assert.equal(s.wins, 2);
  near(s.units, 100 / 110 - 1 + 1.5);
  near(s.roi, s.units / 3);
  near(s.breakEven, (110 / 210 + 110 / 210 + 0.4) / 3);
  assert.ok(s.ci.lo <= s.roi && s.roi <= s.ci.hi);
  assert.equal(flatStake(rows, 0, { B: 50 }).bets, 4);
  assert.deepEqual(flatStake([], 0), { bets: 0, wins: 0, winRate: null, units: 0, roi: null, ci: { lo: null, hi: null }, breakEven: null });
});

test('evaluate：模型输给市场且没有门槛能赚钱时，结论直说不能当投注优势', () => {
  // 市场总是更准：主队赢时市场 0.7、模型 0.55；客队赢时市场 0.3、模型 0.6（模型押错）
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const win = i % 2 === 0;
    rows.push(row(win ? 0.55 : 0.6, win ? 0.7 : 0.3, win, [-110, -110], i < 100 ? '2023-24' : '2024-25'));
  }
  const e = evaluate(rows, { B: 200 });
  assert.equal(e.n, 200);
  assert.ok(e.model.logloss > e.market.logloss);
  assert.ok(e.logLossDiff.lo > 0);          // 模型 − 市场 的单场损失差，整个区间都 > 0
  assert.equal(e.modelBeatsMarket, false);
  assert.equal(e.bySeason.length, 2);
  assert.equal(e.strategies.length, 4);
  assert.ok(e.strategies.every((s) => s.roi < 0));
  assert.equal(e.profitableThreshold, null);
  near(e.overround, 2 * (110 / 210) - 1);
  const text = e.summary.join('');
  assert.match(text, /不能当作投注优势/);
  assert.match(text, /对数损失/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('evaluate：跳过缺钱线的比赛', () => {
  const e = evaluate([row(0.6, 0.5, true), { ...row(0.6, 0.5, true), ml: [null, -110] }], { B: 20 });
  assert.equal(e.n, 1);
});
