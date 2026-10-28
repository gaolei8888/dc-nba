/**
 * 阵容榜分钟预测回测（roster-fixes-batch1）：旧版 vs 新版 vs 朴素「本季至今场均」。
 *
 *   node scripts/minutes-backtest.mjs            # 主结果（新版常数）
 *   MB_GRID=1 node scripts/minutes-backtest.mjs  # 另在训练季（2022-23~2024-25）上扫 cap / floor / DNP 阈值
 *   MB_FIT_Q=1 node scripts/minutes-backtest.mjs # 另重拟合轮换概率 q（server/rotationMinutes.mjs 的 ROTATION_LOGIT）
 *
 * 只读 data/backtest.json、data/teams.json、data/history/（stints_ / impact_ / lineups_ / injury-reports），不联网。
 *
 * 每场每队，只用**赛前**信息给候选球员预测本场分钟：
 *   · 上季出场时场均（上季 ≥10 场，来自上季 stints）、本季此前的出场场数与出场时场均（跨队累计，同线上 p.cur）、
 *     球队本季已赛场数（同线上 wins+losses）；
 *   · 出场信息两种口径：
 *       report  = 当天北京 22:00 时点能看到的官方伤病报告（与 injury-lab 同一条报告链，延迟 15 分钟）——线上的真实处境；
 *       oracle  = 赛后才知道的「谁上了场」（上场 = 可用，没上场 = 不可用）——只看分钟分配本身。
 * 候选名单（「在册」的近似，所有方法共用）：上季最后效力本队且本季首次出场也为本队的人从第 1 场起在册；
 *   其余人从本队首次出场前 5 场起在册；之后为别队出场的，在为本队最后一场之后离册。
 *   这用到了「将来为谁出场」来近似在册名单（线上名单是已知的），对所有方法相同。
 * 真实分钟按每场全队总分钟缩放到 240（加时赛），DNP 记 0。
 *
 * 方法：
 *   old    = 旧线上逻辑：projectMinutes（出场时 MPG × 收缩出场率）+ projectRotation（等比、上限 48），只有 Out 记缺阵；
 *   new    = 新线上逻辑：rotationMinutes（出场时 MPG、轮换概率、DNP-CD 规则）+ P(出场|状态) + projectExpectedRotation（σ 分配、上限 38）；
 *   new-enum / new-noq / new-prorata = 消融：伤病情形逐一枚举 / 不用轮换概率 / 用旧的等比分配（上限 48）；
 *   naive  = 本季至今出场时场均（本季没出场用上季场均），Out 记 0，不缩放——EPM 式朴素基准。
 * 球队层面：阵容分 = Σ 球员价值 × 分钟 / 48（价值 = 上季收缩 IMP，同 continuity-backtest 的 shrunk；替补级 −0.5），
 *   预测净胜分 = a·(主 − 客) + 主场 1.6 + 休息；a、sd 在训练季按 log loss 选（留一赛季），按场配对 bootstrap。
 * 盘口不进任何输入或选参。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import { buildSamples, fit, apply, blend, mean, DECAY_SPAN, DECAY_HALFLIFE } from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { gameMinutes } from '../server/continuityLab.mjs';
import { expand, normalCdf, restAdjust } from '../server/lab.mjs';
import { bootstrapCI } from '../server/fusionLab.mjs';
import { minutesLab, newRows, availOf, impactRow } from '../server/minutesLab.mjs';
import { projectMinutes } from '../server/liveRosterRankings.mjs';
import { projectRotation, projectExpectedRotation, rosterRating, ROTATION_CAP, ROTATION_FLOOR } from '../server/rosterProjection.mjs';
import { rotationMinutes, playProbability, conditionalMinutes, DNP_GAMES, ROTATION_LOGIT } from '../server/rotationMinutes.mjs';
import { REPLACEMENT_IMP } from '../server/ratings.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const INJ = process.env.INJURY_DIR ?? path.join(HISTORY, 'injury-reports');
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const ALL_SEASONS = ['2021-22', ...SEASONS];
const TRAIN = SEASONS.slice(0, 3);
const P = { homeAdv: 1.6, restWeight: 1.8 };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const prevOf = (s) => ALL_SEASONS[ALL_SEASONS.indexOf(s) - 1];
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

const dataset = read(path.join(DATA_DIR, 'backtest.json'));
const teams = read(path.join(DATA_DIR, 'teams.json'));
const fullOf = new Map(teams.map((t) => [t.teamId, t.full]));
const abbrOf = new Map(teams.map((t) => [t.teamId, t.abbr]));
const players = {}; const lineups = {}; const stints = {};
for (const s of ALL_SEASONS) {
  players[s] = read(path.join(HISTORY, `impact_${s}.json`)).players.map((p) => ({ ...p, season: s }));
  lineups[s] = read(path.join(HISTORY, `lineups_${s}.json`)).rows;
  stints[s] = readJsonAuto(path.join(HISTORY, `stints_${s}.json.gz`));
}

// ---------------------------------------------------------------- 球员价值（与 scripts/continuity-backtest.mjs 的 valuesUpto 同口径，只取收缩 IMP）
const apmBySeason = new Map(ALL_SEASONS.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })]));
function valuesUpto(upto) {
  const seen = ALL_SEASONS.slice(0, ALL_SEASONS.indexOf(upto) + 1);
  const spm = fit(buildSamples(seen.flatMap((s) => players[s]), { apmBySeason }), 3000);
  const dec = decayedApm(seen.slice(-DECAY_SPAN).map((s) => ({ season: s, rows: lineups[s] })),
    { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
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
  const mu = mean(players[upto].map((p) => apply(spm, p)).filter((v) => v !== null));
  const out = new Map();
  for (const p of players[upto]) {
    const raw = blend(apply(spm, p), dec.get(p.playerId)?.apm ?? null);
    if (raw !== null) out.set(p.playerId, shrinkByMinutes(raw, (p.gp ?? 0) * (p.min ?? 0), mu, MINUTES_SHRINK) * scale);
  }
  return out;
}

// ---------------------------------------------------------------- 逐场上下文与新版逐人输入（server/minutesLab.mjs，roster-results-backtest 共用）
const { buildContexts, matchStats } = minutesLab({ dataset, teams, players, stints, injDir: INJ, allSeasons: ALL_SEASONS, P });

const METHODS = {
  old(side, mode, values) {
    const rows = side.rows.map((r) => ({ ...impactRow(r, values),
      projectedMinutes: projectMinutes(r.priorMpg, r.curMpg, r.n, side.T),
      availability: availOf(r, mode) ?? (r.status === 'Out' ? 0 : 1) }));
    return projectRotation(rows);
  },
  new(side, mode, values, cfg = {}) {
    return projectExpectedRotation(newRows(side, mode, values, cfg), cfg);
  },
  /** 消融：伤病不确定的人逐一枚举（而非平均场） */
  'new-enum'(side, mode, values) {
    return projectExpectedRotation(newRows(side, mode, values), { mode: 'enumerate' });
  },
  /** 消融：不用轮换概率 q（只有出场时分钟 + 伤病概率 + DNP-CD 规则） */
  'new-noq'(side, mode, values) {
    return projectExpectedRotation(newRows(side, mode, values, { rotationModel: null }));
  },
  /** 消融：新的分钟与出场概率，但用旧的等比分配（上限 48） */
  'new-prorata'(side, mode, values) {
    return projectRotation(newRows(side, mode, values).map((r) => ({ ...r, availability: r.availability * r.rotation })));
  },
  naive(side, mode, values) {
    const players = side.rows.map((r) => ({ ...impactRow(r, values), impact: values?.get(r.pid) ?? REPLACEMENT_IMP,
      minutes: (r.n > 0 ? r.curMpg : r.priorMpg ?? 0) * (availOf(r, mode) ?? (r.status === 'Out' ? 0 : 1)) }));
    return { players };
  },
};

