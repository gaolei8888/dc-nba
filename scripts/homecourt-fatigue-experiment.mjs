/**
 * 主场 × 疲劳实验（见 server/homecourtLab.mjs）。
 *
 *   node scripts/homecourt-fatigue-experiment.mjs
 *
 * 协议：
 *   · 2021-22 只作热身（Elo、球队主场残差历史）；评估赛季 2022-23 ~ 2025-26
 *   · 每个因子单独加在生产模型上；留一赛季（其余三季训练）+ 最终留出（2022-25 训练 → 2025-26 打分一次）
 *   · 组合：在每个外层训练集内部再做留一赛季，内层 log loss 好于生产的因子才入选（嵌套，留出季不参与选择）
 *   · 与生产在完全相同的比赛上比，按场配对 bootstrap 95% 区间（2000 次，固定种子）
 *   · 盘口只作事后诊断；模拟投注沿用预注册规则（edge ≥ 3%，平注），扩张窗口，只报告
 * 纯离线：只读 data/backtest.json、data/history/{stints,books}_*、data/teams.json。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { expand, replay, score, calibration } from '../server/lab.mjs';
import { logLoss, phaseOf, bootstrapCI } from '../server/fusionLab.mjs';
import { favoriteBias, disagreement } from '../server/calibrationLab.mjs';
import { gamesFrom, placeBets, summarize, PRIMARY } from '../server/paperBetting.mjs';
import { US_BOOKS } from '../server/books.mjs';
import { ELO_PER_POINT } from '../server/ratings.mjs';
import {
  eloStartFor, eloBase, buildRows, scheduleContext, gameMinutes, teamHomeAdj, ols, fit, apply,
  FACTORS, FEATURE_NAMES,
} from '../server/homecourtLab.mjs';

const ALL = ['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'];
const EVAL = ALL.slice(1);
const P = { k: 20, carryKeep: 0.75, restWeight: 1.8 };
const KS = [25, 50, 100, 200, 400, 800];
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url)));
const dataset = read('backtest.json');
const teams = read('teams.json');
const abbrMap = new Map(teams.map((t) => [t.teamId, t.abbr]));
const abbrOf = (id) => abbrMap.get(id);

const gamesBy = Object.fromEntries(ALL.map((s) => [s, expand(dataset.seasons[s])]));
const minutes = new Map();
const stintCover = {};
for (const s of ALL) {
  const m = gameMinutes(JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`../data/history/stints_${s}.json.gz`, import.meta.url)))));
  for (const [k, v] of m) minutes.set(k, v);
  stintCover[s] = `${gamesBy[s].filter((g) => m.has(g.gameId)).length}/${gamesBy[s].length}`;
}

// ---- H1 变体：Elo 更新里的主场优势（Elo 分）与预测里的主场（分）
const homeMargin = (s) => {
  const g = gamesBy[s].filter((x) => !x.neutral);
  return g.reduce((t, x) => t + x.home.pts - x.away.pts, 0) / g.length;
};
const measured = (s) => (ALL.indexOf(s) > 0 ? homeMargin(ALL[ALL.indexOf(s) - 1]) : 1.6);
const VARIANTS = {
  prod: () => ({ elo: 100, hca: 1.6 }),
  'elo=1.6分': () => ({ elo: 1.6 * ELO_PER_POINT, hca: 1.6 }),
  'elo=2.0分': () => ({ elo: 2.0 * ELO_PER_POINT, hca: 1.6 }),
  'elo=2.4分': () => ({ elo: 2.4 * ELO_PER_POINT, hca: 1.6 }),
  'elo=上季实测': (s) => ({ elo: measured(s) * ELO_PER_POINT, hca: 1.6 }),
  'elo+预测=上季实测': (s) => ({ elo: measured(s) * ELO_PER_POINT, hca: measured(s) }),
};
const EHAS = Object.keys(VARIANTS);

// ---- 逐场行：所有变体的基础预测 + 因子特征
const rows = [];
for (const s of ALL) {
  const games = gamesBy[s];
  const ctx = scheduleContext(games, { abbrOf, minutes });
  const prior = ALL.indexOf(s) > 0 ? gamesBy[ALL[ALL.indexOf(s) - 1]] : null;
  const byV = Object.fromEntries(EHAS.map((v) => {
    const { elo, hca } = VARIANTS[v](s);
    const start = eloStartFor(prior, { ...P, eloHomeAdv: elo });
    return [v, buildRows(eloBase(games, start, { k: P.k, eloHomeAdv: elo }), ctx, { hca, restWeight: P.restWeight })];
  }));
  games.forEach((g, i) => {
    const { pred, eloPts, ...meta } = byV.prod[i];
    rows.push({
      ...meta, season: s, ctx: ctx[i],
      base: Object.fromEntries(EHAS.map((v) => [v, byV[v][i].pred])),
      x: Object.fromEntries(Object.entries(FACTORS).map(([f, fn]) => [f, fn(ctx[i])])),
      adj: {},
    });
  });
}
const h2Final = {};
for (const v of EHAS) {
  const adj = teamHomeAdj(rows.map((r) => ({ ...r, resid: r.actual - r.base[v] })), KS);
  rows.forEach((r, i) => { r.adj[v] = adj[i]; });
  h2Final[v] = adj.dev;
}
const evalRows = rows.filter((r) => EVAL.includes(r.season));

// 自检：生产基础预测与 lab.replay 逐场一致
const lab = replay(dataset, EVAL);
if (lab.length !== evalRows.length || lab.some((r, i) => r.gameId !== evalRows[i].gameId || Math.abs(r.pred - evalRows[i].base.prod) > 1e-9)) {
  throw new Error('生产基础预测与 lab.replay 不一致');
}

// ---- 模型（训练行, 训练季 → 模型）
const SINGLE = {
  H1: { ehas: EHAS },
  H2: { Ks: [null, ...KS] },
  ...Object.fromEntries(Object.keys(FACTORS).map((f) => [f, { factors: [f] }])),
};
const NAMES = {
  H1: 'H1 Elo 主场一致', H2: 'H2 球队专属主场', H3: 'H3 旅行/时差/高原', F1: 'F1 赛程密度', F2: 'F2 背靠背情境',
  F3: 'F3 上场加时', F4: 'F4 核心负荷', F5: 'F5 客场之旅',
};
const rowsOf = (seasons) => evalRows.filter((r) => seasons.includes(r.season));
const merge = (keys) => ({
  ehas: keys.includes('H1') ? EHAS : ['prod'],
  Ks: keys.includes('H2') ? [null, ...KS] : [null],
  factors: keys.filter((k) => FACTORS[k]),
});
/** 内层留一赛季：哪些因子的样本外 log loss 好于生产 */
function select(trainSeasons) {
  if (trainSeasons.length < 2) return Object.keys(SINGLE);
  const loss = (spec) => trainSeasons.reduce((t, s) => {
    const m = fit(rowsOf(trainSeasons.filter((x) => x !== s)), spec);
    return t + rowsOf([s]).reduce((u, r) => u + logLoss(apply(m, r)), 0);
  }, 0);
  const base = loss({});
  return Object.keys(SINGLE).filter((k) => loss(SINGLE[k]) < base);
}
function desc(m) {
  let i = 0;
  const fs2 = m.factors.map((f) => {
    const b = m.beta.slice(i, i += FEATURE_NAMES[f].length);
    return `${f}[${b.map((v) => v.toFixed(2)).join(',')}]`;
  });
  return [m.eha !== 'prod' ? m.eha : null, m.K != null ? `K=${m.K}` : null, ...fs2].filter(Boolean).join(' ') || '生产';
}

