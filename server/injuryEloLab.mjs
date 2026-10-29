/**
 * 伤病感知 Elo 实验的纯逻辑（scripts/injury-elo-lab.mjs 用）。预注册：docs/superpowers/specs/2026-10-29-injury-aware-elo-prereg.md。
 *
 * 问题：生产 Elo 的赛后更新用满员评级算期望，可比赛常常缺人。球星缺阵时 Elo 一直滑，赛前再扣伤病就是重复扣；
 * 他回来时 Elo 也不会还回去。伤病感知更新：期望用 (Elo − 28·s·D_post)，D_post 是当场**实际**缺阵的扣分（赛后，合法）。
 *
 * 本模块不改线上任何东西：
 *   - eloShift(…, { dH: 0, dA: 0 }) 与 ratings.computeElo / lab.replay 里的位移逐位相同（单测锁定）；
 *   - replayElo(…) 在 D 全为 0、不缩放时与 lab.replay 的逐场预测逐位相同（单测锁定）。
 */
import { carryOver, ELO_BASE, ELO_HOME_ADV, ELO_PER_POINT } from './ratings.mjs';
import { expand, normalCdf, priorOf, restAdjust } from './lab.mjs';
import { rotValue } from './injuryLab.mjs';
import { toEt } from './injuryReport.mjs';
import { REPLACEMENT_IMP } from './ratings.mjs';

export const VALUE_OPTS = Object.freeze({ unknownV: REPLACEMENT_IMP, repl: REPLACEMENT_IMP });

/**
 * 一场的 Elo 位移（主队 +shift，客队 −shift）。与 computeElo 同一公式；
 * dH / dA 是两队「当场实际缺阵」的扣分（每场净胜分，≥0），s 是缩放，damp ∈ [0,1] 是 E 方案的整场降权。
 * diff = (Elo_主 − 28·s·dH) + 主场 100 − (Elo_客 − 28·s·dA)，期望与 MOV 乘数都用这个 diff。
 */
export function eloShift(eh, ea, g, { k = 20, dH = 0, dA = 0, s = 1, damp = 1 } = {}) {
  const diff = (eh - ELO_PER_POINT * s * dH) + (g.neutral ? 0 : ELO_HOME_ADV) - (ea - ELO_PER_POINT * s * dA);
  const expHome = 1 / (1 + 10 ** (-diff / 400));
  const mov = Math.abs(g.home.pts - g.away.pts);
  const winnerEloDiff = g.home.win ? diff : -diff;
  const movMult = ((mov + 3) ** 0.8) / (7.5 + 0.006 * winnerEloDiff);
  return damp * k * movMult * ((g.home.win ? 1 : 0) - expHome);
}

/** E 方案：两队实际缺阵合计越大，这场的更新权重越小；c = Infinity 即不降权 */
export const dampOf = (dH, dA, c) => (Number.isFinite(c) ? 1 - Math.min(1, (dH + dA) / c) : 1);

/**
 * update(gameId) -> { dH, dA }（赛后实际缺阵扣分），缺省 0。mode: { s, c }：
 *   A：s>0, c=Infinity；E：s=0, c 有限；P0 / P1：s=0, c=Infinity（即生产 Elo）。
 */
function updateArgs(g, update, mode) {
  const d = update?.(g.gameId);
  const dH = d?.dH ?? 0; const dA = d?.dA ?? 0;
  return { dH, dA, s: mode.s ?? 0, damp: dampOf(dH, dA, mode.c ?? Infinity) };
}

/** 上季逐场（不按日分组，与 computeElo 相同）从 1500 跑完 */
export function seasonEloSequential(games, { k = 20, update = null, mode = {} } = {}) {
  const elo = new Map();
  const get = (id) => elo.get(id) ?? ELO_BASE;
  for (const g of games) {
    const eh = get(g.home.teamId); const ea = get(g.away.teamId);
    const shift = eloShift(eh, ea, g, { k, ...updateArgs(g, update, mode) });
    elo.set(g.home.teamId, eh + shift);
    elo.set(g.away.teamId, ea - shift);
  }
  return Object.fromEntries(elo);
}

