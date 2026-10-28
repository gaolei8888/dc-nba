/**
 * 拟合并**验证**综合影响力指标（IMP），写出 data/impact-model.json。
 *
 *   node scripts/fit-impact.mjs
 *
 * IMP = w · 衰减 APM + (1-w) · SPM，w = 0.4。
 * 这两半各自不完整：SPM 只看统计栏，看不到球员真实带来的胜负；
 * APM 只看场上结果，样本噪声大。EPM 把 SPM 当贝叶斯先验喂进 RAPM，
 * 我们用固定权重线性混合，方向一致、实现简单得多。
 *
 * **验收标准是「用第 N 季的数据预测第 N+1 季的真实 APM」。**
 * 之前用的是同赛季 APM，那个标准有两个毛病：一是循环（最终指标里含当季 APM，
 * 等于拿目标的一部分预测目标），二是不对题——这个应用本来就是拿上赛季
 * 预测下赛季。换成跨赛季之后，所有数字都变得可信且可比。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import {
  FEATURES, buildSamples, fit, apply, blend, impactOf, corr, mean, sdOf,
  BLEND_W, DECAY_SPAN, DECAY_HALFLIFE, APM_DECAY_SPAN, APM_DECAY_HALFLIFE,
} from '../server/impact.mjs';
import { shrinkByMinutes, populationMean, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { fitAgeCurves } from '../server/impactAging.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const APM_LAMBDA = Number(process.env.APM_LAMBDA) || 6000;
const SPM_LAMBDA = Number(process.env.SPM_LAMBDA) || 3000;

function load() {
  const players = {}; const lineups = {};
  if (!fs.existsSync(HISTORY)) return { players, lineups };
  for (const f of fs.readdirSync(HISTORY)) {
    let m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
    if (m) {
      players[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8'))
        .players.map((p) => ({ ...p, season: m[1] }));
      continue;
    }
    m = f.match(/^lineups_(\d{4}-\d{2})\.json$/);
    if (m) lineups[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')).rows;
  }
  return { players, lineups };
}

const { players, lineups } = load();
const seasons = Object.keys(players).sort().filter((s) => lineups[s]);
if (seasons.length < 3) {
  console.error(`需要至少 3 个赛季（当前 ${seasons.length}）。先运行 npm run impact:fetch && npm run lineups:fetch`);
  process.exit(1);
}
const nextOf = (s) => seasons[seasons.indexOf(s) + 1];

/** 单季 APM，作为回归目标与验收目标 */
const apmBySeason = new Map(seasons.map((s) => [s, computeApm(lineups[s], { lambda: APM_LAMBDA })]));

/**
 * 截至某季的衰减 APM，作为 IMP 的实测那一半。
 * 线上 = APM_DECAY_SPAN 季 / 半衰期 APM_DECAY_HALFLIFE 季；v1（10-28 之前）= DECAY_SPAN / DECAY_HALFLIFE，作对照。
 */
const decayCache = new Map();
function decayUpto(season, span = APM_DECAY_SPAN, halfLife = APM_DECAY_HALFLIFE) {
  const key = `${season}|${span}|${halfLife}`;
  if (!decayCache.has(key)) {
    const i = seasons.indexOf(season);
    const slice = seasons.slice(Math.max(0, i - span + 1), i + 1)
      .map((s) => ({ season: s, rows: lineups[s] }));
    decayCache.set(key, decayedApm(slice, { span, halfLife, lambda: APM_LAMBDA }));
  }
  return decayCache.get(key);
}
const decayV1 = (season) => decayUpto(season, DECAY_SPAN, DECAY_HALFLIFE);

/**
 * 逐项年龄曲线（server/impactAging.mjs）：用相邻赛季对拟合，只看统计栏。
 * 验证时剔除被评估的那一对（held → 下一季），与实验室的留一对口径相同。
 */
// 统计栏历史回填（impact_2015-16 …，没有 lineups）也参与：曲线只看统计栏，与任何验证目标无关。
const boxSeasons = Object.keys(players).sort();
const agePairsExcept = (held) => boxSeasons.slice(0, -1)
  .filter((s) => s !== held)
  .map((s) => ({ from: players[s], to: players[boxSeasons[boxSeasons.indexOf(s) + 1]] }));