function evaluate(ctxs, method, mode, values, cfg) {
  const err = { all: [0, 0], starters: [0, 0], bench: [0, 0], dnp: [0, 0] };
  const add = (k, e) => { err[k][0] += e; err[k][1] += 1; };
  const team = []; let failed = 0;
  for (const c of ctxs) {
    const r = {};
    for (const sideKey of ['home', 'away']) {
      const side = c[sideKey];
      let rot;
      try { rot = METHODS[method](side, mode, values, cfg); } catch { failed += 1; rot = null; }
      side.rows.forEach((row, i) => {
        const m = rot ? rot.players[i].minutes : 0;
        const e = Math.abs(m - row.actual);
        add('all', e); add(row.starter ? 'starters' : row.played ? 'bench' : 'dnp', e);
      });
      r[sideKey] = rot && values ? rosterRating(rot) : null;
    }
    if (values && r.home !== null && r.away !== null) team.push({ season: c.season, diff: r.home - r.away, hca: c.hca, restPts: c.restPts, homeWin: c.homeWin });
  }
  const mae = Object.fromEntries(Object.entries(err).map(([k, [s, n]]) => [k, { mae: s / n, n }]));
  return { mae, team, failed };
}

const logLoss = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-9));
const A_GRID = Array.from({ length: 13 }, (_, i) => 0.5 + i * 0.125);
const SD_GRID = [11, 11.5, 12, 12.5, 13, 13.5];
function tuneTeam(rows) {
  let best = null;
  for (const a of A_GRID) for (const sd of SD_GRID) {
    let s = 0;
    for (const r of rows) s += logLoss(normalCdf(a * r.diff + r.hca + r.restPts, sd), r.homeWin);
    if (!best || s < best.s) best = { a, sd, s };
  }
  return best;
}
function loso(team) {
  const out = []; const picks = [];
  for (const s of SEASONS) {
    const cfg = tuneTeam(team.filter((r) => r.season !== s));
    picks.push(`${s}: a=${cfg.a} sd=${cfg.sd}`);
    for (const r of team.filter((x) => x.season === s)) out.push({ ...r, ll: logLoss(normalCdf(cfg.a * r.diff + r.hca + r.restPts, cfg.sd), r.homeWin) });
  }
  return { out, picks };
}

