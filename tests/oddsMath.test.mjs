import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidAmerican, americanToDecimal, decimalToAmerican, breakEven,
  devigPair, edgeOf, evPerUnit, kellyFraction, worsenAmerican,
} from '../server/oddsMath.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('美式 ↔ 十进制', () => {
  close(americanToDecimal(150), 2.5); close(americanToDecimal(-150), 1.6666667); close(americanToDecimal(-110), 1.9090909);
  assert.equal(decimalToAmerican(2.5), 150); assert.equal(decimalToAmerican(1 + 100 / 150), -150);
});
test('盈亏平衡：+150 → 0.4，−150 → 0.6，−110 → 0.5238095', () => {
  close(breakEven(150), 0.4); close(breakEven(-150), 0.6); close(breakEven(-110), 0.5238095);
});
test('去水：同一家两侧按比例归一', () => {
  const d = devigPair(-150, 130); close(d.home, 0.5798319); close(d.away, 0.4201681); close(d.overround, 1.0347826);
  close(devigPair(-110, -110).home, 0.5); assert.equal(devigPair(null, -110), null);
});
test('edge 与 EV', () => {
  close(edgeOf(0.45, 150), 0.05); close(evPerUnit(0.45, 150), 0.125);
  close(evPerUnit(0.6, -150), 0); close(evPerUnit(0.5, -110), -0.0454545);
});
test('Kelly：f* = (b·p − q)/b，乘分数后截到 [0, cap]', () => {
  close(kellyFraction(0.5, 150), 0.05);
  close(kellyFraction(0.5, 150, { mult: 0.25 }), 0.0416667);
  close(kellyFraction(0.55, -110, { mult: 0.5 }), 0.0275);
  close(kellyFraction(0.55, -110, { mult: 0.5, cap: 1 }), 0.0275);
  assert.equal(kellyFraction(0.35, 150), 0);
});
test('滑点：按美式点数变差，越过 ±100 连续', () => {
  assert.equal(worsenAmerican(150, 5), 145); assert.equal(worsenAmerican(-150, 5), -155);
  assert.equal(worsenAmerican(102, 5), -103); assert.equal(worsenAmerican(100, 5), -105); assert.equal(worsenAmerican(-110, 0), -110);
});
test('isValidAmerican', () => {
  assert.equal(isValidAmerican(-110), true); assert.equal(isValidAmerican(50), false); assert.equal(isValidAmerican(NaN), false);
  for (const bad of [0, null, undefined, '−110', '150', Infinity, -99.9, 99]) assert.equal(isValidAmerican(bad), false, String(bad));
  assert.equal(isValidAmerican(100), true); assert.equal(isValidAmerican(-100), true);
});
test('非法输入：数值函数一律抛 RangeError，devigPair 返回 null', () => {
  for (const bad of [0, NaN, 50, -99, null, undefined, '150']) {
    assert.throws(() => americanToDecimal(bad), RangeError, `decimal ${bad}`);
    assert.throws(() => breakEven(bad), RangeError, `breakEven ${bad}`);
    assert.throws(() => edgeOf(0.5, bad), RangeError);
    assert.throws(() => evPerUnit(0.5, bad), RangeError);
    assert.throws(() => kellyFraction(0.5, bad), RangeError);
    assert.throws(() => worsenAmerican(bad, 5), RangeError);
    assert.equal(devigPair(bad, -110), null); assert.equal(devigPair(-110, bad), null);
  }
  for (const bad of [0.99, 1, 0, NaN, -5, null]) assert.throws(() => decimalToAmerican(bad), RangeError, `d ${bad}`);
  for (const p of [-0.1, 1.1, NaN, null]) {
    assert.throws(() => edgeOf(p, -110), RangeError); assert.throws(() => evPerUnit(p, -110), RangeError);
    assert.throws(() => kellyFraction(p, -110), RangeError);
  }
  assert.throws(() => worsenAmerican(-110, -1), RangeError); assert.throws(() => worsenAmerican(-110, NaN), RangeError);
  assert.throws(() => kellyFraction(0.5, -110, { mult: -1 }), RangeError);
  assert.throws(() => kellyFraction(0.5, -110, { cap: -0.1 }), RangeError);
});
test('边界：p=0/1、decimalToAmerican 取整与 even 价', () => {
  assert.equal(kellyFraction(0, -110), 0); close(kellyFraction(1, -110), 0.05); close(kellyFraction(1, -110, { cap: 1 }), 1);
  assert.equal(decimalToAmerican(2), 100); assert.equal(decimalToAmerican(1.9090909), -110);
  close(evPerUnit(1, -110), 0.9090909); close(evPerUnit(0, 150), -1);
  const d = devigPair(100, 100); close(d.home, 0.5); close(d.overround, 1);
});