/**
 * 与 lab.replay（DEFAULTS）同口径的重放，只换 Elo 更新：返回逐场 { season, gameId, date, homeId, awayId, homeWin,
 * pred（不含伤病扣分的净胜分 = Elo 分差 + 主场 + 休息）, eloPts, teamGp, neutral }。
 * update(gameId) 给赛后缺阵扣分；季 S−1 的热身重放用同一 update / mode。
 */
export function replayElo(dataset, seasons, { k = 20, homeAdv = 1.6, restWeight = 1.8, carryKeep = 0.75, update = null, mode = {} } = {}) {
  const out = [];
  const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);
  for (const season of seasons) {
    const rows = dataset.seasons[season]; const priorRows = dataset.seasons[priorOf(season)];
    if (!rows || !priorRows) continue;
    const games = expand(rows);
    const start = carryOver(seasonEloSequential(expand(priorRows), { k, update, mode }), { keep: carryKeep });
    const elo = new Map(Object.entries(start).map(([id, v]) => [Number(id), v]));
    const get = (id) => elo.get(id) ?? ELO_BASE;
    const lastPlayed = new Map(); const played = new Map();
    for (let i = 0; i < games.length;) {
      let j = i;
      while (j < games.length && games[j].date === games[i].date) j += 1;
      const day = games.slice(i, j); i = j;
      const today = dayNum(day[0].date);
      for (const g of day) {
        const restOf = (id) => { const p = lastPlayed.get(id); return p === undefined ? null : today - p - 1; };
        const restPts = (restAdjust(restOf(g.home.teamId)) - restAdjust(restOf(g.away.teamId))) * restWeight;
        const eloPts = (get(g.home.teamId) - ELO_BASE) / ELO_PER_POINT - (get(g.away.teamId) - ELO_BASE) / ELO_PER_POINT;
        out.push({
          season, gameId: g.gameId, date: g.date, homeId: g.home.teamId, awayId: g.away.teamId, homeWin: g.home.win,
          pred: eloPts + (g.neutral ? 0 : homeAdv) + restPts, eloPts, neutral: g.neutral,
          teamGp: Math.min(played.get(g.home.teamId) ?? 0, played.get(g.away.teamId) ?? 0),
        });
      }
      const shifts = new Map();
      for (const g of day) {
        for (const id of [g.home.teamId, g.away.teamId]) { played.set(id, (played.get(id) ?? 0) + 1); lastPlayed.set(id, today); }
        const shift = eloShift(get(g.home.teamId), get(g.away.teamId), g, { k, ...updateArgs(g, update, mode) });
        shifts.set(g.home.teamId, (shifts.get(g.home.teamId) ?? 0) + shift);
        shifts.set(g.away.teamId, (shifts.get(g.away.teamId) ?? 0) - shift);
      }
      for (const [id, d] of shifts) elo.set(id, get(id) + d);
    }
  }
  return out;
}

/** 赛前扣分进预测：Φ((pred − scale·(D_pre主 − D_pre客)) / sd) */
export const predictProb = (pred, preH, preA, scale, sd = 12) => normalCdf(pred - scale * (preH - preA), sd);

// ---------------------------------------------------------------- 报告时间：只用开赛前（且决策时点前）标注的报告

/** 报告名 -> 标注时间（美东 { date, min }）。'hour' 版 2022-01-14_05PM 标 17:30；'minute' 版 2026-01-14_05_00PM 标 17:00 */
export function reportStamp(name) {
  const m = /^(\d{4}-\d\d-\d\d)_(\d\d)(?:_(\d\d))?(AM|PM)$/.exec(name ?? '');
  if (!m) return null;
  const h = (Number(m[2]) % 12) + (m[4] === 'PM' ? 12 : 0);
  return { date: m[1], min: h * 60 + (m[3] === undefined ? 30 : Number(m[3])) };
}

