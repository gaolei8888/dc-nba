/**
 * 阵容实验榜战绩修正「按实际阵容算残差」实验（预注册：docs/superpowers/specs/2026-10-29-roster-results-fix-prereg.md）。
 *
 *   npm run lab:roster-fix        # 纯离线：只读 data/backtest.json、data/teams.json、data/history/，不联网
 *   IE_PREDS=<json> npm run lab:roster-fix   # 另读 injury-elo 分支 A(0.75) 的逐场概率做只报告的对照
 *
 * 输出：docs/roster-results-fix-lab-output.txt（文本摘要）与 data/roster-results-fix-lab.json（gitignored，逐方案数字）。
 *
 * 方案（全部 K=12 近期加权 0.4^(天数/60) 的同一套求解，见 server/rosterResultsFixLab.mjs）：
 *   R0  现阵容榜：原始净胜分
 *   R1  按实际阵容算残差，s = 1
 *   R1s 同上，s ∈ {0.5, 0.75, 1} 每折只在训练季上选（采纳只看它）
 *   R2  R1s 再加 K ∈ {8, 12, 16}，只报告
 *   P0  生产 Elo（sd 12），只报告；A(0.75) injury-elo 分支，只报告
 * 先验口径：strict（主，赛前候选 + 报告时间核对）与 legacy（docs/roster-results-update-verdict.md 原样，只报告）。
 * 球员价值、分钟模型、协议与 scripts/roster-results-backtest.mjs 相同。盘口不进任何输入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import { buildSamples, fit, apply, blend, mean, DECAY_SPAN, DECAY_HALFLIFE } from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { replaySeason, eloStartFor, teamGamesFromStints, leagueCenter, logLoss } from '../server/continuityLab.mjs';
import { expand, normalCdf } from '../server/lab.mjs';
import { bootstrapCI } from '../server/fusionLab.mjs';
import { resultsUpdate, gamePred } from '../server/rosterResults.mjs';
import { minutesLab } from '../server/minutesLab.mjs';
import { tipMinutes } from '../server/injuryLab.mjs';
import { decisionInstant } from '../server/injuryReport.mjs';
import {
  lineupAdjustedUpdate, teamGameValues, blockBootstrapCI, strataOf, reportUsable, etToMs,
} from '../server/rosterResultsFixLab.mjs';

const t0 = Date.now();
const HISTORY = path.join(DATA_DIR, 'history');
const INJ = process.env.INJURY_DIR ?? path.join(HISTORY, 'injury-reports');
const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const ALL_SEASONS = ['2021-22', ...SEASONS];
const HOLDOUT = '2025-26';
const prevOf = (s) => ALL_SEASONS[ALL_SEASONS.indexOf(s) - 1];
const SD = 12;
const RECENCY = { ratio: 0.4, days: 60 };
const S_GRID = [0.5, 0.75, 1.0];
const K_GRID = [8, 12, 16];
const MODES = ['strict', 'legacy'];
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---------------------------------------------------------------- 特征（与 roster-results-backtest 逐行相同）
const dataset = read(path.join(DATA_DIR, 'backtest.json'));
const teams = read(path.join(DATA_DIR, 'teams.json'));
const players = {}; const lineups = {}; const stints = {};
for (const s of ALL_SEASONS) {
  players[s] = read(path.join(HISTORY, `impact_${s}.json`)).players.map((p) => ({ ...p, season: s }));
  lineups[s] = read(path.join(HISTORY, `lineups_${s}.json`)).rows;
  stints[s] = readJsonAuto(path.join(HISTORY, `stints_${s}.json.gz`));
  if (!stints[s]) { console.error(`缺 stints_${s}`); process.exit(1); }
}
const apmBySeason = new Map(ALL_SEASONS.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })]));

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

// ---------------------------------------------------------------- 报告时间核对（strict）：标注时间 + 15 分钟 ≤ 北京 22:00 < 开赛
const picks = read(path.join(INJ, 'index.json')).picks_lag15;
const timing = { checked: 0, rejected: 0, noTip: 0 };
const tipCache = new Map();
function reportOk(name, { date, ofGame, report }) {
  timing.checked += 1;
  const p22 = picks[`${date}|22`];
  const key = `${date}|${name}`;
  let tipMs = null;
  if (p22) {
    const row = ofGame(report(p22))[0];
    const tm = tipMinutes(row?.gameTime);
    tipMs = tm === null ? null : etToMs(date, tm);
  }
  if (tipMs === null) timing.noTip += 1;
  tipCache.set(key, tipMs);
  const ok = reportUsable(name, decisionInstant(date, '22'), tipMs, 15);
  if (!ok) timing.rejected += 1;
  return ok;
}

// ---------------------------------------------------------------- 逐场行与逐队·场阵容分
const rowsBy = {};
const tg = { strict: new Map(), legacy: new Map() };   // `${gameId}|${teamId}` → teamGameValues
const ctxStats = { strict: { sides: 0, failed: 0 }, legacy: { sides: 0, failed: 0 } };
const teamSeq = new Map();   // strict：`${season}|${team}` → [{ gameId, absent, playedSet }]
const labs = Object.fromEntries(MODES.map((m) => [m, minutesLab({
  dataset, teams, players, stints, injDir: INJ, allSeasons: ALL_SEASONS,
  roster: m, reportOk: m === 'strict' ? reportOk : null,
})]));
const candSize = { strict: [], legacy: [] };
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
  const values = v.values.get('shrunk'); const c = center.get('shrunk');
  for (const mode of MODES) {
    for (const g of labs[mode].buildContexts(s)) {
      for (const side of [g.home, g.away]) {
        ctxStats[mode].sides += 1;
        candSize[mode].push(side.rows.length);
        let val = null;
        try { val = teamGameValues(side, values, c); tg[mode].set(`${g.gameId}|${side.teamId}`, val); } catch { ctxStats[mode].failed += 1; }
        if (mode === 'strict') {
          const key = `${s}|${side.teamId}`;
          if (!teamSeq.has(key)) teamSeq.set(key, []);
          const playedSet = new Set(side.rows.filter((r) => r.played).map((r) => r.pid));
          teamSeq.get(key).push({ gameId: g.gameId, playedSet, absent: new Set((val?.rotationIds ?? []).filter((id) => !playedSet.has(id))) });
        }
      }
    }
  }
}
const strata = strataOf(teamSeq);
const tFeat = (Date.now() - t0) / 1000;

// ---------------------------------------------------------------- 逐比赛日求后验
const carryStats = { strict: { carried: 0, fallback: 0 }, legacy: { carried: 0, fallback: 0 } };
/** cfg = { K, s }；s = null 为 R0（直接调 resultsUpdate，即线上函数） */
function seasonPreds(rows, mode, cfg, count = false) {
  const map = tg[mode];
  const prior = new Map(); const dPre = new Map(); const done = []; const out = new Array(rows.length);
  const setTeam = (gid, teamId, t) => {
    const v = map.get(`${gid}|${teamId}`);
    if (v) { prior.set(teamId, v.prior); dPre.set(teamId, v.dPre); return; }
    if (prior.has(teamId)) { if (count) carryStats[mode].carried += 1; return; }   // 沿用上一次的先验与 D_pre
    if (count) carryStats[mode].fallback += 1;
    prior.set(teamId, t.roster.shrunk ?? t.elo); dPre.set(teamId, 0);
  };
  let i = 0;
  while (i < rows.length) {
    const date = rows[i].date;
    let j = i;
    while (j < rows.length && rows[j].date === date) j += 1;
    for (let x = i; x < j; x += 1) { setTeam(rows[x].gameId, rows[x].homeId, rows[x].home); setTeam(rows[x].gameId, rows[x].awayId, rows[x].away); }
    const opts = { recency: { ...RECENCY, asOf: date }, tol: 1e-6 };
    const post = cfg.s === null ? resultsUpdate(prior, done, cfg.K, opts) : lineupAdjustedUpdate(prior, dPre, done, cfg.K, { ...opts, s: cfg.s });
    for (let x = i; x < j; x += 1) {
      const r = rows[x];
      const { margin: pred, p } = gamePred(post.get(r.homeId).rating, post.get(r.awayId).rating, r.hca, r.restPts, SD);
      out[x] = { row: r, p, pred, actual: r.actual, homeWin: r.homeWin };
    }
    for (let x = i; x < j; x += 1) {
      const r = rows[x];
      done.push({ homeId: r.homeId, awayId: r.awayId, margin: r.actual, hca: r.hca, date,
        dPostHome: map.get(`${r.gameId}|${r.homeId}`)?.dPost ?? 0, dPostAway: map.get(`${r.gameId}|${r.awayId}`)?.dPost ?? 0 });
    }
    i = j;
  }
  return out;
}

