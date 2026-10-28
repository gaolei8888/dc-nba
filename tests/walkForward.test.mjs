import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { normalCdf } from '../server/lab.mjs';
import { rng } from '../server/fusionLab.mjs';
import {
  fitMarginParams, fitSpreadSd, fitLogistic, walkForward, MODEL_VERSION_REPLAY,
} from '../server/walkForward.mjs';

// 提交在库里的真实数据裁剪件（data/backtest.json 被 gitignore，测试不能依赖它）
const FIXTURE = fileURLToPath(new URL('./fixtures/backtest-mini.json.gz', import.meta.url));
const loadFixture = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'));

test('fitMarginParams：无噪声数据精确还原主场优势与休息权重', () => {
  const rows = Array.from({ length: 200 }, (_, i) => {
    const eloPts = (i % 17) - 8; const restRaw = [-1.1, 0, 0.35, 0.5][i % 4]; const neutral = i % 50 === 0;
    return { eloPts, restRaw, neutral, actual: eloPts + (neutral ? 0 : 2.0) + 1.5 * restRaw };
  });
  const f = fitMarginParams(rows);
  assert.ok(Math.abs(f.homeAdv - 2.0) < 1e-9 && Math.abs(f.restWeight - 1.5) < 1e-9, JSON.stringify(f));
});

// 按 Φ(m/13) 抽胜负的合成数据
const synth = () => {
  const rand = rng(7);
  const margins = []; const rows = [];
  for (let i = 0; i < 20000; i += 1) {
    const m = rand() * 30 - 15;
    margins.push(m);
    rows.push({ homeWin: rand() < normalCdf(m, 13) });
  }
  return { rows, margins };
};

test('fitSpreadSd：按 Φ(m/13) 生成的胜负，拟合 σ 在 13 ± 0.6 内', () => {
  const { rows, margins } = synth();
  const sd = fitSpreadSd(rows, margins);
  assert.ok(Math.abs(sd - 13) < 0.6, `sd=${sd}`);
  assert.ok(sd > 6 && sd < 24);
});

test('fitLogistic：正态 σ=13 的数据，截距≈0、斜率≈1.7/13（probit→logit 换算）', () => {
  const { rows, margins } = synth();
  const { a, b } = fitLogistic(rows, margins);
  assert.ok(Math.abs(a) < 0.06, `a=${a}`);
  assert.ok(Math.abs(b - 1.7 / 13) < 0.012, `b=${b}`);
});

test('walkForward：测试季参数只用此前赛季——改动 2025-26 的比分不改变 2025-26 的拟合', () => {
  const ds = loadFixture();
  const swapped = structuredClone(ds);
  for (const g of swapped.seasons['2025-26']) {
    const [x, y] = g.s;
    [x[1], y[1]] = [y[1], x[1]];
  }
  const a = walkForward(ds);
  const b = walkForward(swapped);
  const fitOf = (wf, s) => wf.fits.find((f) => f.season === s);

  assert.deepEqual(a.fits.map((f) => f.season), ['2022-23', '2023-24', '2024-25', '2025-26']);
  for (const s of ['2022-23', '2023-24', '2024-25', '2025-26']) {
    for (const key of ['homeAdv', 'restWeight', 'spreadSd']) assert.equal(fitOf(a, s)[key], fitOf(b, s)[key], `${s} ${key}`);
    assert.deepEqual(fitOf(a, s).logistic, fitOf(b, s).logistic);
  }
  assert.deepEqual(fitOf(a, '2025-26').fitSeasons, ['2022-23', '2023-24', '2024-25']);
  assert.deepEqual(fitOf(a, '2023-24').fitSeasons, ['2022-23']);
  assert.equal(fitOf(a, '2025-26').inSample, false);

  // 2022-23 没有此前重放季：样本内拟合，明确标注
  const f22 = fitOf(a, '2022-23');
  assert.equal(f22.inSample, true);
  assert.deepEqual(f22.fitSeasons, ['2022-23']);
  const rec = (wf, s) => wf.records.filter((r) => r.season === s);
  assert.ok(rec(a, '2022-23').every((r) => r.paramsVersion === 'in-sample:2022-23'));
  assert.ok(rec(a, '2025-26').length === 1230 && rec(a, '2025-26').every((r) => r.paramsVersion === 'wf:2024-25'));
  assert.ok(rec(a, '2024-25').every((r) => r.paramsVersion === 'wf:2023-24'));
  assert.equal(MODEL_VERSION_REPLAY, 'replay-elo-wf');

  // 非空检验：比分对调确实改变了 2025-26 本身（若用它拟合，结果会变）
  const own = (wf) => fitMarginParams(rec(wf, '2025-26')).homeAdv;
  assert.ok(Math.abs(own(a) - own(b)) > 1, `${own(a)} vs ${own(b)}`);

  // 重算的概率与分差：marginWF = eloPts + hca + restWeight·restRaw，pWF = Φ(marginWF/σ)
  const f = fitOf(a, '2025-26');
  for (const r of rec(a, '2025-26').slice(0, 50)) {
    const m = r.eloPts + (r.neutral ? 0 : f.homeAdv) + f.restWeight * r.restRaw;
    assert.equal(r.marginWF, m);
    assert.equal(r.pWF, normalCdf(m, f.spreadSd));
  }
  assert.deepEqual(f.defaults, { homeAdv: 1.6, restWeight: 1.8, spreadSd: 12 });
  assert.equal(f.n, 1230);
});

test('walkForward：fits 带拟合 SD 与默认 12 的校准对比（Brier / LogLoss / 可靠性分档）', () => {
  const wf = walkForward(loadFixture());
  for (const f of wf.fits) {
    const c = f.calibration;
    assert.equal(c.fitted.spreadSd, f.spreadSd);
    assert.equal(c.sd12.spreadSd, 12);
    for (const side of [c.fitted, c.sd12]) {
      assert.equal(side.n, f.n);
      assert.ok(side.brier > 0.15 && side.brier < 0.3, `${f.season} brier ${side.brier}`);
      assert.ok(side.logloss > 0.45 && side.logloss < 0.8);
      assert.ok(side.reliability.length >= 5);
      assert.equal(side.reliability.reduce((s, b) => s + b.n, 0), f.n);
    }
  }
  // 拟合 SD 在样本内不应比 12 更差（样本内对数损失最优）
  const f22 = wf.fits[0];
  assert.ok(f22.calibration.fitted.logloss <= f22.calibration.sd12.logloss);
  assert.equal(wf.fixed.k, 20);
  assert.equal(wf.fixed.carryKeep, 0.75);
});
