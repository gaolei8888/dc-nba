/**
 * 伤病感知 Elo 实验（预注册：docs/superpowers/specs/2026-10-29-injury-aware-elo-prereg.md）。
 *
 *   npm run lab:injury-elo     # 纯离线：只读 data/backtest.json、data/teams.json、data/history/，不联网
 *
 * 输出：data/injury-elo-lab.json（gitignored，逐方案、逐折、逐层的数字）与 docs/injury-elo-lab-output.txt（文本摘要）。
 *
 * 方案：P0 生产 Elo；P1(β) 加赛前扣分；A(s) 伤病感知 Elo 更新 + 赛前扣分；E(β,c) 缺人多时少更新的对照；
 * P1L 伤病报告实验口径（近 10 场、缺席算 0）的赛前扣分，只报告。
 * 赛前缺阵 = 伤病报告实验的 06:30 报告链（延迟 15 分钟）× P(出场 | 状态)（每折只用其余赛季估）。
 * 赛后缺阵（stints 里谁没上场）只进 Elo 更新与分层，绝不进赛前扣分。
 * 球员价值 = 上季收缩 IMP（与 scripts/minutes-backtest.mjs 的 valuesUpto 同口径）。盘口不进任何输入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import { buildSamples, fit, apply, blend, mean, DECAY_SPAN, DECAY_HALFLIFE } from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { gameMinutes } from '../server/continuityLab.mjs';
import * as lab from '../server/lab.mjs';
import { bootstrapCI, phaseOf } from '../server/fusionLab.mjs';
import { STATUS_KEYS, matchName, nameIndex, playRates, tipMinutes, usualRotation } from '../server/injuryLab.mjs';
import { decisionInstant } from '../server/injuryReport.mjs';
import {
  replayElo, predictProb, reportUsable, etToMs, healthyRotation, preDeduction, postDeduction, strataOf,
} from '../server/injuryEloLab.mjs';
import { carryOver } from '../server/ratings.mjs';
import { seasonEloSequential } from '../server/injuryEloLab.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const INJ = process.env.INJURY_DIR ?? path.join(HISTORY, 'injury-reports');
const ALL = ['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'];
const EVAL = ALL.slice(1);
const HOLDOUT = '2025-26';
const GRID = [0.5, 0.75, 1.0];          // s（A）与 β（P1 / E / P1L）
const C_GRID = [5, 10, 20];             // E 的 c（每场净胜分）
const LAG_MIN = 15;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const t0 = Date.now();
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

const dataset = read(path.join(DATA_DIR, 'backtest.json'));
const teams = read(path.join(DATA_DIR, 'teams.json'));
const fullOf = new Map(teams.map((t) => [t.teamId, t.full]));
const abbrOf = new Map(teams.map((t) => [t.teamId, t.abbr]));
const players = {}; const lineups = {}; const stints = {};
for (const s of ALL) {
  players[s] = read(path.join(HISTORY, `impact_${s}.json`)).players.map((p) => ({ ...p, season: s }));
  lineups[s] = read(path.join(HISTORY, `lineups_${s}.json`)).rows;
  stints[s] = readJsonAuto(path.join(HISTORY, `stints_${s}.json.gz`));
}

// ---------------------------------------------------------------- 球员价值：逐字照抄 scripts/minutes-backtest.mjs 的 valuesUpto（收缩 IMP）
const apmBySeason = new Map(ALL.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })]));
function valuesUpto(upto) {
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
  const mu = mean(players[upto].map((p) => apply(spm, p)).filter((v) => v !== null));
  const out = new Map();
  for (const p of players[upto]) {
    const raw = blend(apply(spm, p), dec.get(p.playerId)?.apm ?? null);
    if (raw !== null) out.set(p.playerId, shrinkByMinutes(raw, (p.gp ?? 0) * (p.min ?? 0), mu, MINUTES_SHRINK) * scale);
  }
  return out;
}
// 季 X 的比赛用 valuesUpto(X−1)；2021-22 没有更早的 lineups，用 valuesUpto(2021-22)（只做热身，整季早于任何评估比赛）
const fitCache = new Map();
const valuesFor = (s) => {
  const upto = s === ALL[0] ? ALL[0] : ALL[ALL.indexOf(s) - 1];
  if (!fitCache.has(upto)) fitCache.set(upto, valuesUpto(upto));
  return fitCache.get(upto);
};

// ---------------------------------------------------------------- 赛前报告：06:30 链（与 injury-lab 同），逐份核对标注时间早于决策时点与开赛
const indexFile = read(path.join(INJ, 'index.json'));
const picks = indexFile[`picks_lag${LAG_MIN}`];
const reportCache = new Map();
const report = (name) => {
  if (!reportCache.has(name)) reportCache.set(name, read(path.join(INJ, 'json', `${name}.json`)));
  return reportCache.get(name);
};
const people = []; const seenId = new Set();
for (const s of ALL) for (const p of players[s]) if (!seenId.has(p.playerId)) { seenId.add(p.playerId); people.push({ id: p.playerId, name: p.name }); }
const nameById = new Map(people.map((p) => [p.id, p.name]));
const idx = nameIndex(people);
const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const audit = { teamGames: 0, withReport: 0, rows: 0, matched: 0, early: 0, timingRejected: 0, usedReports: 0 };

/** 一场比赛（两队）的赛前报告链与决策时点：06:30 前已开打的场用 22:00 那次 */
function chainFor(date, h, a) {
  const abbrs = [abbrOf.get(h), abbrOf.get(a)];
  const ofGame = (rep) => rep.rows.concat(rep.notSubmitted).filter((x) => x.gameDate === date
    && x.matchup && abbrs.every((ab) => x.matchup.split('@').includes(ab)));
  const p22 = picks[`${date}|22`]; const pPrev = picks[`${prevDay(date)}|0630`];
  const tipMin = p22 ? tipMinutes(ofGame(report(p22))[0]?.gameTime) : null;
  const tipMs = tipMin === null ? null : etToMs(date, tipMin);
  const d0630 = decisionInstant(date, '0630');
  if (tipMs !== null && tipMs <= d0630) { audit.early += 1; return { chain: [p22, pPrev], decision: decisionInstant(date, '22'), tipMs, ofGame }; }
  return { chain: [picks[`${date}|0630`], p22, pPrev], decision: d0630, tipMs, ofGame };
}
function statusesFor(cg, date, teamId, roster) {
  audit.teamGames += 1;
  const name = cg.chain.find((n) => {
    if (!n || !cg.ofGame(report(n)).length) return false;
    if (report(n).notSubmitted.some((x) => x.gameDate === date && x.team === fullOf.get(teamId))) return false;
    if (!reportUsable(n, cg.decision, cg.tipMs, LAG_MIN)) { audit.timingRejected += 1; return false; }
    return true;
  });
  if (!name) return null;
  audit.withReport += 1; audit.usedReports += 1;
  const st = new Map();
  for (const row of report(name).rows.filter((x) => x.gameDate === date && x.team === fullOf.get(teamId))) {
    const id = matchName(row.player, idx, roster, (i) => nameById.get(i));
    audit.rows += 1;
    if (id) { audit.matched += 1; st.set(id, row.status); }
  }
  return st;
}

