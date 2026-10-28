/**
 * 伤病报告实验：用决策时点「当时能看到」的官方伤病报告估计缺阵，修正生产 Elo 的预测，看样本外 log loss。
 *
 *   node scripts/injury-history.mjs     # 先抓报告（data/history/injury-reports，可用 INJURY_DIR 指到别处）
 *   node scripts/injury-lab.mjs         # 纯离线，除首次取一次 commonallplayers（球员姓名表，缓存）外不发请求
 *
 * 口径与 oracle 上界完全一致（docs/injury-report-experiment-verdict.md）：
 *   球员价值 = 每周重拟合、只用决策日之前数据的段级 RAPM（λ=2000，往季按 0.5^年 衰减）；
 *   常规轮换 = 前 10 场场均分钟；调整 = min(0, 今天预期轮换价值 − 常规)；
 *   预测净胜分 += β·(主调整 − 客调整)，β 只在训练季按 log loss 选（留一季交叉验证）。
 * 唯一的区别：oracle 用「赛后知道谁上了场」，这里用报告状态 × P(出场 | 状态)（只用训练季估）。
 * 盘口只作事后诊断（与盘口的差距、看好热门的程度、模拟投注），不进任何输入和选参。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as lab from '../server/lab.mjs';
import { computeRapm } from '../server/stintRapm.mjs';
import { bootstrapCI, phaseOf } from '../server/fusionLab.mjs';
import { nbaGet, statsUrl, toRows } from '../server/nbaClient.mjs';
import { decisionInstant, toEt } from '../server/injuryReport.mjs';
import { STATUS_KEYS, matchName, nameIndex, playRates, reportAdj, rotValue, tipMinutes } from '../server/injuryLab.mjs';
import { gamesFrom, placeBets, summarize, PRIMARY, TUNING_SEASON } from '../server/paperBetting.mjs';
import { US_BOOKS } from '../server/books.mjs';

const DIR = process.env.INJURY_DIR ?? 'data/history/injury-reports';
const ALL = ['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'];
const EVAL = ALL.slice(1);
const W = 10; const LAMBDA = 2000; const REFIT_DAYS = 7; const OPTS = { unknownV: -1, repl: -2 };
const SLOTS = ['22', '0630'];
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const dataset = read('data/backtest.json');

// ---------------------------------------------------------------- 段数据 -> 每场每队上场分钟
const dateOf = new Map();
for (const s of ALL) for (const r of dataset.seasons[s]) dateOf.set(r.i, r.d);
const games = {};
for (const s of ALL) {
  const f = JSON.parse(zlib.gunzipSync(fs.readFileSync(`data/history/stints_${s}.json.gz`)));
  games[s] = Object.entries(f.games).map(([gid, [home, away, st]]) => {
    const mh = new Map(); const ma = new Map();
    for (const x of st) {
      for (let i = 0; i < 5; i++) mh.set(x[i], (mh.get(x[i]) ?? 0) + x[14] / 60);
      for (let i = 5; i < 10; i++) ma.set(x[i], (ma.get(x[i]) ?? 0) + x[14] / 60);
    }
    return { gid, date: dateOf.get(gid), home, away, st, mins: { [home]: mh, [away]: ma } };
  }).filter((g) => g.date).sort((a, b) => a.date.localeCompare(b.date) || a.gid.localeCompare(b.gid));
}
const firstGame = new Map();   // `${赛季}|${队}` -> Map(id -> 本季第一次为该队上场的日期)；姓名消歧只用比赛日之前的
for (const s of ALL) for (const g of games[s]) for (const t of [g.home, g.away]) {
  const k = `${s}|${t}`;
  if (!firstGame.has(k)) firstGame.set(k, new Map());
  for (const id of g.mins[t].keys()) if (!firstGame.get(k).has(id)) firstGame.get(k).set(id, g.date);
}
const rosterBefore = (season, team, date) => new Set([...(firstGame.get(`${season}|${team}`) ?? [])].filter(([, d]) => d < date).map(([id]) => id));

// ---------------------------------------------------------------- 常规轮换 + 当时的 RAPM（与 oracle 同一套，缓存）
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
function fitAsOf(season, date) {
  const si = ALL.indexOf(season);
  const merged = [];
  for (let a = 0; a <= 2; a++) {
    const s = ALL[si - a];
    if (!s) continue;
    const w = 0.5 ** a;
    for (const g of games[s]) {
      if (a === 0 && g.date >= date) continue;
      for (const x of g.st) merged.push(w === 1 ? x : [...x.slice(0, 10), x[10] * w, x[11] * w, x[12] * w, x[13] * w, x[14]]);
    }
  }
  const v = new Map();
  for (const [k, o] of computeRapm(merged, { lambda: LAMBDA, minPoss: 0.25 })) if (k !== '__hca') v.set(k, o.rapm);
  return v;
}
const CTX = 'data/history/injury-lab-context.json';
let ctx;   // gid -> { season, date, h|a: { team, usual:[{id,m}], val:{id:v}|null, today:[id], prev:[id] } }
if (fs.existsSync(CTX)) ctx = read(CTX);
else {
  ctx = {};
  for (const season of ALL) {
    const hist = new Map();
    let val = null; let lastFit = -1e9;
    for (const g of games[season]) {
      const dn = dayNum(g.date);
      if (EVAL.includes(season) && dn - lastFit >= REFIT_DAYS) { val = fitAsOf(season, g.date); lastFit = dn; }
      const out = { season, date: g.date };
      for (const [side, t] of [['h', g.home], ['a', g.away]]) {
        const past = (hist.get(t) ?? []).slice(-W);
        const today = [...g.mins[t].keys()];
        if (past.length < 3) { out[side] = { team: t, usual: null, today }; continue; }
        const tot = new Map();
        for (const mm of past) for (const [id, m] of mm) tot.set(id, (tot.get(id) ?? 0) + m);
        const usual = [...tot].map(([id, m]) => ({ id, m: m / past.length }));
        out[side] = {
          team: t, usual, today, prev: [...past[past.length - 1].keys()],
          val: val ? Object.fromEntries(usual.map((p) => [p.id, val.get(p.id) ?? null]).filter(([, v]) => v !== null)) : null,
        };
      }
      ctx[g.gid] = out;
      for (const t of [g.home, g.away]) { if (!hist.has(t)) hist.set(t, []); hist.get(t).push(g.mins[t]); }
    }
    console.log(`上下文 ${season} 完成`);
  }
  fs.writeFileSync(CTX, JSON.stringify(ctx));
}

// ---------------------------------------------------------------- 报告 -> 每场每队每个时点的状态
const LAG_MIN = Number(process.env.INJURY_LAG_MIN ?? 15);   // 与 injury-history.mjs 同一个延迟口径
const indexFile = read(path.join(DIR, 'index.json'));
const index = { missing: indexFile.missing, picks: indexFile[`picks_lag${LAG_MIN}`] ?? (LAG_MIN === 0 ? indexFile.picks : null) };
if (!index.picks) throw new Error(`还没有延迟 ${LAG_MIN} 分钟的报告选择：先 INJURY_LAG_MIN=${LAG_MIN} node scripts/injury-history.mjs`);
const reportCache = new Map();
const report = (name) => {
  if (!reportCache.has(name)) reportCache.set(name, read(path.join(DIR, 'json', `${name}.json`)));
  return reportCache.get(name);
};
const teams = read('data/teams.json');
const fullOf = new Map(teams.map((t) => [t.teamId, t.full]));   // 与报告里的队名逐字一致（30/30 核过）
const abbrOf = new Map(teams.map((t) => [t.teamId, t.abbr]));

const people = toRows(await nbaGet(statsUrl('commonallplayers', { LeagueID: '00', Season: '2025-26', IsOnlyCurrentSeason: 0 }), { cache: true }))
  .map((p) => ({ id: p.PERSON_ID, name: p.DISPLAY_FIRST_LAST }));
const nameById = new Map(people.map((p) => [p.id, p.name]));
const idx = nameIndex(people);

const match = { rows: 0, matched: 0, unmatched: new Map() };
const cover = Object.fromEntries(SLOTS.map((s) => [s, { teamGames: 0, direct: 0, fallback: 0, none: 0, early: 0 }]));
const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
/** gid|side|slot -> Map(id -> 状态)，或 null（没有可用信息，调整记 0） */
const statusAt = new Map();
for (const [gid, c] of Object.entries(ctx)) {
  const teamsInGame = [c.h.team, c.a.team];
  const ofGame = (rep) => rep.rows.concat(rep.notSubmitted).filter((x) => x.gameDate === c.date
    && x.matchup && teamsInGame.every((t) => x.matchup.split('@').includes(abbrOf.get(t))));
  const p22 = index.picks[`${c.date}|22`];
  const pPrev = index.picks[`${prevDay(c.date)}|0630`];   // 前一天傍晚那份已经列了今天的比赛
  for (const slot of SLOTS) {
    // 决策时能看到的报告，从新到旧；某队在新的那份里「还没交」就往前找它交过的那份
    let chain = [p22, pPrev];
    if (slot === '0630') {
      const tip = p22 ? tipMinutes(ofGame(report(p22))[0]?.gameTime) : null;
      // 06:30 那次时这场已经开打（下午场）：这场的决策还是 22:00 那次的
      if (tip !== null && tip <= toEt(decisionInstant(c.date, '0630')).min) cover[slot].early += 2;
      else chain = [index.picks[`${c.date}|0630`], p22, pPrev];
    }
    for (const side of ['h', 'a']) {
      const t = c[side].team;
      cover[slot].teamGames++;
      const k = chain.findIndex((name) => name && ofGame(report(name)).length
        && !report(name).notSubmitted.some((x) => x.gameDate === c.date && x.team === fullOf.get(t)));
      if (k < 0) { cover[slot].none++; statusAt.set(`${gid}|${side}|${slot}`, null); continue; }
      cover[slot][k === 0 ? 'direct' : 'fallback']++;
      const st = new Map();
      for (const row of report(chain[k]).rows.filter((x) => x.gameDate === c.date && x.team === fullOf.get(t))) {
        const id = matchName(row.player, idx, rosterBefore(c.season, t, c.date), (i) => nameById.get(i));
        if (slot === '22') { match.rows++; if (id) match.matched++; else match.unmatched.set(row.player, (match.unmatched.get(row.player) ?? 0) + 1); }
        if (id) st.set(id, row.status);
      }
      statusAt.set(`${gid}|${side}|${slot}`, st);
    }
  }
}

