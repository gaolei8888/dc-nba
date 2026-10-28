/**
 * 当前阵容榜示意：实验 1（IMP 按分钟收缩）与实验 2（延续度混合）放到今天的快照上会怎样。
 *
 *   node scripts/impact-shrink-board.mjs [legacy-rows.json] [market.json]
 *
 * 只读 data/*.json 与 data/history/，不抓数据，不改线上。
 * 旧 Elo 榜（OLD）由 predict.mjs 现算，与 /api/rankings 默认口径相同。
 * 第二个参数可选：盘口让分（{gameId:{home,away,neutral,spread}}）。给了就算一次
 * 「盘口隐含实力」与各榜的相关——**只作事后诊断，不参与任何拟合或选择**。
 *
 * 球员价值的四个版本：
 *   V0 快照原样（注意：本机快照的 IMP 是纯 SPM，见下方检查）
 *   V1 补回 APM：按 impact-model 的设计用近 3 季衰减 APM 重算上季 IMP，本季混合同 ingest（K=20 场）
 *   V2 V1 + 实验 1 收缩（shrinkByMinutes，k=3200、pivot=1600 分钟）
 *   V3 V0 + 实验 1 收缩（假如线上仍缺五人组合数据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson, readJsonAuto } from '../server/nbaClient.mjs';
import { decayedApm } from '../server/rapm.mjs';
import { impactOf, apply as spmOf, MIN_GP, corr, mean } from '../server/impact.mjs';
import { shrinkByMinutes } from '../server/impactShrink.mjs';
import { liveRosterRankings } from '../server/liveRosterRankings.mjs';
import { buildModel, powerRankings } from '../server/predict.mjs';
import { gameMinutes, continuity, strength } from '../server/continuityLab.mjs';
import { ELO_BASE, ELO_PER_POINT } from '../server/ratings.mjs';

const store = {
  teams: readJson('teams.json'), players: readJson('players.json'), schedule: readJson('schedule.json'),
  meta: readJson('meta.json'), injuries: readJson('injuries.json') ?? { players: [] }, impactModel: readJson('impact-model.json'),
};
const model = store.impactModel;
const HISTORY = path.join(DATA_DIR, 'history');

// ---- 快照里的 IMP 是否含 APM：与纯 SPM 逐人比
const withImp = store.players.filter((p) => Number.isFinite(p.impact));
const pureSpm = withImp.filter((p) => Math.abs(spmOf(model, p) - p.impact) < 0.006).length;
console.log(`\n快照 ${store.meta.fetchedAt}：${withImp.length} 人有 IMP，其中 ${pureSpm} 人 IMP 恰等于纯 SPM`
  + `${pureSpm === withImp.length ? '——快照里的 IMP 没有混入 APM（ingest 时缺 data/history/lineups_*.json）' : ''}`);

// ---- 四个版本的球员价值
const seasons = ['2023-24', '2024-25', '2025-26'];
const dec = decayedApm(seasons.map((s) => ({ season: s, rows: JSON.parse(fs.readFileSync(path.join(HISTORY, `lineups_${s}.json`), 'utf8')).rows })),
  { span: model.decaySpan ?? 3, halfLife: model.decayHalfLife ?? 1, lambda: model.apmLambda ?? 6000 });
const spmPool = store.players.map((p) => spmOf(model, p)).filter((v) => v !== null);
const mu = mean(spmPool); // 与实验同口径：上季够门槛球员 SPM 的简单均值（已含量纲）
const K = 20; // ingest 的 IMP_PRIOR_GAMES
const currentImpact = (c, prior) => {
  const cur = spmOf(model, c, { minGp: prior === null ? MIN_GP : 1 });
  if (prior === null) return cur;
  if (cur === null) return prior;
  return Math.round(((K * prior + (c.gp ?? 0) * cur) / (K + (c.gp ?? 0))) * 100) / 100;
};
const round = (v) => (v === null ? null : Math.round(v * 100) / 100);
function variant(priorOf) {
  return store.players.map((p) => {
    const prior = priorOf(p);
    const cur = p.cur ? { ...p.cur, impact: p.cur.gp > 0 ? currentImpact(p.cur, prior) : p.cur.impact } : p.cur;
    return { ...p, impact: prior ?? undefined, cur };
  });
}
const v1Prior = (p) => impactOf(model, p, dec.get(p.playerId)?.apm ?? null);
const VARIANTS = {
  V0: store.players,
  V1: variant(v1Prior),
  V2: variant((p) => round(shrinkByMinutes(v1Prior(p), (p.gp ?? 0) * (p.min ?? 0), mu))),
  V3: variant((p) => round(shrinkByMinutes(Number.isFinite(p.impact) ? p.impact : null, (p.gp ?? 0) * (p.min ?? 0), mu))),
};

console.log(`人群均值 μ=${mu.toFixed(2)}；部分球员上季 IMP（V0 快照 → V1 补 APM → V2 补 APM 且收缩 → V3 只收缩）：`);
for (const name of ['Matisse Thybulle', 'Luka Dončić', 'Jalen Brunson', 'Paul Reed', 'Obi Toppin', 'Dru Smith', 'Shai Gilgeous-Alexander', 'Nikola Jokić', 'LaMelo Ball', 'Trae Young']) {
  const vals = Object.values(VARIANTS).map((ps) => ps.find((p) => p.name === name));
  if (!vals[0]) continue;
  console.log(`  ${name.padEnd(24)} ${String(vals[0].teamAbbr).padEnd(4)} ${String(Math.round(vals[0].gp * vals[0].min)).padStart(5)} 分钟  `
    + vals.map((p) => (Number.isFinite(p.impact) ? p.impact.toFixed(2) : '—').padStart(6)).join(' →'));
}

// ---- 各版本的阵容榜；旧 Elo 榜作 OLD
const legacy = powerRankings(buildModel(store, {}), {}).map((r) => ({ ...r }));
const boards = {};
for (const [k, ps] of Object.entries(VARIANTS)) {
  boards[k] = new Map(liveRosterRankings({ ...store, players: ps }, legacy, { availability: 'reported' }).map((r) => [r.abbr ?? store.teams.find((t) => t.teamId === r.teamId).abbr, r]));
}

// ---- 实验 2 示意（不采纳，只看它会把谁挪到哪）：延续度 = 近 82 场里当前名单球员的分钟占比
const cfgPath = process.env.CONT_CFG;
const cont = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')).all : { mode: 'lin', beta: 0.5, a: 1.25, sd: 11, value: 'shrunk' };
const prevSt = readJsonAuto(path.join(HISTORY, 'stints_2025-26.json.gz'));
const curSt = readJsonAuto(path.join(HISTORY, 'shadow', 'stints_2026-27.json.gz'));
const teamGames = new Map();
for (const file of [prevSt, curSt]) {
  for (const gid of Object.keys(file?.games ?? {}).sort()) {
    for (const [tid, mins] of gameMinutes(file.games[gid])) {
      if (!teamGames.has(tid)) teamGames.set(tid, []);
      teamGames.get(tid).push(mins);
    }
  }
}
const contOf = new Map(store.teams.map((t) => {
  const ids = new Set(store.players.filter((p) => p.onRoster && p.teamId === t.teamId).map((p) => p.playerId));
  return [t.abbr, continuity(ids, teamGames.get(t.teamId) ?? [], 82)];
}));
const eloPts = new Map(store.teams.map((t) => [t.abbr, (t.elo - ELO_BASE) / ELO_PER_POINT]));
const exp2 = new Map(store.teams.map((t) => [t.abbr, strength(
  { elo: eloPts.get(t.abbr), c: contOf.get(t.abbr), roster: { [cont.value]: boards.V2.get(t.abbr).total } }, cont)]));

const rankMap = (m) => new Map([...m].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i + 1]));
const cols = {
  OLD: new Map([...boards.V0].map(([k, r]) => [k, r.legacyTotal])),
  RTG_V0: new Map([...boards.V0].map(([k, r]) => [k, r.total])),
  RTG_V1: new Map([...boards.V1].map(([k, r]) => [k, r.total])),
  RTG_V2: new Map([...boards.V2].map(([k, r]) => [k, r.total])),
  RTG_V3: new Map([...boards.V3].map(([k, r]) => [k, r.total])),
  EXP2: exp2,
};
const ranks = Object.fromEntries(Object.entries(cols).map(([k, m]) => [k, rankMap(m)]));
console.log(`\n实验 2 示意配置：${JSON.stringify(cont)}（V2 阵容分；Elo 取 teams.json 当前值）\n`);
console.log('| 球队 | 延续度 c | OLD | RTG 现状(V0) | V1 补 APM | V2 补 APM+收缩 | V3 只收缩 | 实验 2 示意 |');
console.log('|---|---:|---|---|---|---|---|---|');
const order = [...ranks.RTG_V2].sort((a, b) => a[1] - b[1]).map(([k]) => k);
const cell = (k, abbr) => `${ranks[k].get(abbr)}（${cols[k].get(abbr).toFixed(2)}）`;
for (const abbr of order) {
  console.log(`| ${abbr} | ${contOf.get(abbr)?.toFixed(2) ?? '—'} | ${Object.keys(cols).map((k) => cell(k, abbr)).join(' | ')} |`);
}

// ---- 盘口隐含实力：事后诊断，不参与任何选择
const mktFile = process.argv[2];
if (mktFile && fs.existsSync(mktFile)) {
  const m = Object.values(JSON.parse(fs.readFileSync(mktFile, 'utf8')));
  const ids = store.teams.map((t) => t.teamId); const ix = new Map(ids.map((id, i) => [id, i]));
  // 与 scratch/fit.mjs 相同：岭回归 + 主场，梯度下降
  let r = new Array(30).fill(0); let H = 2; const lam = 0.5;
  for (let it = 0; it < 20000; it += 1) {
    const g = new Array(30).fill(0); let gh = 0;
    for (const x of m) {
      const e = r[ix.get(x.home)] - r[ix.get(x.away)] + (x.neutral ? 0 : H) + x.spread;
      g[ix.get(x.home)] += e; g[ix.get(x.away)] -= e; if (!x.neutral) gh += e;
    }
    for (let i = 0; i < 30; i += 1) r[i] -= 0.01 * (g[i] + lam * r[i]);
    H -= 0.01 * gh / 10;
  }
  const mk = r.map((v) => v - mean(r));
  console.log(`\n盘口诊断（${m.length} 场，只作事后对照，未用于任何拟合/选择）：`);
  for (const [k, col] of Object.entries(cols)) {
    console.log(`  corr(盘口, ${k.padEnd(6)}) = ${corr(mk, store.teams.map((t) => col.get(t.abbr))).toFixed(3)}`);
  }
}
