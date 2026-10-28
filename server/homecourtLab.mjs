/**
 * 主场 × 疲劳实验：在生产模型（滚动 Elo + 主场 1.6 + 休息表 ×1.8）之上逐项检验
 *   H1 Elo 更新里的主场优势与实测一致（固定 1.6/2.0/2.4 分，或用上季实测值）
 *   H2 球队专属主场优势：只用此前比赛的残差，按经验贝叶斯向联盟均值收缩
 *   H3 客队旅行距离、时差、高原
 *   F1 赛程密度（四天三赛、六天四赛）
 *   F2 背靠背情境（第二场在客场、背靠背之间的旅行、背靠背进高原）
 *   F3 上一场打了加时
 *   F4 核心三人（按近 10 场分钟）最近两场的超额负荷
 *   F5 客场之旅长度与累计里程
 * 所有特征只用开赛前已知的信息（赛程本身提前公布；分钟、加时来自更早的比赛）。
 * 选择标准只有比赛结果：系数用训练季的净胜分残差最小二乘，H1/H2 的离散超参按训练季 log loss 选。
 * 盘口只作事后诊断。本模块只做实验，不改动线上 DEFAULT_PARAMS。
 */
import { computeElo, carryOver, ELO_HOME_ADV, ELO_PER_POINT } from './ratings.mjs';
import { normalCdf, restAdjust, marketProb } from './lab.mjs';
import { solve, logLoss } from './fusionLab.mjs';
import { ARENAS, ALTITUDE, milesBetween, utcOffsetHours } from './arenas.mjs';

export const SD = 12;
const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

/** 开赛日 Elo：上季从 1500 跑起再回归均值（与 lab.replay 同口径）；没有上季则全员 1500 */
export function eloStartFor(priorGames, { k, carryKeep, eloHomeAdv = ELO_HOME_ADV }) {
  return priorGames ? carryOver(computeElo(priorGames, { k, homeAdv: eloHomeAdv }).final, { keep: carryKeep }) : {};
}

/** 一季逐场的赛前 Elo 净胜分差与结果（Elo 更新用 eloHomeAdv） */
export function eloBase(games, eloStart, { k, eloHomeAdv = ELO_HOME_ADV }) {
  const { history } = computeElo(games, { k, initial: eloStart, homeAdv: eloHomeAdv });
  const played = new Map();
  return games.map((g, i) => {
    const h = g.home.teamId; const a = g.away.teamId;
    const row = {
      gameId: g.gameId, date: g.date, homeId: h, awayId: a, neutral: g.neutral,
      eloPts: (history[i].homeEloPre - history[i].awayEloPre) / ELO_PER_POINT,
      actual: g.home.pts - g.away.pts, homeWin: g.home.win,
      teamGp: Math.min(played.get(h) ?? 0, played.get(a) ?? 0),
      mktProb: g.odds ? marketProb(g.odds, SD) : null,
      ml: g.odds ? [g.odds.homeMl, g.odds.awayMl] : null,
    };
    played.set(h, (played.get(h) ?? 0) + 1);
    played.set(a, (played.get(a) ?? 0) + 1);
    return row;
  });
}

/** 生产口径的预测分差：Elo 差 + 主场 + 休息表 */
export function buildRows(base, ctx, { hca, restWeight }) {
  return base.map((b, i) => {
    const restPts = (restAdjust(ctx[i].home.rest) - restAdjust(ctx[i].away.rest)) * restWeight;
    return { ...b, pred: b.eloPts + (b.neutral ? 0 : hca) + restPts };
  });
}

/**
 * stints 文件 → gameId → { ot: 加时节数, byTeam: teamId → (playerId → 分钟) }。
 * 段格式：[主5, 客5, 主回合, 客回合, 主分, 客分, 秒]。
 */
export function gameMinutes(file) {
  const out = new Map();
  for (const [gameId, [homeId, awayId, stints]] of Object.entries(file.games)) {
    const byTeam = new Map([[homeId, new Map()], [awayId, new Map()]]);
    let secs = 0;
    for (const s of stints) {
      secs += s[14];
      for (let j = 0; j < 10; j += 1) {
        const m = byTeam.get(j < 5 ? homeId : awayId);
        m.set(s[j], (m.get(s[j]) ?? 0) + s[14] / 60);
      }
    }
    out.set(gameId, { ot: Math.max(0, Math.round((secs - 2880) / 300)), byTeam });
  }
  return out;
}

const WINDOW = 10; const MIN_WINDOW = 4; const TOP = 3;

