/**
 * 校准实验：模型是否「不够自信」？（见 server/calibrationLab.mjs）
 *
 *   node scripts/calibration-experiment.mjs
 *
 * 协议：
 *   · 2021-22 只用于热身 Elo；评估赛季 2022-23 ~ 2025-26
 *   · 留一赛季：其余三季按 log loss（只看胜负结果）选参，在留出季打分，四季合并
 *   · 最终留出：2022-23 ~ 2024-25 训练，2025-26 只打一次分
 *   · 与生产参数在完全相同的比赛上比较，按场配对 bootstrap 95% 区间（2000 次，固定种子）
 *   · 盘口只作事后诊断；模拟投注沿用预注册规则（edge ≥ 3%，平注 1 单位），只报告不调参，
 *     参数只用该季**之前**的赛季选（扩张窗口）
 * 纯离线：只读 data/backtest.json、data/history/books_*.json、data/teams.json、data/schedule.json。
 */
import fs from 'node:fs';
import { computeElo, carryOver, scheduleEloGames, ELO_BASE } from '../server/ratings.mjs';
import { expand, calibration, score, normalCdf, restAdjust } from '../server/lab.mjs';
import { logLoss, phaseOf, bootstrapCI } from '../server/fusionLab.mjs';
import {
  PROD, eloKey, features, predictRow, tune, plattFit, plattApply, favoriteBias, disagreement, splits,
} from '../server/calibrationLab.mjs';
import { gamesFrom, placeBets, summarize, PRIMARY } from '../server/paperBetting.mjs';
import { US_BOOKS } from '../server/books.mjs';

const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const KS = [5, 10, 15, 20, 25, 30];
const KEEPS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9];
const EPPS = [18, 20, 22, 24, 26, 28, 30, 32];
const SDS = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14];
const HCAS = [1.2, 1.6, 2.0, 2.4, 2.8];
const GRID = {
  sd: SDS.map((sd) => ({ ...PROD, sd })),
  joint: KS.flatMap((k) => KEEPS.flatMap((carryKeep) => EPPS.flatMap((eloPerPoint) => SDS.flatMap((sd) => HCAS
    .map((homeAdv) => ({ ...PROD, k, carryKeep, eloPerPoint, sd, homeAdv })))))),
};
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url)));
const dataset = read('backtest.json');

// 特征只取决于 (k, keep)：每组算一次，四季一起
const featAll = {};
for (const k of KS) for (const keep of KEEPS) featAll[eloKey(k, keep)] = features(dataset, SEASONS, { k, carryKeep: keep });
const base = featAll[eloKey(PROD.k, PROD.carryKeep)];
for (const rows of Object.values(featAll)) {
  if (rows.length !== base.length || rows.some((r, i) => r.gameId !== base[i].gameId)) throw new Error('比赛顺序不一致');
}
const setsFor = (seasons) => Object.fromEntries(Object.entries(featAll)
  .map(([key, rows]) => [key, rows.filter((r) => seasons.includes(r.season))]));

/** 一个模型 = 训练季 → 预测函数(特征行索引 → { p, pred }) */
const MODELS = {
  production: () => ({ desc: 'production', at: (i) => predictRow(base[i], PROD) }),
  sd: (train) => {
    const { cfg } = tune(setsFor(train), GRID.sd);
    return { desc: `sd=${cfg.sd}`, cfg, at: (i) => predictRow(base[i], cfg) };
  },
  joint: (train) => {
    const { cfg } = tune(setsFor(train), GRID.joint);
    const rows = featAll[eloKey(cfg.k, cfg.carryKeep)];
    return { desc: cfgStr(cfg), cfg, at: (i) => predictRow(rows[i], cfg) };
  },
  platt: (train) => {
    const fit = plattFit(base.filter((r) => train.includes(r.season)).map((r) => ({ ...r, ...predictRow(r, PROD) })));
    return {
      desc: `a=${fit.a.toFixed(4)} b=${fit.b.toFixed(5)}（≈ 截距 ${(fit.a / fit.b).toFixed(2)} 分、sd ${(1.702 / fit.b).toFixed(2)}）`,
      fit,
      at: (i) => { const o = predictRow(base[i], PROD); return { p: plattApply(fit, o.pred), pred: o.pred }; },
    };
  },
};
const NAMES = { production: '生产参数', sd: '只调 sd（温度）', joint: '联合调参', platt: 'Platt 后校准' };
function cfgStr(c) { return `K=${c.k} keep=${c.carryKeep} Elo/分=${c.eloPerPoint} sd=${c.sd} 主场=${c.homeAdv}`; }

