/**
 * IMP 改进实验的纯函数部分（scripts/imp-improve-lab.mjs 用；预注册见 docs/imp-improve-verdict.md）。
 *
 * 这里只放「新数学」，方便单测：
 *   possShare        实验 1：APM 权重随回合数增长 w = wmax·n/(n+c)
 *   blendToward      SPM + w·(APM − SPM)，APM 缺失退回 SPM（与 impact.blend 同口径，但不舍入）
 *   momentPadding    实验 6：季内矩估计的稳定化 padding（(f−f̄)² = σ² + c/m → pad = c/σ²）
 *   padValue         实验 6：f' = (m·f + pad·f̄)/(m + pad)
 *   hingeBasis / fitHinge  实验 5：连续分段线性年龄曲线（加权最小二乘）
 *   lopoPick         留一赛季对选参
 *   verdict          预注册采纳规则
 */
import { ridge } from './impact.mjs';

/**
 * 实验 8：多季加权平均。items[j] = {v, m}（j=0 为第 N 季，v 为数或等长数组，缺季传 null），
 * 权重 d_j·m_j。返回 { v, mEff }，mEff = Σ d_j·m_j；一季都没有返回 null。
 */
export function multiSeasonAvg(items, d) {
  let tot = 0; let acc = null; let wts = null;
  items.forEach((it, j) => {
    if (!it || it.v === null || it.v === undefined || !(it.m > 0) || !(d[j] > 0)) return;
    const w = d[j] * it.m;
    if (Array.isArray(it.v)) {
      // 向量逐项加权：某季某项缺失（NaN，例如 2015-16 大半球员没有 hustle）就只在该项上跳过这一季
      if (!acc) { acc = new Array(it.v.length).fill(0); wts = new Array(it.v.length).fill(0); }
      it.v.forEach((x, i) => { if (Number.isFinite(x)) { acc[i] += w * x; wts[i] += w; } });
    } else acc = (acc ?? 0) + w * it.v;
    tot += w;
  });
  if (!(tot > 0)) return null;
  return { v: Array.isArray(acc) ? acc.map((x, i) => (wts[i] > 0 ? x / wts[i] : NaN)) : acc / tot, mEff: tot };
}

/** 实验 1：c=0 表示常数权重 wmax；n 为（半衰期加权的）APM 回合数 */
export function possShare(n, { wmax, c }) {
  if (!(c > 0)) return wmax;
  const m = Math.max(0, n ?? 0);
  return (wmax * m) / (m + c);
}

/** SPM + w·(APM − SPM)；SPM 缺失返回 null，APM 缺失退回 SPM */
export function blendToward(spm, apm, w) {
  if (spm === null || spm === undefined) return null;
  if (apm === null || apm === undefined) return spm;
  return spm + w * (apm - spm);
}

/**
 * 实验 6：一项速率的稳定化 padding。
 *
 * 拿不到逐场球员 box，做不了折半信度；改用季内矩估计。设观测速率 f = 真值 + 噪声，
 * 噪声方差 ∝ 1/分钟（每 36 分钟速率的抽样方差随样本量反比下降），则
 *   E[(f − f̄)²] = σ² + c/m
 * 对 1/m 做 OLS 得 σ²（真值方差）与 c；padding = c/σ²（分钟），即信度 = m/(m + pad)。
 * σ² ≤ 0 说明这项基本全是噪声，padding 取上限；c ≤ 0 说明测不出噪声，padding = 0。
 *
 * @param {Array<{f:number, m:number}>} obs 每名球员的速率与出场分钟
 * @param {object} [opt] maxPad：padding 上限（分钟）
 * @returns {{mean:number, sigma2:number, c:number, pad:number}}
 */
export function momentPadding(obs, { maxPad = 100000 } = {}) {
  const ok = obs.filter((o) => Number.isFinite(o.f) && o.m > 0);
  if (ok.length < 3) return { mean: 0, sigma2: 0, c: 0, pad: 0 };
  const totM = ok.reduce((s, o) => s + o.m, 0);
  const fbar = ok.reduce((s, o) => s + o.f * o.m, 0) / totM;
  // OLS：y = (f − f̄)²，x = 1/m
  const xs = ok.map((o) => 1 / o.m); const ys = ok.map((o) => (o.f - fbar) ** 2);
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const c = sxx > 0 ? sxy / sxx : 0;
  const sigma2 = my - c * mx;
  let pad;
  if (!(c > 0)) pad = 0;
  else if (!(sigma2 > 0)) pad = maxPad;
  else pad = Math.min(maxPad, c / sigma2);
  return { mean: fbar, sigma2, c, pad };
}