/** 核心三人最近两场的分钟 − 他们在窗口内的场均 ×2（分钟，正 = 比平时多打） */
function starLoad(hist, teamId) {
  const last2 = hist.slice(-2);
  const win = hist.slice(-WINDOW).filter((e) => e.min);
  if (last2.length < 2 || last2.some((e) => !e.min) || win.length < MIN_WINDOW) return 0;
  const tot = new Map();
  for (const e of win) for (const [p, m] of e.min.get(teamId) ?? []) tot.set(p, (tot.get(p) ?? 0) + m);
  const top = [...tot.entries()].sort((x, y) => (y[1] - x[1]) || (x[0] - y[0])).slice(0, TOP);
  let load = 0;
  for (const [p, total] of top) {
    for (const e of last2) load += e.min.get(teamId)?.get(p) ?? 0;
    load -= (2 * total) / win.length;
  }
  return load;
}

/**
 * 逐场赛程上下文（与 games 对齐）。每边：
 *   rest 休息天数 · miles/tz 从上一场地点到本场的里程与时区差（小时，绝对值）
 *   in4/in6 含本场在内近 4/6 天的场数 · b2b · road（不在自己主场）
 *   b2bAlt 背靠背且来到别人的高原主场 · otPrev 上一场加时节数
 *   starLoad 核心三人超额负荷 · tripLen/tripMiles 本次客场之旅已打场数（含本场）与累计里程
 * 中立场地点未知：不计里程/时差/高原，双方都算客场。
 */
export function scheduleContext(games, { abbrOf, minutes = new Map() }) {
  const hist = new Map();
  return games.map((g) => {
    const today = dayNum(g.date);
    const venue = g.neutral ? null : abbrOf(g.home.teamId);
    const altitude = venue && ALTITUDE.has(venue) && !ALTITUDE.has(abbrOf(g.away.teamId)) ? 1 : 0;
    const side = (teamId, isHome) => {
      const h = hist.get(teamId) ?? [];
      const prev = h.at(-1);
      const from = prev ? prev.venue : abbrOf(teamId);
      const known = from && venue && ARENAS[from] && ARENAS[venue];
      const miles = known ? milesBetween(ARENAS[from], ARENAS[venue]) : 0;
      const tz = known ? Math.abs(utcOffsetHours(ARENAS[venue].tz, g.date) - utcOffsetHours(ARENAS[from].tz, g.date)) : 0;
      const rest = prev ? today - prev.day - 1 : null;
      const road = isHome && !g.neutral ? 0 : 1;
      const b2b = rest === 0 ? 1 : 0;
      return {
        rest, miles, tz, road, b2b,
        in4: 1 + h.filter((e) => e.day >= today - 3).length,
        in6: 1 + h.filter((e) => e.day >= today - 5).length,
        b2bAlt: b2b && venue && ALTITUDE.has(venue) && !ALTITUDE.has(abbrOf(teamId)) ? 1 : 0,
        otPrev: prev?.ot ?? 0,
        starLoad: starLoad(h, teamId),
        tripLen: road ? (prev?.road ? prev.tripLen : 0) + 1 : 0,
        tripMiles: road ? (prev?.road ? prev.tripMiles : 0) + miles : 0,
      };
    };
    const out = { home: side(g.home.teamId, true), away: side(g.away.teamId, false), altitude };
    const m = minutes.get(g.gameId);
    for (const [id, s] of [[g.home.teamId, out.home], [g.away.teamId, out.away]]) {
      if (!hist.has(id)) hist.set(id, []);
      hist.get(id).push({ day: today, venue, road: s.road, tripLen: s.tripLen, tripMiles: s.tripMiles, ot: m?.ot ?? 0, min: m?.byTeam.has(id) ? m.byTeam : null });
    }
    return out;
  });
}

const diff = (c, f) => f(c.home) - f(c.away);
/** 各因子的特征（主队视角 = 主 − 客；系数即「对该队每单位的分数影响」） */
export const FACTORS = {
  H3: (c) => [diff(c, (s) => s.miles) / 1000, diff(c, (s) => s.tz), c.altitude],
  F1: (c) => [diff(c, (s) => (s.in4 >= 3 ? 1 : 0)), diff(c, (s) => (s.in6 >= 4 ? 1 : 0))],
  F2: (c) => [diff(c, (s) => s.b2b * s.road), diff(c, (s) => s.b2b * s.miles) / 1000, diff(c, (s) => s.b2bAlt)],
  F3: (c) => [diff(c, (s) => s.otPrev), diff(c, (s) => s.otPrev * s.b2b)],
  F4: (c) => [diff(c, (s) => s.starLoad) / 10],
  F5: (c) => [diff(c, (s) => s.tripLen), diff(c, (s) => s.tripMiles) / 1000],
};
export const FEATURE_NAMES = {
  H3: ['旅行（每千英里）', '时差（每小时）', '客队进高原'],
  F1: ['四天三赛', '六天四赛'],
  F2: ['背靠背且在客场', '背靠背间旅行（每千英里）', '背靠背进高原'],
  F3: ['上一场加时（每节）', '加时后背靠背（每节）'],
  F4: ['核心三人超额负荷（每 10 分钟）'],
  F5: ['客场之旅第几场', '客场之旅累计里程（每千英里）'],
};

