/**
 * IMP 改进实验的数据与预测核心（scripts/imp-improve-lab.mjs、scripts/imp-improve-team.mjs 共用）。
 * import 时读 data/history/ 缓存；不抓数据。口径说明见 imp-improve-lab.mjs 与 docs/imp-improve-verdict.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import { decayedRapm, stintsOf } from '../server/stintRapm.mjs';
import { FEATURES, features, fit, corr, mean, MIN_GP, MIN_MPG } from '../server/impact.mjs';
import { shrinkToward, shrinkByMinutes } from '../server/impactShrink.mjs';
import {
  possShare, blendToward, momentPadding, padValue, fitHinge, lopoPick, verdict, seasonWeights, multiSeasonAvg, cumShift,
} from '../server/impImproveLab.mjs';

const HISTORY = path.join(DATA_DIR, 'history');

// ---------------------------------------------------------------- 数据
const players = {}; const lineups = {}; const stints = {};
for (const f of fs.readdirSync(HISTORY)) {
  let m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
  if (m) {
    players[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')).players.map((p) => ({ ...p, season: m[1] }));
    continue;
  }
  m = f.match(/^lineups_(\d{4}-\d{2})\.json$/);
  if (m) lineups[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')).rows;
}
// allSeasons：有统计栏的全部赛季（含可能的历史回填）；seasons：同时有 lineups 的赛季（APM、SPM 训练、尺子都只在这里）
const allSeasons = Object.keys(players).sort();
const seasons = allSeasons.filter((s) => lineups[s]);
for (const s of seasons) {
  const st = readJsonAuto(path.join(HISTORY, `stints_${s}.json.gz`));
  if (st) stints[s] = stintsOf(st);
}
if (seasons.length < 3) {
  console.error('缺 data/history/impact_*.json / lineups_*.json（从 GB10 的 ~/dc-nba-refresh/data/history 拷，别冷抓）');
  process.exit(1);
}
const byId = Object.fromEntries(allSeasons.map((s) => [s, new Map(players[s].map((p) => [p.playerId, p]))]));
const minutesOf = (p) => (p ? (p.gp ?? 0) * (p.min ?? 0) : 0);
const idx = (s) => seasons.indexOf(s);
const idxAll = (s) => allSeasons.indexOf(s);
const apmBy = new Map(seasons.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })]));

// ---------------------------------------------------------------- 缓存的测量那一半
const window = (s, span) => seasons.slice(Math.max(0, idx(s) - span + 1), idx(s) + 1);
const measCache = new Map();
/** 衰减 APM / RAPM；prior 为 {key, o:Map, d:Map} 或 null */
function meas(s, { src = 'apm', lam = 6000, span = 3, hl = 1, prior = null } = {}) {
  const key = `${s}|${src}|${lam}|${span}|${hl}|${prior?.key ?? '-'}`;
  if (!measCache.has(key)) {
    const w = window(s, span);
    let r;
    if (src === 'rapm') {
      r = decayedRapm(w.map((x) => ({ season: x, stints: stints[x] })), {
        span, halfLife: hl, lambda: lam, priorO: prior?.o ?? null, priorD: prior?.d ?? null,
      });
      for (const [k, v] of r) if (k !== '__hca') v.apm = v.rapm;
    } else {
      r = decayedApm(w.map((x) => ({ season: x, rows: lineups[x] })), {
        span, halfLife: hl, lambda: lam, priorO: prior?.o ?? null, priorD: prior?.d ?? null,
      });
    }
    measCache.set(key, r);
  }
  return measCache.get(key);
}

// ---------------------------------------------------------------- 实验 6：逐季 padding（只看统计栏，不看目标）
const padCache = new Map();
function padsOf(s) {
  if (!padCache.has(s)) {
    const rows = players[s].map((p) => ({ f: features(p), m: minutesOf(p) })).filter((r) => r.f && r.m >= 100);
    padCache.set(s, FEATURES.map((k) => momentPadding(rows.map((r) => ({ f: r.f[k], m: r.m })))));
  }
  return padCache.get(s);
}
const rawVec = (p) => { const f = features(p); return f ? FEATURES.map((k) => f[k]) : null; };
const padVec = (x, m, s, alpha) => (alpha ? x.map((v, j) => padValue(v, m, alpha * padsOf(s)[j].pad, padsOf(s)[j].mean)) : x);
const vecOf = (p, alpha) => { const x = rawVec(p); return x && padVec(x, minutesOf(p), p.season, alpha); };

