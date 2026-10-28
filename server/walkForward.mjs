/**
 * walk-forward 参数拟合与胜率校准（回测新路径，不改线上生产参数）。
 *
 * 重放模型的分差 = Elo 分差 + 主场优势 + 休息权重 × 休息差。
 * 其中主场优势、休息权重、把分差换成胜率用的 SD 原来都是全局定值
 * （用全部赛季，含测试季，测出来的）——拿它回测等于偷看了答案。
 * 这里对每个测试赛季只用**此前**赛季的重放记录重新拟合这三个数，再重算该季的分差与胜率。
 *
 * Elo 轨迹与这三个数无关（Elo 更新只用比分与 ELO_HOME_ADV），所以只重放一次，
 * 之后靠记录里的 eloPts / restRaw 线性重组分差即可。
 *
 * 2021-22 只作 Elo 预热，没有重放记录；所以 2022-23 没有可用的此前赛季，
 * 只能样本内拟合，记为 'in-sample:2022-23'、inSample: true，报告里要照实标注。
 */
import { replay, DEFAULTS, normalCdf, score, calibration } from './lab.mjs';

export const MODEL_VERSION_REPLAY = 'replay-elo-wf';

export const WF_SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];

/** 不拟合的 Elo 参数：来自 FiveThirtyEight NBA Elo 方法（外部来源） */
export const FIXED_PARAMS = {
  k: DEFAULTS.k,
  carryKeep: DEFAULTS.carryKeep,
  source: 'FiveThirtyEight NBA Elo（k = 20，赛季间保留 75%）；外部来源，不拟合',
};

const DEFAULT_FIT = { homeAdv: DEFAULTS.homeAdv, restWeight: DEFAULTS.restWeight, spreadSd: DEFAULTS.spreadSd };

const EPS = 1e-12;
const clampP = (p) => Math.min(1 - EPS, Math.max(EPS, p));

/**
 * 无截距 OLS：actual − eloPts ~ homeAdv·(neutral ? 0 : 1) + restWeight·restRaw。
 * 两个回归量，直接解 2×2 正规方程。
 */
export function fitMarginParams(rows) {
  let s11 = 0; let s12 = 0; let s22 = 0; let b1 = 0; let b2 = 0;
  for (const r of rows) {
    const x1 = r.neutral ? 0 : 1;
    const x2 = r.restRaw;
    const y = r.actual - r.eloPts;
    s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2;
    b1 += x1 * y; b2 += x2 * y;
  }
  const det = s11 * s22 - s12 * s12;
  if (!(Math.abs(det) > 1e-12)) throw new Error('fitMarginParams：样本不足以同时识别主场优势与休息权重');
  return {
    homeAdv: (b1 * s22 - b2 * s12) / det,
    restWeight: (s11 * b2 - s12 * b1) / det,
  };
}

/** 平均对数损失：p = Φ(margin / σ) */
function normalLogloss(rows, margins, sd) {
  let s = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const p = clampP(normalCdf(margins[i], sd));
    s -= rows[i].homeWin ? Math.log(p) : Math.log(1 - p);
  }
  return s / rows.length;
}

/** 使 Φ(margin/σ) 对数损失最小的 σ：黄金分割搜索，区间 [6, 24]，容差 1e-4 */
export function fitSpreadSd(rows, margins, { lo = 6, hi = 24, tol = 1e-4 } = {}) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo; let b = hi;
  let c = b - g * (b - a); let d = a + g * (b - a);
  let fc = normalLogloss(rows, margins, c); let fd = normalLogloss(rows, margins, d);
  while (b - a > tol) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - g * (b - a); fc = normalLogloss(rows, margins, c);
    } else {
      a = c; c = d; fc = fd;
      d = a + g * (b - a); fd = normalLogloss(rows, margins, d);
    }
  }
  return (a + b) / 2;
}