// ---------------------------------------------------------------- 运行
const t0 = Date.now();
const ctx = {}; const vals = {};
for (const s of SEASONS) { ctx[s] = buildContexts(s); vals[s] = valuesUpto(prevOf(s)); }
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
console.log(`# 阵容榜分钟预测回测（上下文 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）\n`);
console.log(`- 比赛：${SEASONS.map((s) => `${s} ${ctx[s].length}`).join('，')}（有 stints 的比赛）`);
console.log(`- 伤病报告：${matchStats.withReport}/${matchStats.teamGames} 个队·场有可用报告；报告行匹配 ${matchStats.matched}/${matchStats.rows}（${(100 * matchStats.matched / matchStats.rows).toFixed(1)}%）`);
console.log(`- 新版常数：cap=${ROTATION_CAP} floor=${ROTATION_FLOOR} DNP 阈值=${DNP_GAMES} 场\n`);

// 轮换概率 q 的拟合（MB_FIT_Q=1）：有报告、且不在名单上（或 Available / Probable）的候选球员·场，
// 标签 = 本场是否上场；训练 2022-23~2024-25，留出 2025-26。结果写进 server/rotationMinutes.mjs 的 ROTATION_LOGIT。
if (process.env.MB_FIT_Q === '1') {
  const healthyRows = (seasons) => seasons.flatMap((s) => ctx[s].flatMap((c) => ['home', 'away'].flatMap((k) => (c[k].hasReport
    ? c[k].rows.filter((r) => r.status === null || r.status === 'Available' || r.status === 'Probable')
      .map((r) => ({ m: conditionalMinutes(r.priorMpg, r.curMpg, r.n), n: r.n, T: c[k].T, y: r.played ? 1 : 0 })) : []))));
  const feats = (r) => {
    const rho = Math.min(0.98, Math.max(0.02, (Math.min(r.n, r.T) + 0.75) / (r.T + 1)));
    return [1, Math.min(r.m ?? 0, 36) / 10, r.m == null ? 1 : 0, Math.log(rho / (1 - rho))];
  };
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const tr = healthyRows(TRAIN); const ho = healthyRows(['2025-26']);
  const X = tr.map(feats); const w = [0, 0, 0, 0];
  for (let it = 0; it < 600; it += 1) {
    const g = [0, 0, 0, 0];
    X.forEach((x, i) => { const e = tr[i].y - sig(x.reduce((a, v, j) => a + v * w[j], 0)); x.forEach((v, j) => { g[j] += e * v; }); });
    w.forEach((v, j) => { w[j] += g[j] / X.length; });
  }
  const ll = (rows) => -rows.reduce((a, r) => { const p = sig(feats(r).reduce((s2, v, j) => s2 + v * w[j], 0)); return a + Math.log(r.y ? p : 1 - p); }, 0) / rows.length;
  const base = tr.reduce((a, r) => a + r.y, 0) / tr.length;
  const llBase = -ho.reduce((a, r) => a + Math.log(r.y ? base : 1 - base), 0) / ho.length;
  console.log(`## 轮换概率 q 拟合\n\n训练 ${tr.length} 行、留出 ${ho.length} 行；系数 [截距, 每 10 分钟, 无分钟信息, logit ρ] = ${w.map((v) => v.toFixed(3)).join(', ')}`);
  console.log(`留出 log loss ${ll(ho).toFixed(4)}（常数 ${base.toFixed(3)} 为 ${llBase.toFixed(4)}）；当前常数：${JSON.stringify(ROTATION_LOGIT)}\n`);
}

