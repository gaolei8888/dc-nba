/** Experimental projections. Inputs are forecasts, never future actual minutes. */
import { REPLACEMENT_IMP } from './ratings.mjs';

const MINUTES = 240;
const EPSILON = 1e-8;

function allocate(weights, caps) {
  if (caps.reduce((s, c) => s + c, 0) < MINUTES - EPSILON) {
    throw new Error('Insufficient rotation capacity: need 240 minutes from eligible players');
  }
  const minutes = weights.map(() => 0);
  let remaining = MINUTES;
  while (remaining > EPSILON) {
    const active = caps.map((cap, i) => i).filter((i) => caps[i] - minutes[i] > EPSILON);
    const scale = active.reduce((largest, i) => Math.max(largest, weights[i]), 0);
    const totalWeight = scale > 0 ? active.reduce((s, i) => s + weights[i] / scale, 0) : 0;
    const before = remaining;
    for (const i of active) {
      const share = totalWeight > 0 ? (weights[i] / scale) / totalWeight : 1 / active.length;
      const added = Math.min(caps[i] - minutes[i], before * share);
      minutes[i] += added;
      remaining -= added;
    }
  }
  return minutes;
}

function validateRows(players) {
  if (!Array.isArray(players) || !players.length) throw new Error('Missing rotation players');
  const ids = new Set();
  return players.map((p) => {
    if (!Number.isSafeInteger(p.playerId) || p.playerId <= 0) throw new Error('Invalid playerId');
    if (ids.has(p.playerId)) throw new Error(`Duplicate player ${p.playerId}`);
    ids.add(p.playerId);
    if (!Number.isFinite(p.projectedMinutes) || p.projectedMinutes < 0) {
      throw new Error(`Invalid projectedMinutes for player ${p.playerId}`);
    }
    if (!Number.isFinite(p.availability) || p.availability < 0 || p.availability > 1) {
      throw new Error(`Invalid availability for player ${p.playerId}`);
    }
    const fromPrior = p.impact == null;
    const impact = fromPrior ? p.impactPrior?.value : p.impact;
    if (!Number.isFinite(impact)) throw new Error(`Missing or invalid impact for player ${p.playerId}`);
    if (fromPrior && (typeof p.impactPrior.source !== 'string' || !p.impactPrior.source.trim())) {
      throw new Error(`An impact prior needs a source for player ${p.playerId}`);
    }
    return { ...p, impact, fromPrior };
  });
}

/** 旧版分配（等比、单人上限 48）：线上阵容榜已换成 projectExpectedRotation，这里留给实验室回放与新旧对照 */
export function projectRotation(players) {
  const rows = validateRows(players);
  const healthy = allocate(rows.map((p) => p.projectedMinutes), rows.map(() => 48));
  const expected = allocate(healthy.map((m, i) => m * rows[i].availability),
    rows.map((p) => 48 * p.availability));
  const rotation = rows.map((p, i) => ({ ...p, healthyMinutes: healthy[i], minutes: expected[i] }));
  return {
    players: rotation,
    priorMinutes: rotation.reduce((s, p) => s + (p.fromPrior ? p.minutes : 0), 0),
  };
}

export function rosterRating(rotation) {
  const replacement = (rotation.replacementMinutes ?? 0) * (rotation.replacementImpact ?? 0) / 48;
  const rating = rotation.players.reduce((s, p) => s + p.impact * (p.minutes / 48), replacement);
  if (!Number.isFinite(rating)) throw new Error('Nonfinite roster rating: input overflow');
  return rating;
}

// ---------------------------------------------------------------- 新版分配（阵容榜线上用）

/**
 * 单人「期望分钟」上限 C（渐近线）。依据 data/history/stints 2021-22…2025-26（只算常规时间打满 48 分钟的比赛）：
 * 首发单场分钟 p90 37.0–38.1、p95 38.5–39.4、p99 40.7–42.1；出场 ≥40 场球员的赛季场均最高 37.0–37.4，
 * 每季 ≥36 分钟的只有 2–6 人。这里分的是**期望**分钟（一场的平均），不是单场上限，所以取 38：
 * 略高于历史最高赛季场均、约等于首发单场 p90。scripts/minutes-backtest.mjs 在训练季上对 36–42 做了敏感性检查。
 */
