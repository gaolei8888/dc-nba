/**
 * 上季 IMP 缺失时的回退先验（预注册：docs/superpowers/specs/2026-10-30-imp-fallback-prior-prereg.md）。
 *
 * 上季出场 < 20 场的人没有上季 IMP，原来一律按替补级 −0.5。回退规则：
 *   1. 从上季往前最多 3 季，取最近一个 gp ≥ 20、场均 ≥ 10 分钟的合格季，按管线方式算该季 IMP（模型 + 该季均值的 shrinkByMinutes）；
 *   2. SPM 特征按逐项年龄曲线从合格季一路平移过来（g = 上季序号 − 合格季序号；生产另加上季 → 本季的那一岁）；
 *   3. 向人群均值收缩：μ + 0.8^g × (aged − μ)，μ = 上季 shrinkByMinutes 用的那个均值（不是替补级）；
 *   4. 上季打过几场（gp ≥ 1、场均 ≥ 10）：(20 × 回退 + gp × 上季 SPM)/(20 + gp)，与 currentImpact 同一个 K。
 * 新秀、3 季内没有合格季、上季 ≥ 20 场的人都不动。
 *
 * 规则本身（fallbackPriors / fallbackValue）是纯函数，实验（server/impFallbackLab.mjs）与生产（productionFallback，
 * scripts/ingest.mjs 调用）共用；两边只是「管线怎么算一季的 IMP」不同，由 valueAt 回调给出。
 */
import { MIN_GP, MIN_MPG, impactOf, apply as spmOf } from './impact.mjs';
import { shrinkByMinutes, populationMean } from './impactShrink.mjs';
import { decayedApm } from './rapm.mjs';

export const FALLBACK = Object.freeze({ back: 3, decay: 0.8, kGames: 20, missedFactor: 0.85 });