if (process.env.MB_GRID === '1') {
  console.log('## 训练季（2022-23~2024-25）网格：report 口径分钟 MAE（全部 / 首发 / 替补 / DNP）\n');
  console.log('| cap | floor | DNP 阈值 | 全部 | 首发 | 替补 | DNP |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|');
  const tr = TRAIN.flatMap((s) => ctx[s]);
  for (const cap of [36, 37, 38, 40, 42]) for (const floor of [0.5, 1, 2]) for (const dnpGames of [1, 2, 3, 1e9]) {
    const { mae } = evaluate(tr, 'new', 'report', null, { cap, floor, dnpGames });
    console.log(`| ${cap} | ${floor} | ${dnpGames > 1e8 ? '不用' : dnpGames} | ${fmt(mae.all.mae)} | ${fmt(mae.starters.mae)} | ${fmt(mae.bench.mae)} | ${fmt(mae.dnp.mae)} |`);
  }
  console.log('');
}

const results = {};
for (const mode of ['report', 'oracle']) {
  console.log(`## 分钟 MAE（${mode === 'report' ? 'report：赛前伤病报告' : 'oracle：已知谁上场'}；每名候选球员每场，分钟）\n`);
  console.log('| 方法 | 赛季 | 全部 | 首发 | 替补（上场） | DNP（在册未上场） | 失败队·场 |');
  console.log('|---|---|---:|---:|---:|---:|---:|');
  for (const method of Object.keys(METHODS)) {
    const team = [];
    for (const group of [...SEASONS.map((s) => [s]), SEASONS]) {
      const res = { mae: null, failed: 0 };
      const parts = group.map((s) => evaluate(ctx[s], method, mode, vals[s]));
      // 合并 MAE
      const keys = ['all', 'starters', 'bench', 'dnp'];
      res.mae = Object.fromEntries(keys.map((k) => {
        const n = parts.reduce((a, p) => a + p.mae[k].n, 0);
        return [k, { mae: parts.reduce((a, p) => a + p.mae[k].mae * p.mae[k].n, 0) / n, n }];
      }));
      res.failed = parts.reduce((a, p) => a + p.failed, 0);
      if (group.length > 1) team.push(...parts.flatMap((p) => p.team));
      const label = group.length > 1 ? '**四季合计**' : group[0];
      console.log(`| ${method} | ${label} | ${fmt(res.mae.all.mae)} | ${fmt(res.mae.starters.mae)} | ${fmt(res.mae.bench.mae)} | ${fmt(res.mae.dnp.mae)} | ${res.failed} |`);
      if (group.length > 1) results[`${mode}|${method}`] = { mae: res.mae, team };
    }
  }
  const n = results[`${mode}|old`].mae;
  console.log(`\n样本：首发 ${n.starters.n}、替补 ${n.bench.n}、DNP ${n.dnp.n}（球员·场）\n`);
}

