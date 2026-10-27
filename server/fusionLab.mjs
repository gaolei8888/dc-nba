/**
 * 融合实验：滚动 Elo × 本季对手调整净胜分。
 *
 * 问题：把「本季至今、按对手强弱调整过的净胜分」按已赛场次逐步混进 Elo，
 * 能不能比纯滚动 Elo 预测得更好，尤其是开季？
 *
 * 本季对手调整净胜分 = 岭回归  margin − 主场 − 休息 = r_主 − r_客，
 * 只用**比赛日期严格早于**当场的本季比赛；岭惩罚把 r 拉向 0（或拉向季前先验）。
 *
 * 四种强度口径（单位：每场净胜分）：
 *   elo        纯滚动 Elo（与 lab.replay 逐场一致，作基线）
 *   blendElo   (1−w)·Elo + w·岭回归，w = n/(n+n0)，n = 该队本季已赛场次
 *   blendPrior (1−w)·季前先验 + w·岭回归——先验不含本季结果，避免与 Elo 重复计数
 *   bayes      岭回归直接向季前先验收缩（λ 即「先验值几场比赛」），不另设 w
 *
 * 本模块只做实验，不改动线上 DEFAULT_PARAMS / ratings。
 */
import { computeElo, carryOver, ELO_BASE, ELO_PER_POINT } from './ratings.mjs';
import { expand, normalCdf, restAdjust, marketProb, priorOf, score } from './lab.mjs';

const toPts = (elo) => (elo - ELO_BASE) / ELO_PER_POINT;
const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

/** 高斯消元解 M x = b（M 对称正定，30×30） */
export function solve(M, b) {
  const n = b.length;
  const A = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = c + 1; r < n; r += 1) {
      const f = A[r][c] / A[c][c];
      if (f) for (let k = c; k <= n; k += 1) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k += 1) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * 岭回归对手调整净胜分。
 * games: [{ h, a, y }]（y = 已扣主场/休息的主队净胜分），ids: 球队 id 列表，
 * prior: id → 先验（缺省 0），lambda: 惩罚强度（单位：场）。
 */
export function ridgeRatings(games, ids, { lambda, prior = null }) {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const M = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? lambda : 0)));
  const b = ids.map((id) => lambda * (prior?.get(id) ?? 0));
  for (const g of games) {
    const i = idx.get(g.h); const j = idx.get(g.a);
    M[i][i] += 1; M[j][j] += 1; M[i][j] -= 1; M[j][i] -= 1;
    b[i] += g.y; b[j] -= g.y;
  }
  const x = solve(M, b);
  return new Map(ids.map((id, i) => [id, x[i]]));
}

export const ridgeKey = (toPrior, lambda, cap) => `${toPrior ? 'P' : '0'}:${lambda}:${cap}`;

/**
 * 重放一个赛季，产出逐场特征行。全部特征只用当天之前的信息。
 * eloStart: { id: 开赛日 Elo }；specs: [{ toPrior, lambda, cap }] 要算的岭回归版本。
 * 返回 { rows, final }，final 是赛季（或快照）末各队状态，供当前赛季示意用。
 */