/** 训练 SPM，训练集里剔除 held 赛季 */
function trainSpm(held) {
  const rows = seasons.filter((s) => s !== held).flatMap((s) => players[s]);
  return fit(buildSamples(rows, { apmBySeason }), SPM_LAMBDA);
}

console.log(`\n拟合综合影响力指标  赛季：${seasons.join('、')}`);
console.log(`IMP = ${BLEND_W} × 衰减APM(${APM_DECAY_SPAN}季，半衰期 ${APM_DECAY_HALFLIFE} 季) + ${(1 - BLEND_W).toFixed(2)} × SPM(特征先按逐项年龄曲线平移一岁)`);
console.log(`APM lambda=${APM_LAMBDA}  SPM lambda=${SPM_LAMBDA}\n`);

// ---------------------------------------------------------------- 验证
//
// 每个"第 N 季 → 第 N+1 季"的组合各评一次，SPM 训练时看不到第 N 季。

// IMP 是线上口径（docs/imp-improve-verdict.md 的组合 8c×5b）：
//   SPM 的特征先按逐项年龄曲线平移一岁（曲线只在其余赛季对上拟合），APM 取 4 季衰减（半衰期 3 季），
//   混合后再按第 N 季出场分钟向人群（平移后）SPM 均值收缩（k=3200，docs/impact-shrink-continuity-verdict.md）。
// 「IMP v1」是 10-28 之前的线上口径（3 季衰减、不调年龄、同样收缩），其余候选照列作对照。
// 两把尺子都报：次季真实 APM 与次季裸 on/off（后者缺陷来源与 APM 不同）。
const muCache = new Map();
const muOf = (s, mdl, tag) => {
  const key = `${s}|${tag}`;
  if (!muCache.has(key)) muCache.set(key, populationMean(players[s].map((p) => apply(mdl, p, { aged: tag === 'aged' }))));
  return muCache.get(key);
};
const mins = (p) => (p.gp ?? 0) * (p.min ?? 0);
const unshrunk = (p, s, m) => blend(apply(m.aged, p, { aged: true }), decayUpto(s).get(p.playerId)?.apm);
const candidates = {
  IMP: (p, s, m) => shrinkByMinutes(unshrunk(p, s, m), mins(p), muOf(s, m.aged, 'aged')),
  'IMP v1（3季衰减、不调年龄）': (p, s, m) => shrinkByMinutes(blend(apply(m.spm, p), decayV1(s).get(p.playerId)?.apm), mins(p), muOf(s, m.spm, 'plain')),
  'IMP 仅长记忆APM': (p, s, m) => shrinkByMinutes(blend(apply(m.spm, p), decayUpto(s).get(p.playerId)?.apm), mins(p), muOf(s, m.spm, 'plain')),
  'IMP 仅逐项年龄': (p, s, m) => shrinkByMinutes(blend(apply(m.aged, p, { aged: true }), decayV1(s).get(p.playerId)?.apm), mins(p), muOf(s, m.aged, 'aged')),
  'IMP（收缩前）': unshrunk,
  'SPM（只看统计栏）': (p, s, m) => apply(m.spm, p),
  'APM（只看场上结果）': (p, s) => decayUpto(s).get(p.playerId)?.apm ?? null,
  PIE: (p) => p.pie ?? 0,
  净效率: (p) => p.netRtg ?? 0,
};

const rowsFor = (s) => {
  const nx = nextOf(s);
  if (!nx) return null;
  const cur = apmBySeason.get(s); const nxt = apmBySeason.get(nx);
  const rows = players[s].filter((p) => {
    const a = cur.get(p.playerId); const b = nxt.get(p.playerId);
    return a && b && a.poss >= 500 && b.poss >= 500 && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10;
  });
  const nxById = new Map(players[nx].map((p) => [p.playerId, p]));
  const onoff = rows.map((p) => {
    const q = nxById.get(p.playerId);
    return q && Number.isFinite(q.onNet) && Number.isFinite(q.offNet) ? q.onNet - q.offNet : null;
  });
  return rows.length >= 50 ? { rows, y: rows.map((p) => nxt.get(p.playerId).apm), onoff, nx } : null;
};