/** 美东本地时间 -> UTC 毫秒（先按 EST 猜，toEt 对不上就是夏令时） */
export function etToMs(date, min) {
  for (const off of [5, 4]) {
    const ms = Date.parse(`${date}T00:00:00Z`) + (min + off * 60) * 60000;
    const back = toEt(ms);
    if (back.date === date && back.min === min) return ms;
  }
  return Date.parse(`${date}T00:00:00Z`) + (min + 5 * 60) * 60000;
}

/** 报告能不能用：标注时间 + lag ≤ 决策时点，且决策时点早于开赛（tipMs 为 null 时只查前一条） */
export function reportUsable(name, decisionMs, tipMs, lagMin = 15) {
  const st = reportStamp(name);
  if (!st) return false;
  const at = etToMs(st.date, st.min) + lagMin * 60000;
  return at <= decisionMs && (tipMs === null || tipMs === undefined || decisionMs < tipMs);
}

// ---------------------------------------------------------------- 健康基线与扣分

/**
 * 健康基线：elig = [{ id, mins: [本季最近若干次为本队出场的分钟] }] -> [{ id, m }]，m = 最近 W 次出场的场均。
 * 资格判断（上场过、没去别队、近 10 场上过或在赛前报告上）由调用方做。
 */
export function healthyRotation(elig, W = 10) {
  return elig.filter((p) => p.mins.length).map((p) => {
    const last = p.mins.slice(-W);
    return { id: p.id, m: last.reduce((a, v) => a + v, 0) / last.length };
  });
}

/** D_pre = max(0, V(H) − V(H，分钟 × P(出场 | 状态)))；statusOf(id) 不在报告上返回 undefined（按 1） */
export function preDeduction(H, statusOf, pPlay, val, opts = VALUE_OPTS) {
  if (!H?.length) return 0;
  const scaled = H.map((p) => { const s = statusOf(p.id); return { id: p.id, m: p.m * (s === undefined ? 1 : pPlay[s] ?? 1) }; });
  return Math.max(0, rotValue(H, val, opts) - rotValue(scaled, val, opts));
}

/** D_post = max(0, V(H) − V(H 中当场实际上场的人)) */
export function postDeduction(H, playedSet, val, opts = VALUE_OPTS) {
  if (!H?.length) return 0;
  return Math.max(0, rotValue(H, val, opts) - rotValue(H.filter((p) => playedSet.has(p.id)), val, opts));
}

/**
 * 预注册分层。teamSeq: Map(teamId -> [{ gameId, absent: Set(轮换球员缺阵), playedSet }])，按本队比赛顺序；
 * 轮换球员缺阵 = 在健康基线、基线分钟 ≥ 20、当场没上。返回 Map(gameId -> 'i' | 'ii')，其余为 'iii'。
 * (i) 这次缺阵所在的连续缺阵段 ≥ minRun 场；(ii) ≥ minRun 场的缺阵段后，复出那场起本队 window 场。(i) 优先。
 */
export function strataOf(teamSeq, { minRun = 5, window = 10 } = {}) {
  const tag = new Map();
  const mark = (gid, t) => { if (t === 'i') tag.set(gid, 'i'); else if (!tag.has(gid)) tag.set(gid, t); };
  for (const seq of teamSeq.values()) {
    const runs = new Map();   // id -> 当前连续缺阵的下标
    const longIdx = new Set(); const returns = [];
    seq.forEach((g, idx) => {
      for (const id of g.absent) { if (!runs.has(id)) runs.set(id, []); runs.get(id).push(idx); }
      for (const [id, list] of [...runs]) {
        if (g.absent.has(id)) continue;
        if (list.length >= minRun) { list.forEach((x) => longIdx.add(x)); if (g.playedSet.has(id)) returns.push(idx); }
        runs.delete(id);
      }
    });
    for (const list of runs.values()) if (list.length >= minRun) list.forEach((x) => longIdx.add(x));
    for (const r of returns) for (let x = r; x < Math.min(seq.length, r + window); x += 1) mark(seq[x].gameId, 'ii');
    for (const x of longIdx) mark(seq[x].gameId, 'i');
  }
  return tag;
}