export const ROTATION_CAP = 38;
/** 没有任何分钟信息（或被判为轮换外）的人的名义出场时分钟：只在轮换耗尽时才会被抬起来 */
export const ROTATION_FLOOR = 1;
/** 枚举模式下最多逐一展开这么多个伤病不确定的人，再多的把最接近 0/1 的取整 */
const MAX_UNCERTAIN = 8;
const logit = (x) => Math.log(x / (1 - x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * 分满 240 分钟。projected = 出场时预计分钟，weights = 本场出场概率（0..1）。
 * 每人期望分钟 = w_i·C·σ(θ_i + c)，θ_i = logit(出场时分钟 / C)，c 为全队同一个平移量，二分求解使总和 = 240。
 * 性质：c 变化时分钟的增减 ∝ σ(1−σ)——接近上限的主力几乎不动，空出来的分钟主要流向中段轮换与替补
 * （「下一个顶上」），而不是按比例把 28 分钟的主力推到 43 分钟；人多分钟不够时也主要压缩替补而不是主力。
 * 出场概率是小数时这是「平均场」近似（不逐一枚举谁上谁不上）。
 * 全员拿满 w_i·C 仍不够 240（轮换耗尽）时，余下的记作替补级分钟 replacement。
 */
export function fillMinutes(projected, weights, { cap = ROTATION_CAP, floor = ROTATION_FLOOR } = {}) {
  const w = projected.map((m, i) => Math.max(0, Math.min(1, Number(weights[i]))));
  const capacity = w.reduce((s, v) => s + v * cap, 0);
  if (capacity <= MINUTES) return { minutes: w.map((v) => v * cap), replacement: MINUTES - capacity };
  const theta = projected.map((m) => logit(Math.min(Math.max(m, floor), cap - 0.5) / cap));
  const total = (c) => theta.reduce((s, t, i) => s + w[i] * cap * sigmoid(t + c), 0);
  let lo = -40; let hi = 40;
  for (let k = 0; k < 60; k += 1) {
    const mid = (lo + hi) / 2;
    if (total(mid) < MINUTES) lo = mid; else hi = mid;
  }
  const raw = theta.map((t, i) => w[i] * cap * sigmoid(t + (lo + hi) / 2));
  const scale = MINUTES / raw.reduce((s, v) => s + v, 0); // 消掉二分的残差，保证恰好 240
  return { minutes: raw.map((v) => v * scale), replacement: 0 };
}

/** 伤病出场概率的所有情形：[{ p, playing: 0/1[] }]。确定的人（0 或 1）不展开 */
export function availabilityScenarios(avail, maxUncertain = MAX_UNCERTAIN) {
  let a = [...avail];
  let unc = a.map((v, i) => i).filter((i) => a[i] > 0 && a[i] < 1);
  if (unc.length > maxUncertain) {
    const keep = new Set([...unc].sort((i, j) => Math.abs(a[i] - 0.5) - Math.abs(a[j] - 0.5)).slice(0, maxUncertain));
    a = a.map((v, i) => (unc.includes(i) && !keep.has(i) ? (v >= 0.5 ? 1 : 0) : v));
    unc = [...keep];
  }
  const out = [];
  for (let mask = 0; mask < 2 ** unc.length; mask += 1) {
    let p = 1;
    const playing = a.map((v) => (v >= 1 ? 1 : 0));
    unc.forEach((i, b) => {
      const on = (mask >> b) & 1;
      playing[i] = on;
      p *= on ? a[i] : 1 - a[i];
    });
    if (p > 0) out.push({ p, playing });
  }
  return out;
}

/**
 * 新版轮换。每名球员：
 *   projectedMinutes = **出场时**的预计分钟；
 *   rotation = 健康时教练让他上场的概率（轮换地位，默认 1；见 server/rotationMinutes.mjs）；
 *   availability = 伤病出场概率（伤病报告 P(出场|状态) / 手动缺阵 0，默认 1）。
 * healthyMinutes = 全员无伤（只看 rotation）时的分配；minutes = 期望分钟（rotation × availability）。
 * 两者都恰好 240（含替补级 replacement）。
 * mode='meanfield'（默认，线上）：出场概率直接当权重；mode='enumerate'：伤病不确定的人逐一枚举、按概率加权（回测对照）。
 */
export function projectExpectedRotation(players, { cap = ROTATION_CAP, floor = ROTATION_FLOOR,
  replacementImpact = REPLACEMENT_IMP, mode = 'meanfield', maxUncertain = MAX_UNCERTAIN } = {}) {
  const rows = validateRows(players).map((p) => {
    const rotation = p.rotation ?? 1;
    if (!Number.isFinite(rotation) || rotation < 0 || rotation > 1) throw new Error(`Invalid rotation for player ${p.playerId}`);
    return { ...p, rotation };
  });
  const projected = rows.map((p) => p.projectedMinutes);
  const opts = { cap, floor };
  const healthy = fillMinutes(projected, rows.map((p) => p.rotation), opts);
  let expected; let replacementMinutes;
  if (mode === 'enumerate') {
    expected = rows.map(() => 0); replacementMinutes = 0;
    for (const { p, playing } of availabilityScenarios(rows.map((r) => r.availability), maxUncertain)) {
      const s = fillMinutes(projected, rows.map((r, i) => playing[i] * r.rotation), opts);
      s.minutes.forEach((m, i) => { expected[i] += p * m; });
      replacementMinutes += p * s.replacement;
    }
  } else {
    const s = fillMinutes(projected, rows.map((r) => r.availability * r.rotation), opts);
    expected = s.minutes; replacementMinutes = s.replacement;
  }
  const rotation = rows.map((p, i) => ({ ...p, healthyMinutes: healthy.minutes[i], minutes: expected[i] }));
  return {
    players: rotation,
    replacementMinutes,
    healthyReplacementMinutes: healthy.replacement,
    replacementImpact,
    priorMinutes: rotation.reduce((s, p) => s + (p.fromPrior ? p.minutes : 0), 0),
  };
}

/** 全员无伤时的阵容分（healthy 基准），与 rosterRating 同口径 */
export function healthyRosterRating(rotation) {
  return rosterRating({
    players: rotation.players.map((p) => ({ ...p, minutes: p.healthyMinutes })),
    replacementMinutes: rotation.healthyReplacementMinutes, replacementImpact: rotation.replacementImpact,
  });
}