/**
 * 逻辑斯蒂刻度 p = 1/(1+e^{−(a + b·margin)})，牛顿法求最大似然。
 * 只作诊断（a 显著偏离 0 说明分差有系统偏置；1.7/b 可与正态 SD 对照），主概率仍用正态 SD。
 */
export function fitLogistic(rows, margins, { maxIter = 50, tol = 1e-10 } = {}) {
  let a = 0; let b = 0;
  for (let it = 0; it < maxIter; it += 1) {
    let ga = 0; let gb = 0; let haa = 0; let hab = 0; let hbb = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const m = margins[i];
      const p = 1 / (1 + Math.exp(-(a + b * m)));
      const e = (rows[i].homeWin ? 1 : 0) - p;
      const w = p * (1 - p);
      ga += e; gb += e * m;
      haa += w; hab += w * m; hbb += w * m * m;
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) < tol && Math.abs(db) < tol) break;
  }
  return { a, b };
}

const marginOf = (r, mp) => r.eloPts + (r.neutral ? 0 : mp.homeAdv) + mp.restWeight * r.restRaw;

/** 一组 (概率, 分差) 的校准指标：Brier、LogLoss、10 档可靠性 */
function calibBlock(rows, probs, margins, spreadSd) {
  const scored = rows.map((r, i) => ({ p: probs[i], pred: margins[i], actual: r.actual, homeWin: r.homeWin }));
  const s = score(scored);
  return {
    spreadSd, n: s.n, brier: s.brier, logloss: s.logloss, reliability: calibration(scored),
  };
}

/**
 * 逐测试季 walk-forward。
 * 返回 records（重放记录 + pWF / marginWF / paramsVersion）与 fits（每季拟合值、默认值、校准对比）。
 */
export function walkForward(dataset, { seasons = WF_SEASONS } = {}) {
  // Elo 轨迹与 homeAdv / restWeight / spreadSd 无关：只重放一次
  const base = replay(dataset, seasons, DEFAULTS);
  const bySeason = new Map();
  for (const r of base) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season).push(r);
  }
  const present = seasons.filter((s) => bySeason.has(s));

  const records = [];
  const fits = present.map((season, idx) => {
    const inSample = idx === 0;
    const fitSeasons = inSample ? [season] : present.slice(0, idx);
    const train = fitSeasons.flatMap((s) => bySeason.get(s));

    const mp = fitMarginParams(train);
    const trainMargins = train.map((r) => marginOf(r, mp));
    const spreadSd = fitSpreadSd(train, trainMargins);
    const logistic = fitLogistic(train, trainMargins);
    const paramsVersion = inSample ? `in-sample:${season}` : `wf:${fitSeasons[fitSeasons.length - 1]}`;

    const test = bySeason.get(season);
    const margins = test.map((r) => marginOf(r, mp));
    const pFit = margins.map((m) => normalCdf(m, spreadSd));
    const p12 = margins.map((m) => normalCdf(m, DEFAULTS.spreadSd));
    for (let i = 0; i < test.length; i += 1) {
      records.push({ ...test[i], marginWF: margins[i], pWF: pFit[i], paramsVersion });
    }

    return {
      season,
      fitSeasons,
      inSample,
      paramsVersion,
      n: test.length,
      nTrain: train.length,
      homeAdv: mp.homeAdv,
      restWeight: mp.restWeight,
      spreadSd,
      logistic,
      defaults: { ...DEFAULT_FIT },
      // 测试季上的校准对比：同一组 walk-forward 分差，σ = 拟合值 vs σ = 12；
      // allDefaults 是三项全用全局默认值的原重放（record.p）作参照
      calibration: {
        fitted: calibBlock(test, pFit, margins, spreadSd),
        sd12: calibBlock(test, p12, margins, DEFAULTS.spreadSd),
        allDefaults: calibBlock(test, test.map((r) => r.p), test.map((r) => r.pred), DEFAULTS.spreadSd),
      },
    };
  });

  return { records, fits, fixed: { ...FIXED_PARAMS }, modelVersion: MODEL_VERSION_REPLAY };
}
