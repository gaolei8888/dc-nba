/**
 * 实验 2 回测：延续度加权的 Elo × 阵容估计（见 server/continuityLab.mjs）。
 *
 *   node scripts/continuity-backtest.mjs
 *
 * 只读 data/backtest.json 与 data/history/（impact_ / lineups_ / stints_），不抓数据。
 * 协议与 scripts/fusion-backtest.mjs 相同：
 *   · 2021-22 只用于热身 Elo 与提供 2022-23 的「上季」球员价值；评估 2022-23 ~ 2025-26
 *   · 留一赛季：其余三季上按 log loss 选超参，在留出季打分
 *   · 最终留出：2022-23 ~ 2024-25 训练，只在 2025-26 打分
 *   · 与生产 Elo（sd=12）在相同比赛上比较，按场配对 bootstrap 95% 区间
 * 盘口只作为参考列显示，不参与任何拟合或选择。
 *
 * 防泄漏：第 N 季的比赛只用第 N−1 季的球员价值。SPM 只在 ≤N−1 季上训练，APM 只用 ≤N−1 季的组合，
 * 量纲校准也只用 ≤N−1 季。名单、分钟、延续度都只看当场之前（第一场的近似见 continuityLab 注释）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import {
  buildSamples, fit, apply, blend, mean, BLEND_W, DECAY_SPAN, DECAY_HALFLIFE,
} from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import {
  replaySeason, eloStartFor, teamGamesFromStints, leagueCenter, predict, tune, logLoss,
} from '../server/continuityLab.mjs';
import { expand, score } from '../server/lab.mjs';
import { bootstrapCI } from '../server/fusionLab.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const ALL_SEASONS = ['2021-22', ...SEASONS];
const BASE = { mode: 'elo', sd: 12 };
// 延续度窗口（场）。默认 82 = 约一个赛季；CONT_WINDOW=41 做敏感性检查
const WINDOW = Number(process.env.CONT_WINDOW) || 82;
const prevOf = (s) => ALL_SEASONS[ALL_SEASONS.indexOf(s) - 1];

const dataset = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backtest.json'), 'utf8'));
const players = {}; const lineups = {}; const stints = {};
for (const s of ALL_SEASONS) {
  const imp = path.join(HISTORY, `impact_${s}.json`);
  const lu = path.join(HISTORY, `lineups_${s}.json`);
  if (!fs.existsSync(imp) || !fs.existsSync(lu)) {
    console.error(`缺 ${imp} 或 ${lu}（从 GB10 的 ~/dc-nba-refresh/data/history 拷，别冷抓）`);
    process.exit(1);
  }
  players[s] = JSON.parse(fs.readFileSync(imp, 'utf8')).players.map((p) => ({ ...p, season: s }));
  lineups[s] = JSON.parse(fs.readFileSync(lu, 'utf8')).rows;
  stints[s] = readJsonAuto(path.join(HISTORY, `stints_${s}.json.gz`));
  if (!stints[s]) { console.error(`缺 stints_${s}`); process.exit(1); }
}
const apmBySeason = new Map(ALL_SEASONS.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })]));

/**
 * 截至 upto 季（含）的球员价值，只用 ≤upto 季的数据。
 * 返回 { imp, shrunk }：两个 Map(playerId → 每百回合价值)，以及总分钟 Map。
 */
