/**
 * 融合实验回测：滚动 Elo × 本季对手调整净胜分（见 server/fusionLab.mjs）。
 *
 *   node scripts/fusion-backtest.mjs
 *
 * 协议：
 *   · 2021-22 只用于给 2022-23 热身 Elo；评估赛季 2022-23 ~ 2025-26
 *   · 留一赛季交叉验证：其余三季上按 log loss 选超参，在留出季打分
 *   · 最终留出：2022-23 ~ 2024-25 训练，2025-26 只打一次分
 *   · 与生产参数纯 Elo（spreadSd 12）在完全相同的比赛上比较，按场配对 bootstrap 给 95% 区间
 *   · 最后把训练选出的配置套到当前赛季快照上——只是示意，不是验证
 * 只读数据，不改线上参数。
 */
import fs from 'node:fs';
import {
  seasonRows, replaySeason, predict, strength, tune, score, logLoss, phaseOf, bootstrapCI,
} from '../server/fusionLab.mjs';

const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const BASE = { mode: 'elo', sd: 12 };

const SDS = [11, 11.5, 12, 12.5, 13];
const CAPS = [Infinity, 20];
const L0 = [0.5, 2, 5, 10];
const LP = [2, 4, 6, 9, 13, 18, 25, 35, 50];
const N0 = [3, 5, 8, 12, 18, 25, 35, 50, 75, 110];
const SPECS = [
  ...L0.flatMap((lambda) => CAPS.map((cap) => ({ toPrior: false, lambda, cap }))),
  ...LP.flatMap((lambda) => CAPS.map((cap) => ({ toPrior: true, lambda, cap }))),
];
const GRID = {
  elo: SDS.map((sd) => ({ mode: 'elo', sd })),
  blendElo: SDS.flatMap((sd) => CAPS.flatMap((cap) => L0.flatMap((lambda) => N0.map((n0) => ({ mode: 'blendElo', sd, cap, lambda, n0 }))))),
  blendPrior: SDS.flatMap((sd) => CAPS.flatMap((cap) => L0.flatMap((lambda) => N0.map((n0) => ({ mode: 'blendPrior', sd, cap, lambda, n0 }))))),
  bayes: SDS.flatMap((sd) => CAPS.flatMap((cap) => LP.map((lambda) => ({ mode: 'bayes', sd, cap, lambda })))),
};
const ALL = Object.values(GRID).flat();

const dataset = JSON.parse(fs.readFileSync(new URL('../data/backtest.json', import.meta.url)));
// backtest.json 在 2024-25、2025-26 各有几行「同一队对自己」的坏数据（中立场、平局、无盘口），不计分
const rowsBy = Object.fromEntries(SEASONS.map((s) => [s, seasonRows(dataset, s, P, SPECS).filter((r) => r.homeId !== r.awayId)]));
const train = (held) => SEASONS.filter((s) => !held.includes(s)).flatMap((s) => rowsBy[s]);

const fmt = (v, d = 4) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const cfgStr = (c) => (c.mode === 'elo' ? `elo sd=${c.sd}` : `${c.mode} λ=${c.lambda}${c.n0 ? ` n0=${c.n0}` : ''} cap=${c.cap} sd=${c.sd}`);
const PHASES = ['all', '<10', '10-19', '>=20'];
const inPhase = (r, ph) => ph === 'all' || phaseOf(r.teamGp) === ph;

/** 每个模型：每个留出季用训练季选的配置打分，拼成一份逐场预测 */
function heldOut(heldSeasons, pick) {
  const out = []; const picks = [];
  for (const s of heldSeasons) {
    const cfg = pick(train([s]));
    picks.push(`${s}: ${cfgStr(cfg)}`);
    for (const r of rowsBy[s]) out.push({ row: r, ...predict(r, cfg) });
  }
  return { out, picks };
}

