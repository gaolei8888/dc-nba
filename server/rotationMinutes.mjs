/**
 * 阵容榜的「出场时分钟」与「出场概率」（roster-fixes-batch1，见 docs/roster-fixes-batch1-verdict.md）。
 *
 * 旧版把两件事搅在一起：预计分钟 = 出场时场均 × 出场率（向 0.60 收缩，K=10）。结果是
 *   · 场场打满 34.6 分钟的人只剩 29.8（出场率 4/4 被拉回 0.71），再等比缩放；
 *   · 本季 0 次出场的人照样拿 0.60 的出场率（Julian Reese 15.7 分钟）；
 *   · 「每日观察」「可能缺阵」一律当 100% 出场——伤病只有 out 一档。
 * 新版拆开：
 *   1. 分钟 = **出场时**的预计分钟（MPG 收缩，常数沿用 scripts/roster-shrinkage.mjs 对「出场时 MPG」的拟合）；
 *   2. 出场概率只来自伤病报告：P(出场 | 状态) 用冻结的 server/injury-params-v1.json（不在这里重拟合）；
 *   3. 轮换概率 q（健康时教练让不让他上，rotationProbability）与伤病出场概率分开，期望分钟 ∝ q × P(出场|状态)；
 *   4. 轮换外（DNP-CD）：本季一场没打、球队已赛 ≥ DNP_GAMES 场、且不在伤病名单上——不是伤停，是教练不用，
 *      出场时分钟降到 ROTATION_FLOOR（只在轮换耗尽时才会被抬起来）。
 *      快照里只有本季累计（场数、场均），没有逐场记录，所以只能识别「一场没打」这一种；
 *      打过几场后连续 DNP 的看不出来（局限，见 verdict）。
 * 分满 240 的方式见 server/rosterProjection.mjs 的 fillMinutes / projectExpectedRotation。
 */
import fs from 'node:fs';
import { ROTATION_FLOOR } from './rosterProjection.mjs';

const shrink = (target, k, value, n) => (k * target + n * value) / (k + n);

/**
 * 出场时 MPG 的收缩（与 liveRosterRankings.MINUTES 的 priorK / noPrior 同一组拟合值；那边的 rate 不再用于线上）：
 * 上季 ≥10 场者向上季场均收缩 K=2.5；其余向 7 + 0.7·本季MPG 收缩 K=16。
 */
export const MPG_SHRINK = { priorK: 2.5, noPrior: { a: 7, b: 0.7, k: 16 } };
/** 本季 0 出场、球队已赛 ≥ 这么多场、又不在伤病名单上 → 视为轮换外。由 scripts/minutes-backtest.mjs 在训练季上选 */
export const DNP_GAMES = 2;

export const INJURY_PARAMS = JSON.parse(fs.readFileSync(new URL('./injury-params-v1.json', import.meta.url), 'utf8'));
/**
 * ESPN 状态 → 官方报告状态。ESPN 的 Day-To-Day（简写 GTD，game-time decision）对应官方 Questionable；
 * ESPN 只有 out / doubtful / dayToDay 三档（espnClient.normalizeStatus），unknown 保守按 Questionable。
 */
const ESPN_TO_OFFICIAL = { out: 'Out', doubtful: 'Doubtful', dayToDay: 'Questionable', questionable: 'Questionable', probable: 'Probable', unknown: 'Questionable' };
/**
 * 用哪个时点的 P(出场 | 状态)：'22' = 北京 22:00（美东上午）那份报告的口径。
 * ingest 在 UTC 14 点前后抓 ESPN（美东上午 10 点），与 '22' 时点一致。
 */
export const INJURY_SLOT = '22';

/** 状态 → 出场概率；不在名单上（status 为空）= 1 */
export function playProbability(status, { slot = INJURY_SLOT, params = INJURY_PARAMS } = {}) {
  if (status == null || status === '') return 1;
  const key = params.slots[slot].pPlay[status] !== undefined ? status : ESPN_TO_OFFICIAL[status] ?? 'Questionable';
  const p = params.slots[slot].pPlay[key];
  return Number.isFinite(p) ? p : 1;
}

/** 出场时的预计 MPG；没有任何信息时返回 null */
export function conditionalMinutes(priorMpg, curMpg, n) {
  const hasPrior = Number.isFinite(priorMpg);
  if (!(n > 0)) return hasPrior ? priorMpg : null;
  if (hasPrior) return shrink(priorMpg, MPG_SHRINK.priorK, curMpg, n);
  const { a, b, k } = MPG_SHRINK.noPrior;
  return shrink(a + b * curMpg, k, curMpg, n);
}

/**
 * 轮换概率 q = P(健康时上场)：教练决定，不是伤病。logistic(β·[1, min(m,36)/10, 无分钟信息, logit ρ])，
 * m = 出场时预计分钟，ρ = (min(n,T) + 0.75)/(T + 1)（本季出场率，向 0.75 收缩 1 场，截在 [0.02, 0.98]）。
 * 拟合：scripts/minutes-backtest.mjs 的 report 口径样本里，**有官方报告且不在名单上（或 Available/Probable）**的
 * 候选球员·场（2022-23~2024-25 训练，约 7.9 万行；2025-26 留出 log loss 0.372，常数基准 0.543）。
 * 经验分档（四季）：出场时 30+ 分钟 97%、20–25 分钟 91%、10–15 分钟 60%、5–10 分钟 39%。
 * 局限：ρ 里混有过去的伤停（快照没有逐场记录），所以对伤愈归来的人偏低一点。
 */
export const ROTATION_LOGIT = { intercept: -0.979, perTenMin: 1.168, noInfo: 0.67, rate: 0.518, rateK: 1, rateR: 0.75 };

export function rotationProbability(m, n, T, cfg = ROTATION_LOGIT) {
  const rho = Math.min(0.98, Math.max(0.02, (Math.min(n, T) + cfg.rateK * cfg.rateR) / (T + cfg.rateK)));
  const z = cfg.intercept + cfg.perTenMin * Math.min(m ?? 0, 36) / 10 + (m == null ? cfg.noInfo : 0) + cfg.rate * Math.log(rho / (1 - rho));
  return 1 / (1 + Math.exp(-z));
}

/**
 * 一名球员的出场时预计分钟、轮换概率与来源。
 * listed：是否在伤病名单上（在名单上的 0 出场按伤停处理，不判轮换外）。
 */
export function rotationMinutes({ priorMpg = null, curMpg = null, n = 0, teamGames = 0, listed = false },
  { dnpGames = DNP_GAMES, floor = ROTATION_FLOOR, rotationModel = ROTATION_LOGIT } = {}) {
  const hasPrior = Number.isFinite(priorMpg);
  const cur = n > 0 && Number.isFinite(curMpg);
  const m = conditionalMinutes(hasPrior ? priorMpg : null, cur ? curMpg : null, cur ? n : 0);
  const rotation = rotationModel ? rotationProbability(m, cur ? n : 0, teamGames, rotationModel) : 1;
  if (!cur && !listed && teamGames >= dnpGames) return { minutes: floor, rotation, minutesSource: 'dnp-benched' };
  if (m === null) return { minutes: floor, rotation, minutesSource: 'replacement' };
  return { minutes: m, rotation, minutesSource: cur ? (hasPrior ? 'current+prior' : 'current+population') : 'prior-season' };
}
