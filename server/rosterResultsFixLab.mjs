/**
 * 阵容实验榜战绩修正的「按实际阵容算残差」实验（scripts/roster-results-fix-lab.mjs 用）。
 * 预注册：docs/superpowers/specs/2026-10-29-roster-results-fix-prereg.md。本模块不改线上任何东西。
 *
 * 问题：rosterResults.resultsUpdate 的战绩项用原始终场净胜分，而先验 p 已扣掉今天的缺阵：
 * 缺人打的比赛照样拉低评级（重复扣），球星回来后那些比赛也不还分。
 *
 * 修法（R1）：每场残差相对「当场实际上场的人」的期望。记 H = 满员阵容分（只看轮换概率），
 *   D_pre(今) = H − p（赛前报告的缺阵扣分），D_post(g) = H − A(g)（A = 当场实际上场的人的阵容分，赛后、只进以后的更新）。
 * 在「满员当量」空间里解原方程：先验 p + s·D_pre，每场净胜分 m + s·(D_post_主 − D_post_客)，解出后减回 s·D_pre。
 * 所有 D = 0 时与 resultsUpdate 逐位相同（单测锁定）。
 */
import { resultsUpdate } from './rosterResults.mjs';
import { newRows } from './minutesLab.mjs';
import { projectExpectedRotation, rosterRating, healthyRosterRating } from './rosterProjection.mjs';
import { rng } from './fusionLab.mjs';
import { toEt } from './injuryReport.mjs';

/**
 * @param {Map<number, number>} priors teamId → 先验 p（今天的阵容分，已扣赛前缺阵）
 * @param {Map<number, number>} dPre teamId → D_pre（缺省 0）
 * @param {Array<{homeId, awayId, margin, hca, date?, dPostHome?, dPostAway?}>} games 已完赛
 * @param {number} K
 * @param {object} [opts] s（缩放，默认 1）+ resultsUpdate 的其余选项（recency / cap / floor / tol …）
 * @returns 与 resultsUpdate 相同结构；rating = 满员当量后验 − s·D_pre，另附 fullRating、dPre
 */
export function lineupAdjustedUpdate(priors, dPre, games, K, { s = 1, ...opts } = {}) {
  const d = (id) => dPre?.get(id) ?? 0;
  // 不走捷径：D 全为 0（或 s = 0）时 p + 0、m + 0、r − 0 在浮点下都逐位不变，所以与 resultsUpdate 逐位相同（单测锁定）
  const fullPriors = new Map([...priors].map(([id, p]) => [id, p + s * d(id)]));
  const fullGames = games.map((g) => ({ ...g, margin: g.margin + s * ((g.dPostHome ?? 0) - (g.dPostAway ?? 0)) }));
  const post = resultsUpdate(fullPriors, fullGames, K, opts);
  const out = new Map();
  for (const [id, v] of post) {
    out.set(id, { ...v, prior: priors.get(id), fullRating: v.rating, rating: v.rating - s * d(id), dPre: d(id) });
  }
  return out;
}

/**
 * 一个队·场的四个阵容分（都减去同一个联盟均值 center）：
 *   prior   = 线上口径（分钟 × 轮换概率 × P(出场|赛前状态)）—— 先验 p
 *   healthy = 同一 rows、只看轮换概率 —— 满员 H
 *   actual  = 同一 rows、出场概率改为当场是否上场（1/0，赛后）—— A
 * dPre = H − p（赛前），dPost = H − A（赛后）。都带符号。
 * rotationIds = 满员分钟 ≥ rotMin 的候选（分层用的「轮换球员」）。
 */
export function teamGameValues(side, values, center, { rotMin = 20 } = {}) {
  const rows = newRows(side, 'report', values);
  const rot = projectExpectedRotation(rows);
  const prior = rosterRating(rot) - center;
  const healthy = healthyRosterRating(rot) - center;
  const playedOf = new Map(side.rows.map((r) => [r.pid, r.played]));
  const act = projectExpectedRotation(rows.map((r) => ({ ...r, availability: playedOf.get(r.playerId) ? 1 : 0 })));
  const actual = rosterRating(act) - center;
  return {
    prior, healthy, actual, dPre: healthy - prior, dPost: healthy - actual,
    rotationIds: rot.players.filter((p) => p.healthyMinutes >= rotMin).map((p) => p.playerId),
  };
}

/**
 * 按比赛日分块的配对 bootstrap：整日的比赛一起重抽，统计量 = 抽中各场 Δ 之和 / 抽中场数。
 * diffs[i] 与 blocks[i]（比赛日）一一对应。B、seed 与 fusionLab.bootstrapCI 同默认。
 */
export function blockBootstrapCI(diffs, blocks, { B = 2000, seed = 7 } = {}) {
  const n = diffs.length;
  const mean = diffs.reduce((a, v) => a + v, 0) / n;
  const by = new Map();
  diffs.forEach((v, i) => {
    const k = blocks[i];
    if (!by.has(k)) by.set(k, { s: 0, n: 0 });
    const b = by.get(k); b.s += v; b.n += 1;
  });
  const list = [...by.values()];
  const m = list.length;
  const rand = rng(seed);
  const means = [];
  for (let b = 0; b < B; b += 1) {
    let s = 0; let c = 0;
    for (let i = 0; i < m; i += 1) { const x = list[Math.floor(rand() * m)]; s += x.s; c += x.n; }
    means.push(s / c);
  }
  means.sort((x, y) => x - y);
  return { mean, lo: means[Math.floor(0.025 * B)], hi: means[Math.ceil(0.975 * B) - 1], blocks: m };
}

/**
 * 预注册分层（与 injury-elo 分支 server/injuryEloLab.mjs 的 strataOf 同一算法，原样搬来）。
 * teamSeq: Map(key -> [{ gameId, absent: Set(轮换球员缺阵), playedSet }])，按本队比赛顺序。
 * (i) 这次缺阵所在的连续缺阵段 ≥ minRun 场；(ii) ≥ minRun 场的缺阵段后，复出那场起本队 window 场。(i) 优先。
 */
export function strataOf(teamSeq, { minRun = 5, window = 10 } = {}) {
  const tag = new Map();
  const mark = (gid, t) => { if (t === 'i') tag.set(gid, 'i'); else if (!tag.has(gid)) tag.set(gid, t); };
  for (const seq of teamSeq.values()) {
    const runs = new Map();
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

// ---------------------------------------------------------------- 报告时间核对（与 injury-elo 分支 injuryEloLab 同口径）

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