// ---------------------------------------------------------------- P(出场 | 状态)：只在训练季估
// 观测 = 常规轮换里（前 10 场有分钟）且上了报告的人，按常规分钟加权（24 分钟算 1 个观测）——调整就是按分钟乘 p
const obs = Object.fromEntries(SLOTS.map((s) => [s, []]));
for (const [gid, c] of Object.entries(ctx)) for (const side of ['h', 'a']) for (const slot of SLOTS) {
  const st = statusAt.get(`${gid}|${side}|${slot}`);
  if (!st || !c[side].usual) continue;
  const today = new Set(c[side].today);
  for (const p of c[side].usual) {
    const s = st.get(p.id);
    obs[slot].push({ season: c.season, status: s ?? 'none', played: today.has(p.id), w: p.m / 24 });
  }
}
const rates = (slot, seasons) => {
  const o = obs[slot].filter((x) => seasons.includes(x.season));
  const out = playRates(o.filter((x) => x.status !== 'none'), (x) => x.w);
  const none = o.filter((x) => x.status === 'none');
  out.none = { n: none.length, p: none.reduce((s, x) => s + x.w * x.played, 0) / none.reduce((s, x) => s + x.w, 0) };
  return out;
};

// ---------------------------------------------------------------- 各方案的调整量
const valMap = (side) => new Map(Object.entries(side.val ?? {}).map(([k, v]) => [Number(k), v]));
function adjFor(variant, pPlay) {
  const out = new Map();
  for (const [gid, c] of Object.entries(ctx)) {
    if (!EVAL.includes(c.season)) continue;
    const o = {};
    for (const side of ['h', 'a']) {
      const x = c[side];
      if (!x.usual) { o[side] = 0; continue; }
      const val = valMap(x);
      const base = rotValue(x.usual, val, OPTS);
      if (variant === 'oracle') { const t = new Set(x.today); o[side] = Math.min(0, rotValue(x.usual.filter((p) => t.has(p.id)), val, OPTS) - base); }
      else if (variant === 'persist') { const t = new Set(x.prev); o[side] = Math.min(0, rotValue(x.usual.filter((p) => t.has(p.id)), val, OPTS) - base); }
      else {
        const st = statusAt.get(`${gid}|${side}|${variant.slice(1)}`);
        o[side] = st ? reportAdj(x.usual, (id) => st.get(id), pPlay, val, OPTS) : 0;
      }
    }
    out.set(gid, o.h - o.a);
  }
  return out;
}