// ---------------------------------------------------------------- SPM
const r2 = (v) => Math.round(v * 100) / 100;
const modelCache = new Map();
/** side: 'apm' | 'o' | 'd'；train: 训练赛季列表 */
function spmModel(train, side, lam, pad) {
  const key = `${train.join(',')}|${side}|${lam}|${pad}`;
  if (!modelCache.has(key)) {
    const samples = [];
    samples.keys = FEATURES;
    for (const s of train) {
      for (const p of players[s]) {
        if ((p.gp ?? 0) < MIN_GP || (p.min ?? 0) < MIN_MPG) continue;
        const a = apmBy.get(s).get(p.playerId);
        if (!a || a.poss < 500) continue;
        const x = vecOf(p, pad);
        if (!x) continue;
        samples.push({ x, y: a[side], w: a.poss });
      }
    }
    modelCache.set(key, fit(samples, lam));
  }
  return modelCache.get(key);
}
const applyVec = (mdl, x) => r2(mdl.beta.reduce((s, b, i) => s + b * ((x[i] - mdl.mu[i]) / mdl.sd[i]), mdl.intercept));
const eligible = (p) => p && (p.gp ?? 0) >= MIN_GP && (p.min ?? 0) >= MIN_MPG;
/** 单季 SPM（不在训练区间返回 null，与 impact.apply 同口径） */
function spmSingle(mdl, p, pad) {
  if (!eligible(p)) return null;
  const x = vecOf(p, pad);
  return x ? applyVec(mdl, x) : null;
}

/**
 * 实验 8：多季 SPM。返回 {v, mEff}；应用门槛看第 N 季。
 * multi = {mode, h, level:'spm'|'feat', span}；往季从 allSeasons 取（含可能的历史回填）。
 * aging（可选，实验 5b/8d/8e）：
 *   stat: 逐项曲线数组，alpha：feat 路径下每季特征平移到 N+1 岁（Σ g_j）
 *   tot: 总值曲线，align：spm 路径下每季 SPM 平移到第 N 季的岁数（最后的 +g(age_N) 由 cfg.age 负责）
 */
function spmMulti(mdl, p, pad, multi, aging = null) {
  if (!eligible(p)) return null;
  const single = !multi || multi.mode === 'single';
  if (single && !aging?.stat) {
    const v = spmSingle(mdl, p, pad);
    return v === null ? null : { v, mEff: minutesOf(p) };
  }
  const span = single ? 1 : (multi.span ?? 3);
  const d = single ? [1] : seasonWeights(multi, span);
  const back = Array.from({ length: span }, (_, j) => allSeasons[idxAll(p.season) - j]).map((s) => (s ? byId[s].get(p.playerId) : null));
  const ageAt = (q, j) => (Number.isFinite(q?.age) ? q.age : (Number.isFinite(p.age) ? p.age - j : null));
  if (!single && multi.level === 'spm') {
    const items = back.map((q, j) => {
      let v = q ? spmSingle(mdl, q, pad) : null;
      if (v === null) return null;
      if (aging?.tot && aging.align && j > 0 && ageAt(q, j) !== null && Number.isFinite(p.age)) v += cumShift(aging.tot.at, ageAt(q, j), p.age);
      return { v, m: minutesOf(q) };
    });
    return multiSeasonAvg(items, d);
  }
  // feat：原始速率（可选先按逐项年龄曲线对齐到 N+1 岁）按 d·m 平均，再用有效分钟与第 N 季的 padding 收缩
  const target = Number.isFinite(p.age) ? p.age + 1 : null;
  const items = back.map((q, j) => {
    let x = q && (q.min ?? 0) > 0 ? rawVec(q) : null;
    if (!x) return null;
    if (aging?.stat && target !== null && ageAt(q, j) !== null) {
      const a0 = ageAt(q, j);
      x = x.map((v, i) => v + aging.alpha * cumShift(aging.stat[i].at, a0, target));
    }
    return { v: x, m: minutesOf(q) };
  });
  const avg = multiSeasonAvg(items, d);
  if (!avg) return null;
  return { v: applyVec(mdl, padVec(avg.v, avg.mEff, p.season, pad)), mEff: avg.mEff };
}