/** 按切分生成逐场样本外预测（与 base 对齐），返回 { recs, picks } */
function oos(mode, model) {
  const recs = []; const picks = [];
  for (const { test, train } of mode === 'holdout' ? [{ test: '2025-26', train: SEASONS.slice(0, 3) }] : splits(SEASONS, mode)) {
    const m = MODELS[model](train);
    picks.push(`${test}: ${m.desc}`);
    base.forEach((r, i) => { if (r.season === test) recs.push({ ...r, ...m.at(i) }); });
  }
  return { recs, picks };
}

const f4 = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(4));
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const sgn = (v, d = 4) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
const ciS = (c, d = 4) => `${sgn(c.mean, d)} [${sgn(c.lo, d)}, ${sgn(c.hi, d)}]`;
const brier = (r) => ((r.homeWin ? 1 : 0) - r.p) ** 2;
const PHASES = ['全部', '<10', '10-19', '>=20'];
const inPhase = (r, ph) => ph === '全部' || phaseOf(r.teamGp) === ph;

function report(title, mode) {
  console.log(`\n## ${title}\n`);
  const res = Object.fromEntries(Object.keys(MODELS).map((m) => [m, oos(mode, m)]));
  const prod = res.production.recs;
  for (const ph of PHASES) {
    const idx = prod.map((r, i) => (inPhase(r, ph) ? i : -1)).filter((i) => i >= 0);
    const mk = idx.filter((i) => prod[i].mktProb != null);
    const mll = mk.reduce((s, i) => s + logLoss({ p: prod[i].mktProb, homeWin: prod[i].homeWin }), 0) / mk.length;
    console.log(`\n### 阶段 ${ph}（n=${idx.length}；诊断：收盘赔率 log loss ${f4(mll)}，${mk.length} 场有盘口）\n`);
    console.log('| 模型 | log loss | Brier | 准确率 | 分差 MAE | Δlog loss [95% CI] | ΔBrier [95% CI] |');
    console.log('|---|---:|---:|---:|---:|---|---|');
    for (const [m, { recs }] of Object.entries(res)) {
      const sc = score(idx.map((i) => recs[i]));
      const dl = m === 'production' ? '—' : ciS(bootstrapCI(idx.map((i) => logLoss(recs[i]) - logLoss(prod[i]))));
      const db = m === 'production' ? '—' : ciS(bootstrapCI(idx.map((i) => brier(recs[i]) - brier(prod[i]))));
      console.log(`| ${NAMES[m]} | ${f4(sc.logloss)} | ${f4(sc.brier)} | ${pct(sc.accuracy, 2)} | ${sc.marginMae.toFixed(2)} | ${dl} | ${db} |`);
    }
  }
  console.log('\n各留出季选中的参数（只按训练季胜负 log loss 选）：');
  for (const m of ['sd', 'joint', 'platt']) console.log(`- ${NAMES[m]}：${res[m].picks.join('；')}`);
  return res;
}

const loso = report('留一赛季交叉验证（2022-23 ~ 2025-26，逐季留出后合并）', 'loso');
report('最终留出：训练 2022-23 ~ 2024-25，只在 2025-26 打分一次', 'holdout');

// ---------------------------------------------------------------- 诊断（留一赛季样本外预测）
console.log('\n## 诊断（留一赛季样本外预测；盘口只作事后对照）\n');
console.log('### 可靠性表（主队胜率按 10% 分档：预测均值 → 实际胜率）\n');
const cal = Object.fromEntries(Object.entries(loso).map(([m, { recs }]) => [m, calibration(recs)]));
console.log(`| 档位 | ${Object.keys(cal).map((m) => `${NAMES[m]} n · 预测 → 实际`).join(' | ')} |`);
console.log(`|---|${Object.keys(cal).map(() => '---').join('|')}|`);
for (let lo = 0; lo < 100; lo += 10) {
  const cells = Object.values(cal).map((bins) => {
    const b = bins.find((x) => x.lo === lo);
    return b ? `${b.n} · ${pct(b.predicted)} → ${pct(b.actual)}` : '—';
  });
  console.log(`| ${lo}–${lo + 10}% | ${cells.join(' | ')} |`);
}