// ---------------------------------------------------------------- 评估（与 oracle 同：LOSO 选 β，按场配对 bootstrap）
const recs = lab.replay(dataset, EVAL);
const ll = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-12));
const base = (r) => lab.normalCdf(r.pred, 12);
const BETAS = Array.from({ length: 41 }, (_, i) => i * 0.05);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const ci = (d) => { const b = bootstrapCI(d); return `${f4(b.mean)} [${f4(b.lo)}, ${f4(b.hi)}]`; };

const pTables = {};
function evaluate(variant) {
  const prob = new Map();   // gameId -> 该方案在其留出季下的概率
  const betas = {};
  for (const hold of EVAL) {
    const trainSeasons = ALL.filter((s) => s !== hold);
    let adj;
    if (variant.startsWith('r')) {
      const rt = rates(variant.slice(1), trainSeasons);
      pTables[`${variant}|${hold}`] = rt;
      adj = adjFor(variant, Object.fromEntries(STATUS_KEYS.map((s) => [s, rt[s].p])));
    } else adj = adjFor(variant);
    const train = recs.filter((r) => r.season !== hold);
    let best = 0; let bl = Infinity;
    for (const b of BETAS) {
      const l = mean(train.map((r) => ll(lab.normalCdf(r.pred + b * (adj.get(r.gameId) ?? 0), 12), r.homeWin)));
      if (l < bl) { bl = l; best = b; }
    }
    betas[hold] = best;
    for (const r of recs.filter((x) => x.season === hold)) prob.set(r.gameId, lab.normalCdf(r.pred + best * (adj.get(r.gameId) ?? 0), 12));
  }
  return { prob, betas };
}

