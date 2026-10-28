/**
 * 阵容先验 + 本季战绩修正（贝叶斯式更新，类似 ESPN BPI / FiveThirtyEight「先验 + 本季结果」）。
 *
 * 模型：每队强度 r_i（每场净胜分，联盟均值 0）。
 *   先验：r_i ~ N(p_i, σ²/K)，p_i = 阵容估计（liveRosterRankings 的 total）
 *   每场：m_g − h_g ~ N(r_主 − r_客, σ²)，m_g = 主队净胜分，h_g = 主场优势（中立场 0）
 * 后验均值 = 带先验的岭回归解，满足（对每队）：
 *
 *   r_i = (K·p_i + n_i·adj_i) / (K + n_i)
 *   adj_i = 本队这 n_i 场的「对手调整后净胜分」均值 = mean(本队净胜分 − 主场项 + r_对手)
 *
 * 即「先验值 K 场」：已赛 n 场时先验权重 K/(K+n)，战绩越多权重越低。
 * 加了近期加权后，n 换成各场权重之和 Σw、均值换成加权均值（每场噪声方差按 1/w 放大）。
 * 对手强度 r_对手 取同一张后验榜（SRS 式），用 Gauss–Seidel 迭代求解；K>0 时方程组严格对角占优，必收敛。
 */
import { normalCdf } from './lab.mjs';

/**
 * 线上配置：留一赛季在 96 组预注册候选（K × {无, 先验下限, 近期加权, 净胜分截断}）里按 log loss 选出，
 * 四折都选「近期加权」，K=8/8/10/12；四季合并选 K=8。见回测脚本与结论文档。
 * 近期加权：每场权重 0.4^(距今天数/60)，约等于「第 1 场是第 30 场权重的 40%」（KenPom 式）。
 */
export const RESULTS = Object.freeze({ K: 8, recency: Object.freeze({ ratio: 0.4, days: 60 }) });

/**
 * 单场预测：净胜分 = r主 − r客 + 主场项（中立场 0）+ 休息项，胜率 = Φ(净胜分 / sd)。
 * 回测（scripts/roster-results-backtest.mjs）与影子运行（server/rosterResultsShadow.mjs）共用这一个函数，保证同口径。
 */
export function gamePred(ratingHome, ratingAway, hca, restPts, sd) {
  const margin = ratingHome - ratingAway + hca + restPts;
  return { margin, p: normalCdf(margin, sd) };
}

const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

/**
 * @param {Map<number, number>} priors teamId → 先验（每场净胜分）
 * @param {Array<{homeId:number, awayId:number, margin:number, hca:number, date?:string}>} games
 *   已完赛：margin = 主队得分 − 客队得分，hca = 主场项（中立场 0）
 * @param {number} K 先验值几场；Infinity = 只用先验
 * @param {object} [opts] 以下三项只做回测里的预注册变体，线上默认都不开：
 *   cap      单场净胜分截断（只有终场比分时代替垃圾时间剔除）
 *   floor    先验权重下限：K_i = max(K, floor·n/(1−floor))，即先验权重 = max(K/(K+n), floor)（BPI 式「先验永不归零」）
 *   recency  { ratio, days, asOf }：每场权重 ratio^(距 asOf 的天数/days)（KenPom 式近期加权）
 * @returns {Map<number, {rating:number, prior:number, n:number, weight:number, priorWeight:number, adjResult:number|null}>}
 */
export function resultsUpdate(priors, games, K, {
  cap = Infinity, floor = 0, recency = null, iters = 500, tol = 1e-9,
} = {}) {
  const ids = new Set(priors.keys());
  const opp = new Map([...ids].map((id) => [id, []])); // teamId → [{ opp, m, w }]，m = 本队视角的调整后净胜分
  const asOf = recency ? dayNum(recency.asOf) : 0;
  for (const g of games) {
    if (!ids.has(g.homeId) || !ids.has(g.awayId)) continue;
    const m = Math.max(-cap, Math.min(cap, g.margin)) - (g.hca ?? 0);
    const w = recency ? recency.ratio ** (Math.max(0, asOf - dayNum(g.date)) / recency.days) : 1;
    opp.get(g.homeId).push({ opp: g.awayId, m, w });
    opp.get(g.awayId).push({ opp: g.homeId, m: -m, w });
  }
  const weight = new Map([...ids].map((id) => [id, opp.get(id).reduce((s, x) => s + x.w, 0)]));
  const kOf = (id) => (floor > 0 ? Math.max(K, (floor * weight.get(id)) / (1 - floor)) : K);
  const r = new Map(priors);
  if (K !== Infinity) {
    for (let it = 0; it < iters; it += 1) {
      let delta = 0;
      for (const id of ids) {
        const list = opp.get(id);
        if (!list.length) continue;
        const k = kOf(id);
        const sum = list.reduce((s, x) => s + x.w * (x.m + r.get(x.opp)), 0);
        const next = (k * priors.get(id) + sum) / (k + weight.get(id));
        delta = Math.max(delta, Math.abs(next - r.get(id)));
        r.set(id, next);
      }
      if (delta < tol) break;
    }
  }
  const out = new Map();
  for (const id of ids) {
    const list = opp.get(id); const W = weight.get(id); const k = kOf(id);
    out.set(id, {
      rating: r.get(id), prior: priors.get(id), n: list.length, weight: W,
      priorWeight: k === Infinity ? 1 : k / (k + W),
      adjResult: W > 0 ? list.reduce((s, x) => s + x.w * (x.m + r.get(x.opp)), 0) / W : null,
    });
  }
  return out;
}