const MODELS = {
  ...Object.fromEntries(Object.entries(SINGLE).map(([k, spec]) => [k, (tr) => fit(rowsOf(tr), spec)])),
  combined: (tr) => { const keys = select(tr); const m = fit(rowsOf(tr), merge(keys)); return { ...m, keys }; },
  allIn: (tr) => fit(rowsOf(tr), merge(Object.keys(SINGLE))),
};
NAMES.production = '生产'; NAMES.combined = '★ 组合（嵌套选择）'; NAMES.allIn = '全部因子（不选择）';

const splitsOf = (mode) => {
  if (mode === 'holdout') return [{ test: '2025-26', train: EVAL.slice(0, 3) }];
  if (mode === 'forward') return EVAL.slice(1).map((s, i) => ({ test: s, train: EVAL.slice(0, i + 1) }));
  return EVAL.map((s) => ({ test: s, train: EVAL.filter((x) => x !== s) }));
};
const cache = {};
function oos(mode, name) {
  const key = `${mode}:${name}`;
  if (!cache[key]) {
    const recs = []; const picks = [];
    for (const { test, train } of splitsOf(mode)) {
      const m = name === 'production' ? { eha: 'prod', K: null, factors: [], beta: [] } : MODELS[name](train);
      picks.push(`${test}: ${m.keys ? `{${m.keys.join(',')}} ` : ''}${desc(m)}`);
      for (const r of rowsOf([test])) recs.push({ ...r, ...apply(m, r) });
    }
    cache[key] = { recs, picks };
  }
  return cache[key];
}