console.log('\n### 热门偏差（模型给热门的平均胜率 − 热门实际胜率；负 = 低估热门）\n');
console.log('| 模型 | 按模型自己的热门：n · 预测 → 实际 · 偏差 | 按市场热门（有盘口）：n · 预测 → 实际 · 偏差 |');
console.log('|---|---|---|');
for (const [m, { recs }] of Object.entries(loso)) {
  const a = favoriteBias(recs, (r) => r.p);
  const b = favoriteBias(recs, (r) => r.mktProb);
  const s = (x) => `${x.n} · ${pct(x.predicted)} → ${pct(x.actual)} · ${sgn(x.bias * 100, 1)} 个百分点`;
  console.log(`| ${NAMES[m]} | ${s(a)} | ${s(b)} |`);
}

console.log('\n### 逐季：与收盘赔率的 log loss 差距、分歧率（|模型 − 市场| ≥ 3%）\n');
console.log('| 赛季 | 有盘口 | 市场 log loss | 模型差距 生产 → 联合 → Platt | 分歧率 生产 → 联合 → Platt |');
console.log('|---|---:|---:|---|---|');
for (const s of [...SEASONS, '合计']) {
  const pick = (m) => loso[m].recs.filter((r) => (s === '合计' || r.season === s) && r.mktProb != null);
  const pr = pick('production');
  const mll = pr.reduce((t, r) => t + logLoss({ p: r.mktProb, homeWin: r.homeWin }), 0) / pr.length;
  const gap = (m) => sgn(pick(m).reduce((t, r) => t + logLoss(r), 0) / pr.length - mll);
  const dis = (m) => pct(disagreement(pick(m), PRIMARY).rate);
  console.log(`| ${s} | ${pr.length} | ${f4(mll)} | ${gap('production')} → ${gap('joint')} → ${gap('platt')} | ${dis('production')} → ${dis('joint')} → ${dis('platt')} |`);
}

// ---------------------------------------------------------------- 模拟投注（只报告，规则不变）
console.log('\n## 模拟投注重跑（预注册规则：edge = 模型 − 该家去水 ≥ 3%，平注 1 单位；参数只用该季之前的赛季选）\n');
const books = Object.fromEntries(SEASONS.map((s) => {
  const f = new URL(`../data/history/books_${s}.json`, import.meta.url);
  return [s, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)).games ?? {} : {}];
}));
const fwd = Object.fromEntries(Object.keys(MODELS).map((m) => [m, oos('forward', m)]));
console.log(`扩张窗口选参：只调 sd ${fwd.sd.picks.join('；')}；联合 ${fwd.joint.picks.join('；')}；Platt ${fwd.platt.picks.join('；')}\n`);
const betSeasons = SEASONS.slice(1);
const betGames = (recs) => betSeasons.flatMap((s) => gamesFrom(recs.filter((r) => r.season === s), books[s]));
const rules = [
  ['DraftKings ≥3%', { book: 'draftkings', threshold: PRIMARY }],
  ['挑最优价 ≥3%', { book: 'best', threshold: PRIMARY, pool: US_BOOKS }],
];
const roiS = (x) => (x.bets ? `${x.bets} 注 ${pct(x.winRate)}/${pct(x.breakEven)} ROI ${sgn(x.roi * 100, 1)}% [${sgn(x.ci.lo * 100, 1)}, ${sgn(x.ci.hi * 100, 1)}]` : '无');
console.log(`| 规则 | 模型 | ${betSeasons.join(' | ')} | 合计 |`);
console.log(`|---|---|${betSeasons.map(() => '---').join('|')}|---|`);
for (const [label, rule] of rules) {
  for (const m of ['production', 'sd', 'joint', 'platt']) {
    const bets = placeBets(betGames(fwd[m].recs), rule);
    const cells = betSeasons.map((s) => roiS(summarize(bets.filter((b) => b.season === s))));
    console.log(`| ${label} | ${NAMES[m]} | ${cells.join(' | ')} | ${roiS(summarize(bets))} |`);
  }
}
console.log('\n（格式：注数 胜率/保本胜率 ROI [95% 区间]。2022-23 没有更早的训练季，不计入；2024-25 无 DK 价。）');

// ---------------------------------------------------------------- 建议参数与当前赛季示意
const final = tune(setsFor(SEASONS), GRID.joint);
const finalSd = tune(setsFor(SEASONS), GRID.sd);
const finalPlatt = plattFit(base.map((r) => ({ ...r, ...predictRow(r, PROD) })));
console.log(`\n## 四季全量选出的参数（供建议用）\n\n- 联合：${cfgStr(final.cfg)}（训练 log loss ${f4(final.logloss)}）`);
console.log(`- 只调 sd：sd=${finalSd.cfg.sd}（${f4(finalSd.logloss)}）\n- Platt：a=${finalPlatt.a.toFixed(4)} b=${finalPlatt.b.toFixed(5)}`);
const prodLL = tune(setsFor(SEASONS), [PROD]).logloss;
console.log(`- 生产参数同口径 log loss ${f4(prodLL)}`);

