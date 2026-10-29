import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COSTS, buildCandidates, runBacktest, summarizeLedger } from '../server/betBacktest.mjs';

// 桩策略（形状同 Task 9 的 Strategy）
const flat3 = { id: 'B-edge3', family: 'B', minEdge: 0.03 };
const kellyFull = { id: 'D-kelly-full', family: 'D', kelly: { mult: 1, cap: 0.05 } };
const homeOnly = { id: 'A-home', family: 'A', pick: 'home' };

let seq = 0;
/** 候选小工厂：默认收盘情景、DK 收盘价、主队赢 */
function cand({ pHome = 0.5, ml = [-110, -110], homeWin = true, actual, date = '2024-01-10', gameId, scenario = 'close',
  priceAt, closeMl, flags = [], voidGame = false, b2bHome = false, b2bAway = false } = {}) {
  seq += 1;
  return {
    gameId: gameId ?? `G${String(seq).padStart(4, '0')}`,
    date, season: '2023-24', homeId: 1, awayId: 2,
    homeWin, actual: actual ?? (homeWin === true ? 5 : homeWin === false ? -5 : null),
    void: voidGame, b2bHome, b2bAway, teamGp: 30,
    pHome, paramsVersion: 'wf:2022-23', modelVersion: 'replay-elo-wf',
    scenario, split: 'validate', ml, books: ['draftkings', 'draftkings'],
    priceAt: priceAt ?? scenario, closeMl: closeMl === undefined ? (scenario === 'close' ? ml : null) : closeMl, flags,
  };
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('DEFAULT_COSTS 默认全 0 / 无限额', () => {
  assert.deepEqual(DEFAULT_COSTS, { feeOnWin: 0, slippagePts: 0, maxStake: null });
});

test('确定性：同一输入两次运行，逐注流水与汇总完全一致；输入顺序不影响结果', () => {
  const c = [
    cand({ pHome: 0.45, ml: [150, -170], date: '2024-01-11', gameId: 'B' }),
    cand({ pHome: 0.30, ml: [150, -170], homeWin: true, date: '2024-01-10', gameId: 'C' }),
    cand({ pHome: 0.45, ml: [150, -170], homeWin: false, date: '2024-01-10', gameId: 'A' }),
  ];
  const r1 = runBacktest(c, flat3);
  const r2 = runBacktest(c, flat3);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  // 打乱输入顺序：流水仍按 date, gameId 排序，字节一致
  const r3 = runBacktest([c[2], c[0], c[1]], flat3);
  assert.equal(JSON.stringify(r3), JSON.stringify(r1));
  assert.deepEqual(r1.ledger.map((b) => b.gameId), ['A', 'C', 'B']);
});

test('决策用报价、结算用滑点后的价', () => {
  const { ledger } = runBacktest([cand({ pHome: 0.45, ml: [150, -170], homeWin: true })], flat3, { costs: { ...DEFAULT_COSTS, slippagePts: 10 } });
  assert.deepEqual([ledger[0].quoted, ledger[0].american, ledger[0].profit], [150, 140, 1.4]);
  near(ledger[0].edge, 0.05);       // edge 按报价 +150 算（0.45 − 0.40）
  assert.equal(ledger[0].decimal, 2.4);
});

test('逐注流水记录全部字段（模型/参数版本、情景、时点、博彩公司、flags、CLV）', () => {
  const { ledger } = runBacktest([cand({ pHome: 0.30, ml: [150, -170], homeWin: false, b2bHome: true, flags: ['currentAsClose'], priceAt: 'current' })], flat3);
  const b = ledger[0];
  assert.equal(b.side, 'away');
  near(b.pModel, 0.7);
  assert.deepEqual(
    [b.homeId, b.awayId, b.modelVersion, b.paramsVersion, b.scenario, b.split, b.priceAt, b.book, b.strategy, b.market, b.quoted, b.american, b.stake, b.result, b.b2bSide, b.b2bOpp, b.teamGp],
    [1, 2, 'replay-elo-wf', 'wf:2022-23', 'close', 'validate', 'current', 'draftkings', 'B-edge3', 'moneyline', -170, -170, 1, 'win', false, true, 30]);
  near(b.profit, 100 / 170);
  near(b.bankrollAfter, 100 + 100 / 170);
  // 收盘情景：下注价即收盘价，CLV 为 null 并标注
  assert.equal(b.clv, null);
  assert.deepEqual(b.flags, ['currentAsClose', 'clvAtClose']);
});

test('CLV：开盘情景 = 所押一边收盘去水概率 − 下注报价去水概率；无收盘价为 null 并标注', () => {
  const { ledger } = runBacktest([
    cand({ scenario: 'open', pHome: 0.45, ml: [150, -170], closeMl: [130, -150], gameId: 'A' }),
    cand({ scenario: 'open', pHome: 0.45, ml: [150, -170], closeMl: null, flags: ['noCloseForClv'], gameId: 'B' }),
  ], flat3);
  // 下注：主队 +150/−170 去水 0.4/(0.4+0.62963)；收盘 +130/−150 去水 (100/230)/(100/230+0.6)
  const bet = 0.4 / (0.4 + 170 / 270);
  const close = (100 / 230) / (100 / 230 + 0.6);
  near(ledger[0].clv, close - bet);
  assert.ok(ledger[0].clv > 0);
  assert.deepEqual(ledger[0].flags, []);
  assert.equal(ledger[1].clv, null);
  assert.deepEqual(ledger[1].flags, ['noCloseForClv']);
  const s = summarizeLedger(ledger);
  assert.equal(s.clv.n, 1);
  near(s.clv.mean, close - bet);
  assert.equal(s.clv.beatClose, 1);
});

test('作废：profit 0，不计入下注额与 ROI 分母', () => {
  const { ledger, summary } = runBacktest([
    cand({ pHome: 0.45, ml: [150, -170], homeWin: null, gameId: 'A' }),
    cand({ pHome: 0.45, ml: [150, -170], homeWin: true, gameId: 'B' }),
  ], flat3);
  assert.deepEqual(ledger.map((b) => [b.result, b.profit]), [['void', 0], ['win', 1.5]]);
  assert.deepEqual([summary.staked, summary.roi, summary.voids, summary.bets, summary.wins, summary.losses, summary.profit],
    [1, 1.5, 1, 1, 1, 0, 1.5]);
});

test('比分相等（NBA 无平局）是数据错误：作废并带 reason，绝不当客胜', () => {
  const { ledger, summary } = runBacktest([cand({ pHome: 0.30, ml: [150, -170], homeWin: false, actual: 0 })], flat3);
  assert.equal(ledger[0].side, 'away');
  assert.deepEqual([ledger[0].result, ledger[0].profit, ledger[0].reason], ['void', 0, 'tie_score']);
  assert.deepEqual([summary.voids, summary.staked, summary.bets], [1, 0, 0]);
  assert.deepEqual(summary.voidReasons, { tie_score: 1 });
});

test('非法报价作废（invalid_price）在汇总里单列，不混入普通作废', () => {
  const { ledger, summary } = runBacktest([
    cand({ ml: [50, -170], gameId: 'A' }),                 // 主队价非法
    cand({ ml: [120, -140], homeWin: null, gameId: 'B' }),  // 普通作废
    cand({ ml: [120, -140], homeWin: true, gameId: 'C' }),
  ], homeOnly);
  assert.deepEqual(ledger.map((b) => [b.result, b.reason ?? null]), [['void', 'invalid_price'], ['void', null], ['win', null]]);
  assert.equal(ledger[0].decimal, null);
  assert.equal(ledger[0].edge, null);
  assert.deepEqual([summary.voids, summary.invalidPriceVoids, summary.staked, summary.bets], [1, 1, 1, 1]);
  near(summary.profit, 1.2);
});

test('Kelly 按日初资金定注：同日两注各 5% × 100', () => {
  const { ledger, summary } = runBacktest([
    cand({ pHome: 0.5, ml: [150, -170], homeWin: true, date: '2024-01-10', gameId: 'A' }),
    cand({ pHome: 0.5, ml: [150, -170], homeWin: false, date: '2024-01-10', gameId: 'B' }),
    cand({ pHome: 0.5, ml: [150, -170], homeWin: true, date: '2024-01-11', gameId: 'C' }),
  ], kellyFull);
  // 第一日：两注都按日初 100 定注 5，赢 +7.5、输 −5 → 102.5
  assert.deepEqual(ledger.map((b) => b.stake), [5, 5, 5.125]);
  assert.deepEqual(ledger.map((b) => b.bankrollAfter), [107.5, 102.5, 102.5 + 5.125 * 1.5]);
  assert.deepEqual(summary.curve.map((d) => [d.date, d.bankroll]), [['2024-01-10', 102.5], ['2024-01-11', 102.5 + 5.125 * 1.5]]);
});

test('maxStake 截住单注', () => {
  const { ledger } = runBacktest([cand({ pHome: 0.5, ml: [150, -170] })], kellyFull, { costs: { ...DEFAULT_COSTS, maxStake: 3 } });
  assert.equal(ledger[0].stake, 3);
  assert.equal(ledger[0].profit, 4.5);
});

test('同日敞口（M10）只约束 Kelly：当日下注总额超过日初资金时按比例缩减', () => {
  // 21 场同日，每场 Kelly 截在 5% × 100 = 5，合计 105 > 日初 100 → 各缩为 100/21
  const games = Array.from({ length: 21 }, (_, i) => cand({ pHome: 0.5, ml: [150, -170], homeWin: i % 2 === 0, date: '2024-01-10', gameId: `K${String(i).padStart(2, '0')}` }));
  const { ledger, summary, notes } = runBacktest(games, kellyFull);
  assert.equal(ledger.length, 21);
  for (const b of ledger) { near(b.stake, 100 / 21); assert.ok(b.flags.includes('exposureScaled')); }
  near(summary.staked, 100);
  assert.equal(notes.scaledDays, 1);
  // 不超过时不缩
  const ok = runBacktest(games.slice(0, 20), kellyFull);
  for (const b of ok.ledger) near(b.stake, 5);
  assert.equal(ok.notes.scaledDays, 0);
});

test('固定金额策略不受资金约束（I1）：日初资金不足、资金耗尽后仍每注 1 单位', () => {
  const day = (gameId, homeWin, date = '2024-01-10') => cand({ pHome: 0.45, ml: [150, -170], homeWin, date, gameId });
  // 日初只有 2，同日 3 注：不缩减，各 1
  const same = runBacktest([day('A', true), day('B', false), day('C', false)], flat3, { bankroll0: 2 });
  assert.deepEqual(same.ledger.map((b) => b.stake), [1, 1, 1]);
  assert.ok(same.ledger.every((b) => !b.flags.includes('exposureScaled')));
  assert.equal(same.notes.scaledDays, 0);
  // 资金 1：首日输光后次日照常下 1 单位，资金曲线可为负（只是累计盈亏记账）
  const { ledger, summary, notes } = runBacktest([
    day('A', false, '2024-01-10'), day('B', false, '2024-01-11'), day('C', true, '2024-01-12'),
  ], flat3, { bankroll0: 1 });
  assert.deepEqual(ledger.map((b) => [b.gameId, b.stake, b.bankrollAfter]), [['A', 1, 0], ['B', 1, -1], ['C', 1, 0.5]]);
  assert.equal(notes.skippedNoBankroll, 0);
  assert.equal(summary.bets, 3);
  near(summary.roi, -0.5 / 3);
  // maxStake 仍然生效
  const capped = runBacktest([day('A', true)], flat3, { costs: { ...DEFAULT_COSTS, maxStake: 0.5 } });
  assert.equal(capped.ledger[0].stake, 0.5);
});

test('Kelly 资金耗尽后不再下注（不允许杠杆）', () => {
  const { ledger, notes } = runBacktest([
    cand({ pHome: 0.5, ml: [150, -170], homeWin: false, date: '2024-01-10', gameId: 'A' }),
  ], kellyFull, { bankroll0: 0 });
  assert.equal(ledger.length, 0);
  assert.equal(notes.skippedNoBankroll, 1);
});

test('手续费按赢注净利扣', () => {
  const { ledger } = runBacktest([cand({ pHome: 0.45, ml: [150, -170], homeWin: true })], flat3, { costs: { ...DEFAULT_COSTS, feeOnWin: 0.02 } });
  near(ledger[0].profit, 1.47);
});

/** 直接造流水行，测汇总 */
function row(date, result, profit, stake = 1, extra = {}) {
  return { gameId: `${date}-${result}-${profit}`, date, side: 'home', stake, result, profit, decimal: 2, clv: null, ...extra };
}

test('summarizeLedger：最大回撤与持续、最长连亏（作废不打断）、盈利月份比例、资金曲线', () => {
  // 逐日 profit [+1, −2, −1, +3]（d1..d4）
  const dd = summarizeLedger([
    row('2024-01-01', 'win', 1), row('2024-01-02', 'loss', -2, 2), row('2024-01-03', 'loss', -1), row('2024-01-04', 'win', 3),
  ]);
  assert.deepEqual(dd.curve, [
    { date: '2024-01-01', profit: 1, bankroll: 101 }, { date: '2024-01-02', profit: -2, bankroll: 99 },
    { date: '2024-01-03', profit: -1, bankroll: 98 }, { date: '2024-01-04', profit: 3, bankroll: 101 },
  ]);
  assert.deepEqual(dd.maxDrawdown, { units: 3, pctOfPeak: 3 / 101, days: 3, bets: 3, recovered: true });

  // 结果序列 [win, loss, loss, void, loss, win] → 最长连亏 3
  const st = summarizeLedger([
    row('2024-01-01', 'win', 1), row('2024-01-02', 'loss', -1), row('2024-01-03', 'loss', -1),
    row('2024-01-04', 'void', 0), row('2024-01-05', 'loss', -1), row('2024-01-06', 'win', 1),
  ]);
  assert.equal(st.longestLosingStreak, 3);
  assert.equal(st.voids, 1);
  // 回撤未收复：峰值 d1 101 → 98，到最后一日 d6 99 仍未收复
  assert.deepEqual(st.maxDrawdown, { units: 3, pctOfPeak: 3 / 101, days: 5, bets: 4, recovered: false });

  // 1 月 +1、2 月 −1、3 月 +0.5 → 盈利月份比例 2/3
  const mo = summarizeLedger([
    row('2024-01-05', 'win', 1), row('2024-02-05', 'loss', -1), row('2024-03-05', 'win', 0.5),
  ]);
  assert.deepEqual(mo.months.map((m) => [m.month, m.profit]), [['2024-01', 1], ['2024-02', -1], ['2024-03', 0.5]]);
  assert.equal(mo.profitableMonthShare, 2 / 3);
  assert.deepEqual([mo.bets, mo.wins, mo.losses, mo.staked, mo.profit, mo.roi, mo.hitRate, mo.avgDecimal],
    [3, 2, 1, 3, 0.5, 0.5 / 3, 2 / 3, 2]);
});

test('summarizeLedger：首日即亏，回撤从初始资金算起', () => {
  const s = summarizeLedger([row('2024-01-01', 'loss', -2), row('2024-01-03', 'win', 3)], { bankroll0: 10 });
  assert.deepEqual(s.maxDrawdown, { units: 2, pctOfPeak: 0.2, days: 2, bets: 2, recovered: true });
  assert.deepEqual(s.curve.map((d) => d.bankroll), [8, 11]);
});

test('summarizeLedger 回归：回到峰值后再跌得更深 → 最大回撤从新峰值算、未收复、持续到最后一日', () => {
  // bankroll 101, 98, 101, 95, 96（d1..d5）：最大回撤 6（d3 的 101 → d4 的 95），之后未收复
  const s = summarizeLedger([
    row('2024-01-01', 'win', 1), row('2024-01-02', 'loss', -3, 3), row('2024-01-03', 'win', 3),
    row('2024-01-04', 'loss', -6, 6), row('2024-01-05', 'win', 1),
  ]);
  assert.deepEqual(s.curve.map((d) => d.bankroll), [101, 98, 101, 95, 96]);
  assert.deepEqual(s.maxDrawdown, { units: 6, pctOfPeak: 6 / 101, days: 2, bets: 2, recovered: false });
});

test('空流水：不抛错，bets 0、roi null、curve []', () => {
  const s = summarizeLedger([]);
  assert.equal(s.bets, 0);
  assert.equal(s.roi, null);
  assert.equal(s.hitRate, null);
  assert.equal(s.avgDecimal, null);
  assert.equal(s.profitableMonthShare, null);
  assert.equal(s.clv, null);
  assert.deepEqual(s.curve, []);
  assert.deepEqual(s.maxDrawdown, { units: 0, pctOfPeak: 0, days: 0, bets: 0, recovered: true });
  assert.equal(s.longestLosingStreak, 0);
});

test('buildCandidates：缺价按原因计数；splitOf 为 null 的赛季不进', () => {
  const dk = { draftkings: { open: [130, -150], close: [150, -170], current: [150, -170] } };
  const g = (gameId, season, books) => ({
    gameId, date: '2023-11-01', season, homeId: 1, awayId: 2, homeWin: true, actual: 3, void: false,
    b2bHome: false, b2bAway: false, teamGp: 5, pHome: 0.5, paramsVersion: 'wf:2022-23', modelVersion: 'replay-elo-wf', books,
  });
  const splitOf = (season) => (season === '2021-22' ? null : 'validate');
  const games = [g('G2', '2023-24', dk), g('G1', '2023-24', {}), g('G0', '2021-22', dk), g('G3', '2023-24', { draftkings: { open: null, close: null, current: null } })];
  const out = buildCandidates(games, { scenario: 'close', splitOf });
  assert.deepEqual([out.total, out.priced, out.missing], [3, 1, { noUsBook: 1, noPrice: 1 }]);
  const c = out.candidates[0];
  assert.equal(c.books.length, 2);
  assert.deepEqual([c.gameId, c.scenario, c.split, c.ml, c.books, c.priceAt, c.closeMl, c.flags], ['G2', 'close', 'validate', [150, -170], ['draftkings', 'draftkings'], 'close', [150, -170], []]);
  assert.equal('books' in c && Array.isArray(c.books), true);   // 原 books 字典被选价结果取代

  const open = buildCandidates(games, { scenario: 'open', splitOf });
  assert.deepEqual([open.priced, open.missing], [1, { noUsBook: 1, noOpen: 1 }]);
  assert.deepEqual([open.candidates[0].ml, open.candidates[0].closeMl, open.candidates[0].priceAt], [[130, -150], [150, -170], 'open']);
});