const names = Object.keys(candidates);
const scores = Object.fromEntries(names.map((n) => [n, []]));
const scoresOnoff = Object.fromEntries(names.map((n) => [n, []]));
const perPair = []; const perPairOnoff = [];

console.log('验证：用第 N 季的数据预测第 N+1 季（SPM 训练与年龄曲线都看不到这一对）');
console.log(`  尺子 赛季对              人数   ${names.map((n, i) => `[${i}]`.padEnd(7)).join(' ')}`);
names.forEach((n, i) => console.log(`    [${i}] ${n}`));
for (const s of seasons) {
  const got = rowsFor(s);
  if (!got) continue;
  const spm = trainSpm(s);
  const m = { spm, aged: { ...spm, ageCurves: fitAgeCurves(agePairsExcept(s)) } };
  const line = { pair: `${s}→${got.nx}`, n: got.rows.length };
  const ok = got.onoff.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  const lineO = { pair: line.pair, n: ok.length };
  for (const n of names) {
    const x = got.rows.map((p) => candidates[n](p, s, m) ?? 0);
    line[n] = corr(x, got.y); scores[n].push(line[n]);
    lineO[n] = corr(ok.map((i) => x[i]), ok.map((i) => got.onoff[i])); scoresOnoff[n].push(lineO[n]);
  }
  perPair.push(line); perPairOnoff.push(lineO);
  console.log(`  APM  ${line.pair}   ${String(line.n).padStart(4)}   ${names.map((n) => line[n].toFixed(4).padEnd(7)).join(' ')}`);
  console.log(`  onoff${lineO.pair}   ${String(lineO.n).padStart(4)}   ${names.map((n) => lineO[n].toFixed(4).padEnd(7)).join(' ')}`);
}
console.log(`  APM  平均                     ${names.map((n) => mean(scores[n]).toFixed(4).padEnd(7)).join(' ')}`);
console.log(`  onoff平均                     ${names.map((n) => mean(scoresOnoff[n]).toFixed(4).padEnd(7)).join(' ')}`);

const impAvg = mean(scores.IMP);
const bestOther = Math.max(...names.filter((n) => n !== 'IMP').map((n) => mean(scores[n])));
console.log(`\nIMP ${impAvg.toFixed(4)}，比第二名高 ${((impAvg - bestOther) * 100).toFixed(2)} 个点`);
const sweeps = perPair.filter((l) => names.every((n) => n === 'IMP' || l.IMP >= l[n])).length;
console.log(`逐对赛季：${sweeps}/${perPair.length} 次 IMP 排第一`);

// ---------------------------------------------------------------- 出模型

const allSamples = buildSamples(seasons.flatMap((s) => players[s]), { apmBySeason });
const raw = { ...fit(allSamples, SPM_LAMBDA), ageCurves: { ...fitAgeCurves(agePairsExcept(null)), seasons: boxSeasons } };

// 量纲校准：把单位钉在"球队净效率"上。
// teamRows 给的是分钟加权**平均**（权重和为 1），球队净效率对应场上**五人之和**，
// 所以回归斜率要再除以 5——第一版忘了除，SGA 被算成 +39.12。
function teamRows(seasonRows, valueOf) {
  const byTeam = new Map();
  for (const p of seasonRows) {
    if (!p.teamId || !(p.min > 0) || !(p.gp > 0)) continue;
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
    byTeam.get(p.teamId).push(p);
  }
  const out = [];
  for (const squad of byTeam.values()) {
    const tot = squad.reduce((s, p) => s + p.min * p.gp, 0);
    if (!tot) continue;
    out.push({
      x: squad.reduce((s, p) => s + ((p.min * p.gp) / tot) * (valueOf(p) ?? 0), 0),
      y: squad.reduce((s, p) => s + ((p.min * p.gp) / tot) * (p.netRtg ?? 0), 0),
    });
  }
  return out;
}
const calRows = seasons.flatMap((s) => teamRows(players[s],
  (p) => blend(apply(raw, p, { aged: true }), decayUpto(s).get(p.playerId)?.apm)));