/** 实验 6：向均值收缩一项速率；pad=0 原样返回 */
export function padValue(f, m, pad, target) {
  if (!(pad > 0)) return f;
  const mm = Math.max(0, m ?? 0);
  return (mm * f + pad * target) / (mm + pad);
}

/** 实验 5：连续分段线性基 [1, x, (x−k1)+, (x−k2)+, …]，x 先截断到 [lo, hi] */
export function hingeBasis(x, knots, [lo, hi] = [-Infinity, Infinity]) {
  const v = Math.min(hi, Math.max(lo, x));
  return [1, v, ...knots.map((k) => Math.max(0, v - k))];
}

/**
 * 实验 5：加权最小二乘拟合分段线性曲线。
 * @param {Array<{x:number, y:number, w:number}>} samples
 * @returns {{coef:number[], at:(x:number)=>number, n:number}}
 */
export function fitHinge(samples, knots, clip = [-Infinity, Infinity]) {
  const ok = samples.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y) && s.w > 0);
  // 样本不足（例如最早一季之前没有相邻赛季对）时返回恒为 0 的曲线 = 不做年龄调整
  if (ok.length < knots.length + 2) {
    const coef = new Array(knots.length + 2).fill(0);
    return { coef, at: () => 0, n: ok.length };
  }
  // 极小的岭只为数值稳定，不起收缩作用
  const coef = ridge(ok.map((s) => hingeBasis(s.x, knots, clip)), ok.map((s) => s.y), ok.map((s) => s.w), 1e-6);
  const at = (x) => hingeBasis(x, knots, clip).reduce((s, b, i) => s + b * coef[i], 0);
  return { coef, at, n: ok.length };
}

/**
 * 实验 5b/8d：从 a0 岁对齐到 a1 岁的累计年龄增量 Σ_{a=a0}^{a1−1} g(a)（g 为「从 a 岁到 a+1 岁」的一年变化）。
 * a1 < a0 时取反（往年轻方向平移）；年龄取整。
 */
export function cumShift(g, a0, a1) {
  const lo = Math.round(Math.min(a0, a1)); const hi = Math.round(Math.max(a0, a1));
  let s = 0;
  for (let a = lo; a < hi; a++) s += g(a);
  return a1 >= a0 ? s : -s;
}

/**
 * 留一赛季对选参。
 * @param {Array<{cfg:any, s:Array<{apm:number, onoff:number}>}>} table 每个候选在每对上的两尺
 * @returns {Array<{cfg:any, s:{apm:number,onoff:number}}>} 每个留出对选中的候选及其在留出对上的成绩
 */
export function lopoPick(table) {
  const nPairs = table[0].s.length;
  return Array.from({ length: nPairs }, (_, i) => {
    let pick = null;
    for (const { cfg, s } of table) {
      const others = s.filter((_, j) => j !== i);
      const v = others.reduce((a, x) => a + (x.apm + x.onoff) / 2, 0) / others.length;
      if (!pick || v > pick.v + 1e-12) pick = { cfg, v, s: s[i] };
    }
    return { cfg: pick.cfg, s: pick.s };
  });
}

/**
 * 实验 8：统计栏多季加权的赛季衰减权重 d_j（j=0 为第 N 季）。
 * single = 只用第 N 季（现状）；marcel = 5/4/3 归一；exp = 半衰期 h 季；equal = 等权。
 */
export function seasonWeights({ mode, h = 1 }, n = 3) {
  return Array.from({ length: n }, (_, j) => {
    if (mode === 'single') return j === 0 ? 1 : 0;
    if (mode === 'marcel') return [1, 0.8, 0.6, 0.4, 0.2][j] ?? 0; // 5/4/3(/2/1) 归一
    if (mode === 'equal') return 1;
    return 0.5 ** (j / h);
  });
}

/**
 * 预注册采纳规则：两尺 4 对平均 Δ 都 > 0，且任一尺子输（Δ<0）的对数 ≤ maxLose（4 对时为 2）。
 * @param {number[]} dA 次季 APM 尺子逐对 Δ；@param {number[]} dO 次季 on/off 尺子逐对 Δ
 */
export function verdict(dA, dO, { maxLose = Math.floor(dA.length / 2), eps = 1e-9 } = {}) {
  const m = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mA = m(dA); const mO = m(dO);
  const loseA = dA.filter((v) => v < -eps).length; const loseO = dO.filter((v) => v < -eps).length;
  return { mA, mO, loseA, loseO, adopt: mA > 0 && mO > 0 && loseA <= maxLose && loseO <= maxLose };
}
