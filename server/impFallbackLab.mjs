/**
 * IMP 回退先验实验（预注册：docs/superpowers/specs/2026-10-30-imp-fallback-prior-prereg.md）的价值构建。
 *
 * labValuesUpto 是回测共用的 valuesUpto（原先在 scripts/injury-elo-lab.mjs 与 scripts/roster-results-backtest.mjs
 * 里各抄一份、逐行相同）抽出来的版本：不传 fallback 时输出与原函数逐位相同（两份回测改用它之后输出逐字不变）。
 * 传 fallback 时在 shrunk 表里补上回退值（server/impFallback.mjs 的同一条规则），原有的值一个不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decayedApm } from './rapm.mjs';
import { buildSamples, fit, apply, blend, mean, DECAY_SPAN, DECAY_HALFLIFE } from './impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from './impactShrink.mjs';
import { fitAgeCurves } from './impactAging.mjs';
import { fallbackPriors, seasonApm, seasonBack } from './impFallback.mjs';

/** data/history 里全部 impact_<季>.json（含 2015-16 起的回填季），只给回退与年龄曲线用 */
export function loadBoxSeasons(historyDir) {
  const out = {};
  for (const f of fs.readdirSync(historyDir)) {
    const m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
    if (m) out[m[1]] = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8')).players.map((p) => ({ ...p, season: m[1] }));
  }
  return out;
}

/**
 * @param {object} ctx { seasons: 有 lineups 的赛季（升序，ALL）, players, lineups, apmBySeason, box?: loadBoxSeasons 的结果, cache?: Map }
 * @param {string} upto
 * @param {object} [opts] fallback: null | 'primary' | 'sens'
 * @returns {{ imp, shrunk, minutes, priorMpg, scale, spm, mu, fallback: Map }}
 */
export function labValuesUpto(ctx, upto, { fallback = null } = {}) {
  const { seasons: ALL, players, lineups, apmBySeason } = ctx;
  const seen = ALL.slice(0, ALL.indexOf(upto) + 1);
  const spm = fit(buildSamples(seen.flatMap((s) => players[s]), { apmBySeason }), 3000);
  const dec = decayedApm(seen.slice(-DECAY_SPAN).map((s) => ({ season: s, rows: lineups[s] })),
    { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
  const cal = [];
  for (const s of seen) {
    const decS = decayedApm(ALL.slice(Math.max(0, ALL.indexOf(s) - DECAY_SPAN + 1), ALL.indexOf(s) + 1)
      .map((x) => ({ season: x, rows: lineups[x] })), { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
    const byTeam = new Map();
    for (const p of players[s]) {
      if (!p.teamId || !(p.min > 0) || !(p.gp > 0)) continue;
      if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
      byTeam.get(p.teamId).push(p);
    }
    for (const squad of byTeam.values()) {
      const tot = squad.reduce((a, p) => a + p.min * p.gp, 0);
      cal.push({
        x: squad.reduce((a, p) => a + ((p.min * p.gp) / tot) * (blend(apply(spm, p), decS.get(p.playerId)?.apm ?? null) ?? 0), 0),
        y: squad.reduce((a, p) => a + ((p.min * p.gp) / tot) * (p.netRtg ?? 0), 0),
      });
    }
  }
  const mx = mean(cal.map((r) => r.x)); const my = mean(cal.map((r) => r.y));
  const scale = cal.reduce((a, r) => a + (r.x - mx) * (r.y - my), 0) / cal.reduce((a, r) => a + (r.x - mx) ** 2, 0) / 5;
  const imp = new Map(); const shrunk = new Map(); const minutes = new Map(); const priorMpg = new Map();
  const mu = mean(players[upto].map((p) => apply(spm, p)).filter((v) => v !== null));
  for (const p of players[upto]) {
    const m = (p.gp ?? 0) * (p.min ?? 0);
    minutes.set(p.playerId, m);
    if ((p.gp ?? 0) >= 10 && p.min > 0) priorMpg.set(p.playerId, p.min);
    const raw = blend(apply(spm, p), dec.get(p.playerId)?.apm ?? null);
    if (raw === null) continue;
    imp.set(p.playerId, raw * scale);
    shrunk.set(p.playerId, shrinkByMinutes(raw, m, mu, MINUTES_SHRINK) * scale);
  }
  const added = new Map();   // 只记真正补进去的人（原来就有值的一个不动）
  if (fallback) {
    for (const [id, r] of labFallback(ctx, upto, { spm, scale, mu, sensitivity: fallback === 'sens' })) {
      if (!shrunk.has(id)) { shrunk.set(id, r.value); added.set(id, r); }
    }
  }
  return { imp, shrunk, minutes, priorMpg, scale, spm, mu, fallback: added };
}

/**
 * 实验口径的回退：管线 = valuesUpto 对该季的算法（同一个 spm、以该季为末季的衰减 APM、该季 SPM 均值的 shrinkByMinutes、× scale），
 * SPM 特征平移 g 岁（valuesUpto 本身不平移，所以 extraAgeYears = 0）；年龄曲线只用 ≤ upto 的相邻赛季对拟合。
 */
export function labFallback(ctx, upto, { spm, scale, mu, sensitivity = false }) {
  const box = ctx.box;
  if (!box) throw new Error('labFallback 需要 ctx.box（loadBoxSeasons）');
  const cache = ctx.cache ?? (ctx.cache = new Map());
  const rowsOfSeason = (s) => {
    const key = `rows|${s}`;
    if (!cache.has(key)) cache.set(key, box[s] ? new Map(box[s].map((p) => [p.playerId, p])) : undefined);
    return cache.get(key);
  };
  const boxSeasons = Object.keys(box).sort().filter((s) => s <= upto);
  const curvesKey = `curves|${upto}`;
  if (!cache.has(curvesKey)) {
    cache.set(curvesKey, fitAgeCurves(boxSeasons.slice(0, -1).map((s, i) => ({ from: box[s], to: box[boxSeasons[i + 1]] }))));
  }
  const model = { ...spm, ageCurves: cache.get(curvesKey) };
  const apmOf = (s) => {
    const key = `apm|${s}`;
    if (!cache.has(key)) {
      cache.set(key, seasonApm(s, (x) => (ctx.seasons.includes(x) && x <= upto ? ctx.lineups[x] : null),
        { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 }));
    }
    return cache.get(key);
  };
  const muOf = new Map();
  const valueAt = (row, s, ageYears) => {
    if (!muOf.has(s)) muOf.set(s, mean(box[s].map((p) => apply(spm, p)).filter((v) => v !== null)));
    const raw = blend(apply(model, row, { ageYears }), apmOf(s)?.get(row.playerId)?.apm ?? null);
    return raw === null ? null : shrinkByMinutes(raw, (row.gp ?? 0) * (row.min ?? 0), muOf.get(s), MINUTES_SHRINK) * scale;
  };
  const ids = new Set();
  for (let k = 0; k <= 3; k += 1) for (const p of box[seasonBack(upto, k)] ?? []) ids.add(p.playerId);
  return fallbackPriors({
    ids, priorSeason: upto, rowsOf: rowsOfSeason, valueAt, muPrior: mu * scale, extraAgeYears: 0, sensitivity,
    partialOf: (row) => { const v = apply(spm, row, { minGp: 1 }); return v === null ? null : v * scale; },
  });
}
