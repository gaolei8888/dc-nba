import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shrinkToward, shrunkImpact, shrinkByMinutes, populationMean, MINUTES_SHRINK,
} from '../server/impactShrink.mjs';
import { blend } from '../server/impact.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('shrinkToward：k=0 不动，n=0 全取目标，n=k 取中点', () => {
  assert.equal(shrinkToward(4, 0, 100, 0), 4);
  close(shrinkToward(4, 1, 0, 500), 1);
  close(shrinkToward(4, 0, 500, 500), 2);
  close(shrinkToward(4, 0, -10, 500), 0); // 负的证据量按 0 处理
});

test('shrunkImpact：不收缩时与 impact.blend 一致（未舍入），缺 APM 退回 SPM，缺 SPM 为 null', () => {
  for (const [spm, apm] of [[2.31, -1.2], [-0.4, 3.9], [0, 0]]) {
    close(Math.round(shrunkImpact({ spm, apm }, { w: 0.35 }) * 100) / 100, blend(spm, apm, 0.35));
  }
  assert.equal(shrunkImpact({ spm: 1.5, apm: null }, { w: 0.35 }), 1.5);
  assert.equal(shrunkImpact({ spm: null, apm: 2 }, { w: 0.35 }), null);
});

test('shrunkImpact：A 让实测那一半随回合数逐步生效，B 把 SPM 拉向目标', () => {
  // A：k = 回合数时，APM 的权重减半
  close(shrunkImpact({ spm: 1, apm: 3, apmPoss: 2000 }, { w: 0.4, kApm: 2000 }), 1 + 0.4 * 0.5 * 2);
  // B：分钟 = k 时，SPM 先拉到与目标的中点，再与 APM 混合
  close(shrunkImpact({ spm: 4, apm: null, minutes: 800 }, { w: 0.35, kSpm: 800, spmTarget: 0 }), 2);
  close(shrunkImpact({ spm: 4, apm: 1, minutes: 800 }, { w: 0.35, kSpm: 800, spmTarget: 0 }), 2 + 0.35 * (1 - 2));
});

test('shrinkByMinutes：pivot 分钟不变，0 分钟取均值，分钟越多越接近放大后的原值', () => {
  const { k, pivot } = MINUTES_SHRINK;
  close(shrinkByMinutes(4.45, pivot, 0.1), 4.45);
  close(shrinkByMinutes(4.45, 0, 0.1), 0.1);
  assert.equal(shrinkByMinutes(null, 1000, 0.1), null);
  const at = (m) => shrinkByMinutes(4, m, 0);
  assert.ok(at(480) < at(1000) && at(1000) < at(pivot) && at(pivot) < at(2600));
  // 显式公式：480 分钟的 +4.45（Thybulle 的量级）收缩后约 1.75 + 0.1 附近
  close(shrinkByMinutes(4.45, 480, 0.1), 0.1 + 4.35 * (480 / (480 + k)) * ((pivot + k) / pivot));
  // 收缩是对均值的线性变换：先乘量纲再收缩 = 先收缩再乘量纲
  close(shrinkByMinutes(2 * 3, 900, 2 * 0.5), 2 * shrinkByMinutes(3, 900, 0.5));
});

test('populationMean 忽略空值', () => {
  close(populationMean([1, null, 3, undefined, Number.NaN]), 2);
  assert.equal(populationMean([null]), 0);
});