// ---------------------------------------------------------------- 赛季对
const pairs = [];
for (const s of seasons) {
  const nx = seasons[idx(s) + 1];
  if (!nx) continue;
  const cur = apmBy.get(s); const nxt = apmBy.get(nx);
  const rows = players[s].filter((p) => {
    const a = cur.get(p.playerId); const b = nxt.get(p.playerId);
    return a && b && a.poss >= 500 && b.poss >= 500 && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10;
  });
  const onoffY = rows.map((p) => {
    const q = byId[nx].get(p.playerId);
    return q && Number.isFinite(q.onNet) && Number.isFinite(q.offNet) ? q.onNet - q.offNet : null;
  });
  pairs.push({ s, nx, pair: `${s}→${nx}`, rows, apmY: rows.map((p) => nxt.get(p.playerId).apm), onoffY, back: idx(s) + 1 });
}

// ---------------------------------------------------------------- 年龄曲线（实验 5 / 5b）
/**
 * 拟合年龄曲线用的相邻赛季对：LOPO 的 agePairs（其余 3 个评估对），
 * 加上历史回填赛季之间（以及回填末季 → 首个 lineups 季）的相邻对——那些只含统计栏，不涉及目标。
 */
const backfillPairs = allSeasons.slice(0, -1).map((s, i) => ({ s, nx: allSeasons[i + 1] })).filter((pr) => !lineups[pr.s]);
const p10 = (vals) => { const a = vals.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length * 0.1)] : 0; };
const ageCache = new Map();
/**
 * 总值曲线：delta 法拟合 g(age)，值为 IMP_收缩前（train 训练的基础 SPM + 现行衰减 APM），只在有 lineups 的赛季对上。
 * opt.weight 'harm'（主口径，两季分钟调和均值）| 'none'；opt.impute 幸存者粗修正（次季消失的按次季第 10 百分位补）
 */
function ageCurve(train, agePairs, { weight = 'harm', impute = false } = {}) {
  const key = `${train.join(',')}|${agePairs.map((p) => p.s).join(',')}|${weight}|${impute}`;
  if (!ageCache.has(key)) {
    const mdl = spmModel(train, 'apm', 3000, 0);
    const imp = (p) => blendToward(spmSingle(mdl, p, 0), meas(p.season).get(p.playerId)?.apm ?? null, 0.35);
    const samples = [];
    for (const pr of agePairs) {
      const floor = impute ? p10(players[pr.nx].filter(eligible).map(imp)) : null;
      for (const p of players[pr.s]) {
        if (!eligible(p) || !Number.isFinite(p.age)) continue;
        const q = byId[pr.nx].get(p.playerId);
        const a = imp(p);
        if (a === null) continue;
        const m1 = minutesOf(p);
        if (!eligible(q)) {
          if (impute && minutesOf(q) < 100) samples.push({ x: p.age, y: floor - a, w: weight === 'harm' ? m1 / 2 : 1 });
          continue;
        }
        const b = imp(q);
        if (b === null) continue;
        const m2 = minutesOf(q);
        samples.push({ x: p.age, y: b - a, w: weight === 'harm' ? (2 * m1 * m2) / (m1 + m2) : 1 });
      }
    }
    ageCache.set(key, fitHinge(samples, [23, 27, 31], [19, 38]));
  }
  return ageCache.get(key);
}
/** 逐项曲线（5b）：每个特征一条 g_j(age)；只看统计栏，所以也用回填赛季对 */
const statCache = new Map();
function statCurves(agePairs, { weight = 'harm', impute = false } = {}) {
  const use = [...agePairs, ...backfillPairs];
  const key = `${use.map((p) => p.s).join(',')}|${weight}|${impute}`;
  if (!statCache.has(key)) {
    const per = FEATURES.map(() => []);
    for (const pr of use) {
      const floors = impute ? FEATURES.map((_, j) => p10(players[pr.nx].filter((q) => minutesOf(q) >= 100).map((q) => rawVec(q)?.[j]))) : null;
      for (const p of players[pr.s]) {
        const m1 = minutesOf(p);
        if (m1 < 100 || !Number.isFinite(p.age)) continue;
        const x1 = rawVec(p);
        if (!x1) continue;
        const q = byId[pr.nx].get(p.playerId);
        const m2 = minutesOf(q);
        if (m2 < 100) {
          if (impute && eligible(p)) FEATURES.forEach((_, j) => per[j].push({ x: p.age, y: floors[j] - x1[j], w: weight === 'harm' ? m1 / 2 : 1 }));
          continue;
        }
        const x2 = rawVec(q);
        if (!x2) continue;
        const w = weight === 'harm' ? (2 * m1 * m2) / (m1 + m2) : 1;
        FEATURES.forEach((_, j) => per[j].push({ x: p.age, y: x2[j] - x1[j], w }));
      }
    }
    statCache.set(key, per.map((smp) => fitHinge(smp, [23, 27, 31], [19, 38])));
  }
  return statCache.get(key);
}

