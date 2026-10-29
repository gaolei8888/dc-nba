/**
 * IMP 的逐项年龄曲线（DARKO 式；实验 5b，docs/imp-improve-verdict.md）。
 *
 * 每个 SPM 特征（每 36 分钟速率）各一条「从 a 岁到 a+1 岁」的平均变化 g_j(a)：
 * delta 法，只用相邻两季都有 ≥100 分钟的球员，权重为两季分钟的调和均值，
 * 连续分段线性（节点 23/27/31 岁，年龄截断到 [19, 38]）。
 * 用法：上季 IMP 是拿来预测本季的，所以上季特征先平移 g_j(上季年龄) 再套 SPM（impact.apply 的 aged 选项）。
 * 本季分段 SPM 测的是本季自己，不平移。
 *
 * 已知偏差（verdict 里有敏感性）：
 *   · 幸存者偏差：衰退最快的人退出样本，老年段偏乐观；
 *   · 曲线里混着联盟逐年的统计口径漂移（例如 contest 全年龄段都是负的），对所有人近似同幅平移。
 */
import { features, FEATURES } from './impact.mjs';
import { fitHinge } from './impImproveLab.mjs';

export const AGE_KNOTS = [23, 27, 31];
const NA_SRC = { defl: 'deflections', contest: 'contested', screen: 'screenAstPts', potAst: 'potentialAst', dSup: 'diffPct' };
export const AGE_CLIP = [19, 38];

/**
 * @param {Array<{from:Array, to:Array}>} seasonPairs 相邻两季的球员行（flat 形状，含 age、gp、min）
 * @returns {{knots:number[], clip:number[], coef:Object<string,number[]>, n:number}}
 */
export function fitAgeCurves(seasonPairs, { minMinutes = 100 } = {}) {
  const per = Object.fromEntries(FEATURES.map((k) => [k, []]));
  const mins = (p) => (p ? (p.gp ?? 0) * (p.min ?? 0) : 0);
  for (const { from, to } of seasonPairs) {
    const next = new Map(to.map((q) => [q.playerId, q]));
    for (const p of from) {
      const q = next.get(p.playerId);
      const m1 = mins(p); const m2 = mins(q);
      if (m1 < minMinutes || m2 < minMinutes || !Number.isFinite(p.age)) continue;
      const a = features(p); const b = features(q);
      if (!a || !b) continue;
      const w = (2 * m1 * m2) / (m1 + m2);
      for (const k of FEATURES) {
        // 源字段缺失（如 2015-16 大半球员没有 hustle）时 features() 记 0，差值没有意义，跳过
        const src = NA_SRC[k];
        if (src && (p[src] == null || q[src] == null)) continue;
        per[k].push({ x: p.age, y: b[k] - a[k], w });
      }
    }
  }
  const coef = {}; let n = 0;
  for (const k of FEATURES) {
    const g = fitHinge(per[k], AGE_KNOTS, AGE_CLIP);
    coef[k] = g.coef.map((c) => Math.round(c * 1e6) / 1e6);
    n = Math.max(n, g.n);
  }
  return { knots: AGE_KNOTS, clip: AGE_CLIP, coef, n };
}