console.log(`伤病报告实验  W=${W} λ=${LAMBDA} 每 ${REFIT_DAYS} 天重拟合  比赛 ${recs.length}  报告延迟 ${LAG_MIN} 分钟`);
const picks = Object.values(index.picks);
console.log(`报告：时点 ${picks.length} 个，找到 ${picks.filter(Boolean).length}；PDF ${fs.readdirSync(path.join(DIR, 'pdf')).length} 份；已确认不存在 ${index.missing.length} 个文件名`);
console.log(`姓名匹配（22:00 报告、我们数据里的比赛）：${match.matched}/${match.rows} = ${(100 * match.matched / match.rows).toFixed(1)}%`);
console.log('  未匹配（次数最多的 25 个）：', [...match.unmatched].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, k]) => `${n}×${k}`).join('; '));
for (const s of SLOTS) console.log(`覆盖 ${s}:`, cover[s]);

for (const slot of SLOTS) {
  const all = rates(slot, ALL);
  console.log(`\nP(出场 | 状态) ${slot === '22' ? '22:00' : '06:30'} 报告，全部赛季（常规轮换球员，按分钟加权；n=人次）`);
  for (const s of [...STATUS_KEYS, 'none']) console.log(`  ${s.padEnd(12)} n=${String(all[s].n).padStart(6)}  p=${all[s].p.toFixed(3)}`);
}