function valuesUpto(upto) {
  const seen = ALL_SEASONS.slice(0, ALL_SEASONS.indexOf(upto) + 1);
  const spm = fit(buildSamples(seen.flatMap((s) => players[s]), { apmBySeason }), 3000);
  const dec = decayedApm(seen.slice(-DECAY_SPAN).map((s) => ({ season: s, rows: lineups[s] })),
    { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
  const rawOf = (p, s) => blend(apply(spm, p), (s === upto ? dec : null)?.get(p.playerId)?.apm ?? null);
  // 量纲校准（同 fit-impact）：球队分钟加权 IMP 对球队净效率的斜率 / 5，只用 ≤upto 季
  const cal = [];
  for (const s of seen) {
    const decS = decayedApm(ALL_SEASONS.slice(Math.max(0, ALL_SEASONS.indexOf(s) - DECAY_SPAN + 1), ALL_SEASONS.indexOf(s) + 1)
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
  const pool = players[upto].map((p) => apply(spm, p)).filter((v) => v !== null);
  const mu = mean(pool);
  for (const p of players[upto]) {
    const m = (p.gp ?? 0) * (p.min ?? 0);
    minutes.set(p.playerId, m);
    if ((p.gp ?? 0) >= 10 && p.min > 0) priorMpg.set(p.playerId, p.min);
    const raw = rawOf(p, upto);
    if (raw === null) continue;
    imp.set(p.playerId, raw * scale);
    shrunk.set(p.playerId, shrinkByMinutes(raw, m, mu, MINUTES_SHRINK) * scale);
  }
  return { values: new Map([['imp', imp], ['shrunk', shrunk]]), minutes, priorMpg, scale };
}

const t0 = Date.now();
const rowsBy = {}; const coverage = [];
for (const s of SEASONS) {
  const prev = prevOf(s);
  const v = valuesUpto(prev);
  const center = new Map([...v.values].map(([k, m]) => [k, leagueCenter(v.minutes, m)]));
  const { rows } = replaySeason(expand(dataset.seasons[s]), eloStartFor(dataset, s, P), P, {
    stints: new Map(Object.entries(stints[s].games)),
    prevGames: teamGamesFromStints(stints[prev]),
    priorMpg: v.priorMpg, values: v.values, center, window: WINDOW,
  });
  rowsBy[s] = rows.map((r) => ({ ...r, season: s }));
  const withRoster = rows.filter((r) => r.home.roster.imp !== null && r.away.roster.imp !== null).length;
  coverage.push(`${s}: ${rows.length} 场，两队都有阵容分 ${withRoster}（${(100 * withRoster / rows.length).toFixed(1)}%），量纲 ×${v.scale.toFixed(3)}`);
}
console.log(`\n# 延续度加权 Elo × 阵容 回测（延续度窗口 ${WINDOW} 场；特征构建 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）\n`);
coverage.forEach((c) => console.log(`- ${c}`));

// 延续度分布（开季第一场）——看换血是否真的被量到了
{
  const first = SEASONS.flatMap((s) => rowsBy[s].flatMap((r) => [r.home, r.away].filter((t) => t.n === 0)));
  const cs = first.map((t) => t.c).filter((c) => c !== null).sort((a, b) => a - b);
  console.log(`- 各队本季第一场的延续度：最低 ${cs[0].toFixed(2)}，中位 ${cs[Math.floor(cs.length / 2)].toFixed(2)}，最高 ${cs.at(-1).toFixed(2)}（${cs.length} 队季）`);
}

// ---------------------------------------------------------------- 网格
const SDS = [11, 11.5, 12, 12.5, 13];
const AS = [0.5, 0.75, 1, 1.25, 1.5];
const VALUES = ['imp', 'shrunk'];
const fam = (value) => [
  { mode: 'roster' },
  ...[0.25, 0.5, 0.75].map((w) => ({ mode: 'const', w })),
  ...[0.5, 1, 2, 4].map((gamma) => ({ mode: 'pow', gamma })),
  ...[0.5, 1, 1.5, 2, 3].map((beta) => ({ mode: 'lin', beta })),
].flatMap((m) => AS.flatMap((a) => SDS.map((sd) => ({ ...m, a, sd, value }))));
const GRID = {
  elo: SDS.map((sd) => ({ mode: 'elo', sd })),
  roster: VALUES.flatMap((v) => fam(v).filter((c) => c.mode === 'roster')),
  const: VALUES.flatMap((v) => fam(v).filter((c) => c.mode === 'const')),
  'pow（w=c^γ）': VALUES.flatMap((v) => fam(v).filter((c) => c.mode === 'pow')),
  'lin（w=1−β(1−c)）': VALUES.flatMap((v) => fam(v).filter((c) => c.mode === 'lin')),
  '延续度·仅 IMP 原值': fam('imp').filter((c) => ['pow', 'lin'].includes(c.mode)),
  '延续度·仅收缩 IMP': fam('shrunk').filter((c) => ['pow', 'lin'].includes(c.mode)),
};
const ALL = [...GRID.elo, ...VALUES.flatMap(fam)];
const train = (held) => SEASONS.filter((s) => !held.includes(s)).flatMap((s) => rowsBy[s]);

const fmt = (v, d = 4) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const cfgStr = (c) => {
  if (c.mode === 'elo') return `elo sd=${c.sd}`;
  const w = c.mode === 'const' ? `w=${c.w}` : c.mode === 'pow' ? `γ=${c.gamma}` : c.mode === 'lin' ? `β=${c.beta}` : '';
  return `${c.mode} ${w} a=${c.a} ${c.value} sd=${c.sd}`.replace(/\s+/g, ' ');
};
const minC = (r) => Math.min(r.home.c ?? 1, r.away.c ?? 1);
const PHASES = [
  ['全部', () => true],
  ['已赛 <10', (r) => r.teamGp < 10],
  ['已赛 10–19', (r) => r.teamGp >= 10 && r.teamGp < 20],
  ['已赛 ≥20', (r) => r.teamGp >= 20],
  ['较低延续度一方 c<0.6', (r) => minC(r) < 0.6],
  ['较低延续度一方 c≥0.6', (r) => minC(r) >= 0.6],
];

function heldOut(heldSeasons, pick) {
  const out = []; const picks = [];
  for (const s of heldSeasons) {
    const cfg = pick(train([s]));
    picks.push(`${s}: ${cfgStr(cfg)}`);
    for (const r of rowsBy[s]) out.push({ row: r, ...predict(r, cfg) });
  }
  return { out, picks };
}

const verdicts = {};
function report(title, heldSeasons, key) {
  console.log(`\n## ${title}\n`);
  const models = {
    '基线 Elo（生产 sd=12）': () => BASE,
    'Elo（调 sd）': (tr) => tune(tr, GRID.elo).cfg,
    ...Object.fromEntries(Object.entries(GRID).filter(([k]) => k !== 'elo').map(([k, g]) => [k, (tr) => tune(tr, g).cfg])),
    '★ 选定（全部候选中按训练 log loss 选）': (tr) => tune(tr, ALL).cfg,
  };
  const res = Object.fromEntries(Object.entries(models).map(([k, f]) => [k, heldOut(heldSeasons, f)]));
  const base = res['基线 Elo（生产 sd=12）'].out;
  const eloT = res['Elo（调 sd）'].out;
  for (const [ph, inPh] of PHASES) {
    const idx = base.map((x, i) => (inPh(x.row) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    console.log(`\n### ${ph}（n=${idx.length}）\n`);
    console.log('| 模型 | log loss | Brier | 准确率 | Δlog loss vs 基线 [95% CI] | ΔBrier vs 基线 [95% CI] | Δlog loss vs 调 sd 的 Elo [95% CI] |');
    console.log('|---|---:|---:|---:|---|---|---|');
    for (const [name, { out }] of Object.entries(res)) {
      const sc = score(idx.map((i) => out[i]));
      const isBase = name.startsWith('基线');
      const ci = bootstrapCI(idx.map((i) => logLoss(out[i]) - logLoss(base[i])));
      const brier = (x) => (x.p - (x.homeWin ? 1 : 0)) ** 2;
      const cb = bootstrapCI(idx.map((i) => brier(out[i]) - brier(base[i])));
      const c2 = bootstrapCI(idx.map((i) => logLoss(out[i]) - logLoss(eloT[i])));
      const s = (c, skip) => (skip ? '—' : `${fmt(c.mean)} [${fmt(c.lo)}, ${fmt(c.hi)}]`);
      console.log(`| ${name} | ${fmt(sc.logloss)} | ${fmt(sc.brier)} | ${fmt(sc.accuracy * 100, 2)}% | ${s(ci, isBase)} | ${s(cb, isBase)} | ${s(c2, isBase || name.startsWith('Elo'))} |`);
      if (ph === '全部' && name.startsWith('★')) verdicts[key] = ci;
    }
    const mk = idx.filter((i) => base[i].row.mktProb !== null);
    const mll = mk.reduce((a, i) => a + logLoss({ p: base[i].row.mktProb, homeWin: base[i].homeWin }), 0) / mk.length;
    console.log(`| 参考：收盘赔率（${mk.length} 场有盘口，只作参照） | ${fmt(mll)} | | | | | |`);
  }
  console.log('\n各留出季选中的配置：');
  for (const [name, { picks }] of Object.entries(res)) if (!name.startsWith('基线')) console.log(`- ${name}: ${picks.join('；')}`);

  // 逐季（只在留一赛季里有意义）
  if (heldSeasons.length > 1) {
    console.log('\n逐季 ★ 选定 vs 基线：\n');
    console.log('| 留出季 | 场数 | 基线 log loss | 选定 log loss | Δ [95% CI] |');
    console.log('|---|---:|---:|---:|---|');
    const sel = res['★ 选定（全部候选中按训练 log loss 选）'].out;
    for (const s of heldSeasons) {
      const idx = base.map((x, i) => (x.row.season === s ? i : -1)).filter((i) => i >= 0);
      const ci = bootstrapCI(idx.map((i) => logLoss(sel[i]) - logLoss(base[i])));
      console.log(`| ${s} | ${idx.length} | ${fmt(score(idx.map((i) => base[i])).logloss)} | ${fmt(score(idx.map((i) => sel[i])).logloss)} | ${fmt(ci.mean)} [${fmt(ci.lo)}, ${fmt(ci.hi)}] |`);
    }
  }
}

report('留一赛季交叉验证（2022-23 ~ 2025-26，逐季留出后合并）', SEASONS, 'loso');
report('最终留出：训练 2022-23~2024-25，只在 2025-26 打分', ['2025-26'], 'holdout');

const L = verdicts.loso; const H = verdicts.holdout;
const adopt = L.hi < 0 && H.mean < 0;
console.log(`\n## 预注册规则\n\n留一赛季 ★ 全部比赛 Δlog loss ${fmt(L.mean)} [${fmt(L.lo)}, ${fmt(L.hi)}]；最终留出 ${fmt(H.mean)} [${fmt(H.lo)}, ${fmt(H.hi)}]。`);
console.log(`规则「留一赛季区间不含 0（整体在 0 以下）且留出季同号」：${adopt ? '通过 → 采纳' : '不通过 → 不采纳'}`);

// ---- 实验 1 的比赛层面旁证（不是预注册判据）：只换球员价值，其余同一套模型
// 纯阵容模型最直接受球员价值影响；开季 <10 场时 Elo 还没吸收本季结果，最能看出差别。
console.log('\n## 旁证：球员价值用 IMP 原值 vs 收缩 IMP（留一赛季，同一模型族内各自调 a、sd）\n');
console.log('| 模型族 | 阶段 | 场数 | IMP 原值 log loss | 收缩 IMP log loss | Δ（收缩 − 原值）[95% CI] |');
console.log('|---|---|---:|---:|---:|---|');
for (const [famName, modes] of [['纯阵容', ['roster']], ['延续度混合（pow+lin）', ['pow', 'lin']]]) {
  const run = (value) => heldOut(SEASONS, (tr) => tune(tr, fam(value).filter((c) => modes.includes(c.mode))).cfg).out;
  const a = run('imp'); const b = run('shrunk');
  for (const [ph, inPh] of PHASES.slice(0, 2)) {
    const idx = a.map((x, i) => (inPh(x.row) ? i : -1)).filter((i) => i >= 0);
    const ci = bootstrapCI(idx.map((i) => logLoss(b[i]) - logLoss(a[i])));
    console.log(`| ${famName} | ${ph} | ${idx.length} | ${fmt(score(idx.map((i) => a[i])).logloss)} | ${fmt(score(idx.map((i) => b[i])).logloss)} | ${fmt(ci.mean)} [${fmt(ci.lo)}, ${fmt(ci.hi)}] |`);
  }
}

// 供 docs / 当前榜示意使用
const final = tune(train(['2025-26']), ALL);
console.log(`\n2022-25 训练选出的配置：${cfgStr(final.cfg)}（训练 log loss ${fmt(final.logloss)}）`);
const allTrain = tune(train([]), ALL);
console.log(`四季全部训练选出的配置（仅供当前榜示意）：${cfgStr(allTrain.cfg)}（训练 log loss ${fmt(allTrain.logloss)}）`);
if (process.env.CONT_OUT) fs.writeFileSync(process.env.CONT_OUT, JSON.stringify({ final: final.cfg, all: allTrain.cfg }));