// ---- 输出工具
const f4 = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(4));
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const sgn = (v, d = 4) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
const ciS = (c, d = 4) => `${sgn(c.mean, d)} [${sgn(c.lo, d)}, ${sgn(c.hi, d)}]`;
const brier = (r) => ((r.homeWin ? 1 : 0) - r.p) ** 2;
const hit = (r) => ((r.p >= 0.5) === r.homeWin ? 1 : 0);
const ae = (r) => Math.abs(r.pred - r.actual);
const PHASES = ['<10', '10-19', '>=20'];
const deltaCI = (a, b, f, idx) => bootstrapCI(idx.map((i) => f(a[i]) - f(b[i])));
const allIdx = (recs) => recs.map((_, i) => i);
const phaseIdx = (recs, ph) => allIdx(recs).filter((i) => phaseOf(recs[i].teamGp) === ph);

function factorTable(title, mode, names) {
  console.log(`\n## ${title}\n`);
  const prod = oos(mode, 'production').recs;
  const s0 = score(prod);
  console.log(`生产：n=${s0.n} log loss ${f4(s0.logloss)} Brier ${f4(s0.brier)} 准确率 ${pct(s0.accuracy, 2)} 分差 MAE ${s0.marginMae.toFixed(3)}\n`);
  console.log('| 模型 | Δlog loss [95% CI] | ΔBrier [95% CI] | Δ准确率（百分点）[95% CI] | Δ分差 MAE [95% CI] |');
  console.log('|---|---|---|---|---|');
  for (const n of names) {
    const { recs } = oos(mode, n); const idx = allIdx(recs);
    console.log(`| ${NAMES[n]} | ${ciS(deltaCI(recs, prod, logLoss, idx))} | ${ciS(deltaCI(recs, prod, brier, idx))} | ${ciS(deltaCI(recs, prod, (r) => hit(r) * 100, idx), 2)} | ${ciS(deltaCI(recs, prod, ae, idx), 3)} |`);
  }
  console.log(`\n分阶段 Δlog loss [95% CI]（按两队较少已赛场次；n = ${PHASES.map((ph) => `${ph}: ${phaseIdx(prod, ph).length}`).join('，')}）\n`);
  console.log(`| 模型 | ${PHASES.join(' | ')} |`);
  console.log(`|---|${PHASES.map(() => '---').join('|')}|`);
  for (const n of names) {
    const { recs } = oos(mode, n);
    console.log(`| ${NAMES[n]} | ${PHASES.map((ph) => ciS(deltaCI(recs, prod, logLoss, phaseIdx(prod, ph)))).join(' | ')} |`);
  }
  console.log('\n各留出季训练选出的模型：');
  for (const n of names) console.log(`- ${NAMES[n]}：${oos(mode, n).picks.join('；')}`);
}

console.log('# 主场 × 疲劳实验输出\n');
console.log(`stints 覆盖（有分钟/加时数据的比赛）：${ALL.map((s) => `${s} ${stintCover[s]}`).join('，')}`);
console.log(`各季主场平均净胜分（非中立场）：${ALL.map((s) => `${s} ${homeMargin(s).toFixed(2)}`).join('，')}`);

const ORDER = ['H1', 'H2', 'H3', 'F1', 'F2', 'F3', 'F4', 'F5', 'combined', 'allIn'];
factorTable('留一赛季交叉验证（2022-23 ~ 2025-26 合并，4 折）', 'loso', ORDER);
factorTable('最终留出：训练 2022-23 ~ 2024-25，只在 2025-26 打分一次', 'holdout', ORDER);