const teams = read('teams.json');
const sched = read('schedule.json');
const done = scheduleEloGames(sched.games, teams);
const abbr = new Map(teams.map((t) => [t.teamId, t.abbr]));
function current(cfg) {
  const start = carryOver(computeElo(expand(dataset.seasons['2025-26']), { k: cfg.k }).final, { keep: cfg.carryKeep });
  return computeElo(done, { k: cfg.k, initial: start }).final;
}
const eloProd = current(PROD);
const eloNew = current(final.cfg);
const gap = Math.max(...teams.map((t) => Math.abs(eloProd[t.teamId] - t.elo)));
console.log(`\n## 当前赛季示意（不是验证）：已完成常规赛 ${done.length} 场；生产口径重放与 teams.json Elo 最大差 ${gap.toFixed(2)}\n`);
const pts = (elo, cfg, id) => ((elo[id] ?? ELO_BASE) - ELO_BASE) / cfg.eloPerPoint;
const rec = new Map(teams.map((t) => [t.teamId, [0, 0]]));
for (const g of done) { rec.get(g.home.teamId)[g.home.win ? 0 : 1] += 1; rec.get(g.away.teamId)[g.away.win ? 0 : 1] += 1; }
const rankOf = (f) => new Map([...teams].sort((a, b) => f(b.teamId) - f(a.teamId)).map((t, i) => [t.teamId, i + 1]));
const rP = rankOf((id) => pts(eloProd, PROD, id));
const rN = rankOf((id) => pts(eloNew, final.cfg, id));
console.log('| 新名次 | 球队 | 战绩 | 现名次 | 现评分（分/场） | 新评分（分/场） |');
console.log('|---:|---|---|---:|---:|---:|');
for (const t of [...teams].sort((a, b) => rN.get(a.teamId) - rN.get(b.teamId))) {
  if (rN.get(t.teamId) > 10 && !['SAS', 'ATL'].includes(t.abbr)) continue;
  const [w, l] = rec.get(t.teamId);
  console.log(`| ${rN.get(t.teamId)} | ${t.abbr} | ${w}-${l} | ${rP.get(t.teamId)} | ${pts(eloProd, PROD, t.teamId).toFixed(2)} | ${pts(eloNew, final.cfg, t.teamId).toFixed(2)} |`);
}
const moved = teams.filter((t) => rN.get(t.teamId) !== rP.get(t.teamId)).length;
console.log(`\n名次变动的球队：${moved} / 30，最大变动 ${Math.max(...teams.map((t) => Math.abs(rN.get(t.teamId) - rP.get(t.teamId))))} 位`);

// 下一个比赛日的胜率：生产 vs 联合 vs Platt（休息天数按已完成比赛算）
const next = sched.games.filter((g) => g.type === 'regular' && g.homeScore == null).sort((a, b) => a.date.localeCompare(b.date));
const day = next[0]?.date;
const last = new Map();
for (const g of done) { last.set(g.home.teamId, g.date); last.set(g.away.teamId, g.date); }
const restDays = (id) => (last.has(id) ? Math.round((Date.parse(day) - Date.parse(last.get(id))) / 86400000) - 1 : null);
console.log(`\n### ${day} 比赛的主队胜率（示意）\n`);
console.log('| 比赛 | 生产 | 只调 sd | 联合调参 | Platt |');
console.log('|---|---:|---:|---:|---:|');
for (const g of next.filter((x) => x.date === day)) {
  const row = (elo, cfg) => ({
    eloPts: pts(elo, { eloPerPoint: 28 }, g.homeId) - pts(elo, { eloPerPoint: 28 }, g.awayId),
    neutral: !!g.neutral,
    restRaw: restAdjust(restDays(g.homeId)) - restAdjust(restDays(g.awayId)),
  });
  const pp = predictRow(row(eloProd, PROD), PROD);
  const pn = predictRow(row(eloNew, final.cfg), final.cfg);
  console.log(`| ${abbr.get(g.awayId)} @ ${abbr.get(g.homeId)} | ${pct(pp.p)} | ${pct(normalCdf(pp.pred, finalSd.cfg.sd))} | ${pct(pn.p)} | ${pct(plattApply(finalPlatt, pp.pred))} |`);
}