const cfgKey = (c) => (c.s === null ? `R0 K=${c.K}` : `K=${c.K} s=${c.s}`);
const R0 = { K: 12, s: null };
const R1 = { K: 12, s: 1 };
const GRID_R1S = S_GRID.map((s) => ({ K: 12, s }));
const GRID_R2 = K_GRID.flatMap((K) => S_GRID.map((s) => ({ K, s })));
const ALLCFG = [R0, { K: 12, s: 0 }, ...GRID_R1S, ...GRID_R2.filter((c) => c.K !== 12)];
const predsBy = new Map();
for (const mode of MODES) {
  for (const s of SEASONS) {
    for (const c of ALLCFG) predsBy.set(`${mode}|${s}|${cfgKey(c)}`, seasonPreds(rowsBy[s], mode, c, c === R0));
  }
}
const preds = (mode, s, c) => predsBy.get(`${mode}|${s}|${cfgKey(c)}`);
// s = 0 走 lineupAdjustedUpdate，必须与 R0（resultsUpdate）逐位相同
let maxS0 = 0;
for (const mode of MODES) for (const s of SEASONS) {
  const a = preds(mode, s, R0); const b = preds(mode, s, { K: 12, s: 0 });
  a.forEach((x, i) => { maxS0 = Math.max(maxS0, Math.abs(x.p - b[i].p)); });
}
if (maxS0 !== 0) throw new Error(`s=0 与 R0 不一致：${maxS0}`);
const eloPreds = (rows) => rows.map((r) => {
  const pred = r.home.elo - r.away.elo + r.hca + r.restPts;
  return { row: r, p: normalCdf(pred, SD), pred, actual: r.actual, homeWin: r.homeWin };
});