// ---- H1 / H2 固定取值（不调参，直接看每个取值的留一样本外效果，便于给出具体参数）
console.log('\n## H1 / H2 各固定取值（四季，样本外 = 这些取值本身不经训练）\n');
const prodAll = evalRows.map((r) => apply({ eha: 'prod', K: null, factors: [], beta: [] }, r));
console.log('| 取值 | Δlog loss [95% CI] | ΔBrier [95% CI] |');
console.log('|---|---|---|');
for (const v of EHAS.slice(1)) {
  const recs = evalRows.map((r) => apply({ eha: v, K: null, factors: [], beta: [] }, r));
  console.log(`| H1 ${v} | ${ciS(deltaCI(recs, prodAll, logLoss, allIdx(recs)))} | ${ciS(deltaCI(recs, prodAll, brier, allIdx(recs)))} |`);
}
for (const K of KS) {
  const recs = evalRows.map((r) => apply({ eha: 'prod', K, factors: [], beta: [] }, r));
  console.log(`| H2 K=${K} | ${ciS(deltaCI(recs, prodAll, logLoss, allIdx(recs)))} | ${ciS(deltaCI(recs, prodAll, brier, allIdx(recs)))} |`);
}
const resid = evalRows.map((r) => r.actual - r.base.prod);
const sigma = Math.sqrt(resid.reduce((t, v) => t + v * v, 0) / resid.length);
console.log(`\n残差标准差 σ=${sigma.toFixed(2)} 分；K 场先验 ⇔ 球队主场偏离的先验标准差 τ = σ/(2√K)：${KS.map((K) => `K=${K}→${(sigma / (2 * Math.sqrt(K))).toFixed(2)}`).join('，')}`);
const dev = h2Final.prod;
const devs = teams.map((t) => ({ abbr: t.abbr, d: dev(t.teamId, 100), raw: dev(t.teamId, 1e-9) })).sort((a, b) => b.d - a.d);
const sd = (xs) => Math.sqrt(xs.reduce((t, v) => t + v * v, 0) / xs.length);
console.log(`2021-26 全部数据末的球队主场偏离（每队单边，分）：原始 sd ${sd(devs.map((x) => x.raw)).toFixed(2)}，K=100 收缩后 sd ${sd(devs.map((x) => x.d)).toFixed(2)}`);
console.log(`最高：${devs.slice(0, 4).map((x) => `${x.abbr} ${sgn(x.d, 2)}（原始 ${sgn(x.raw, 2)}）`).join('，')}；最低：${devs.slice(-3).map((x) => `${x.abbr} ${sgn(x.d, 2)}（原始 ${sgn(x.raw, 2)}）`).join('，')}`);

