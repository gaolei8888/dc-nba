import { projectExpectedRotation, rosterRating, healthyRosterRating } from './rosterProjection.mjs';
import { rotationMinutes, playProbability } from './rotationMinutes.mjs';
import { REPLACEMENT_IMP } from './ratings.mjs';
import { apply as spmOf } from './impact.mjs';

const round = (n) => Math.round(n * 100) / 100;

/** 按样本量收缩：(k·target + n·value)/(k + n)。k 是「先验值几场」。 */
export const shrink = (target, k, value, n) => (k * target + n * value) / (k + n);

// 以下常数均由 scripts/roster-shrinkage.mjs 拟合（node scripts/roster-shrinkage.mjs 复现）。
/**
 * 【2026-10-28 起线上阵容榜不再用 projectMinutes】改用 server/rotationMinutes.mjs：出场时分钟 + 轮换概率 + 伤病出场概率
 * （docs/roster-fixes-batch1-verdict.md）。projectMinutes 只留给实验室（continuityLab、roster-shrinkage）与新旧对照回测。
 *
 * 预计分钟 = 每场球队比赛的期望分钟 = 出场时场均（MPG）× 出场率，两部分分别收缩。
 * 拟合（stints 2021-22…2025-26，按球队、本季前 T=1..10 场做检查点，目标是剩余场次）：
 * 训练 = 前 3 组相邻赛季，留出 = 2024-25→2025-26。
 * - priorK：上季 ≥10 场者 MPG 向上季场均收缩，K=2.5 场。
 * - noPrior：其余球员 MPG 向 a + b·本季MPG 收缩（不是单一人群均值），a=7、b=0.7、K=16。
 *   留出集校准（早期 MPG → 剩余实际 / 本模型 / 上一版单一均值 21）：<8 分钟 9.0 / 9.0 / 13.1，
 *   8–15 分钟 14.9 / 14.4 / 15.4，15–25 分钟 20.0 / 20.3 / 19.9，≥25 分钟 27.5 / 28.7 / 27.0。
 * - rate：出场率 n/T 向 R 收缩，K 以球队场数计：有先验 R=0.60、K=10；无先验 R=0.45、K=4。
 *   不用上季出场率——上季伤停会被当成「不上场」，而伤病另由 availability 处理。
 * 留出集 RMSE（每名球员每场球队比赛分钟，DNP 记 0）：上一版不缩放 9.76 / 等比缩放到 240 6.92；
 * 本模型 5.92 / 6.28。模拟「伤病已知」（某场前后 ±3 场出过场即视为可用）逐场分配实际总分钟时：
 * 上一版 10.57（缩放）；本模型 10.01（缩放）/ 10.72（不缩放）——榜单的机制正是先剔除已报缺阵再分 240，
 * 所以保留 rosterProjection 的等比缩放。每队预测总和（缩放前）留出集均值：上一版 315、本模型 203。
 * 局限：比赛按 gameId 排序近似时间；出场率混入了伤停；n=0 的先验外推不在拟合样本内。
 */
export const MINUTES = {
  priorK: 2.5,
  noPrior: { a: 7, b: 0.7, k: 16 },
  rate: { prior: { R: 0.6, k: 10 }, noPrior: { R: 0.45, k: 4 } },
};

/** priorMpg：上季 ≥10 场的场均（否则 null）；curMpg/n：本季出场场均与场数；teamGames：球队本季已赛场数 */
export function projectMinutes(priorMpg, curMpg, n, teamGames) {
  const hasPrior = Number.isFinite(priorMpg);
  if (!(n > 0) && !hasPrior) return 0;
  const T = Math.max(teamGames, n);
  const mpg = !(n > 0) ? priorMpg : hasPrior ? shrink(priorMpg, MINUTES.priorK, curMpg, n)
    : shrink(MINUTES.noPrior.a + MINUTES.noPrior.b * curMpg, MINUTES.noPrior.k, curMpg, n);
  const r = hasPrior ? MINUTES.rate.prior : MINUTES.rate.noPrior;
  return mpg * (T > 0 ? shrink(r.R, r.k, n / T, T) : r.R);
}
/**
 * n 场统计栏 SPM 向人群均值收缩的 K（「人群均值值几场」）。
 * 拟合：2026-10-27 快照中上季有 IMP 且本季已出场的 264 人，用本季 1–4 场 SPM 收缩后预测上季 IMP，
 * K=38，RMSE 1.831（K→∞ 即只用均值 1.861，K=0 即只用 SPM 4.400）。信号弱、曲面在 30–50 很平。
 * 局限：目标跨赛季且含 APM；只用 1–4 场样本；新秀直接沿用同一 K——新秀部分无法从数据验证。
 * 快照更新后应重跑脚本。
 */
export const IMPACT_K = 38;

const MEASURED_IMPACT = new Set(['current-blended', 'prior-season']);
const minuteWeightedMean = (rows) => rows.reduce((s, r) => s + r.v * r.w, 0) / rows.reduce((s, r) => s + r.w, 0);