function report(title, heldSeasons) {
  console.log(`\n## ${title}\n`);
  const models = {
    '基线 Elo（生产 sd=12）': () => BASE,
    'Elo（调 sd）': (tr) => tune(tr, GRID.elo).cfg,
    blendElo: (tr) => tune(tr, GRID.blendElo).cfg,
    blendPrior: (tr) => tune(tr, GRID.blendPrior).cfg,
    bayes: (tr) => tune(tr, GRID.bayes).cfg,
    '★ 选定（全部候选中按训练 log loss 选）': (tr) => tune(tr, ALL).cfg,
  };
  const res = Object.fromEntries(Object.entries(models).map(([k, f]) => [k, heldOut(heldSeasons, f)]));
  const base = res['基线 Elo（生产 sd=12）'].out;
  const eloT = res['Elo（调 sd）'].out; // 同样调过 sd 的纯 Elo：隔离「融合本身」的贡献

  for (const ph of PHASES) {
    const idx = base.map((x, i) => (inPhase(x.row, ph) ? i : -1)).filter((i) => i >= 0);
    console.log(`\n### 阶段 ${ph}（n=${idx.length}，按两队较少已赛场次）\n`);
    console.log('| 模型 | log loss | Brier | 准确率 | 分差 MAE | Δlog loss vs 基线 [95% CI] | Δ vs 调 sd 的 Elo [95% CI] |');
    console.log('|---|---:|---:|---:|---:|---|---|');
    for (const [name, { out }] of Object.entries(res)) {
      const sc = score(idx.map((i) => out[i]));
      const ci = bootstrapCI(idx.map((i) => logLoss(out[i]) - logLoss(base[i])));
      const ci2 = bootstrapCI(idx.map((i) => logLoss(out[i]) - logLoss(eloT[i])));
      const ciStr = (c, skip) => (skip ? '—' : `${fmt(c.mean)} [${fmt(c.lo)}, ${fmt(c.hi)}]`);
      console.log(`| ${name} | ${fmt(sc.logloss)} | ${fmt(sc.brier)} | ${fmt(sc.accuracy * 100, 2)}% | ${fmt(sc.marginMae, 2)} | ${ciStr(ci, name.startsWith('基线'))} | ${ciStr(ci2, !['blendElo', 'blendPrior', 'bayes'].includes(name) && !name.startsWith('★'))} |`);
    }
    const mk = idx.filter((i) => base[i].row.mktProb !== null);
    const mll = mk.reduce((s, i) => s + logLoss({ p: base[i].row.mktProb, homeWin: base[i].homeWin }), 0) / mk.length;
    const bll = mk.reduce((s, i) => s + logLoss(base[i]), 0) / mk.length;
    console.log(`| 参考：收盘赔率（${mk.length} 场有盘口） | ${fmt(mll)} | | | | 同场基线 ${fmt(bll)} | |`);
  }
  console.log('\n各留出季选中的配置：');
  for (const [name, { picks }] of Object.entries(res)) if (!name.startsWith('基线')) console.log(`- ${name}: ${picks.join('；')}`);
}

report('留一赛季交叉验证（2022-23 ~ 2025-26，逐季留出后合并）', SEASONS);
report('最终留出：训练 2022-23~2024-25，只在 2025-26 打分', ['2025-26']);

// ---- 当前赛季示意（不是验证）
const final = tune(train(['2025-26']), ALL);
console.log(`\n## 当前赛季示意（配置由 2022-25 训练选出：${cfgStr(final.cfg)}；训练 log loss ${fmt(final.logloss)}）\n`);
const teams = JSON.parse(fs.readFileSync(new URL('../data/teams.json', import.meta.url)));
const sched = JSON.parse(fs.readFileSync(new URL('../data/schedule.json', import.meta.url)));
const done = sched.games
  .filter((g) => g.type !== 'preseason' && g.homeScore != null && g.awayScore != null)
  .map((g) => ({
    gameId: g.gameId, date: g.date, neutral: !!g.neutral, odds: null,
    home: { teamId: g.homeId, pts: g.homeScore, win: g.homeScore > g.awayScore },
    away: { teamId: g.awayId, pts: g.awayScore, win: g.awayScore > g.homeScore },
  }))
  .sort((x, y) => (x.date === y.date ? x.gameId.localeCompare(y.gameId) : x.date.localeCompare(y.date)));
const eloStart = Object.fromEntries(teams.map((t) => [t.teamId, t.eloPreseasonExact ?? t.eloPreseason]));
const cfgSpec = final.cfg.mode === 'elo' ? [] : [{ toPrior: final.cfg.mode === 'bayes', lambda: final.cfg.lambda, cap: final.cfg.cap }];
const snap = replaySeason(done, eloStart, P, [...cfgSpec, { toPrior: false, lambda: 2, cap: Infinity }]).final;
const maxEloGap = Math.max(...teams.map((t) => Math.abs((snap.get(t.teamId).elo * 28 + 1500) - t.elo)));
console.log(`已完成 ${done.length} 场；重放 Elo 与 teams.json 最大差 ${maxEloGap.toFixed(2)}（舍入误差内即一致）\n`);
const rec = new Map(teams.map((t) => [t.teamId, [0, 0]]));
for (const g of done) { rec.get(g.home.teamId)[g.home.win ? 0 : 1] += 1; rec.get(g.away.teamId)[g.away.win ? 0 : 1] += 1; }
const rows = teams.map((t) => ({ t, s: snap.get(t.teamId), base: strength(snap.get(t.teamId), BASE), fused: strength(snap.get(t.teamId), final.cfg) }));
const rankBy = (k) => new Map([...rows].sort((a, b) => b[k] - a[k]).map((r, i) => [r.t.abbr, i + 1]));
const rb = rankBy('base'); const rf = rankBy('fused');
console.log('| 新名次 | 球队 | 战绩 | 已赛 | 现 Elo 名次 | 现 Elo 分 | 融合分 | 季前先验 | 本季岭回归(λ=2) |');
console.log('|---:|---|---|---:|---:|---:|---:|---:|---:|');
const show = [...rows].sort((a, b) => b.fused - a.fused)
  .filter((r) => rf.get(r.t.abbr) <= 10 || ['SAS', 'OKC', 'ATL'].includes(r.t.abbr));
for (const r of show) {
  const [w, l] = rec.get(r.t.teamId);
  console.log(`| ${rf.get(r.t.abbr)} | ${r.t.abbr} | ${w}-${l} | ${r.s.n} | ${rb.get(r.t.abbr)} | ${fmt(r.base, 2)} | ${fmt(r.fused, 2)} | ${fmt(r.s.prior, 2)} | ${fmt(r.s.ridge['0:2:Infinity'], 2)} |`);
}