const meanLoss = (ps) => ps.reduce((a, x) => a + logLoss(x), 0) / ps.length;
const pick = (mode, train, grid) => {
  let best = null;
  for (const c of grid) {
    const loss = meanLoss(train.flatMap((s) => preds(mode, s, c)));
    if (!best || loss < best.loss - 1e-12) best = { cfg: c, loss };   // 并列取网格里靠前（较小 s / K）
  }
  return best;
};
/** 逐季留出，返回 4920 场的样本外预测（顺序 = SEASONS 拼接）与各折选中 */
function oof(mode, grid) {
  const sel = []; const picks = {};
  for (const s of SEASONS) {
    const { cfg } = pick(mode, SEASONS.filter((x) => x !== s), grid);
    picks[s] = cfgKey(cfg);
    sel.push(...preds(mode, s, cfg));
  }
  return { sel, picks, all: cfgKey(pick(mode, SEASONS, grid).cfg) };
}

// ---------------------------------------------------------------- A(0.75)（injury-elo 分支，只报告）
let ieBy = null;
if (process.env.IE_PREDS && fs.existsSync(process.env.IE_PREDS)) {
  const ie = read(process.env.IE_PREDS);
  ieBy = new Map(ie.games.map((g) => [g.gameId, g]));
}

// ---------------------------------------------------------------- 报告
const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const ci = (c) => `${f4(c.mean)} [${f4(c.lo)}, ${f4(c.hi)}]`;
const brier = (x) => (x.p - (x.homeWin ? 1 : 0)) ** 2;
const result = { modes: {} };

log('# 阵容实验榜战绩修正「按实际阵容算残差」实验输出（npm run lab:roster-fix）');
log(`预注册：docs/superpowers/specs/2026-10-29-roster-results-fix-prereg.md；运行于 ${new Date().toISOString()}；特征构建 ${tFeat.toFixed(1)} 秒`);
log('');
log('## 数据与审计');
for (const mode of MODES) {
  const ms = labs[mode].matchStats;
  const vals = [...tg[mode].values()];
  log(`- ${mode}：${ctxStats[mode].sides} 个队·场有赛前上下文（阵容分失败 ${ctxStats[mode].failed}）；伤病报告 ${ms.withReport}/${ms.teamGames} 个队·场可用；`
    + `报告行匹配 ${ms.matched}/${ms.rows}；候选人数均值 ${mean(candSize[mode]).toFixed(1)}；无上下文沿用 ${carryStats[mode].carried}、退回 continuity ${carryStats[mode].fallback}（四季合计）`);
  log(`  平均 D_pre ${mean(vals.map((x) => x.dPre)).toFixed(3)}（>0 占 ${(100 * mean(vals.map((x) => (x.dPre > 1e-9 ? 1 : 0)))).toFixed(1)}%）；`
    + `平均 D_post ${mean(vals.map((x) => x.dPost)).toFixed(3)}（>0 占 ${(100 * mean(vals.map((x) => (x.dPost > 1e-9 ? 1 : 0)))).toFixed(1)}%，<0 占 ${(100 * mean(vals.map((x) => (x.dPost < -1e-9 ? 1 : 0)))).toFixed(1)}%）；`
    + `D_post 的 p90 ${[...vals.map((x) => x.dPost)].sort((a, b) => a - b)[Math.floor(vals.length * 0.9)].toFixed(2)}`);
}
log(`- strict 报告时间核对：检查 ${timing.checked} 次，因「标注时间 + 15 分钟 > 北京 22:00」或「22:00 ≥ 开赛」剔除 ${timing.rejected} 次；找不到开赛时间（只查前一条）${timing.noTip} 次`);
log(`- s=0 走新函数与 R0（线上 resultsUpdate）逐场最大差 ${maxS0}`);
const allRows = SEASONS.flatMap((s) => rowsBy[s]);
const stratumOf = (r) => strata.get(r.gameId) ?? 'iii';
const nStr = (t) => allRows.filter((r) => stratumOf(r) === t).length;
log(`- 分层（strict 上下文定义，两种口径共用）：(i) ${nStr('i')}，(ii) ${nStr('ii')}，(iii) ${nStr('iii')}`);
if (ieBy) log(`- A(0.75)：injury-elo 分支逐场概率 ${ieBy.size} 场，与本实验对上 ${allRows.filter((r) => ieBy.has(r.gameId)).length} 场`);
else log('- A(0.75)：未提供 IE_PREDS，跳过');