/**
 * 没有 IMP 的球员（上季 <20 场 / <10 分钟、新秀）的估计，取代替补级 −0.5。
 * 人群均值在运行时从同一份快照算出，保证与数据一致；全部估计都未经回测验证。
 */
function impactPriors(store) {
  const model = store.impactModel;
  if (!model) return null;
  const withImp = store.players.filter((p) => Number.isFinite(p.impact));
  const spm = (p) => spmOf(model, p, { minGp: 1 });
  const lastRookies = store.players.filter((p) => p.exp === '1' && p.gp > 0)
    .map((p) => ({ v: spm(p), w: p.gp * p.min })).filter((r) => r.v !== null);
  const fringe = store.players.filter((p) => p.min < 15)
    .map((p) => ({ v: spm(p), w: p.gp * p.min })).filter((r) => r.v !== null);
  return {
    spm,
    // 上季有 IMP 球员的简单均值：与 IMPACT_K 拟合时用的收缩目标相同
    population: withImp.length ? withImp.reduce((s, p) => s + p.impact, 0) / withImp.length : null,
    // 上季新秀（今年 exp=1）新秀赛季 SPM 的分钟加权均值：拿到上场时间的新秀才计入
    rookie: lastRookies.length ? minuteWeightedMean(lastRookies) : null,
    // 没有任何 SPM 的老将（两季场均都 <10 分钟）：取上季 10–15 分钟段的分钟加权 SPM 均值。
    // 模型不在 <10 分钟上外推，这是最接近的可测人群——外推本身未验证
    fringe: fringe.length ? minuteWeightedMean(fringe) : null,
  };
}

function estimateImpact(p, priors) {
  const fallback = { value: REPLACEMENT_IMP, impactSource: 'replacement-prior', source: '项目既有替补级 IMP 先验；非实测球员评级' };
  if (!priors) return fallback;
  const samples = [[p, p.gp], [p.cur, p.cur?.gp]]
    .map(([row, n]) => ({ v: row ? priors.spm(row) : null, n: n ?? 0 })).filter((x) => x.v !== null && x.n > 0);
  const rookie = p.exp === 'R';
  const target = rookie ? priors.rookie : samples.length ? priors.population : priors.fringe;
  if (!Number.isFinite(target)) return fallback;
  const n = samples.reduce((s, x) => s + x.n, 0);
  const value = samples.length ? shrink(target, IMPACT_K, samples.reduce((s, x) => s + x.n * x.v, 0) / n, n) : target;
  const impactSource = samples.length ? 'estimated-shrunk-spm' : rookie ? 'estimated-rookie-prior' : 'estimated-population-prior';
  const what = rookie ? '上季新秀 SPM 分钟加权均值' : samples.length ? '上季有 IMP 球员均值' : '上季 10–15 分钟段 SPM 均值';
  return { value: Math.round(value * 100) / 100, impactSource,
    source: `估计值（未验证）：${n} 场统计栏 SPM 按 K=${IMPACT_K} 场收缩到${what} ${target.toFixed(2)}` };
}

/** 按来源汇总预计分钟占 240 的比例 */
function shares(players, keyOf) {
  const out = {};
  for (const p of players) if (p.minutes > 0) out[keyOf(p)] = (out[keyOf(p)] ?? 0) + p.minutes / 240;
  return out;
}

/** 伤病快照比统计快照旧这么多小时就标「可能过期」（每天刷新一次，留半天余量） */
export const INJURY_STALE_HOURS = 36;

/**
 * Current snapshot estimate; not a historically validated forecast.
 * 分钟（roster-fixes-batch1）：出场时预计分钟 × 轮换概率 × 伤病出场概率，σ 分配到 240（见 rosterProjection / rotationMinutes）。
 *   availability='reported'：伤病出场概率 = P(出场 | 状态)（冻结的 injury-params-v1）；'healthy'：全员无伤（轮换概率照用——那是教练决定）。
 *   手动缺阵两种模式都记 0。
 * 去均值：每种模式用**该模式**下（不含手动缺阵）全联盟阵容分的均值，所以联盟均值恒为 0，手动勾选不牵动别队。
 *   healthyTotal 用健康均值；rosterAdj = （期望 − 健康）阵容分 × 节奏，是绝对的伤病代价（不去均值）。
 * 某队算不出来只影响该队（total=null + error），其余照常排名；均值只用算得出的队。
 */
