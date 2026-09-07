/**
 * 真 RAPM：从 play-by-play 还原的逐段攻守双方阵容拟合。
 *
 * 和 `rapm.mjs` 的 APM 差在哪：
 *   APM  一条观测只有进攻方 5 人，对手是谁不知道 → 打谁都一样，没有对手调整
 *   RAPM 一条观测有 10 个人，进攻方 +1、防守方 −1 → 回归能把「对手弱」扣掉
 *
 * 这正是之前那个已知缺陷的解药：总在一起上场的球员分不开，
 * 强队的角色球员被系统性抬高——因为他们不但队友好，碰上的对手也被队友压住了。
 *
 * 设计矩阵：每名球员两列（进攻、防守），外加一列**不受惩罚**的主场项。
 * 主场项必须留，否则主队球员会集体吃掉那 1.6 分的主场优势。
 *
 * 一条观测 = 某一段里某一方的进攻：
 *   进攻效率 = 联盟平均 + Σ(进攻方 5 人的 o) − Σ(防守方 5 人的 d) + 主场项
 * 所以 d 为正表示防守好（少丢分），与 o 同向，可以直接相加。
 */

/**
 * 加权岭回归：法方程 + 高斯消元，支持带符号的稀疏行和不惩罚的列。
 *
 * 规模 ~1100 列（550 名球员 × 2），消元 O(n³) 约 13 亿次浮点运算，
 * 在 Node 里几十秒——比引入线性代数依赖划算。
 *
 * @param {Array<{idx:Int32Array, val:Float64Array, y:number, w:number}>} rows
 * @param {number[]} lambdas 每列的正则强度，0 表示不惩罚
 * @param {Float64Array} [prior] 收缩目标，缺省为 0
 */
function ridgeSolve(rows, nCols, lambdas, prior = null) {
  const A = Array.from({ length: nCols }, () => new Float64Array(nCols));
  const b = new Float64Array(nCols);

  for (const r of rows) {
    const { idx, val, w } = r;
    // 先验不是加在惩罚项上，而是把目标平移：解 δ = β − prior
    let y = r.y;
    if (prior) for (let i = 0; i < idx.length; i++) y -= val[i] * prior[idx[i]];
    for (let i = 0; i < idx.length; i++) {
      const ri = idx[i];
      const wv = w * val[i];
      b[ri] += wv * y;
      const Ari = A[ri];
      for (let j = 0; j < idx.length; j++) Ari[idx[j]] += wv * val[j];
    }
  }
  for (let i = 0; i < nCols; i++) A[i][i] += lambdas[i];

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
  if (prior) for (let i = 0; i < nCols; i++) out[i] += prior[i];
  return out;
}

/** 一段的压扁格式：[主队5人, 客队5人, 主回合, 客回合, 主得分, 客得分, 秒] */
export const HOME = 0;
export const AWAY = 5;
const POSS_H = 10; const POSS_A = 11; const PTS_H = 12; const PTS_A = 13;

/**
 * @param {Array<Array<number>>} stints 压扁格式的段
 * @param {object} [opts]
 * @param {number} [opts.lambda] 正则强度
 * @param {number} [opts.minPoss] 一段少于这么多回合就丢掉（极短的段全是噪声）
 * @param {Map} [opts.priorO] / [opts.priorD] 先验（EPM 的做法：往 SPM 收缩而不是往 0）
 * @param {number} [opts.weightCap] 单条观测的权重上限，防止长段主导
 * @returns {Map<number,{o,d,rapm,poss}>}
 */
export function computeRapm(stints, {
  lambda = 2000, minPoss = 1, priorO = null, priorD = null,
} = {}) {
  // 只留下两边回合数都够的段
  const used = stints.filter((s) => s[POSS_H] >= minPoss && s[POSS_A] >= minPoss);
  if (!used.length) return new Map();

  const ids = [...new Set(used.flatMap((s) => s.slice(0, 10)))].sort((a, b) => a - b);
  const n = ids.length;
  const col = new Map(ids.map((id, i) => [id, i]));
  const OFF = 0;
  const DEF = n;
  const HCA = 2 * n;
  const nCols = 2 * n + 1;

  let sumPts = 0; let sumPoss = 0;
  for (const s of used) {
    sumPts += s[PTS_H] + s[PTS_A];
    sumPoss += s[POSS_H] + s[POSS_A];
  }
  const avgOff = (100 * sumPts) / sumPoss;

  const rows = [];
  const poss = new Map();
  const addRow = (offFive, defFive, pts, p, isHome) => {
    const idx = new Int32Array(11);
    const val = new Float64Array(11);
    for (let i = 0; i < 5; i++) {
      idx[i] = OFF + col.get(offFive[i]);
      val[i] = 1;
      idx[5 + i] = DEF + col.get(defFive[i]);
      val[5 + i] = -1;
    }
    idx[10] = HCA;
    val[10] = isHome ? 0.5 : -0.5; // 主客各半，主场项就是主客效率差
    rows.push({ idx, val, y: (100 * pts) / p - avgOff, w: p });
    for (const id of offFive) poss.set(id, (poss.get(id) ?? 0) + p);
    for (const id of defFive) poss.set(id, (poss.get(id) ?? 0) + p);
  };

  for (const s of used) {
    const h = s.slice(HOME, HOME + 5);
    const a = s.slice(AWAY, AWAY + 5);
    addRow(h, a, s[PTS_H], s[POSS_H], true);
    addRow(a, h, s[PTS_A], s[POSS_A], false);
  }

  const lambdas = new Float64Array(nCols).fill(lambda);
  lambdas[HCA] = 0; // 主场优势不该被收缩到 0

  let prior = null;
  if (priorO || priorD) {
    prior = new Float64Array(nCols);
    for (const [id, i] of col) {
      prior[OFF + i] = priorO?.get(id) ?? 0;
      prior[DEF + i] = priorD?.get(id) ?? 0;
    }
  }

  const beta = ridgeSolve(rows, nCols, lambdas, prior);

  const out = new Map();
  for (const [id, i] of col) {
    const o = beta[OFF + i];
    const d = beta[DEF + i];
    out.set(id, {
      o: Math.round(o * 100) / 100,
      d: Math.round(d * 100) / 100,
      rapm: Math.round((o + d) * 100) / 100,
      poss: Math.round(poss.get(id) ?? 0),
    });
  }
  out.set('__hca', { hca: Math.round(beta[HCA] * 100) / 100, rows: rows.length });
  return out;
}

/**
 * 多赛季衰减合并：越久远权重越低。
 * 单季 RAPM 噪声仍然不小，合并几季能明显提高年度稳定性。
 * @param {Array<{season:string, stints:Array}>} bySeason 按时间**升序**
 */
export function decayedRapm(bySeason, {
  span = 3, halfLife = 1, lambda = 2000, minPoss = 1, priorO = null, priorD = null,
} = {}) {
  const recent = bySeason.slice(-span);
  const merged = [];
  for (const [i, s] of recent.entries()) {
    const age = recent.length - 1 - i;
    const w = 0.5 ** (age / halfLife);
    for (const st of s.stints) {
      // 权重靠回合数体现，直接缩放回合数即可（得分同比例缩放保持效率不变）
      merged.push([...st.slice(0, 10),
        st[POSS_H] * w, st[POSS_A] * w, st[PTS_H] * w, st[PTS_A] * w, st[14]]);
    }
  }
  return computeRapm(merged, { lambda, minPoss: minPoss * 0.25, priorO, priorD });
}

/** 从 stints_<season>.json 取出全部段 */
export function stintsOf(file) {
  return Object.values(file.games).flatMap((g) => g[2]);
}
