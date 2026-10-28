/**
 * 阵容先验 + 本季战绩修正 回测（server/rosterResults.mjs）。
 *
 *   node scripts/roster-results-backtest.mjs     （npm run roster:results）
 *
 * 只读 data/backtest.json 与 data/history/（impact_ / lineups_ / stints_），不抓数据。
 * 逐场特征（上季球员价值、此前出场名单与分钟、联盟均值）沿用 continuity-backtest 的同一套防泄漏构建，
 * 球员价值默认用收缩 IMP（与线上 ingest 一致；RR_VALUE=imp 换成收缩前做敏感性）。
 *
 * 模型：每个比赛日开赛前，用更早日期的本季全部完赛结果，对每队求
 *   r = (K·阵容先验 + n·对手调整净胜分)/(K + n)（对手强度取同一张后验榜，迭代求解，见 rosterResults.mjs）
 * 胜率 = Φ((r主 − r客 + 主场 1.6（中立场 0） + 休息项)/12)，与 lab / 生产同口径。
 * 阵容先验 = 每百回合阵容分 − 联盟均值，系数 1（线上再乘 pace/100，≈1）。
 *
 * 协议（预注册，与 continuity / fusion 回测相同）：
 *   · 2021-22 只做热身；评估 2022-23 ~ 2025-26
 *   · 留一赛季：在其余三季上按 log loss 只选 K，在留出季打分；最终留出：2022-25 选 K，只在 2025-26 打分
 *   · 对照 (a) 现阵容榜（K=∞，只用先验）(b) 生产 Elo（sd=12），按场配对 bootstrap 95% 区间
 *   · 采纳规则：留一赛季 vs 现阵容榜 Δlog loss 区间上界 ≤ +0.002，且最终留出不显著变差（区间下界 ≤ 0）
 * 盘口只作参照列显示，不参与任何拟合或选择。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import { buildSamples, fit, apply, blend, mean, DECAY_SPAN, DECAY_HALFLIFE } from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { replaySeason, eloStartFor, teamGamesFromStints, leagueCenter, logLoss } from '../server/continuityLab.mjs';
import { expand, score, normalCdf } from '../server/lab.mjs';
import { bootstrapCI } from '../server/fusionLab.mjs';
import { resultsUpdate, gamePred } from '../server/rosterResults.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const ALL_SEASONS = ['2021-22', ...SEASONS];
const prevOf = (s) => ALL_SEASONS[ALL_SEASONS.indexOf(s) - 1];
const SD = 12;
const VALUE = process.env.RR_VALUE || 'shrunk';
const KS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 60, 100];

// ---------------------------------------------------------------- 特征（与 continuity-backtest 相同）
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

/** 截至 upto 季（含）的球员价值，只用 ≤upto 季的数据（与 continuity-backtest 逐行相同） */
function valuesUpto(upto) {
  const seen = ALL_SEASONS.slice(0, ALL_SEASONS.indexOf(upto) + 1);
  const spm = fit(buildSamples(seen.flatMap((s) => players[s]), { apmBySeason }), 3000);
  const dec = decayedApm(seen.slice(-DECAY_SPAN).map((s) => ({ season: s, rows: lineups[s] })),
    { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
  const rawOf = (p, s) => blend(apply(spm, p), (s === upto ? dec : null)?.get(p.playerId)?.apm ?? null);
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
const rowsBy = {};
for (const s of SEASONS) {
  const prev = prevOf(s);
  const v = valuesUpto(prev);
  const center = new Map([...v.values].map(([k, m]) => [k, leagueCenter(v.minutes, m)]));
  const { rows } = replaySeason(expand(dataset.seasons[s]), eloStartFor(dataset, s, P), P, {
    stints: new Map(Object.entries(stints[s].games)),
    prevGames: teamGamesFromStints(stints[prev]),
    priorMpg: v.priorMpg, values: v.values, center, window: 82,
  });
  rowsBy[s] = rows.map((r) => ({ ...r, season: s }));
}
const tFeat = (Date.now() - t0) / 1000;

// ---------------------------------------------------------------- 战绩修正后的赛前强度

/** 阵容先验（缺阵容分时退回 Elo 分，与 continuityLab.strength 相同） */
const priorOfTeam = (t) => t.roster[VALUE] ?? t.elo;

/**
 * 一个赛季、一个配置：逐比赛日，用更早日期的完赛结果求后验，返回逐场预测（顺序同 rows）。
 * 先验取每队「最近一次出场时的赛前阵容分」：名单 / 分钟变了，先验跟着变，已赛结果保留。
 * cfg = { K, cap?, floor?, recency? }，K=Infinity 即现阵容榜。
 */
function seasonPreds(rows, cfg) {
  const prior = new Map(); const done = []; const out = new Array(rows.length);
  let i = 0;
  while (i < rows.length) {
    const date = rows[i].date;
    let j = i;
    while (j < rows.length && rows[j].date === date) j += 1;
    for (let x = i; x < j; x += 1) {
      prior.set(rows[x].homeId, priorOfTeam(rows[x].home));
      prior.set(rows[x].awayId, priorOfTeam(rows[x].away));
    }
    const post = resultsUpdate(prior, done, cfg.K, {
      cap: cfg.cap ?? Infinity, floor: cfg.floor ?? 0,
      recency: cfg.recency ? { ...cfg.recency, asOf: date } : null, tol: 1e-6,
    });
    for (let x = i; x < j; x += 1) {
      const r = rows[x];
      const { margin: pred, p } = gamePred(post.get(r.homeId).rating, post.get(r.awayId).rating, r.hca, r.restPts, SD);
      out[x] = { row: r, p, pred, actual: r.actual, homeWin: r.homeWin };
    }
    for (let x = i; x < j; x += 1) {
      done.push({ homeId: rows[x].homeId, awayId: rows[x].awayId, margin: rows[x].actual, hca: rows[x].hca, date });
    }
    i = j;
  }
  return out;
}
const eloPreds = (rows) => rows.map((r) => {
  const pred = r.home.elo - r.away.elo + r.hca + r.restPts;
  return { row: r, p: normalCdf(pred, SD), pred, actual: r.actual, homeWin: r.homeWin };
});

// ---------------------------------------------------------------- 预注册变体（全部只按留一赛季 log loss 选）
// KenPom 式近期加权：第 1 场约为第 30 场权重的 40%；30 场 ≈ 60 天，所以每 60 天乘 0.4
const RECENCY = { ratio: 0.4, days: 60 };
const FAMILIES = {
  '基础（只选 K）': KS.map((K) => ({ K })),
  '先验下限 floor（BPI 式）': KS.flatMap((K) => [0.1, 0.2].map((floor) => ({ K, floor }))),
  '近期加权（KenPom 式）': KS.map((K) => ({ K, recency: RECENCY })),
  '净胜分截断 cap（代替垃圾时间）': KS.flatMap((K) => [15, 20].map((cap) => ({ K, cap }))),
};
const ALL = Object.values(FAMILIES).flat();
const cfgKey = (c) => `K=${c.K}${c.floor ? ` floor=${c.floor}` : ''}${c.recency ? ' 近期加权' : ''}${c.cap ? ` cap=${c.cap}` : ''}`;
const ROSTER = { K: Infinity };

const predsBy = new Map(); // `${season}|${cfgKey}` → preds
const preds = (s, c) => predsBy.get(`${s}|${cfgKey(c)}`);
for (const s of SEASONS) {
  for (const c of [...ALL, ROSTER]) predsBy.set(`${s}|${cfgKey(c)}`, seasonPreds(rowsBy[s], c));
  predsBy.set(`${s}|elo`, eloPreds(rowsBy[s]));
}
const elo = (s) => predsBy.get(`${s}|elo`);
const meanLoss = (ps) => ps.reduce((a, x) => a + logLoss(x), 0) / ps.length;
const pick = (trainSeasons, grid) => {
  let best = null;
  for (const c of grid) {
    const loss = meanLoss(trainSeasons.flatMap((s) => preds(s, c)));
    if (!best || loss < best.loss) best = { cfg: c, loss };
  }
  return best;
};

// ---------------------------------------------------------------- 报告
const fmt = (v, d = 4) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const ciStr = (c, d = 4) => `${fmt(c.mean, d)} [${fmt(c.lo, d)}, ${fmt(c.hi, d)}]`;
const brier = (x) => (x.p - (x.homeWin ? 1 : 0)) ** 2;
const absErr = (x) => Math.abs(x.pred - x.actual);
const PHASES = [
  ['全部', () => true],
  ['已赛 0–9', (r) => r.teamGp < 10],
  ['已赛 10–19', (r) => r.teamGp >= 10 && r.teamGp < 20],
  ['已赛 ≥20', (r) => r.teamGp >= 20],
];

console.log(`# 阵容先验 + 本季战绩修正 回测（球员价值 ${VALUE}，sd=${SD}；特征构建 ${tFeat.toFixed(1)} 秒）\n`);
console.log(`候选共 ${ALL.length} 组，分 ${Object.keys(FAMILIES).length} 族；★ = 全部候选按训练季 log loss 一起选。\n`);

console.log('## 基础族：各 K 的逐季 log loss（样本内全貌，仅供看曲面；选择只用留一赛季）\n');
console.log(`| K | ${SEASONS.join(' | ')} | 四季合并 | 四季净胜分 MAE |`);
console.log(`|---:|${SEASONS.map(() => '---:').join('|')}|---:|---:|`);
for (const c of [...FAMILIES['基础（只选 K）'], ROSTER, 'elo']) {
  const get = (s) => (c === 'elo' ? elo(s) : preds(s, c));
  const label = c === 'elo' ? '生产 Elo' : c.K === Infinity ? '∞（现阵容榜）' : c.K;
  const all = SEASONS.flatMap(get);
  console.log(`| ${label} | ${SEASONS.map((s) => fmt(meanLoss(get(s)))).join(' | ')} | ${fmt(meanLoss(all))} | ${fmt(score(all).marginMae, 2)} |`);
}

/** 留出若干季：每季在其余季上从 grid 里选配置 */
function heldOut(heldSeasons, grid) {
  const sel = []; const picks = [];
  for (const s of heldSeasons) {
    const { cfg } = pick(SEASONS.filter((x) => x !== s), grid);
    picks.push([s, cfg]);
    sel.push(...preds(s, cfg));
  }
  return { sel, picks };
}
const baseOf = (heldSeasons) => ({
  ros: heldSeasons.flatMap((s) => preds(s, ROSTER)), eloP: heldSeasons.flatMap(elo),
});

console.log('\n## 各族留一赛季总览（4920 场）\n');
console.log('| 族 | 各折选中 | log loss | Brier | 净胜分 MAE | Δlog loss vs 阵容榜 [95% CI] | Δlog loss vs Elo [95% CI] | ΔMAE vs Elo [95% CI] |');
console.log('|---|---|---:|---:|---:|---|---|---|');
{
  const { ros, eloP } = baseOf(SEASONS);
  for (const [name, grid] of [...Object.entries(FAMILIES), ['★ 全部候选', ALL]]) {
    const { sel, picks } = heldOut(SEASONS, grid);
    const sc = score(sel);
    const d = (A, B, f) => bootstrapCI(A.map((x, i) => f(x) - f(B[i])));
    console.log(`| ${name} | ${picks.map(([, c]) => cfgKey(c)).join('；')} | ${fmt(sc.logloss)} | ${fmt(sc.brier)} | ${fmt(sc.marginMae, 2)} | ${ciStr(d(sel, ros, logLoss))} | ${ciStr(d(sel, eloP, logLoss))} | ${ciStr(d(sel, eloP, absErr), 2)} |`);
  }
  const se = score(eloP); const sr = score(ros);
  console.log(`| 参照：现阵容榜（K=∞） | — | ${fmt(sr.logloss)} | ${fmt(sr.brier)} | ${fmt(sr.marginMae, 2)} | — | | |`);
  console.log(`| 参照：生产 Elo（sd=12） | — | ${fmt(se.logloss)} | ${fmt(se.brier)} | ${fmt(se.marginMae, 2)} | | — | — |`);
}

const verdicts = {};
function report(title, heldSeasons, key) {
  console.log(`\n## ${title}（★ 全部候选）\n`);
  const { sel, picks } = heldOut(heldSeasons, ALL);
  const { ros, eloP } = baseOf(heldSeasons);
  console.log(`选中：${picks.map(([s, c]) => `${s}: ${cfgKey(c)}`).join('；')}\n`);
  console.log('| 阶段 | 场数 | 阵容榜 | Elo | 新榜 | Δlog loss vs 阵容榜 [95% CI] | ΔBrier vs 阵容榜 [95% CI] | Δlog loss vs Elo [95% CI] | ΔBrier vs Elo [95% CI] | 净胜分 MAE 阵容榜 / Elo / 新榜 | ΔMAE vs Elo [95% CI] | 收盘赔率（参照） |');
  console.log('|---|---:|---:|---:|---:|---|---|---|---|---|---|---:|');
  for (const [ph, inPh] of PHASES) {
    const idx = sel.map((x, i) => (inPh(x.row) ? i : -1)).filter((i) => i >= 0);
    const d = (A, B, f) => bootstrapCI(idx.map((i) => f(A[i]) - f(B[i])));
    const cR = d(sel, ros, logLoss); const cE = d(sel, eloP, logLoss);
    const mk = idx.filter((i) => sel[i].row.mktProb !== null);
    const mll = mk.reduce((a, i) => a + logLoss({ p: sel[i].row.mktProb, homeWin: sel[i].homeWin }), 0) / mk.length;
    const sc = (A) => score(idx.map((i) => A[i]));
    console.log(`| ${ph} | ${idx.length} | ${fmt(sc(ros).logloss)} | ${fmt(sc(eloP).logloss)} | ${fmt(sc(sel).logloss)} | ${ciStr(cR)} | ${ciStr(d(sel, ros, brier))} | ${ciStr(cE)} | ${ciStr(d(sel, eloP, brier))} | ${fmt(sc(ros).marginMae, 2)} / ${fmt(sc(eloP).marginMae, 2)} / ${fmt(sc(sel).marginMae, 2)} | ${ciStr(d(sel, eloP, absErr), 2)} | ${fmt(mll)}（${mk.length}） |`);
    if (ph === '全部') verdicts[key] = { vsRoster: cR, vsElo: cE };
  }
  if (heldSeasons.length > 1) {
    console.log('\n逐季：\n');
    console.log('| 留出季 | 选中 | 阵容榜 | Elo | 新榜 | Δ vs 阵容榜 [95% CI] | Δ vs Elo [95% CI] |');
    console.log('|---|---|---:|---:|---:|---|---|');
    for (const [s, c] of picks) {
      const idx = sel.map((x, i) => (x.row.season === s ? i : -1)).filter((i) => i >= 0);
      const d = (A, B) => bootstrapCI(idx.map((i) => logLoss(A[i]) - logLoss(B[i])));
      const ll = (A) => fmt(score(idx.map((i) => A[i])).logloss);
      console.log(`| ${s} | ${cfgKey(c)} | ${ll(ros)} | ${ll(eloP)} | ${ll(sel)} | ${ciStr(d(sel, ros))} | ${ciStr(d(sel, eloP))} |`);
    }
  }
}

report('留一赛季交叉验证（2022-23 ~ 2025-26，逐季留出后合并）', SEASONS, 'loso');
report('最终留出：2022-23~2024-25 选配置，只在 2025-26 打分', ['2025-26'], 'holdout');

const L = verdicts.loso.vsRoster; const H = verdicts.holdout.vsRoster;
const adopt = L.hi <= 0.002 && H.lo <= 0;
console.log(`\n## 预注册规则（★）\n\n留一赛季 vs 现阵容榜 Δlog loss ${ciStr(L)}；最终留出 ${ciStr(H)}。`);
console.log(`规则「留一赛季区间上界 ≤ +0.002，且留出季不显著变差（区间下界 ≤ 0）」：${adopt ? '通过 → 采纳' : '不通过 → 不采纳'}`);
console.log(`对生产 Elo（如实报告，不是采纳条件）：留一赛季 ${ciStr(verdicts.loso.vsElo)}；最终留出 ${ciStr(verdicts.holdout.vsElo)}`);
const all = pick(SEASONS, ALL);
const allBase = pick(SEASONS, FAMILIES['基础（只选 K）']);
console.log(`\n四季全部选出（供线上使用）：★ ${cfgKey(all.cfg)}（log loss ${fmt(all.loss)}）；基础族 ${cfgKey(allBase.cfg)}（${fmt(allBase.loss)}）`);
