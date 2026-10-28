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
 * 年龄项。EPM 明说用了年龄（"each stat is affected differently by player age"）。
 * 用两项：年龄本身与年龄的平方——巅峰期在中间，所以效应不是线性的。
 * 以 27 岁为中心，让系数读起来是"相对巅峰年龄"。
 */
export const AGE_FEATURES = ['age', 'ageSq'];
const ageOf = (p) => (Number.isFinite(p.age) ? p.age - 27 : 0);

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

  // 拼抢表里没有这个人（ingest 里 num(undefined) = null）≠ 拼抢为 0。打分时这三项按人群均值处理（apply），
  // 训练样本照旧记 0——每季只有 1–9 行缺，改训练会牵动已验证的 IMP 系数，不值得
  const missing = ['deflections', 'contested', 'screenAstPts'].every((k) => g('hustle', k) == null)
    ? ['defl', 'contest', 'screen'] : [];
  return {
    missing,
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
    age: ageOf(p),
    ageSq: ageOf(p) ** 2,
  };
}

/**
 * 要不要带年龄项，取决于训练时的选择；模型自己记着用了哪些特征。
 *
 * 实测结论：**年龄项在我们这里没用**，加上后 r 从 0.4571 变成 0.4573，
 * 差异完全在噪声里。EPM 用年龄是因为它有 22 个赛季撑得起年龄曲线，
 * 我们只有 5 季。代码留着，默认不启用——一个测不出收益的特征不值得进模型。
 */
export const featureList = (withAge) => (withAge ? [...FEATURES, ...AGE_FEATURES] : FEATURES);

// ---------------------------------------------------------------- 混合

/**
 * SPM 先验与实测 APM 的混合权重。
 *
 * 这是 EPM 的第二步：SPM 只看统计栏，APM 只看场上结果，两个都不完整。
 * EPM 把 SPM 当贝叶斯先验喂进 RAPM；我们用一个固定权重做线性混合，
 * 效果的方向一致，实现简单得多。
 *
 * w 由实验扫出来（scripts/impact-lab.mjs），而且用了**两把尺子**：
 * 预测次季的真实 APM，以及预测次季的真实 on/off。
 * 后者很重要——IMP 里含 APM，只用前者等于拿目标的一部分去预测目标，
 * 两者共享同一个偏差。两把尺子的联合最优是 0.35：
 *
 *   w      对次季APM   对次季on/off   平均
 *   0.00    0.4010      0.3325       0.3667   ← 纯 SPM（旧版）
 *   0.30    0.4542      0.3559       0.4050
 *   0.35    0.4570      0.3552     **0.4061**
 *   0.40    0.4584      0.3534       0.4059
 *   1.00    0.4210      0.3027       0.3619   ← 纯 APM
 *
 * 0.30~0.40 一片平坦，选点不脆弱。
 *
 * 还试过照 EPM 原样把 SPM 当先验内嵌进 APM 的岭回归（rapm.mjs 支持 priorO/priorD），
 * 结果是 0.3988，**不如简单线性混合**。忠实照搬未必更好——
 * EPM 有 22 季 550 万回合和对手阵容撑着，我们只有 5 季的聚合数据。
 */
export const BLEND_W = 0.35;

/** 多赛季衰减：越久远权重越低。半衰期 1 个赛季，取最近 3 季。 */
export const DECAY_SPAN = 3;
export const DECAY_HALFLIFE = 1;

/**
 * 把 SPM 与 APM 合成最终的 IMP。
 * APM 缺失（新秀、上赛季没打）时退回纯 SPM，而不是当作 0——
 * 当作 0 等于凭空断言"他影响力为零"。
 */
export function blend(spm, apm, w = BLEND_W) {
  if (spm === null || spm === undefined) return null;
  if (apm === null || apm === undefined) return Math.round(spm * 100) / 100;
  return Math.round((w * apm + (1 - w) * spm) * 100) / 100;
}

/**
 * 最终的 IMP：给一名球员和他的原始 APM，返回校准后的混合值。
 *
 * 单独封一个函数是因为量纲校准**必须同时作用在两半上**——
 * `apply()` 出来的 SPM 已经乘过 scale（系数里就带着），
 * 但 APM 是外面算的，得在这里补乘。分开写两处极容易漏掉一处。
 *
 * @param {object} model data/impact-model.json
 * @param {object} p 球员行
 * @param {number|null} rawApm 未校准的 APM，没有就传 null
 */
