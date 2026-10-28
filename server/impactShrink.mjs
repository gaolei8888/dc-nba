/**
 * IMP 按样本量收缩（实验在 scripts/impact-shrink-lab.mjs；形式 C 的 shrinkByMinutes 已由 ingest 接入线上）。
 *
 * 起因：小样本球员的 IMP 偏高，例如 Thybulle 2025-26 只打 30 场 × 16 分钟（480 分钟），
 * IMP +4.45 比东契奇还高。EPM / LEBRON 的做法是：实测（正负值）那一半按回合数
 * 向统计栏先验收缩，证据越多越敢偏离先验；FiveThirtyEight 对 1000 分钟以下的球员放慢更新。
 *
 * 两种收缩，都是同一个公式 (n·值 + k·目标)/(n + k)，只是作用的对象不同：
 *   A  实测那一半向 SPM 收缩：n = 衰减 APM 背后的回合数。
 *      IMP = SPM + w·n/(n+k)·(APM − SPM)，k=0 即现状。
 *   B  SPM 本身向人群均值收缩：n = 该季出场总分钟（gp × 场均）。
 *      统计栏速率（每 36 分钟抢断、干扰球）在几百分钟上同样是噪声，A 管不到它。
 * 两者可以叠加（先 B 再 A）。k 取 0 表示不收缩。
 */

/** (n·value + k·target)/(n + k)；k=0 或 n=∞ 时原样返回 value */
export function shrinkToward(value, target, n, k) {
  if (!(k > 0)) return value;
  const m = Math.max(0, n ?? 0);
  return (m * value + k * target) / (m + k);
}

/**
 * 收缩后的 IMP（未舍入，单位与输入一致）。
 *
 * @param {object} x
 * @param {number|null} x.spm 统计栏 SPM（null = 不在训练区间，整体返回 null）
 * @param {number|null} x.apm 衰减 APM（null = 没有实测，退回 SPM，与 impact.blend 一致）
 * @param {number} [x.apmPoss] 衰减 APM 背后的（已加权）回合数
 * @param {number} [x.minutes] 该季出场总分钟
 * @param {object} opt
 * @param {number} opt.w 混合权重（线上 0.35）
 * @param {number} [opt.kApm] A：回合数意义上的 k，0 = 不收缩
 * @param {number} [opt.kSpm] B：分钟意义上的 k，0 = 不收缩
 * @param {number} [opt.spmTarget] B 的收缩目标（人群均值）
 */
export function shrunkImpact({ spm, apm, apmPoss = 0, minutes = 0 }, {
  w, kApm = 0, kSpm = 0, spmTarget = 0,
}) {
  if (spm === null || spm === undefined) return null;
  const s = shrinkToward(spm, spmTarget, minutes, kSpm);
  if (apm === null || apm === undefined) return s;
  const share = kApm > 0 ? Math.max(0, apmPoss) / (Math.max(0, apmPoss) + kApm) : 1;
  return s + w * share * (apm - s);
}

/**
 * 实验 1 选中的形式 C：整个 IMP 按出场分钟向人群均值收缩，再乘常数定量纲。
 *
 *   IMP' = μ + (IMP − μ) · m/(m+k) · (pivot+k)/pivot
 *
 * k 由留一赛季对选出（4 折都选 3200 分钟，1600–12800 一片平坦）。
 * 第二个因子只定量纲：相关系数与量纲无关，所以 pivot 由「次季目标对预测值的斜率」
 * 之比定出——收缩后斜率是现状的 3.0 倍（次季 APM 3.016、次季 on/off 3.001），
 * 补乘 3 即 pivot = k/(3−1) = 1600 分钟：打满 1600 分钟的人不变，少于它的被拉向均值，
 * 多于它的略微放大（2600 分钟 ×1.34）。阵容榜把 IMP×分钟直接加总，量纲不能丢。
 */
export const MINUTES_SHRINK = { k: 3200, pivot: 1600 };

export function shrinkByMinutes(imp, minutes, mu, { k, pivot } = MINUTES_SHRINK) {
  if (imp === null || imp === undefined) return null;
  const m = Math.max(0, minutes ?? 0);
  return mu + (imp - mu) * (m / (m + k)) * ((pivot + k) / pivot);
}

/** 人群均值：够门槛（SPM 非空）球员的简单均值，与实验里的收缩目标同口径 */
export function populationMean(values) {
  const ok = values.filter((v) => Number.isFinite(v));
  return ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : 0;
}
