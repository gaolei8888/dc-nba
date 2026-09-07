/**
 * 综合影响力指标（IMP）：球员相对联盟平均水平，每百回合给球队带来多少分。
 *
 * 这是 EPM / LEBRON / DARKO 那一类"all-in-one"指标的自制版本。
 * 那三个都拿不到——EPM 的站点这台机器连不上、LEBRON 与 DARKO 的公开表格在
 * docs.google.com 上同样连不上，而且 EPM 与 LEBRON 本身是收费产品。
 * 但它们的**输入**我们全都有：box score、球场追踪、拼抢、防守对位、on/off。
 *
 * 做法与 BPM/EPM 的先验部分一致：
 *   1. 目标取球员的 on/off 净效率差（个人层面，不是球队层面）
 *   2. 特征取每 36 分钟的 box + 追踪速率
 *   3. 加权岭回归，权重为 on/off 两侧回合数的调和均值——任一侧样本小就降权
 *   4. 用**没参与训练的赛季**验证
 *
 * 曾经走错过一次，教训值得留着：第一版在**球队层面**拟合系数再套回个人，
 * 结果 Mitchell Robinson 拿到 +341 分/百回合。原因是球队分钟加权均值的方差
 * 比个人小一个量级，个人偏离除以球队标准差会放大二十倍；而且球队层面
 * 根本分不开个人贡献，模型只学到了"内线多的队净效率高"。
 */

/** 每 36 分钟速率 */
const per36 = (v, min) => (min > 0 ? ((v ?? 0) * 36) / min : 0);

/** 联盟真实命中率基准，用于把效率折成"相对平均多得几分" */
const TS_BASE = 0.565;

export const FEATURES = [
  'pts', 'tsAdd', 'ast', 'potAst', 'tov', 'oreb', 'dreb',
  'stl', 'blk', 'defl', 'contest', 'dSup', 'screen', 'pf', 'usg',
];

/**
 * 从一行球员数据取特征。
 * 同时吃两种形状：ingest 产出的嵌套结构（base/adv/track…）与
 * impact_<赛季>.json 的扁平结构。
 */
export function features(p) {
  const min = p.min ?? 0;
  if (!min) return null;
  const flat = p.base === undefined;
  const g = (nested, key) => (flat ? p[key] : (p[nested] ?? {})[key]);

  const fga = per36(g('base', 'fga'), min);
  const tsPct = g('adv', 'tsPct') ?? TS_BASE;
  const dFga = per36(g('defend', 'dFga'), min);
  const diffPct = g('defend', 'diffPct') ?? 0;

  return {
    pts: per36(g('base', 'pts'), min),
    // 效率 × 出手量：单看命中率会把低出手的角色球员抬得过高
    tsAdd: (tsPct - TS_BASE) * fga,
    ast: per36(g('base', 'ast'), min),
    potAst: per36(g('track', 'potentialAst'), min),
    tov: per36(g('base', 'tov'), min),
    oreb: per36(g('base', 'oreb'), min),
    dreb: per36(g('base', 'dreb'), min),
    stl: per36(g('base', 'stl'), min),
    blk: per36(g('base', 'blk'), min),
    defl: per36(g('hustle', 'deflections'), min),
    contest: per36(g('hustle', 'contested'), min),
    // 对位压制 × 承担的防守量。样本不足时压制值不可信，
    // 乘上出手量天然降权——防得少的人这一项自然接近 0。
    dSup: -diffPct * dFga,
    screen: per36(g('hustle', 'screenAstPts'), min),
    pf: per36(g('base', 'pf'), min),
    usg: (g('adv', 'usgPct') ?? 0.2) * 100,
  };
}

// ---------------------------------------------------------------- 线性代数

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
export const sdOf = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1;
};
export const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  const sa = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0));
  const sb = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0));
  return sa && sb ? cov / (sa * sb) : 0;
};
export { mean };

/** 加权岭回归，返回系数向量 */
export function ridge(X, y, w, lambda) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const bv = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < k; r++) {
      bv[r] += w[i] * X[i][r] * y[i];
      for (let c = 0; c < k; c++) A[r][c] += w[i] * X[i][r] * X[i][c];
    }
  }
  for (let r = 0; r < k; r++) A[r][r] += lambda;
  const M = A.map((row, i) => [...row, bv[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]));
}

// ---------------------------------------------------------------- 训练

/** on/off 两侧回合数的调和均值：任一侧样本小，这个估计就不可信 */
export const onoffWeight = (r) => {
  const on = r.onPoss ?? 0; const off = r.offPoss ?? 0;
  return on > 0 && off > 0 ? (2 * on * off) / (on + off) : 0;
};

export const MIN_GP = 20;
export const MIN_MPG = 10;

/** 把若干赛季的球员行整理成训练样本 */
export function buildSamples(rows) {
  const out = [];
  for (const p of rows) {
    if ((p.gp ?? 0) < MIN_GP || (p.min ?? 0) < MIN_MPG) continue;
    const w = onoffWeight(p);
    if (!w) continue;
    const f = features(p);
    if (!f) continue;
    out.push({
      playerId: p.playerId,
      season: p.season,
      x: FEATURES.map((k) => f[k]),
      y: (p.onNet ?? 0) - (p.offNet ?? 0),
      w,
      pie: p.pie ?? 0,
    });
  }
  return out;
}

/** 训练一个模型：返回可直接用于 apply() 的对象 */
export function fit(samples, lambda) {
  const mu = FEATURES.map((_, j) => mean(samples.map((r) => r.x[j])));
  const sd = FEATURES.map((_, j) => sdOf(samples.map((r) => r.x[j])));
  const Z = samples.map((r) => r.x.map((v, j) => (v - mu[j]) / sd[j]));
  const yMean = mean(samples.map((r) => r.y));
  const beta = ridge(Z, samples.map((r) => r.y - yMean), samples.map((r) => r.w), lambda);
  return { features: FEATURES, mu, sd, beta, intercept: yMean, lambda, n: samples.length };
}

/**
 * 把模型作用到一行球员数据上，返回每百回合影响力分。
 *
 * **不在训练区间内就返回 null，不外推。** 这不是保守，是必须的：
 * 模型只在「出场 ≥20 场、场均 ≥10 分钟」的球员上训练过，
 * 拿去套一个打了 1 场 2.7 分钟的球员会得到 −42.67 分/百回合——
 * 那不是评价，那是线性外推的产物。训练门槛与使用门槛必须是同一个。
 */
export function apply(model, p) {
  if ((p.gp ?? 0) < MIN_GP || (p.min ?? 0) < MIN_MPG) return null;
  const f = features(p);
  if (!f) return null;
  let s = model.intercept;
  model.features.forEach((k, i) => {
    s += model.beta[i] * ((f[k] - model.mu[i]) / model.sd[i]);
  });
  return Math.round(s * 100) / 100;
}