// ---------------------------------------------------------------- 逐场上下文：健康基线 H、近 10 场基线、赛前状态、实际上场、D_post
const ctx = new Map();   // gameId -> { season, date, sides: { h, a }, dPost: { h, a } }
const teamSeqAll = new Map();   // `${season}|${team}` -> [{ gameId, absent, playedSet }]
let noStints = 0;
for (const s of ALL) {
  const val = valuesFor(s);
  const games = lab.expand(dataset.seasons[s]);
  const minsBy = new Map();      // pid -> Map(team -> [分钟…])
  const lastTeam = new Map();    // pid -> 最近一次出场的队
  const teamHist = new Map();    // team -> [{ date, mins: Map }]（有 stints 的场）
  for (let i = 0; i < games.length;) {
    let j = i;
    while (j < games.length && games[j].date === games[i].date) j += 1;
    const day = games.slice(i, j); i = j;
    const updates = [];
    for (const g of day) {
      const st = stints[s].games[g.gameId];
      const mins = st ? gameMinutes(st) : null;
      if (!mins || !mins.has(g.home.teamId) || !mins.has(g.away.teamId)) {
        noStints += 1;
        ctx.set(g.gameId, { season: s, date: g.date, sides: null, dPost: { h: 0, a: 0 } });
        continue;
      }
      const cg = chainFor(g.date, g.home.teamId, g.away.teamId);
      const side = (t) => {
        const hist = teamHist.get(t) ?? [];
        const cand = [...minsBy].filter(([pid, byT]) => byT.has(t) && lastTeam.get(pid) === t).map(([pid]) => pid);
        const status = statusesFor(cg, g.date, t, new Set(cand));
        const recent = new Set(hist.slice(-10).flatMap((x) => [...x.mins.keys()]));
        const elig = cand.filter((pid) => recent.has(pid) || status?.has(pid)).map((pid) => ({ id: pid, mins: minsBy.get(pid).get(t) }));
        const H = hist.length >= 3 ? healthyRotation(elig) : [];
        const usual = usualRotation(hist, g.date, 10);
        const playedSet = new Set(mins.get(t).keys());
        return { team: t, H, usual: usual ?? [], status, playedSet, dPost: postDeduction(H, playedSet, val) };
      };
      const h = side(g.home.teamId); const a = side(g.away.teamId);
      ctx.set(g.gameId, { season: s, date: g.date, sides: { h, a }, dPost: { h: h.dPost, a: a.dPost } });
      for (const x of [h, a]) {
        const k = `${s}|${x.team}`;
        if (!teamSeqAll.has(k)) teamSeqAll.set(k, []);
        teamSeqAll.get(k).push({ gameId: g.gameId, playedSet: x.playedSet, absent: new Set(x.H.filter((p) => p.m >= 20 && !x.playedSet.has(p.id)).map((p) => p.id)) });
      }
      updates.push(mins);
    }
    // 当日全部上下文记完再更新出场记录：同日的出场不进同日的基线
    for (const mins of updates) {
      for (const [t, m] of mins) {
        if (!teamHist.has(t)) teamHist.set(t, []);
        teamHist.get(t).push({ date: day[0].date, mins: m });
        for (const [pid, v] of m) {
          if (!minsBy.has(pid)) minsBy.set(pid, new Map());
          if (!minsBy.get(pid).has(t)) minsBy.get(pid).set(t, []);
          minsBy.get(pid).get(t).push(v);
          lastTeam.set(pid, t);
        }
      }
    }
  }
  console.log(`上下文 ${s} 完成（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
}
const strata = strataOf(teamSeqAll);

// ---------------------------------------------------------------- P(出场 | 状态)：每折只用其余赛季（含 2021-22）
const obs = [];
for (const c of ctx.values()) {
  if (!c.sides) continue;
  for (const x of [c.sides.h, c.sides.a]) {
    if (!x.status) continue;
    for (const p of x.H) obs.push({ season: c.season, status: x.status.get(p.id) ?? 'none', played: x.playedSet.has(p.id), w: p.m / 24 });
  }
}
const pTable = (seasons) => {
  const r = playRates(obs.filter((o) => seasons.includes(o.season) && o.status !== 'none'), (o) => o.w);
  return Object.fromEntries(STATUS_KEYS.map((k) => [k, r[k].p]));
};
const valCache = new Map(ALL.map((s) => [s, valuesFor(s)]));
/** gameId -> { h, a } 的赛前扣分（base: 'H' 健康基线 | 'usual' 近 10 场） */
function preD(pPlay, base) {
  const out = new Map();
  for (const [gid, c] of ctx) {
    if (!c.sides) { out.set(gid, { h: 0, a: 0 }); continue; }
    const val = valCache.get(c.season);
    const d = (x) => (x.status ? preDeduction(base === 'H' ? x.H : x.usual, (id) => x.status.get(id), pPlay, val) : 0);
    out.set(gid, { h: d(c.sides.h), a: d(c.sides.a) });
  }
  return out;
}

// ---------------------------------------------------------------- Elo 重放
const update = (gid) => { const d = ctx.get(gid)?.dPost; return d ? { dH: d.h, dA: d.a } : null; };
const P0 = replayElo(dataset, EVAL);
const prod = lab.replay(dataset, EVAL);
const maxDiff = Math.max(...P0.map((r, i) => (r.gameId === prod[i].gameId ? Math.abs(r.pred - prod[i].pred) : Infinity)));
if (maxDiff !== 0) throw new Error(`replayElo 与 lab.replay 不一致：${maxDiff}`);
const A = Object.fromEntries(GRID.map((s) => [s, replayElo(dataset, EVAL, { update, mode: { s } })]));
const E = Object.fromEntries(C_GRID.map((c) => [c, replayElo(dataset, EVAL, { update, mode: { s: 0, c } })]));
const recs = P0;   // 逐场顺序以 P0 为准（各重放同序）
for (const r of [...Object.values(A), ...Object.values(E)]) if (r.length !== recs.length || r.some((x, i) => x.gameId !== recs[i].gameId)) throw new Error('重放顺序不一致');

// ---------------------------------------------------------------- 候选 -> 逐场概率；LOSO 选参
const ll = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-12));
const candidates = (pre, preL) => ({
  P0: [{ key: '—', prob: (i) => lab.normalCdf(recs[i].pred, 12) }],
  P1: GRID.map((b) => ({ key: `β=${b}`, prob: (i) => { const d = pre.get(recs[i].gameId); return predictProb(recs[i].pred, d.h, d.a, b); } })),
  A: GRID.map((s) => ({ key: `s=${s}`, prob: (i) => { const d = pre.get(recs[i].gameId); return predictProb(A[s][i].pred, d.h, d.a, s); } })),
  E: GRID.flatMap((b) => C_GRID.map((c) => ({ key: `β=${b},c=${c}`, prob: (i) => { const d = pre.get(recs[i].gameId); return predictProb(E[c][i].pred, d.h, d.a, b); } }))),
  P1L: GRID.map((b) => ({ key: `β=${b}`, prob: (i) => { const d = preL.get(recs[i].gameId); return predictProb(recs[i].pred, d.h, d.a, b); } })),
  // 事后诊断（未预注册、不参与任何规则，参数固定不选）：拆开「更新」与「扣分幅度」各贡献多少
  xAupd: [{ key: 'A(s=0.75) 的 Elo、不扣赛前', prob: (i) => lab.normalCdf(A[0.75][i].pred, 12) }],
  xP1b75: [{ key: 'P0 Elo、扣 0.75·D_pre', prob: (i) => { const d = pre.get(recs[i].gameId); return predictProb(recs[i].pred, d.h, d.a, 0.75); } }],
  xAb50: [{ key: 'A(s=0.75) 的 Elo、扣 0.5·D_pre', prob: (i) => { const d = pre.get(recs[i].gameId); return predictProb(A[0.75][i].pred, d.h, d.a, 0.5); } }],
});
const ARMS = ['P0', 'P1', 'A', 'E', 'P1L'];
const DIAG = ['xAupd', 'xP1b75', 'xAb50'];
const oof = Object.fromEntries([...ARMS, ...DIAG].map((a) => [a, new Array(recs.length)]));
const picksBy = Object.fromEntries([...ARMS, ...DIAG].map((a) => [a, {}]));
const pTables = {};
const select = (cands, idxs) => {
  let best = null;
  for (const c of cands) {
    let s = 0;
    for (const i of idxs) s += ll(c.prob(i), recs[i].homeWin);
    if (!best || s / idxs.length < best.loss) best = { c, loss: s / idxs.length };   // 并列保留网格里靠前（较小）的
  }
  return best;
};
for (const hold of EVAL) {
  const pPlay = pTable(ALL.filter((s) => s !== hold));
  pTables[hold] = pPlay;
  const cands = candidates(preD(pPlay, 'H'), preD(pPlay, 'usual'));
  const train = recs.map((r, i) => (r.season !== hold && EVAL.includes(r.season) ? i : -1)).filter((i) => i >= 0);
  const test = recs.map((r, i) => (r.season === hold ? i : -1)).filter((i) => i >= 0);
  for (const arm of [...ARMS, ...DIAG]) {
    const b = select(cands[arm], train);
    picksBy[arm][hold] = b.c.key;
    for (const i of test) oof[arm][i] = b.c.prob(i);
  }
}
// 四季合起来选（影子要冻结的参数，只报告）
const pAll = pTable(ALL);

const frozenKey = (arm) => select(candidates(preD(pAll, 'H'), preD(pAll, 'usual'))[arm], recs.map((_, i) => i)).c.key;
// ---------------------------------------------------------------- 影子冻结参数（INJURY_ELO_FREEZE=1 时只写参数文件就退出，不碰实验输出）
// 影子预注册：docs/superpowers/specs/2026-10-29-injury-elo-shadow-prereg.md。s、β 是本实验四季合并选出的值（frozen）。
if (process.env.INJURY_ELO_FREEZE) {
  const LAST = ALL.at(-1);
  const S = 0.75; const BETA = 0.5;
  if (frozenKey('A') !== `s=${S}` || frozenKey('P1') !== `β=${BETA}`) throw new Error(`四季合并选出的参数变了：A ${frozenKey('A')}，P1 ${frozenKey('P1')}`);
  const lastGames = lab.expand(dataset.seasons[LAST]);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const startP = carryOver(seasonEloSequential(lastGames));
  const startA = carryOver(seasonEloSequential(lastGames, { update, mode: { s: S } }));
  const exact = new Map(teams.map((t) => [String(t.teamId), t.eloPreseasonExact]));
  const pDiff = Math.max(...Object.entries(startP).map(([id, v]) => Math.abs(v - (exact.get(id) ?? NaN))));
  if (!(pDiff < 1e-6)) throw new Error(`D=0 时的开季 Elo 与 teams.json 的 eloPreseasonExact 不一致：最大差 ${pDiff}`);
  const vals = valuesUpto(LAST);
  const out = {
    version: 1,
    note: '伤病感知 Elo 影子运行的冻结参数（scripts/injury-elo-lab.mjs 在 INJURY_ELO_FREEZE=1 时生成）。影子期内不改。',
    season: `${Number(LAST.slice(0, 4)) + 1}-${String(Number(LAST.slice(0, 4)) + 2).slice(2)}`,
    s: S, beta: BETA, spreadSd: 12, lagMin: LAG_MIN, window: 10, minGames: 3, eloPerPoint: 28, k: 20,
    valueOpts: { unknownV: -0.5, repl: -0.5 },
    valuesThrough: LAST,
    pPlay: Object.fromEntries(Object.entries(pAll).map(([k, v]) => [k, r6(v)])),
    eloStartA: Object.fromEntries(Object.entries(startA).map(([id, v]) => [id, r6(v)])),
    eloStartP: Object.fromEntries(Object.entries(startP).map(([id, v]) => [id, r6(v)])),
    values: Object.fromEntries([...vals].sort((x, y) => x[0] - y[0]).map(([id, v]) => [id, r6(v)])),
  };
  const file = path.join(DATA_DIR, '..', 'server', 'injury-elo-params-v1.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  const dA = Object.keys(startA).map((id) => startA[id] - startP[id]);
  console.log(`写出 ${file}：价值 ${vals.size} 人；A − P 开季 Elo 差 ${Math.min(...dA).toFixed(1)}..${Math.max(...dA).toFixed(1)}；D=0 开季 Elo 与线上最大差 ${pDiff}`);
  process.exit(0);
}
const candAll = candidates(preD(pAll, 'H'), preD(pAll, 'usual'));
const allIdx = recs.map((_, i) => i);
const frozen = Object.fromEntries(ARMS.map((a) => [a, select(candAll[a], allIdx).c.key]));
// 网格曲面（四季合并、用全部赛季的 P 表，只供看形状）
const surface = Object.fromEntries(['P1', 'A', 'E'].map((a) => [a, candAll[a].map((c) => ({ key: c.key, ll: allIdx.reduce((s, i) => s + ll(c.prob(i), recs[i].homeWin), 0) / allIdx.length }))]));

// ---------------------------------------------------------------- 指标
const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const metrics = (arm, idxs) => {
  let L = 0; let B = 0; let H = 0;
  for (const i of idxs) { const p = oof[arm][i]; const y = recs[i].homeWin ? 1 : 0; L += ll(p, y); B += (p - y) ** 2; H += ((p >= 0.5) === !!y) ? 1 : 0; }
  return { n: idxs.length, logloss: L / idxs.length, brier: B / idxs.length, hit: H / idxs.length };
};
const delta = (a, b, idxs) => {
  const d = idxs.map((i) => ll(oof[a][i], recs[i].homeWin) - ll(oof[b][i], recs[i].homeWin));
  const ci = bootstrapCI(d);
  return { mean: ci.mean, lo: ci.lo, hi: ci.hi, n: idxs.length };
};
const deltaBrier = (a, b, idxs) => bootstrapCI(idxs.map((i) => { const y = recs[i].homeWin ? 1 : 0; return (oof[a][i] - y) ** 2 - (oof[b][i] - y) ** 2; }));
const ciStr = (c) => `${f4(c.mean)} [${f4(c.lo)}, ${f4(c.hi)}]`;
const stratumOf = (i) => strata.get(recs[i].gameId) ?? 'iii';
const groups = {
  'LOSO 合并': allIdx,
  ...Object.fromEntries(EVAL.map((s) => [s === HOLDOUT ? `${s}（最终留出）` : s, allIdx.filter((i) => recs[i].season === s)])),
  '(i) 长期缺阵': allIdx.filter((i) => stratumOf(i) === 'i'),
  '(ii) 复出后 10 场': allIdx.filter((i) => stratumOf(i) === 'ii'),
  '(iii) 其余': allIdx.filter((i) => stratumOf(i) === 'iii'),
  '阶段 <10': allIdx.filter((i) => phaseOf(recs[i].teamGp) === '<10'),
  '阶段 10-19': allIdx.filter((i) => phaseOf(recs[i].teamGp) === '10-19'),
  '阶段 ≥20': allIdx.filter((i) => phaseOf(recs[i].teamGp) === '>=20'),
};

log('# 伤病感知 Elo 实验输出（npm run lab:injury-elo）');
log(`预注册：docs/superpowers/specs/2026-10-29-injury-aware-elo-prereg.md；运行于 ${new Date().toISOString()}`);
log('');
log('## 数据与审计');
log(`- 评估比赛 ${recs.length}（${EVAL.join(' / ')}），replayElo(D=0) 与 lab.replay 逐场最大差 ${maxDiff}`);
log(`- 没有 stints 的比赛（D 记 0、归 (iii)）：五季合计 ${noStints}；评估季 ${recs.filter((r) => !ctx.get(r.gameId)?.sides).length}`);
log(`- 赛前报告：${audit.withReport}/${audit.teamGames} 个队·场有可用报告；报告行匹配 ${audit.matched}/${audit.rows}（${(100 * audit.matched / audit.rows).toFixed(1)}%）；06:30 前已开打用 22:00 链的场 ${audit.early}`);
log(`- 时间核对：因「标注时间 + ${LAG_MIN} 分钟 > 决策时点」或「决策时点 ≥ 开赛」被拒的报告 ${audit.timingRejected} 次（预注册要求为 0）`);
const evalCtx = recs.map((r) => ctx.get(r.gameId)).filter((c) => c.sides);
const avgD = (f) => mean(evalCtx.flatMap((c) => [f(c.sides.h), f(c.sides.a)]));
log(`- 评估季平均 D_post（每队·场）${avgD((x) => x.dPost).toFixed(3)} 分；D_post>0 的队·场占 ${(100 * mean(evalCtx.flatMap((c) => [c.sides.h.dPost > 0 ? 1 : 0, c.sides.a.dPost > 0 ? 1 : 0]))).toFixed(1)}%；健康基线平均人数 ${avgD((x) => x.H.length).toFixed(1)}`);
const dPreAll = preD(pAll, 'H'); const dPreL = preD(pAll, 'usual');
log(`- 评估季平均 D_pre（全部赛季 P 表）：健康基线 ${mean(recs.flatMap((r) => [dPreAll.get(r.gameId).h, dPreAll.get(r.gameId).a])).toFixed(3)}；近 10 场基线 ${mean(recs.flatMap((r) => [dPreL.get(r.gameId).h, dPreL.get(r.gameId).a])).toFixed(3)}`);
log(`- 分层场数：(i) ${groups['(i) 长期缺阵'].length}，(ii) ${groups['(ii) 复出后 10 场'].length}，(iii) ${groups['(iii) 其余'].length}`);
log('');
log('## P(出场 | 状态)（每折只用其余赛季，健康基线球员按基线分钟加权）');
for (const h of EVAL) log(`- 留出 ${h}：${STATUS_KEYS.map((k) => `${k} ${pTables[h][k].toFixed(3)}`).join('  ')}`);
log('');
log('## 各折选中的参数（训练 = 其余三个评估季）');
for (const arm of ARMS) log(`- ${arm}：${EVAL.map((s) => `${s} ${picksBy[arm][s]}`).join('；')}；四季合并选 ${frozen[arm]}`);
log('');
log('## 网格曲面（四季合并 log loss，P 表用全部赛季，只看形状）');
for (const [a, rows] of Object.entries(surface)) log(`- ${a}：${rows.map((r) => `${r.key} ${r.ll.toFixed(4)}`).join('；')}`);
log('');
log('## 各方案（样本外，LOSO 合并）');
log('| 方案 | log loss | Brier | 命中率 | Δ vs P1 [95% CI] | Δ vs P0 [95% CI] | Brier Δ vs P1 |');
log('|---|---:|---:|---:|---|---|---|');
const result = { arms: {}, groups: {}, picks: picksBy, frozen, pTables, surface, audit, noStints };
for (const arm of ARMS) {
  const m = metrics(arm, allIdx);
  const v1 = arm === 'P1' ? null : delta(arm, 'P1', allIdx);
  const v0 = arm === 'P0' ? null : delta(arm, 'P0', allIdx);
  const b1 = arm === 'P1' ? null : deltaBrier(arm, 'P1', allIdx);
  result.arms[arm] = { ...m, vsP1: v1, vsP0: v0, brierVsP1: b1 };
  log(`| ${arm} | ${m.logloss.toFixed(4)} | ${m.brier.toFixed(4)} | ${(100 * m.hit).toFixed(2)}% | ${v1 ? ciStr(v1) : '—'} | ${v0 ? ciStr(v0) : '—'} | ${b1 ? ciStr(b1) : '—'} |`);
}
log('');
log('## 分组（Δ log loss，样本外）');
log('| 组 | n | P0 LL | A − P1 | A − P0 | P1 − P0 | E − P1 | A − E | P1L − P0 |');
log('|---|---:|---:|---|---|---|---|---|---|');
for (const [name, idxs] of Object.entries(groups)) {
  const row = {
    n: idxs.length, P0: metrics('P0', idxs).logloss,
    AvsP1: delta('A', 'P1', idxs), AvsP0: delta('A', 'P0', idxs), P1vsP0: delta('P1', 'P0', idxs),
    EvsP1: delta('E', 'P1', idxs), AvsE: delta('A', 'E', idxs), P1LvsP0: delta('P1L', 'P0', idxs),
    metrics: Object.fromEntries(ARMS.map((a) => [a, metrics(a, idxs)])),
  };
  result.groups[name] = row;
  log(`| ${name} | ${row.n} | ${row.P0.toFixed(4)} | ${ciStr(row.AvsP1)} | ${ciStr(row.AvsP0)} | ${ciStr(row.P1vsP0)} | ${ciStr(row.EvsP1)} | ${ciStr(row.AvsE)} | ${ciStr(row.P1LvsP0)} |`);
}
log('');
const r1 = result.arms.A.vsP1;
const r2 = result.groups[`${HOLDOUT}（最终留出）`].AvsP1.mean;
const r3 = result.groups['(iii) 其余'].AvsP1.mean;
const rules = [
  [`LOSO Δ(A − P1) 95% 区间上界 < 0：${f4(r1.hi)}`, r1.hi < 0],
  [`最终留出 ${HOLDOUT} 点估计 Δ(A − P1) ≤ 0：${f4(r2)}`, r2 <= 0],
  [`第 (iii) 层点估计 Δ(A − P1) ≤ +0.002：${f4(r3)}`, r3 <= 0.002],
];
result.rules = rules.map(([t, ok]) => ({ rule: t, pass: ok }));
result.adopt = rules.every(([, ok]) => ok);
log('## 预注册采纳规则（A(s*) 进影子运行，三条同时满足）');
for (const [t, ok] of rules) log(`- ${ok ? '通过' : '不通过'}：${t}`);
log(`- 结论：${result.adopt ? '通过 → A 进影子运行' : '不通过 → 不采纳'}`);
log('');
log('## 事后诊断（未预注册，参数固定，不参与任何规则）');
log('| 诊断 | log loss | Δ vs P0 | Δ vs P1 | A − 它 |');
log('|---|---:|---|---|---|');
result.diagnostics = {};
for (const d of DIAG) {
  const row = { label: candAll[d][0].key, ...metrics(d, allIdx), vsP0: delta(d, 'P0', allIdx), vsP1: delta(d, 'P1', allIdx), AvsIt: delta('A', d, allIdx) };
  result.diagnostics[d] = row;
  log(`| ${row.label} | ${row.logloss.toFixed(4)} | ${ciStr(row.vsP0)} | ${ciStr(row.vsP1)} | ${ciStr(row.AvsIt)} |`);
}
log('');
log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

fs.writeFileSync(path.join(DATA_DIR, 'injury-elo-lab.json'), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(DATA_DIR, '..', 'docs', 'injury-elo-lab-output.txt'), `${lines.join('\n')}\n`);