/**
 * 球队专属主场优势（滚动、经验贝叶斯）。rows 按日期升序，resid = 实际 − 基础预测（主队视角）。
 * 每队 a = (主场平均残差 − 客场平均残差[本队视角])/2 − 联盟均值（= 全部残差均值），
 * 收缩权重 n/(n+K)，n = 1/(1/n主 + 1/n客)，K 即「联盟均值相当于几场」。
 * 本场调整 = a_主 + a_客（客队在客场更弱 → 主队得利）。只用当天之前的比赛，中立场不计也不调。
 * 返回与 rows 对齐的 { [K]: 调整分 }；附带 .dev(teamId, K)：全部 rows 之后该队的（收缩后）单边偏离。
 */
export function teamHomeAdj(rows, Ks) {
  const acc = new Map();
  const get = (id) => acc.get(id) ?? { sh: 0, nh: 0, sr: 0, nr: 0 };
  let sum = 0; let n = 0;
  const out = new Array(rows.length);
  const dev = (id, K) => {
    const t = get(id);
    if (!t.nh || !t.nr) return 0;
    const nEff = 1 / (1 / t.nh + 1 / t.nr);
    return ((t.sh / t.nh - t.sr / t.nr) / 2 - sum / n) * (nEff / (nEff + K));
  };
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].date === rows[i].date) j += 1;
    for (let q = i; q < j; q += 1) {
      const r = rows[q];
      out[q] = Object.fromEntries(Ks.map((K) => [K, r.neutral ? 0 : dev(r.homeId, K) + dev(r.awayId, K)]));
    }
    for (let q = i; q < j; q += 1) {
      const r = rows[q];
      if (r.neutral) continue;
      const h = get(r.homeId); const a = get(r.awayId);
      acc.set(r.homeId, { ...h, sh: h.sh + r.resid, nh: h.nh + 1 });
      acc.set(r.awayId, { ...a, sr: a.sr - r.resid, nr: a.nr + 1 });
      sum += r.resid; n += 1;
    }
    i = j;
  }
  out.dev = dev;
  return out;
}

/** 最小二乘（无截距）：法方程 + fusionLab.solve */
export function ols(X, y) {
  const k = X[0].length;
  const M = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  X.forEach((x, i) => {
    for (let p = 0; p < k; p += 1) {
      b[p] += x[p] * y[i];
      for (let q = 0; q < k; q += 1) M[p][q] += x[p] * x[q];
    }
  });
  for (let p = 0; p < k; p += 1) M[p][p] += 1e-9;
  return solve(M, b);
}

const design = (r, factors) => factors.flatMap((f) => r.x[f]);
const offset = (r, eha, K) => r.base[eha] + (K == null ? 0 : r.adj[eha][K]);

/** 模型 + 行 → lab.score 能吃的记录 */
export function apply(m, r) {
  const x = design(r, m.factors);
  const pred = offset(r, m.eha, m.K) + x.reduce((s, v, i) => s + (v - m.mu[i]) * m.beta[i], 0);
  return { p: normalCdf(pred, SD), pred, actual: r.actual, homeWin: r.homeWin };
}

/**
 * 训练：对每个 (eha, K) 组合，因子系数用净胜分残差最小二乘；再按训练 log loss 挑组合。
 * rows[i].base[eha] 基础预测分差，rows[i].adj[eha][K] 球队主场调整，rows[i].x[因子] 特征。
 * 特征按训练集均值中心化（斜率与带截距的回归相同）：因子只在比赛之间重新分配分差，
 * 不能借「客队总在旅行」之类恒正的特征偷偷把主场优势整体调高——那是 H1 的问题。
 */
export function fit(rows, { ehas = ['prod'], Ks = [null], factors = [] }) {
  const X = rows.map((r) => design(r, factors));
  const mu = factors.length ? X[0].map((_, j) => X.reduce((s, x) => s + x[j], 0) / X.length) : [];
  const Xc = X.map((x) => x.map((v, j) => v - mu[j]));
  let best = null;
  for (const eha of ehas) {
    for (const K of Ks) {
      const beta = factors.length ? ols(Xc, rows.map((r) => r.actual - offset(r, eha, K))) : [];
      const m = { eha, K, factors, beta, mu };
      const loss = rows.reduce((s, r) => s + logLoss(apply(m, r)), 0) / rows.length;
      if (!best || loss < best.loss) best = { ...m, loss };
    }
  }
  return best;
}