export function liveRosterRankings(store, legacyRows, { out = {}, availability = 'reported' } = {}) {
  if (!['reported', 'healthy'].includes(availability)) throw new Error('Unknown roster availability mode');
  const status = new Map(availability === 'reported'
    ? (store.injuries?.players ?? []).map((p) => [p.playerId, p.status]) : []);
  const listed = new Set((store.injuries?.players ?? []).map((p) => p.playerId));
  const projections = new Map();
  const priors = impactPriors(store);
  for (const t of store.teams) {
    const roster = store.players.filter((p) => p.onRoster && p.teamId === t.teamId);
    const teamGames = Number.isFinite(t.cur?.wins) ? t.cur.wins + (t.cur.losses ?? 0)
      : Math.max(0, ...roster.map((p) => p.cur?.gp ?? 0));
    const players = roster.map((p) => {
      const currentRole = p.cur?.gp > 0 && Number.isFinite(p.cur.min) && p.cur.min > 0;
      const priorRole = p.gp >= 10 && Number.isFinite(p.min) && p.min > 0;
      const impact = Number.isFinite(p.cur?.impact) ? p.cur.impact
        : Number.isFinite(p.impact) ? p.impact : null;
      const estimate = impact == null ? estimateImpact(p, priors) : null;
      const rm = rotationMinutes({ priorMpg: priorRole ? p.min : null, curMpg: currentRole ? p.cur.min : null,
        n: currentRole ? p.cur.gp : 0, teamGames, listed: listed.has(p.playerId) });
      return {
        playerId: p.playerId, name: p.name,
        projectedMinutes: rm.minutes, rotation: rm.rotation, minutesSource: rm.minutesSource,
        impact, impactSource: Number.isFinite(p.cur?.impact) ? 'current-blended' : impact != null ? 'prior-season' : estimate.impactSource,
        impactPrior: estimate ? { value: estimate.value, source: estimate.source } : undefined,
        injuryStatus: status.get(p.playerId) ?? null, availability: playProbability(status.get(p.playerId)),
      };
    });
    const pace = t.cur?.adv?.pace ?? t.adv?.pace ?? store.meta.leagueAvg.pace;
    try {
      if (!Number.isFinite(pace) || pace <= 0) throw new Error('缺少有效节奏数据');
      const rot = projectExpectedRotation(players);
      // 折成每场分差（× 节奏 / 100）后再去均值，联盟均值才恰好是 0
      projections.set(t.teamId, { players, pace, healthy: healthyRosterRating(rot) * pace / 100, expected: rosterRating(rot) * pace / 100 });
    } catch (error) {
      projections.set(t.teamId, { error: error.message });
    }
  }
  const valid = [...projections.values()].filter((p) => !p.error);
  const avg = (k) => valid.reduce((s, p) => s + p[k], 0) / valid.length;
  const mean = { healthy: avg('healthy'), expected: availability === 'healthy' ? avg('healthy') : avg('expected') };
  const injuryFetchedAt = store.injuries?.fetchedAt ?? null;
  const lagH = injuryFetchedAt && store.meta.fetchedAt
    ? (Date.parse(store.meta.fetchedAt) - Date.parse(injuryFetchedAt)) / 3600e3 : null;
  const info = { experimental: true, fetchedAt: store.meta.fetchedAt, injuryFetchedAt, availability,
    // 伤病快照比统计快照旧多少小时；缺失或超过阈值即 injuryStale（界面另按当前时间算一次）
    injuryLagHours: lagH === null ? null : round(lagH),
    injuryStale: availability === 'reported' && (lagH === null || lagH > INJURY_STALE_HOURS),
    injuryStaleHours: INJURY_STALE_HOURS,
    // 没有 IMP 模型（data/impact-model.json）时缺 IMP 的人全部退回替补级 −0.5——不再静默
    impactModelMissing: !priors,
    leagueTeams: valid.length };
  const rows = legacyRows.map((row) => {
    const projection = projections.get(row.teamId);
    const base = { ...row, legacyTotal: row.total, legacyRank: row.rank, model: 'roster',
      total: null, rank: null, rosterAdj: null, modelDelta: null };
    if (!valid.length || !projection || projection.error) return { ...base, rosterProjection: {
      ...info, error: projection?.error ?? '该队阵容数据不足，无法估计',
    } };
    const excluded = new Set(out[row.teamId] ?? []);
    const { pace } = projection;
    try {
      const expected = projectExpectedRotation(projection.players.map((p) => ({ ...p,
        availability: excluded.has(p.playerId) ? 0 : availability === 'healthy' ? 1 : p.availability })));
      const pts = rosterRating(expected) * pace / 100;
      const healthyTotal = projection.healthy - mean.healthy;
      const total = pts - mean.expected;
      return { ...base, total: round(total), rosterAdj: round(pts - projection.healthy), modelDelta: round(total - row.total),
        rosterProjection: { ...info, healthyTotal: round(healthyTotal),
          priorMinutes: expected.priorMinutes, replacementMinutes: round(expected.replacementMinutes),
          knownImpactPct: shares(expected.players, (p) => (MEASURED_IMPACT.has(p.impactSource) ? 'measured' : 'estimated')).measured ?? 0,
          impactSourceShares: shares(expected.players, (p) => p.impactSource),
          minutesSourceShares: shares(expected.players, (p) => p.minutesSource),
          rotation: expected.players,
        } };
    } catch (error) {
      return { ...base, rosterProjection: { ...info, error: error.message } };
    }
  });
  rows.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity) || a.teamId - b.teamId);
  return rows.map((row, i) => ({ ...row, rank: row.total == null ? null : i + 1 }));
}
