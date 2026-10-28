/**
 * 校准实验：模型是不是「不够自信」（大比分差距的比赛胜率被压向 50%）？
 *
 * 只调控制「自信程度 / 结构」的少数几个量，选择标准**只有比赛结果**（log loss）：
 *   sd           胜率换算的单场分差标准差（等价于概率温度）
 *   eloPerPoint  Elo → 每场净胜分的换算（只缩放 Elo 部分，主场/休息不变）
 *   carryKeep    赛季间保留比例
 *   k            赛季中 Elo 更新步长
 *   homeAdv      主场优势（分）
 * 备选：在生产预测分差上做 Platt（logistic）后校准，不动任何参数。
 *
 * 盘口只作事后诊断（偏差、分歧率、与市场 log loss 的差距），**从不**作为训练目标、
 * 特征、先验或混合项；也不按「与市场的分歧」或模拟投注 ROI 挑参数。
 * 本模块只做实验，不改动线上 DEFAULT_PARAMS / ratings 常数。
 */
import { ELO_PER_POINT } from './ratings.mjs';
import { replay, normalCdf, restAdjust } from './lab.mjs';
import { logLoss } from './fusionLab.mjs';

/** 生产参数（server/predict.mjs DEFAULT_PARAMS + ratings 常数） */
export const PROD = {
  k: 20, carryKeep: 0.75, eloPerPoint: ELO_PER_POINT, sd: 12, homeAdv: 1.6, restWeight: 1.8,
};

export const eloKey = (k, carryKeep) => `${k}:${carryKeep}`;

/**
 * 逐场特征：Elo 部分只取决于 (k, carryKeep)，其余参数在 predictRow 里套。
 * 直接复用 lab.replay（主场、休息权重置 0，pred 即 Elo 净胜分差），保证与生产重放逐场一致。
 */
export function features(dataset, seasons, { k, carryKeep }) {
  return replay(dataset, seasons, { k, carryKeep, homeAdv: 0, restWeight: 0 }).map((r) => ({
    season: r.season,
    gameId: r.gameId,
    date: r.date,
    homeId: r.homeId,
    awayId: r.awayId,
    eloPts: r.pred,
    neutral: r.neutral,
    restRaw: restAdjust(r.restHome) - restAdjust(r.restAway),
    actual: r.actual,
    homeWin: r.homeWin,
    teamGp: r.teamGp,
    // 以下仅供诊断 / 模拟投注结算，不参与预测与选参
    mktProb: r.mktProb,
    ml: r.ml,
  }));
}

/** 特征行 + 参数 → { p, pred }（与 lab.replay 同式） */
export function predictRow(r, cfg) {
  const scale = cfg.eloPerPoint === ELO_PER_POINT ? 1 : ELO_PER_POINT / cfg.eloPerPoint;
  const pred = r.eloPts * scale + (r.neutral ? 0 : cfg.homeAdv) + r.restRaw * cfg.restWeight;
  return { p: normalCdf(pred, cfg.sd), pred };
}

/** 训练集上按平均 log loss（只看胜负结果）挑配置。sets: eloKey → 特征行 */
export function tune(sets, grid) {
  let best = null;
  for (const cfg of grid) {
    const rows = sets[eloKey(cfg.k, cfg.carryKeep)];
    let s = 0;
    for (const r of rows) s += logLoss({ p: predictRow(r, cfg).p, homeWin: r.homeWin });
    const loss = s / rows.length;
    if (!best || loss < best.logloss) best = { cfg, logloss: loss };
  }
  return best;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Platt 后校准：homeWin ~ σ(a + b·pred)，牛顿法极大似然 */
export function plattFit(rows, { iters = 50 } = {}) {
  let a = 0; let b = 0.1;
  for (let it = 0; it < iters; it += 1) {
    let ga = 0; let gb = 0; let haa = 0; let hab = 0; let hbb = 0;
    for (const r of rows) {
      const p = sigmoid(a + b * r.pred);
      const e = (r.homeWin ? 1 : 0) - p;
      const w = p * (1 - p);
      ga += e; gb += e * r.pred;
      haa += w; hab += w * r.pred; hbb += w * r.pred * r.pred;
    }
    const det = haa * hbb - hab * hab;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-12) break;
  }
  return { a, b };
}

export const plattApply = ({ a, b }, pred) => sigmoid(a + b * pred);

/**
 * 热门偏差：按 favOf(r)（主队胜率）定谁是热门，模型给热门的平均胜率 − 热门实际胜率。
 * 正数 = 高估热门（过度自信），负数 = 低估热门（不够自信）。favOf 返回 null 的比赛不计。
 */
export function favoriteBias(rows, favOf) {
  let n = 0; let pred = 0; let won = 0;
  for (const r of rows) {
    const f = favOf(r);
    if (f == null) continue;
    const home = f >= 0.5;
    n += 1;
    pred += home ? r.p : 1 - r.p;
    won += home === r.homeWin ? 1 : 0;
  }
  return n ? { n, predicted: pred / n, actual: won / n, bias: (pred - won) / n } : { n: 0 };
}

/** 诊断：有盘口的比赛里 |模型 − 市场去水概率| ≥ threshold 的占比 */
export function disagreement(rows, threshold = 0.03) {
  const priced = rows.filter((r) => r.mktProb != null);
  const count = priced.filter((r) => Math.abs(r.p - r.mktProb) >= threshold - 1e-12).length;
  return { n: priced.length, count, rate: priced.length ? count / priced.length : null };
}

/** 训练/打分切分：loso = 留一赛季；forward = 只用更早的赛季训练（扩张窗口） */
export function splits(seasons, mode) {
  if (mode === 'loso') return seasons.map((s) => ({ test: s, train: seasons.filter((x) => x !== s) }));
  return seasons.slice(1).map((s, i) => ({ test: s, train: seasons.slice(0, i + 1) }));
}