// ---------------------------------------------------------------- 通用预测
/**
 * cfg 字段（缺省 = 现状）：
 *   k=3200 收缩；mEff 是否用多季有效分钟作收缩证据量
 *   pad=0（实验 6 的 α）；lam=3000（SPM λ），lamO/lamD（分侧）
 *   multi（实验 8：{mode,h,level,span}）
 *   src='apm'|'rapm'，srcLam=6000，span=3，hl=1（8c），prior=null|'side'|'half'（实验 3/7）
 *   w=0.35，c=0（实验 1：w_i = w·n/(n+c)）
 *   sides=false（实验 2：wO,wD,kO,kD）
 *   age=0（实验 5 的 α：最后加 α·g(age_N)）
 *   ageStat=0（5b/8d 的 α：逐项特征对齐到 N+1 岁）；align=false（8e：多季 SPM 各季先按总值曲线对齐到第 N 季岁数）
 *   ageOpt={weight,impute}（幸存者偏差敏感性）
 */
const DEF = {
  k: 3200, mEff: false, pad: 0, lam: 3000, multi: null, src: 'apm', srcLam: 6000, span: 3, hl: 1, prior: null,
  w: 0.35, c: 0, sides: false, age: 0, ageStat: 0, align: false, ageOpt: null,
};

function predictor(ctx, cfgIn) {
  const cfg = { ...DEF, ...cfgIn };
  const { s, train } = ctx;
  const lamO = cfg.lamO ?? cfg.lam; const lamD = cfg.lamD ?? cfg.lam;
  const mods = cfg.sides
    ? { o: spmModel(train, 'o', lamO, cfg.pad), d: spmModel(train, 'd', lamD, cfg.pad) }
    : { t: spmModel(train, 'apm', cfg.lam, cfg.pad) };

  // 先验（实验 3/7）：窗口内每名球员取最近一季够门槛的单季 SPM
  let prior = null;
  if (cfg.prior) {
    const mo = cfg.prior === 'side' ? spmModel(train, 'o', lamO, cfg.pad) : spmModel(train, 'apm', cfg.lam, cfg.pad);
    const md = cfg.prior === 'side' ? spmModel(train, 'd', lamD, cfg.pad) : mo;
    const o = new Map(); const d = new Map();
    for (const x of [...window(s, cfg.span)].reverse()) {
      for (const p of players[x]) {
        if (o.has(p.playerId)) continue;
        const vo = spmSingle(mo, p, cfg.pad); const vd = spmSingle(md, p, cfg.pad);
        if (vo === null || vd === null) continue;
        if (cfg.prior === 'side') { o.set(p.playerId, vo); d.set(p.playerId, vd); } else { o.set(p.playerId, vo / 2); d.set(p.playerId, vd / 2); }
      }
    }
    prior = { key: `${ctx.key}|${cfg.prior}|${cfg.lam}|${lamO}|${lamD}|${cfg.pad}`, o, d };
  }
  const M = meas(s, { src: cfg.src, lam: cfg.srcLam, span: cfg.span, hl: cfg.hl, prior });

  // 每侧的 SPM（含多季）与人群均值
  const sideKeys = cfg.sides ? ['o', 'd'] : ['t'];
  const ageOpt = cfg.ageOpt ?? {};
  const aging = cfg.ageStat || cfg.align ? {
    stat: cfg.ageStat ? statCurves(ctx.agePairs, ageOpt) : null,
    alpha: cfg.ageStat,
    tot: cfg.align ? ageCurve(train, ctx.agePairs, ageOpt) : null,
    align: cfg.align,
  } : null;
  const spmMap = {}; const mu = {};
  for (const sk of sideKeys) {
    spmMap[sk] = new Map();
    for (const p of players[s]) {
      const r = spmMulti(mods[sk], p, cfg.pad, cfg.multi, aging);
      if (r) spmMap[sk].set(p.playerId, r);
    }
    mu[sk] = mean([...spmMap[sk].values()].map((r) => r.v));
  }
  const g = cfg.age ? ageCurve(train, ctx.agePairs, ageOpt) : null;
  const measKey = { t: 'apm', o: 'o', d: 'd' };
  const wOf = { t: cfg.w, o: cfg.wO ?? cfg.w, d: cfg.wD ?? cfg.w };
  const kOf = { t: cfg.k, o: cfg.kO ?? cfg.k, d: cfg.kD ?? cfg.k };

  return (p) => {
    let v = 0;
    for (const sk of sideKeys) {
      const S = spmMap[sk].get(p.playerId);
      if (!S) return null;
      const a = M.get(p.playerId);
      const share = possShare(a?.poss ?? 0, { wmax: wOf[sk], c: cfg.c });
      const raw = blendToward(S.v, a ? a[measKey[sk]] : null, share);
      v += shrinkToward(raw, mu[sk], cfg.mEff ? S.mEff : minutesOf(p), kOf[sk]);
    }
    if (g) v += cfg.age * g.at(p.age);
    return v;
  };
}

