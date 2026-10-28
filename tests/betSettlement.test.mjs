import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS, outcomeOf, settleBet } from '../server/betSettlement.mjs';

const o = (homeWin) => outcomeOf({ homeWin });

test('独赢盘结算：赢按实际报价，输 −stake，作废 0', () => {
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: o(true) }), { result: 'win', profit: 1.5 });
  const w = settleBet({ market: 'moneyline', side: 'away', american: -150, stake: 2, outcome: o(false) });
  assert.equal(w.result, 'win'); assert.ok(Math.abs(w.profit - 4 / 3) < 1e-9);
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: -150, stake: 1, outcome: o(false) }), { result: 'loss', profit: -1 });
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'away', american: 200, stake: 3, outcome: o(true) }), { result: 'loss', profit: -3 });
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: outcomeOf({ homeWin: null }) }), { result: 'void', profit: 0 });
});

test('手续费只扣赢注净利，输与作废不受影响', () => {
  assert.ok(Math.abs(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: o(true), feeOnWin: 0.02 }).profit - 1.47) < 1e-9);
  assert.equal(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: o(false), feeOnWin: 0.02 }).profit, -1);
  assert.equal(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: o(null), feeOnWin: 0.02 }).profit, 0);
});

test('outcomeOf：比分缺失、void 标记、非布尔 → 作废；正常 → 不作废', () => {
  assert.deepEqual(outcomeOf({ homeWin: true }), { homeWin: true, void: false });
  assert.deepEqual(outcomeOf({ homeWin: false }), { homeWin: false, void: false });
  assert.deepEqual(outcomeOf({ homeWin: null }), { homeWin: null, void: true });
  assert.deepEqual(outcomeOf({ homeWin: undefined }), { homeWin: null, void: true });
  assert.deepEqual(outcomeOf({ homeWin: true, void: true }), { homeWin: null, void: true });
  assert.deepEqual(outcomeOf({ homeWin: 1 }), { homeWin: null, void: true });
});

test('void 标记即使 homeWin 有值也作废（延期/取消）', () => {
  const out = outcomeOf({ homeWin: true, void: true });
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: out }), { result: 'void', profit: 0 });
});

test('非法报价：作废并带 reason，绝不静默按 0 盈亏当正常单', () => {
  for (const american of [0, 50, -99, NaN, Infinity, null, undefined, '150']) {
    assert.deepEqual(
      settleBet({ market: 'moneyline', side: 'home', american, stake: 1, outcome: o(true) }),
      { result: 'void', profit: 0, reason: 'invalid_price' });
  }
});

test('非法输入直接报错：side、stake、feeOnWin、outcome', () => {
  const base = { market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: o(true) };
  assert.throws(() => settleBet({ ...base, side: 'draw' }), /side/);
  assert.throws(() => settleBet({ ...base, stake: 0 }), /stake/);
  assert.throws(() => settleBet({ ...base, stake: -1 }), /stake/);
  assert.throws(() => settleBet({ ...base, stake: NaN }), /stake/);
  assert.throws(() => settleBet({ ...base, feeOnWin: -0.1 }), /feeOnWin/);
  assert.throws(() => settleBet({ ...base, feeOnWin: 1.5 }), /feeOnWin/);
  assert.throws(() => settleBet({ ...base, outcome: undefined }), /outcome/);
});

test('未实现的市场直接报错（让分 / 大小分本期不做），不静默当独赢盘', () => {
  for (const market of ['spread', 'totals', undefined, '']) {
    assert.throws(() => settleBet({ market, side: 'home', american: -110, stake: 1, outcome: o(true) }), /未实现的市场/);
  }
  assert.deepEqual(MARKETS, ['moneyline']);
});