/** '2025-26', 2 → '2023-24' */
export function seasonBack(season, back) {
  const y = Number(season.slice(0, 4)) - back;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export const qualifies = (row) => !!row && (row.gp ?? 0) >= MIN_GP && (row.min ?? 0) >= MIN_MPG;

/**
 * 最近的合格季：rowsOf(season) → Map(id → 数据行) 或 undefined（没有该季数据）。
 * 返回 { season, g, row } 或 null；g = 1..back。
 */
export function goodSeason(id, priorSeason, rowsOf, back = FALLBACK.back) {
  for (let g = 1; g <= back; g += 1) {
    const s = seasonBack(priorSeason, g);
    const row = rowsOf(s)?.get(id);
    if (qualifies(row)) return { season: s, g, row };
  }
  return null;
}

/** 合格季之后到上季（含）之间，有没有一整季没出场（该季有数据文件，但没有他的行或 gp = 0） */
export function missedFullSeason(id, priorSeason, g, rowsOf) {
  for (let k = 0; k < g; k += 1) {
    const rows = rowsOf(seasonBack(priorSeason, k));
    if (!rows) continue;
    const r = rows.get(id);
    if (!r || !((r.gp ?? 0) > 0)) return true;
  }
  return false;
}

/**
 * 第 3–5 步：aged 为合格季 IMP（已按年龄平移、已按该季收缩），mu 为上季人群均值（同单位）。
 * sensitivity=true 且 missed 时 (value − μ) 再乘 0.85（敏感性变体，只报告）。
 */
export function fallbackValue({ aged, mu, g, missed = false, partial = null, priorGp = 0, sensitivity = false }) {
  const f = sensitivity && missed ? FALLBACK.missedFactor : 1;
  const fb = mu + FALLBACK.decay ** g * f * (aged - mu);
  if (partial === null || partial === undefined || !(priorGp >= 1)) return fb;
  return (FALLBACK.kGames * fb + priorGp * partial) / (FALLBACK.kGames + priorGp);
}

/**
 * 对一批球员套回退规则。
 * @param {object} x
 * @param {Iterable<number>} x.ids 候选球员（已有上季 IMP 的人照样可以传，会被跳过）
 * @param {string} x.priorSeason 上季
 * @param {(season:string)=>Map<number,object>|undefined} x.rowsOf 各季数据行
 * @param {(row:object, season:string, ageYears:number)=>number|null} x.valueAt 管线算法：合格季那一行平移 ageYears 岁后的收缩 IMP
 * @param {number} x.muPrior 上季 shrinkByMinutes 的人群均值（与 valueAt 同单位）
 * @param {(row:object)=>number|null} x.partialOf 上季少量出场的 SPM（minGp=1；不合门槛返回 null）
 * @param {number} [x.extraAgeYears] 在 g 之外再平移几岁（生产 = 1，上季 → 本季；实验 = 0）
 * @param {boolean} [x.sensitivity] 敏感性变体
 * @returns {Map<number,{value:number, season:string, g:number, aged:number, missed:boolean, priorGp:number, partial:number|null}>}
 */
export function fallbackPriors({ ids, priorSeason, rowsOf, valueAt, muPrior, partialOf, extraAgeYears = 0, sensitivity = false }) {
  const out = new Map();
  const prior = rowsOf(priorSeason);
  for (const id of new Set(ids)) {
    const p = prior?.get(id);
    if ((p?.gp ?? 0) >= MIN_GP) continue;   // 上季 ≥ 20 场：走原管线（场均 < 10 分钟的也不动）
    const good = goodSeason(id, priorSeason, rowsOf);
    if (!good) continue;
    const aged = valueAt(good.row, good.season, good.g + extraAgeYears);
    if (aged === null || aged === undefined || !Number.isFinite(aged)) continue;
    const priorGp = p?.gp ?? 0;
    const partial = priorGp >= 1 ? (partialOf(p) ?? null) : null;
    const missed = missedFullSeason(id, priorSeason, good.g, rowsOf);
    const value = fallbackValue({ aged, mu: muPrior, g: good.g, missed, partial, priorGp, sensitivity });
    out.set(id, { value, season: good.season, g: good.g, aged, missed, priorGp, partial });
  }
  return out;
}

// ---------------------------------------------------------------- 生产口径

/**
 * 以 season 为最后一季、往前共 span 季的衰减 APM；窗口前端缺 lineups 的季截掉（与 valuesUpto 校准段对早期赛季的做法相同），
 * season 本身没有 lineups 返回 null（IMP 退回纯 SPM，与 impact.blend 一致）。
 */
export function seasonApm(season, lineupsOf, { span = 3, halfLife = 1, lambda = 6000 } = {}) {
  if (!lineupsOf(season)) return null;
  const w = [];
  for (let k = span - 1; k >= 0; k -= 1) {
    const s = seasonBack(season, k);
    const rows = lineupsOf(s);
    if (rows) w.push({ season: s, rows });
    else w.length = 0;   // 只截前端：中间缺季时丢掉更早的，保证位置权重从最新一季数起
  }
  return decayedApm(w, { span, halfLife, lambda });
}

/**
 * 生产口径的回退先验（scripts/ingest.mjs 用）：管线 = impactOf(model, 行, 衰减 APM, 平移 ageYears) → shrinkByMinutes（该季 aged SPM 均值）。
 * 上季 IMP 本身平移一岁，所以 extraAgeYears = 1；上季少量出场的 SPM 同样平移一岁。结果舍入到 0.01，与 p.impact 同。
 *
 * @param {object} x
 * @param {object} x.model data/impact-model.json
 * @param {string} x.priorSeason
 * @param {Array} x.priorRows 上季球员行（ingest 的嵌套形状或 impact_*.json 的扁平形状都行）
 * @param {(season:string)=>Array|null} x.historyRows 更早赛季的球员行（data/history/impact_<季>.json 的 players）
 * @param {(season:string)=>Array|null} x.lineupsOf 各季五人组合（data/history/lineups_<季>.json 的 rows），缺返回 null
 * @param {number} x.muPrior 上季 shrinkByMinutes 用的均值（ingest 里的 mu）
 * @param {boolean} [x.sensitivity]
 */
export function productionFallback({ model, priorSeason, priorRows, historyRows, lineupsOf, muPrior, sensitivity = false }) {
  const bySeason = new Map([[priorSeason, new Map(priorRows.map((p) => [p.playerId, p]))]]);
  for (let k = 1; k <= FALLBACK.back; k += 1) {
    const s = seasonBack(priorSeason, k);
    const rows = historyRows(s);
    if (rows) bySeason.set(s, new Map(rows.map((p) => [p.playerId, p])));
  }
  const rowsOf = (s) => bySeason.get(s);
  const ids = new Set();
  for (const m of bySeason.values()) for (const id of m.keys()) ids.add(id);
  const cache = new Map();
  const seasonCtx = (s) => {
    if (!cache.has(s)) {
      const rows = [...bySeason.get(s).values()];
      cache.set(s, {
        apm: seasonApm(s, lineupsOf, { span: model.decaySpan ?? 3, halfLife: model.decayHalfLife ?? 1, lambda: model.apmLambda ?? 6000 }),
        mu: populationMean(rows.map((p) => spmOf(model, p, { aged: true }))),
      });
    }
    return cache.get(s);
  };
  const valueAt = (row, s, ageYears) => {
    const c = seasonCtx(s);
    const v = impactOf(model, row, c.apm?.get(row.playerId)?.apm ?? null, { ageYears });
    return v === null ? null : shrinkByMinutes(v, (row.gp ?? 0) * (row.min ?? 0), c.mu);
  };
  const res = fallbackPriors({
    ids, priorSeason, rowsOf, valueAt, muPrior, extraAgeYears: 1, sensitivity,
    partialOf: (row) => spmOf(model, row, { minGp: 1, aged: true }),
  });
  for (const r of res.values()) r.value = Math.round(r.value * 100) / 100;
  return res;
}