const variants = { oracle: 'oracle（赛后知道谁上场，上界）', persist: '沿用上一场缺阵（无报告）', r22: '22:00 报告', r0630: '06:30 报告' };
const results = {};
for (const [v, label] of Object.entries(variants)) {
  const { prob, betas } = evaluate(v);
  results[v] = prob;
  const d = recs.map((r) => ll(prob.get(r.gameId), r.homeWin) - ll(base(r), r.homeWin));
  console.log(`\n[${label}] β 各留出季：${EVAL.map((s) => `${s} ${betas[s].toFixed(2)}`).join('  ')}`);
  console.log(`  生产 LL ${mean(recs.map((r) => ll(base(r), r.homeWin))).toFixed(4)}  LOSO Δ ${ci(d)}`);
  for (const s of EVAL) {
    const dd = recs.map((r, i) => (r.season === s ? d[i] : null)).filter((x) => x !== null);
    console.log(`   ${s}${s === '2025-26' ? '（最终留出）' : ''} n=${dd.length} Δ ${ci(dd)}`);
  }
  for (const ph of ['<10', '10-19', '>=20']) {
    const dd = recs.map((r, i) => (phaseOf(r.teamGp) === ph ? d[i] : null)).filter((x) => x !== null);
    console.log(`   阶段 ${ph.padEnd(5)} n=${dd.length} Δ ${ci(dd)}`);
  }
  const br = recs.map((r) => ((r.homeWin ? 1 : 0) - prob.get(r.gameId)) ** 2 - ((r.homeWin ? 1 : 0) - base(r)) ** 2);
  console.log(`  Brier Δ ${ci(br)}`);
  // 事后诊断：与盘口的差距、对盘口热门的低估（不参与任何选择）
  const mk = recs.filter((r) => r.mktProb !== null);
  const mll = mean(mk.map((r) => ll(r.mktProb, r.homeWin)));
  const fav = (pf) => { let pm = 0; let w = 0; for (const r of mk) { const hf = r.mktProb >= 0.5; pm += hf ? pf(r) : 1 - pf(r); w += (hf === r.homeWin) ? 1 : 0; } return 100 * (pm - w) / mk.length; };
  console.log(`  诊断：盘口 LL ${mll.toFixed(4)}，差距 生产 ${f4(mean(mk.map((r) => ll(base(r), r.homeWin))) - mll)} -> ${f4(mean(mk.map((r) => ll(prob.get(r.gameId), r.homeWin))) - mll)}；`
    + `盘口热门 预测−实际 生产 ${fav(base).toFixed(1)}pp -> ${fav((r) => prob.get(r.gameId)).toFixed(1)}pp`);
}
// 两个报告时点之间、报告与 oracle 之间的直接配对比较
for (const [a, b] of [['r0630', 'r22'], ['r22', 'persist'], ['r0630', 'oracle']]) {
  const d = recs.map((r) => ll(results[a].get(r.gameId), r.homeWin) - ll(results[b].get(r.gameId), r.homeWin));
  console.log(`配对 ${a} − ${b}: Δ ${ci(d)}`);
}

// 训练季估出的 P 表（每个留出季一张），文档要的是「只用训练季」
for (const slot of SLOTS) {
  console.log(`\nP 表（${slot}，按留出季，只用其余赛季估）：`);
  for (const hold of EVAL) {
    const t = pTables[`r${slot}|${hold}`];
    console.log(`  留出 ${hold}: ${STATUS_KEYS.map((s) => `${s} ${t[s].p.toFixed(3)}`).join('  ')}`);
  }
}

// ---------------------------------------------------------------- 预注册的模拟投注规则，只报告（docs/paper-betting-verdict.md）
console.log('\n模拟投注（预注册规则，只报告不调参；样本外 = 2022-23 之后）');
const books = {};
for (const s of EVAL) { const f = `data/history/books_${s}.json`; if (fs.existsSync(f)) books[s] = read(f).games ?? {}; }
const pct = (v) => (v == null ? '—' : `${(100 * v).toFixed(1)}%`);
for (const v of ['base', ...Object.keys(variants)]) {
  const rs = recs.map((r) => ({ ...r, p: v === 'base' ? base(r) : results[v].get(r.gameId) }));
  const g = EVAL.flatMap((s) => (books[s] ? gamesFrom(rs.filter((r) => r.season === s), books[s]) : []));
  const oos = g.filter((x) => x.season > TUNING_SEASON);
  const dk = summarize(placeBets(oos, { book: 'draftkings', threshold: PRIMARY }), { B: 2000 });
  const best = summarize(placeBets(oos, { book: 'best', threshold: PRIMARY, pool: US_BOOKS }), { B: 2000 });
  console.log(`  ${v.padEnd(8)} DK≥3% ${dk.bets} 注 ROI ${pct(dk.roi)} [${pct(dk.ci.lo)}, ${pct(dk.ci.hi)}]  `
    + `最优价≥3% ${best.bets} 注 ROI ${pct(best.roi)} [${pct(best.ci.lo)}, ${pct(best.ci.hi)}]`);
}