const mx = mean(calRows.map((r) => r.x));
const my = mean(calRows.map((r) => r.y));
const denom = calRows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
const scale = (denom ? calRows.reduce((s, r) => s + (r.x - mx) * (r.y - my), 0) / denom : 1) / 5;
// v1（10-28 之前的口径）各自校准一次量纲，ingest 据此复原 impactV1 作对照
const slopeOf = (rows) => {
  const ax = mean(rows.map((r) => r.x)); const ay = mean(rows.map((r) => r.y));
  return rows.reduce((t, r) => t + (r.x - ax) * (r.y - ay), 0) / rows.reduce((t, r) => t + (r.x - ax) ** 2, 0) / 5;
};
const scaleV1 = slopeOf(seasons.flatMap((s) => teamRows(players[s],
  (p) => blend(apply(raw, p), decayV1(s).get(p.playerId)?.apm))));
console.log(`\n量纲校准 ×${scale.toFixed(3)}  （IMP 读作：每百回合给球队净效率贡献几分，与 EPM 同单位）`);

const model = {
  ...raw,
  beta: raw.beta.map((b) => b * scale),
  intercept: raw.intercept * scale,
  scale,
  blendW: BLEND_W,
  decaySpan: APM_DECAY_SPAN,
  decayHalfLife: APM_DECAY_HALFLIFE,
  // 10-28 之前的线上口径：ingest 用它另算 p.impactV1 供对照
  v1: { decaySpan: DECAY_SPAN, decayHalfLife: DECAY_HALFLIFE, aged: false, scale: scaleV1 },
  apmLambda: APM_LAMBDA,
  builtAt: new Date().toISOString(),
  seasons,
  validation: {
    criterion: '用第 N 季的数据预测第 N+1 季的真实 APM',
    criterionOnoff: '用第 N 季的数据预测第 N+1 季的裸 on/off',
    shrink: { ...MINUTES_SHRINK, note: 'IMP 按第 N 季出场分钟向人群均值收缩；「IMP（收缩前）」为对照' },
    aging: {
      note: 'SPM 特征先按逐项年龄曲线平移一岁；APM 取 4 季衰减、半衰期 3 季（docs/imp-improve-verdict.md 组合 8c×5b）',
      decaySpan: APM_DECAY_SPAN, decayHalfLife: APM_DECAY_HALFLIFE,
    },
    candidates: names,
    perPair,
    average: Object.fromEntries(names.map((n) => [n, mean(scores[n])])),
    perPairOnoff,
    averageOnoff: Object.fromEntries(names.map((n) => [n, mean(scoresOnoff[n])])),
  },
};

// 最新赛季的榜单（用校准后的模型 + 校准后的 APM）
const last = seasons[seasons.length - 1];
const dec = decayUpto(last);
const muLast = populationMean(players[last].map((p) => apply(model, p, { aged: true })));
const impOf = (p) => {
  const v = impactOf(model, p, dec.get(p.playerId)?.apm ?? null, { aged: true });
  return v === null ? null : shrinkByMinutes(v, (p.gp ?? 0) * (p.min ?? 0), muLast);
};
const board = players[last]
  .filter((p) => (p.gp ?? 0) >= 40 && (p.min ?? 0) >= 20)
  .map((p) => ({ name: p.name, v: impOf(p) }))
  .filter((r) => r.v !== null)
  .sort((a, b) => b.v - a.v);
console.log(`\n${last} IMP（已按分钟收缩）前 15：`);
board.slice(0, 15).forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(24)} ${r.v >= 0 ? '+' : ''}${r.v.toFixed(2)}`));

const vals = board.map((r) => r.v);
model.distribution = {
  mean: mean(vals), sd: sdOf(vals), min: Math.min(...vals), max: Math.max(...vals),
};
writeJson('impact-model.json', model);
console.log('\n已写入 data/impact-model.json');
