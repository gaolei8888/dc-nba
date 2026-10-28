import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, features } from '../server/impact.mjs';

// 只看拼抢一项的极简模型：均值 2 次 / 36 分钟，系数 1
const model = { features: ['defl'], mu: [2], sd: [1], beta: [1], intercept: 0 };
const row = (hustle) => ({ gp: 30, min: 30, base: { pts: 10 }, hustle });

test('missing hustle rows score as the population mean instead of zero', () => {
  assert.equal(apply(model, row({ deflections: 0, contested: 0, screenAstPts: 0 })), -2); // 真的是 0
  assert.equal(apply(model, row({ deflections: null, contested: null, screenAstPts: null })), 0); // 缺失 = 均值
  assert.equal(apply(model, row(undefined)), 0);
  assert.deepEqual(features(row({})).missing, ['defl', 'contest', 'screen']);
  assert.deepEqual(features(row({ deflections: 1 })).missing, []);
  // 训练用的特征值不变（仍记 0），只有打分时跳过
  assert.equal(features(row({})).defl, 0);
});