export function impactOf(model, p, rawApm) {
  const spm = apply(model, p);
  if (spm === null) return null;
  const scale = model.scale ?? 1;
  const apm = rawApm === null || rawApm === undefined ? null : rawApm * scale;
  return blend(spm, apm, model.blendW ?? BLEND_W);
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

/**
 * 把若干赛季的球员行整理成训练样本。
 *
 * 目标默认取 on/off 差；传入 apmBySeason 时改用 APM，后者好得多——
 * 实测年度稳定性 APM 0.398、on/off 0.286，四对赛季全胜。
 * on/off 衡量的是「这个人 vs 其余所有人」，队友一好就跟着好；
 * APM 把每个五人组合当一条观测，让回归自己去分离谁带来的。
 * EPM 拿 RAPM 当回归目标，就是这个道理。
 *
 * @param {Array} rows 球员行
 * @param {object} [opts]
 * @param {Map<string,Map<number,object>>} [opts.apmBySeason] 赛季 -> (球员 id -> {apm, poss})
 * @param {number} [opts.minApmPoss] APM 至少要多少回合才可信，默认 500
 */
export function buildSamples(rows, { apmBySeason = null, minApmPoss = 500, withAge = false } = {}) {
  const keys = featureList(withAge);
  const out = [];
  out.keys = keys;
  for (const p of rows) {
    if ((p.gp ?? 0) < MIN_GP || (p.min ?? 0) < MIN_MPG) continue;
    const f = features(p);
    if (!f) continue;

    let y; let w;
    if (apmBySeason) {
      const a = apmBySeason.get(p.season)?.get(p.playerId);
      if (!a || a.poss < minApmPoss) continue;
      y = a.apm;
      w = a.poss;
    } else {
      w = onoffWeight(p);
      if (!w) continue;
      y = (p.onNet ?? 0) - (p.offNet ?? 0);
    }

    out.push({
      playerId: p.playerId,
      season: p.season,
      x: keys.map((k) => f[k]),
      y,
      w,
      pie: p.pie ?? 0,
    });
  }
  return out;
}

/** 训练一个模型：返回可直接用于 apply() 的对象 */
export function fit(samples, lambda) {
  // 特征清单跟着样本走——带不带年龄项由 buildSamples 决定，模型自己记住
  const keys = samples.keys ?? FEATURES;
  const mu = keys.map((_, j) => mean(samples.map((r) => r.x[j])));
  const sd = keys.map((_, j) => sdOf(samples.map((r) => r.x[j])));
  const Z = samples.map((r) => r.x.map((v, j) => (v - mu[j]) / sd[j]));
  const yMean = mean(samples.map((r) => r.y));
  const beta = ridge(Z, samples.map((r) => r.y - yMean), samples.map((r) => r.w), lambda);
  return { features: keys, mu, sd, beta, intercept: yMean, lambda, n: samples.length };
}

/**
 * 把模型作用到一行球员数据上，返回每百回合影响力分。
 *
 * **不在训练区间内就返回 null，不外推。** 这不是保守，是必须的：
 * 模型只在「出场 ≥20 场、场均 ≥10 分钟」的球员上训练过，
 * 拿去套一个打了 1 场 2.7 分钟的球员会得到 −42.67 分/百回合——
 * 那不是评价，那是线性外推的产物。训练门槛与使用门槛必须是同一个。
 */
/**
 * @param {number} opts.minGp 出场门槛。默认是训练门槛；本赛季的混合 IMP 会放宽它，
 *   因为那时小样本的噪声由上赛季的先验兜底（见 ingest.mjs 的 currentImpact）。
 */
export function apply(model, p, { minGp = MIN_GP } = {}) {
  if ((p.gp ?? 0) < minGp || (p.min ?? 0) < MIN_MPG) return null;
  const f = features(p);
  if (!f) return null;
  let s = model.intercept;
  model.features.forEach((k, i) => {
    if (f.missing.includes(k)) return; // 缺失 = 人群均值，标准化后为 0
    s += model.beta[i] * ((f[k] - model.mu[i]) / model.sd[i]);
  });
  return Math.round(s * 100) / 100;
}