const groupsOf = (rs) => ({
  'LOSO 合并': rs.map((_, i) => i),
  ...Object.fromEntries(SEASONS.map((s) => [s === HOLDOUT ? `${s}（最终留出）` : s, rs.map((r, i) => (r.season === s ? i : -1)).filter((i) => i >= 0)])),
  '(i) 长期缺阵': rs.map((r, i) => (stratumOf(r) === 'i' ? i : -1)).filter((i) => i >= 0),
  '(ii) 复出后 10 场': rs.map((r, i) => (stratumOf(r) === 'ii' ? i : -1)).filter((i) => i >= 0),
  '(iii) 其余': rs.map((r, i) => (stratumOf(r) === 'iii' ? i : -1)).filter((i) => i >= 0),
  '已赛 0–9': rs.map((r, i) => (r.teamGp < 10 ? i : -1)).filter((i) => i >= 0),
  '已赛 10–19': rs.map((r, i) => (r.teamGp >= 10 && r.teamGp < 20 ? i : -1)).filter((i) => i >= 0),
  '已赛 ≥20': rs.map((r, i) => (r.teamGp >= 20 ? i : -1)).filter((i) => i >= 0),
});

for (const mode of MODES) {
  const arms = {
    R0: { sel: SEASONS.flatMap((s) => preds(mode, s, R0)), picks: 'K=12 近期加权（固定）', all: 'K=12' },
    R1: { sel: SEASONS.flatMap((s) => preds(mode, s, R1)), picks: 's=1（固定）', all: 's=1' },
    R1s: oof(mode, GRID_R1S),
    R2: oof(mode, GRID_R2),
    P0: { sel: SEASONS.flatMap((s) => eloPreds(rowsBy[s])), picks: '—', all: '—' },
  };
  const rows = arms.R0.sel.map((x) => x.row);
  if (ieBy) {
    arms.A = { sel: rows.map((r, i) => { const g = ieBy.get(r.gameId); return g ? { ...arms.R0.sel[i], p: g.pA, pred: NaN } : null; }), picks: 'injury-elo 各折 s', all: '' };
  }
  const groups = groupsOf(rows);
  const blocks = rows.map((r) => r.date);
  const okIdx = (idx, a, b) => idx.filter((i) => arms[a].sel[i] && arms[b].sel[i]);
  const d = (a, b, idx, f = logLoss) => { const ii = okIdx(idx, a, b); return bootstrapCI(ii.map((i) => f(arms[a].sel[i]) - f(arms[b].sel[i]))); };
  const db = (a, b, idx, f = logLoss) => { const ii = okIdx(idx, a, b); return blockBootstrapCI(ii.map((i) => f(arms[a].sel[i]) - f(arms[b].sel[i])), ii.map((i) => blocks[i])); };
  const ll = (a, idx) => { const ii = idx.filter((i) => arms[a].sel[i]); return meanLoss(ii.map((i) => arms[a].sel[i])); };
  const res = { picks: {}, arms: {}, groups: {} };
  log('');
  log(`## 口径 ${mode}${mode === 'strict' ? '（主，决定采纳）' : '（只报告：docs/roster-results-update-verdict.md 原样先验）'}`);
  log('');
  log('各折选中（训练 = 其余三个评估季）与四季合并选出：');
  for (const a of ['R1s', 'R2']) { log(`- ${a}：${SEASONS.map((s) => `${s} ${arms[a].picks[s]}`).join('；')}；四季合并 ${arms[a].all}`); res.picks[a] = { folds: arms[a].picks, all: arms[a].all }; }
  const surf = GRID_R2.map((c) => `${cfgKey(c)} ${meanLoss(SEASONS.flatMap((s) => preds(mode, s, c))).toFixed(4)}`);
  log(`- 四季合并曲面（只看形状）：R0 ${meanLoss(arms.R0.sel).toFixed(4)}；${surf.join('；')}`);
  log('');
  log('| 方案 | log loss | Brier | 净胜分 MAE | Δ vs R0 按场 [95% CI] | Δ vs R0 按日分块 [95% CI] | Δ vs P0 按日分块 | ΔBrier vs R0 |');
  log('|---|---:|---:|---:|---|---|---|---|');
  const all = groups['LOSO 合并'];
  for (const a of Object.keys(arms)) {
    const ii = all.filter((i) => arms[a].sel[i]);
    const sel = ii.map((i) => arms[a].sel[i]);
    const mae = a === 'A' ? NaN : mean(sel.map((x) => Math.abs(x.pred - x.actual)));
    const row = { logloss: meanLoss(sel), brier: mean(sel.map(brier)), mae, n: ii.length };
    if (a !== 'R0') { row.vsR0 = d(a, 'R0', all); row.vsR0b = db(a, 'R0', all); row.brierVsR0 = d(a, 'R0', all, brier); }
    if (a !== 'P0') row.vsP0b = db(a, 'P0', all);
    res.arms[a] = row;
    log(`| ${a}${a === 'A' ? `（${ii.length} 场）` : ''} | ${row.logloss.toFixed(4)} | ${row.brier.toFixed(4)} | ${Number.isNaN(mae) ? '—' : mae.toFixed(2)} | ${row.vsR0 ? ci(row.vsR0) : '—'} | ${row.vsR0b ? ci(row.vsR0b) : '—'} | ${row.vsP0b ? ci(row.vsP0b) : '—'} | ${row.brierVsR0 ? ci(row.brierVsR0) : '—'} |`);
  }
  log('');
  log('分组（Δ log loss，样本外；CI 为按日分块 bootstrap，(按场) 另列）：');
  log('');
  log(`| 组 | n | R0 LL | R1s − R0 | R1s − R0 (按场) | R1 − R0 | R1s − P0 |${ieBy ? ' R1s − A |' : ''}`);
  log(`|---|---:|---:|---|---|---|---|${ieBy ? '---|' : ''}`);
  for (const [name, idx] of Object.entries(groups)) {
    const g = { n: idx.length, R0: ll('R0', idx), R1s: db('R1s', 'R0', idx), R1sGame: d('R1s', 'R0', idx), R1: db('R1', 'R0', idx), vsP0: db('R1s', 'P0', idx) };
    if (ieBy) g.vsA = db('R1s', 'A', idx);
    res.groups[name] = g;
    log(`| ${name} | ${g.n} | ${g.R0.toFixed(4)} | ${ci(g.R1s)} | ${ci(g.R1sGame)} | ${ci(g.R1)} | ${ci(g.vsP0)} |${ieBy ? ` ${ci(g.vsA)} |` : ''}`);
  }
  const r1 = res.arms.R1s.vsR0b; const r2 = res.groups[`${HOLDOUT}（最终留出）`].R1s.mean; const r3 = res.groups['(iii) 其余'].R1s.mean;
  const rules = [
    [`LOSO Δ(R1s − R0) 按日分块 95% 区间上界 < 0：${f4(r1.hi)}`, r1.hi < 0],
    [`最终留出 ${HOLDOUT} 点估计 Δ ≤ 0：${f4(r2)}`, r2 <= 0],
    [`第 (iii) 层点估计 Δ ≤ +0.002：${f4(r3)}`, r3 <= 0.002],
  ];
  res.rules = rules.map(([t, ok]) => ({ rule: t, pass: ok }));
  res.adopt = rules.every(([, ok]) => ok);
  log('');
  log(`预注册采纳规则（${mode}${mode === 'strict' ? '，决定采纳' : '，只报告'}）：`);
  for (const [t, ok] of rules) log(`- ${ok ? '通过' : '不通过'}：${t}`);
  log(`- 结论：${res.adopt ? `通过 → R1(s*=${arms.R1s.all}) 进影子` : '不通过 → 不采纳'}`);
  result.modes[mode] = res;
}
log('');
log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

fs.writeFileSync(path.join(DATA_DIR, 'roster-results-fix-lab.json'), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(DATA_DIR, '..', 'docs', 'roster-results-fix-lab-output.txt'), `${lines.join('\n')}\n`);
