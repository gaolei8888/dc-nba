/**
 * 从五人组合数据算 APM（调整后正负值）。
 *
 * 为什么要这个：裸 on/off 被队友严重污染——一个替补中锋只要总跟主力同时上场，
 * on/off 就会很好看。我们的 IMP 前十里混进 Paul Reed、Thybulle 这类角色球员，
 * 就是这个毛病。EPM 用 RAPM 作为回归目标，正是为了解决它。
 *
 * 做法：把每个五人组合当一条观测，球员当自变量（在场为 1），
 * 用回合数加权做岭回归，让回归自己去分离"这几分是谁带来的"。
 * 进攻与防守分开拟合，每名球员两个系数——与 EPM 的"two variables per player"一致。
 *
 * **必须说清楚的局限**：leaguedashlineups 只给进攻方的五个人，不给对手阵容，
 * 所以这里算出来的是**未做对手调整**的 APM，不是严格意义的 RAPM。
 * 真正的 RAPM 需要逐回合的攻防双方阵容，那要解析每场的 play-by-play。
 * 差别在于：一整个赛季下来对手大致会平均掉，但对上场时间少、
 * 对手分布不均匀的球员，估计仍会有偏。
 */

/** 岭回归：法方程 + 高斯消元。特征是 0/1 指示变量，规模 ~500 列，足够快。 */
function ridgeSolve(rows, nCols, lambda) {
  const A = Array.from({ length: nCols }, () => new Float64Array(nCols));
  const b = new Float64Array(nCols);
  for (const { idx, y, w } of rows) {
    for (let i = 0; i < idx.length; i++) {
      const ri = idx[i];
      b[ri] += w * y;
      for (let j = 0; j < idx.length; j++) A[ri][idx[j]] += w;
    }
  }
  for (let i = 0; i < nCols; i++) A[i][i] += lambda;

  // 高斯消元（部分主元）
  const M = Array.from({ length: nCols }, (_, i) => {
    const row = new Float64Array(nCols + 1);
    row.set(A[i]);
    row[nCols] = b[i];
    return row;
  });
  for (let c = 0; c < nCols; c++) {
    let piv = c;
    for (let r = c + 1; r < nCols; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
    const d = M[c][c];
    if (Math.abs(d) < 1e-10) continue;
    for (let r = 0; r < nCols; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let j = c; j <= nCols; j++) M[r][j] -= f * M[c][j];
    }
  }
  const out = new Float64Array(nCols);
  for (let i = 0; i < nCols; i++) out[i] = Math.abs(M[i][i]) < 1e-10 ? 0 : M[i][nCols] / M[i][i];
  return out;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * @param {Array} lineups leaguedashlineups 的行：{ players:[5个id], poss, off, def }
 * @param {object} [opts]
 * @param {number} [opts.minPoss] 低于这个回合数的组合直接丢掉，默认 1（权重已按回合数，小样本自然被压低）
 * @param {number} [opts.lambda] 正则强度，默认 2000
 * @returns {Map<number,{o:number,d:number,apm:number,poss:number}>}
 */
export function computeApm(lineups, {
  minPoss = 1, lambda = 3000, priorO = null, priorD = null,
} = {}) {
  const used = lineups.filter((l) => (l.poss ?? 0) >= minPoss
    && Number.isFinite(l.off) && Number.isFinite(l.def));
  if (!used.length) return new Map();

  // 球员编号
  const ids = [...new Set(used.flatMap((l) => l.players))];
  const col = new Map(ids.map((id, i) => [id, i]));

  // 回合加权的联盟平均效率，作为基准
  const totPoss = used.reduce((s, l) => s + l.poss, 0);
  const avgOff = used.reduce((s, l) => s + l.off * l.poss, 0) / totPoss;
  const avgDef = used.reduce((s, l) => s + l.def * l.poss, 0) / totPoss;

  /**
   * 带先验的岭回归。
   *
   * 普通岭回归把系数往 0 收缩，等于默认"没有证据就当他是联盟平均"。
   * EPM 的做法是往 **SPM 先验**收缩——没有证据就当他值 box score 说的那么多。
   * 这对总在一起打的球员尤其重要：雷霆全队阵容都好，回归分不开谁的功劳，
   * 往 0 收缩会让所有人平分好处（角色球员被抬高），
   * 往先验收缩则各回各位。
   *
   * 实现上只需换个变量：解 δ = β − prior，目标相应减去先验的贡献。
   */
  const solveWithPrior = (yOf, prior) => {
    const pv = prior
      ? ids.map((id) => prior.get(id) ?? 0)
      : null;
    const rows = used.map((l) => {
      const idx = l.players.map((p) => col.get(p));
      let y = yOf(l);
      if (pv) for (const i of idx) y -= pv[i];
      return { idx, y, w: l.poss };
    });
    const delta = ridgeSolve(rows, ids.length, lambda);
    return pv ? delta.map((d, i) => d + pv[i]) : delta;
  };

  // 进攻：高于联盟平均为正。防守：低于联盟平均（失分少）为正，所以取负号。
  const bo = solveWithPrior((l) => l.off - avgOff, priorO);
  const bd = solveWithPrior((l) => -(l.def - avgDef), priorD);

  // 每名球员出现过的回合数，用来判断估计可信度
  const poss = new Map();
  for (const l of used) for (const p of l.players) poss.set(p, (poss.get(p) ?? 0) + l.poss);

  const out = new Map();
  for (const [id, i] of col) {
    // 系数本身就是个人贡献：模型是 组合净效率 ≈ Σ(在场五人的系数)，
    // 全员联盟平均时系数为 0。曾经在这里乘过 5，结果 CJ McCollum 拿到 +31.77——
    // 那是把"五人合计"又按人头放大了一遍。
    const o = bo[i];
    const d = bd[i];
    out.set(id, {
      o: Math.round(o * 100) / 100,
      d: Math.round(d * 100) / 100,
      apm: Math.round((o + d) * 100) / 100,
      poss: poss.get(id) ?? 0,
    });
  }
  return out;
}

/**
 * 多赛季衰减 APM：把最近若干季的组合并在一起，越久远权重越低。
 *
 * 单季 APM 噪声大（每个组合平均只有 14 个回合）。合并多季后年度稳定性
 * 从 0.398 提到 0.421，作为混合项的输入也更好。
 * EPM 用的是 2002 年至今全部回合的指数衰减，思路一样，我们只有 5 季。
 *
 * @param {Array<{season:string, rows:Array}>} bySeason 按时间**升序**排列
 * @param {object} [opts] span=取最近几季，halfLife=半衰期（赛季数）
 */
export function decayedApm(bySeason, {
  span = 3, halfLife = 1, lambda = 6000, priorO = null, priorD = null,
} = {}) {
  const recent = bySeason.slice(-span);
  const newest = recent.length - 1;
  const rows = [];
  for (const [i, s] of recent.entries()) {
    const w = 0.5 ** ((newest - i) / halfLife);
    for (const l of s.rows) rows.push({ ...l, poss: (l.poss ?? 0) * w });
  }
  return computeApm(rows, { lambda, priorO, priorD });
}

/** 诊断用：报告这批组合的覆盖情况 */
export function coverage(lineups, minPoss = 1) {
  const used = lineups.filter((l) => (l.poss ?? 0) >= minPoss);
  const all = lineups.reduce((s, l) => s + (l.poss ?? 0), 0);
  const kept = used.reduce((s, l) => s + l.poss, 0);
  return {
    lineups: lineups.length,
    used: used.length,
    possAll: all,
    possUsed: kept,
    possShare: all ? Math.round((kept / all) * 1000) / 1000 : 0,
    players: new Set(used.flatMap((l) => l.players)).size,
    possPerLineup: used.length ? Math.round(mean(used.map((l) => l.poss))) : 0,
  };
}