export function replaySeason(games, eloStart, p, specs) {
  const prior = new Map(Object.entries(eloStart).map(([id, v]) => [Number(id), toPts(v)]));
  let elo = { ...eloStart };
  const ids = [...new Set([...prior.keys(), ...games.flatMap((g) => [g.home.teamId, g.away.teamId])])];
  const eloPts = (id) => toPts(elo[id] ?? ELO_BASE);
  const played = new Map();
  const lastPlayed = new Map();
  const past = [];
  const rows = [];

  const ridgeAll = () => Object.fromEntries(specs.map((s) => [ridgeKey(s.toPrior, s.lambda, s.cap),
    ridgeRatings(past.map((g) => ({ h: g.h, a: g.a, y: Math.max(-s.cap, Math.min(s.cap, g.margin)) - g.adj })),
      ids, { lambda: s.lambda, prior: s.toPrior ? prior : null })]));
  const team = (id, ridge) => ({
    elo: eloPts(id),
    prior: prior.get(id) ?? 0,
    n: played.get(id) ?? 0,
    ridge: Object.fromEntries(Object.entries(ridge).map(([k, m]) => [k, m.get(id) ?? 0])),
  });

  const byDate = new Map();
  for (const g of games) byDate.set(g.date, [...(byDate.get(g.date) ?? []), g]);
  for (const [date, dayGames] of byDate) {
    const ridge = ridgeAll();
    const today = dayNum(date);
    const restOf = (id) => (lastPlayed.has(id) ? today - lastPlayed.get(id) - 1 : null);
    for (const g of dayGames) {
      const h = g.home.teamId; const a = g.away.teamId;
      const hca = g.neutral ? 0 : p.homeAdv;
      const restPts = (restAdjust(restOf(h)) - restAdjust(restOf(a))) * p.restWeight;
      const actual = g.home.pts - g.away.pts;
      rows.push({
        date, homeId: h, awayId: a, home: team(h, ridge), away: team(a, ridge),
        hca, restPts, actual, homeWin: g.home.win,
        teamGp: Math.min(played.get(h) ?? 0, played.get(a) ?? 0),
        mktProb: g.odds ? marketProb(g.odds, 12) : null,
      });
      past.push({ h, a, margin: actual, adj: hca + restPts });
    }
    for (const g of dayGames) {
      for (const id of [g.home.teamId, g.away.teamId]) {
        played.set(id, (played.get(id) ?? 0) + 1);
        lastPlayed.set(id, today);
      }
    }
    if (p.inSeasonElo !== 0) elo = computeElo(dayGames, { k: p.k, initial: elo }).final;
  }
  const ridge = ridgeAll();
  return { rows, final: new Map(ids.map((id) => [id, team(id, ridge)])) };
}

/** 回测数据集的一个赛季：开赛日 Elo 与 lab.replay 同口径（上季从零跑 Elo，再回归均值） */
export function seasonRows(dataset, season, p, specs) {
  const prev = dataset.seasons[priorOf(season)];
  if (!prev || !dataset.seasons[season]) return [];
  const eloStart = carryOver(computeElo(expand(prev), { k: p.k }).final, { keep: p.carryKeep });
  return replaySeason(expand(dataset.seasons[season]), eloStart, p, specs).rows.map((r) => ({ ...r, season }));
}

/** 一支球队的强度（每场净胜分，相对联盟平均） */
export function strength(t, cfg) {
  if (cfg.mode === 'elo') return t.elo;
  const r = t.ridge[ridgeKey(cfg.mode === 'bayes', cfg.lambda, cfg.cap)];
  if (cfg.mode === 'bayes') return r;
  const w = t.n / (t.n + cfg.n0);
  return (1 - w) * (cfg.mode === 'blendPrior' ? t.prior : t.elo) + w * r;
}

/** 特征行 + 配置 → lab.score 能吃的记录 */
export function predict(row, cfg) {
  const pred = strength(row.home, cfg) - strength(row.away, cfg) + row.hca + row.restPts;
  return { p: normalCdf(pred, cfg.sd), pred, actual: row.actual, homeWin: row.homeWin };
}

export const logLoss = (r) => -Math.log(Math.max(r.homeWin ? r.p : 1 - r.p, 1e-9));
export const phaseOf = (gp) => (gp < 10 ? '<10' : gp < 20 ? '10-19' : '>=20');

/** 训练集上按平均 log loss 挑配置 */
export function tune(rows, grid) {
  let best = null;
  for (const cfg of grid) {
    let s = 0;
    for (const r of rows) s += logLoss(predict(r, cfg));
    if (!best || s < best.loss) best = { cfg, loss: s };
  }
  return { cfg: best.cfg, logloss: best.loss / rows.length };
}

/** 可复现随机数（mulberry32） */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按场配对 bootstrap：diffs[i] = 候选 − 基线 的单场损失差，返回均值与 95% 区间 */
export function bootstrapCI(diffs, { B = 2000, seed = 7 } = {}) {
  const n = diffs.length;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const rand = rng(seed);
  const means = [];
  for (let b = 0; b < B; b += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += diffs[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return { mean, lo: means[Math.floor(0.025 * B)], hi: means[Math.ceil(0.975 * B) - 1] };
}

export { score };