// ---- 效应量：四季全部比赛，生产残差上最小二乘，按场 bootstrap
console.log('\n## 效应量（四季 4920 场，生产残差上单因子最小二乘，带截距作冗余项（不让因子吸收主场水平）；对「该队」每单位的分数影响，按场 bootstrap 95% 区间）\n');
console.log('| 因子 | 特征 | 系数（分） [95% CI] | 非零场次 |');
console.log('|---|---|---|---:|');
const rand = (() => { let a = 11; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
for (const f of Object.keys(FACTORS)) {
  const X = evalRows.map((r) => [...r.x[f], 1]);
  const beta = ols(X, resid);
  const boots = [];
  for (let b = 0; b < 1000; b += 1) {
    const ix = X.map(() => Math.floor(rand() * X.length));
    boots.push(ols(ix.map((i) => X[i]), ix.map((i) => resid[i])));
  }
  beta.slice(0, -1).forEach((v, j) => {
    const s = boots.map((x) => x[j]).sort((p, q) => p - q);
    console.log(`| ${f} | ${FEATURE_NAMES[f][j]} | ${sgn(v, 2)} [${sgn(s[25], 2)}, ${sgn(s[974], 2)}] | ${X.filter((x) => x[j] !== 0).length} |`);
  });
}

// ---- 诊断（盘口只作事后对照）
console.log('\n## 诊断（留一赛季样本外预测；盘口只作事后对照）\n');
const DIAG = ['production', 'combined', 'allIn'];
console.log('| 模型 | 按模型热门：n · 预测 → 实际 · 偏差 | 按市场热门：偏差 | 与收盘 log loss 差距（有盘口） | 分歧率 ≥3% |');
console.log('|---|---|---|---|---|');
for (const n of DIAG) {
  const { recs } = oos('loso', n);
  const a = favoriteBias(recs, (r) => r.p); const b = favoriteBias(recs, (r) => r.mktProb);
  const pr = recs.filter((r) => r.mktProb != null);
  const gap = pr.reduce((t, r) => t + logLoss(r) - logLoss({ p: r.mktProb, homeWin: r.homeWin }), 0) / pr.length;
  console.log(`| ${NAMES[n]} | ${a.n} · ${pct(a.predicted)} → ${pct(a.actual)} · ${sgn(a.bias * 100, 1)} 个百分点 | ${sgn(b.bias * 100, 1)} 个百分点 | ${sgn(gap)}（${pr.length} 场） | ${pct(disagreement(recs, PRIMARY).rate)} |`);
}
console.log('\n可靠性（组合模型，留一样本外）：', calibration(oos('loso', 'combined').recs).map((b) => `${b.lo}–${b.hi}% ${b.n}·${pct(b.predicted)}→${pct(b.actual)}`).join('；'));
// 疲劳/旅行场景切片上，生产与组合模型的分差偏置（实际 − 预测，客队视角正 = 客队比预测更好）
console.log('\n切片分差偏置（实际 − 预测，主队视角；留一样本外）：\n');
console.log('| 切片 | n | 生产 | 组合 |');
console.log('|---|---:|---:|---:|');
const SL = [
  ['客队背靠背', (r) => r.ctx.away.b2b && !r.ctx.home.b2b],
  ['客队四天三赛', (r) => r.ctx.away.in4 >= 3],
  ['客队旅行 >1500 英里', (r) => r.ctx.away.miles > 1500],
  ['客队跨 ≥2 时区', (r) => r.ctx.away.tz >= 2],
  ['客队进高原', (r) => r.ctx.altitude === 1],
  ['客场之旅第 ≥4 场', (r) => r.ctx.away.tripLen >= 4],
];
const pc = oos('loso', 'production').recs; const cc = oos('loso', 'combined').recs;
for (const [label, f] of SL) {
  const idx = allIdx(pc).filter((i) => f(pc[i]));
  const bias = (recs) => idx.reduce((t, i) => t + recs[i].actual - recs[i].pred, 0) / idx.length;
  console.log(`| ${label} | ${idx.length} | ${sgn(bias(pc), 2)} | ${sgn(bias(cc), 2)} |`);
}

// ---- 模拟投注（只报告）
console.log('\n## 模拟投注重跑（预注册规则：edge = 模型 − 该家去水 ≥ 3%，平注 1 单位；扩张窗口，只用该季之前的赛季训练/选择）\n');
const books = Object.fromEntries(EVAL.map((s) => {
  const f = new URL(`../data/history/books_${s}.json`, import.meta.url);
  return [s, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)).games ?? {} : {}];
}));
const betSeasons = EVAL.slice(1);
console.log(`扩张窗口选出的组合：${oos('forward', 'combined').picks.join('；')}\n`);
const roiS = (x) => (x.bets ? `${x.bets} 注 ${pct(x.winRate)}/${pct(x.breakEven)} ROI ${sgn(x.roi * 100, 1)}% [${sgn(x.ci.lo * 100, 1)}, ${sgn(x.ci.hi * 100, 1)}]` : '无');
console.log(`| 规则 | 模型 | ${betSeasons.join(' | ')} | 合计 |`);
console.log(`|---|---|${betSeasons.map(() => '---').join('|')}|---|`);
for (const [label, rule] of [['DraftKings ≥3%', { book: 'draftkings', threshold: PRIMARY }], ['挑最优价 ≥3%', { book: 'best', threshold: PRIMARY, pool: US_BOOKS }]]) {
  for (const n of ['production', 'combined']) {
    const { recs } = oos('forward', n);
    const bets = placeBets(betSeasons.flatMap((s) => gamesFrom(recs.filter((r) => r.season === s), books[s])), rule);
    console.log(`| ${label} | ${NAMES[n]} | ${betSeasons.map((s) => roiS(summarize(bets.filter((b) => b.season === s)))).join(' | ')} | ${roiS(summarize(bets))} |`);
  }
}
console.log('\n（格式：注数 胜率/保本胜率 ROI [95% 区间]。2023-24 只有 2022-23 一季可训练，内层无法留一，组合退化为全部因子。）');

// ---- 建议参数：四季全量
const finalCombined = MODELS.combined(EVAL);
console.log(`\n## 四季全量训练（供建议参数用）\n\n- 组合：{${finalCombined.keys.join(',')}} ${desc(finalCombined)}`);
for (const k of Object.keys(SINGLE)) console.log(`- ${NAMES[k]}：${desc(fit(evalRows, SINGLE[k]))}`);