// 「场场打满」的主力：本季此前每场都上、出场时场均 ≥ 32 的人，本场（上场时）的预测 vs 实际
{
  console.log('## 主力被压缩的检查（report 口径）：本季此前场场出场、出场时场均 ≥32，且本场上场\n');
  const acc = {}; let cnt = 0; let act = 0;
  for (const s of SEASONS) for (const c of ctx[s]) for (const sideKey of ['home', 'away']) {
    const side = c[sideKey];
    const ix = side.rows.map((r, i) => (r.played && side.T >= 3 && r.n >= side.T && r.curMpg >= 32 ? i : -1)).filter((i) => i >= 0);
    if (!ix.length) continue;
    for (const m of ['old', 'new', 'naive']) {
      let rot; try { rot = METHODS[m](side, 'report', null); } catch { continue; }
      acc[m] = (acc[m] ?? 0) + ix.reduce((a, i) => a + rot.players[i].minutes, 0);
    }
    cnt += ix.length; act += ix.reduce((a, i) => a + side.rows[i].actual, 0);
  }
  console.log(`n=${cnt}；实际 ${fmt(act / cnt, 1)}；${Object.entries(acc).map(([m, v]) => `${m} ${fmt(v / cnt, 1)}`).join('；')}\n`);
}

// ---------------------------------------------------------------- 球队层面 log loss
console.log('## 球队层面：纯阵容分预测的 log loss（留一赛季 2022-23~2025-26，a、sd 在其余三季上选）\n');
console.log('| 口径 | 方法 | 场数 | log loss | Δ vs old [95% CI] | 各留出季选中的 a / sd |');
console.log('|---|---|---:|---:|---|---|');
const verdict = {};
for (const mode of ['report', 'oracle']) {
  const base = loso(results[`${mode}|old`].team);
  for (const method of Object.keys(METHODS)) {
    const r = loso(results[`${mode}|${method}`].team);
    const ok = r.out.length === base.out.length && r.out.every((x, i) => x.season === base.out[i].season);
    const ci = ok && method !== 'old' ? bootstrapCI(r.out.map((x, i) => x.ll - base.out[i].ll)) : null;
    const ll = r.out.reduce((a, x) => a + x.ll, 0) / r.out.length;
    console.log(`| ${mode} | ${method} | ${r.out.length} | ${fmt(ll, 4)} | ${ci ? `${fmt(ci.mean, 4)} [${fmt(ci.lo, 4)}, ${fmt(ci.hi, 4)}]` : '—'} | ${r.picks.join('；')} |`);
    if (method === 'new') verdict[mode] = ci;
  }
}

const mOld = results['report|old'].mae.all.mae; const mNew = results['report|new'].mae.all.mae;
const L = verdict.report;
console.log(`\n## 采纳规则\n\n分钟 MAE（report 口径，四季）：old ${fmt(mOld)} → new ${fmt(mNew)}（${mNew < mOld ? '改善' : '未改善'}）；`
  + `球队 log loss Δ ${fmt(L.mean, 4)} [${fmt(L.lo, 4)}, ${fmt(L.hi, 4)}]（${L.lo > 0 ? '显著变差' : '不显著变差'}）。`);
console.log(`规则「分钟 MAE 优于旧版，且球队 log loss 没有显著变差」：${mNew < mOld && !(L.lo > 0) ? '通过 → 采纳' : '不通过'}`);
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