/** 一个 cfg 在每个赛季对上的两尺（每对的 ctx 剔除该对的第 N 季） */
const ctxOf = (i) => {
  const pr = pairs[i];
  const train = seasons.filter((x) => x !== pr.s);
  return { s: pr.s, train, agePairs: pairs.filter((_, j) => j !== i), key: `lopo${i}` };
};
const CTX = pairs.map((_, i) => ctxOf(i));
function scoreCfg(cfg) {
  return pairs.map((pr, i) => {
    const f = predictor(CTX[i], cfg);
    const x = pr.rows.map((p) => f(p) ?? 0);
    const ok = pr.onoffY.map((v, j) => (v === null ? -1 : j)).filter((j) => j >= 0);
    return { apm: corr(x, pr.apmY), onoff: corr(ok.map((j) => x[j]), ok.map((j) => pr.onoffY[j])) };
  });
}


/**
 * 截至 upto 季（含）、只用 ≤upto 季数据的线上口径球员价值（每百回合，与 fit-impact / ingest 同单位）：
 * 收缩前值 → 量纲校准（球队分钟加权值对球队净效率斜率 / 5）→ shrinkByMinutes（k=3200，pivot 1600）。
 * 逐项年龄曲线只用 ≤upto 季内的相邻赛季对。返回 { values: Map(id → 值), raw: Map, scale }。
 */
function calibratedValues(upto, cfg, { train: trainIn = null } = {}) {
  const seen = seasons.slice(0, seasons.indexOf(upto) + 1);
  const train = trainIn ?? seen;
  const agePairs = seen.slice(0, -1).map((x, i) => ({ s: x, nx: seen[i + 1] }));
  const ctxFor = (x) => ({ s: x, train, agePairs, key: `cal${upto}|${x}|${train.join(',')}` });
  const cal = [];
  for (const x of seen) {
    const raw = predictor(ctxFor(x), { ...cfg, k: 0 });
    const byTeam = new Map();
    for (const p of players[x]) {
      if (!p.teamId || !(p.min > 0) || !(p.gp > 0)) continue;
      if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
      byTeam.get(p.teamId).push(p);
    }
    for (const squad of byTeam.values()) {
      const tot = squad.reduce((a, p) => a + p.min * p.gp, 0);
      cal.push({
        x: squad.reduce((a, p) => a + ((p.min * p.gp) / tot) * (raw(p) ?? 0), 0),
        y: squad.reduce((a, p) => a + ((p.min * p.gp) / tot) * (p.netRtg ?? 0), 0),
      });
    }
  }
  const mx = mean(cal.map((r) => r.x)); const my = mean(cal.map((r) => r.y));
  const scale = cal.reduce((a, r) => a + (r.x - mx) * (r.y - my), 0) / cal.reduce((a, r) => a + (r.x - mx) ** 2, 0) / 5;
  const raw = predictor(ctxFor(upto), { ...cfg, k: 0 });
  const spmOnly = predictor(ctxFor(upto), { ...cfg, k: 0, w: 0 });
  const mu = mean(players[upto].map(spmOnly).filter((v) => v !== null));
  const values = new Map(); const raws = new Map();
  for (const p of players[upto]) {
    const v = raw(p);
    if (v === null) continue;
    raws.set(p.playerId, v * scale);
    values.set(p.playerId, shrinkByMinutes(v, minutesOf(p), mu) * scale);
  }
  return { values, raw: raws, scale, mu };
}

export {
  calibratedValues, players, lineups, stints, allSeasons, seasons, byId, minutesOf, apmBy, meas, padsOf, spmModel, spmSingle, spmMulti,
  pairs, ageCurve, statCurves, backfillPairs, DEF, predictor, CTX, scoreCfg, eligible,
};
