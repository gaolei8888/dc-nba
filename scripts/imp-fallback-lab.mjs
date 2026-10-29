/**
 * IMP 回退先验实验（预注册：docs/superpowers/specs/2026-10-30-imp-fallback-prior-prereg.md）。
 *
 *   npm run lab:imp-fallback     # 纯离线：只读 data/backtest.json、data/teams.json、data/players.json、data/history/，不联网
 *
 * 两个主检验各跑三遍（现状 / 回退 / 敏感性 ×0.85），除价值外一切不变，逐场配对：
 *   (a) scripts/injury-elo-lab.mjs 的 P1（β=0.5，P 表留一赛季）——INJURY_ELO_DUMP 导出逐场胜率；
 *   (b) scripts/roster-results-backtest.mjs 的 batch1 先验 + 线上 RESULTS（K=12 近期加权）——RR_DUMP 导出。
 * Δ log loss = 回退 − 现状，按比赛日分块 bootstrap（server/injuryEloShadow.mjs 的 dayBlockCI，B=2000，seed 7）。
 * 采纳：(a)、(b) 的区间上界都 < +0.0005。
 *
 * 输出：docs/imp-fallback-lab-output.txt（文本摘要）与 data/imp-fallback-lab.json（gitignored）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { computeApm } from '../server/rapm.mjs';
import { apply as spmOf } from '../server/impact.mjs';
import { populationMean } from '../server/impactShrink.mjs';
import { dayBlockCI } from '../server/injuryEloShadow.mjs';
import { labValuesUpto, loadBoxSeasons } from '../server/impFallbackLab.mjs';
import { productionFallback } from '../server/impFallback.mjs';

const ROOT = path.join(DATA_DIR, '..');
const HISTORY = path.join(DATA_DIR, 'history');
const TMP = fs.mkdtempSync(path.join(DATA_DIR, 'imp-fallback-'));
const THRESH = 0.0005;
const t0 = Date.now();
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---------------------------------------------------------------- 跑两份回测的导出
function dump(script, envKey, mode) {
  const file = path.join(TMP, `${envKey}-${mode}.json`);
  const env = { ...process.env, [envKey]: file };
  delete env.IMP_FALLBACK;
  if (mode !== 'off') env.IMP_FALLBACK = mode;
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], { env, stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT });
  return read(file);
}
const MODES = ['off', 'primary', 'sens'];
const inj = Object.fromEntries(MODES.map((m) => [m, dump('injury-elo-lab.mjs', 'INJURY_ELO_DUMP', m)]));
console.log(`(a) 导出完成（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
const ros = Object.fromEntries(MODES.map((m) => [m, dump('roster-results-backtest.mjs', 'RR_DUMP', m)]));
console.log(`(b) 导出完成（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
fs.rmSync(TMP, { recursive: true, force: true });

// ---------------------------------------------------------------- Δ 与区间
const ll = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-12));
const f4 = (v) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(4));
const ciStr = (c) => (c ? `${f4(c.mean)} [${f4(c.lo)}, ${f4(c.hi)}]` : '—（无比赛）');
function paired(base, cand, { key = 'p', filter = () => true } = {}) {
  const byId = new Map(cand.games.map((g) => [g.gameId, g]));
  const items = [];
  for (const g of base.games) {
    const c = byId.get(g.gameId);
    if (!c) throw new Error(`配对缺场 ${g.gameId}`);
    if (c.homeWin !== g.homeWin) throw new Error(`结果不一致 ${g.gameId}`);
    if (!filter(c)) continue;
    items.push({ day: g.date, d: ll(c[key], c.homeWin) - ll(g[key], g.homeWin), base: ll(g[key], g.homeWin) });
  }
  const ci = dayBlockCI(items);
  return ci ? { ...ci, n: items.length, baseLL: items.reduce((s, x) => s + x.base, 0) / items.length } : null;
}
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const result = { prereg: 'docs/superpowers/specs/2026-10-30-imp-fallback-prior-prereg.md', threshold: THRESH, tests: {} };
const tests = [
  ['a', '(a) 伤病扣分 P1（β=0.5）', inj, 'p'],
  ['b', '(b) 阵容榜（batch1 先验 + K=12 近期加权）', ros, 'p'],
  ['b∞', '(b′) 只看阵容 K=∞（只报告）', ros, 'pRoster'],
];
for (const [k, , d, key] of tests) {
  const r = {};
  for (const variant of ['primary', 'sens']) {
    r[variant] = {
      all: paired(d.off, d[variant], { key }),
      affected: paired(d.off, d[variant], { key, filter: (g) => g.affected }),
      seasons: Object.fromEntries(SEASONS.map((s) => [s, paired(d.off, d[variant], { key, filter: (g) => g.season === s })])),
    };
  }
  r.cover = d.primary.cover;
  result.tests[k] = r;
}

log('# IMP 回退先验实验输出（npm run lab:imp-fallback）');
log(`预注册：${result.prereg}；运行于 ${new Date().toISOString()}`);
log('');
log('## 覆盖：每份价值表里补上回退值的人数（键 = 价值截至的赛季，用于下一季的比赛）');
log(`- (a)：${Object.entries(inj.primary.cover).map(([u, n]) => `${u} ${n}`).join('；')}`);
log(`- (b)：${Object.entries(ros.primary.cover).map(([u, n]) => `${u} ${n}`).join('；')}`);
log(`- 受影响比赛（回退口径下任一队有轮换球员用回退值）：(a) ${inj.primary.games.filter((g) => g.affected).length}/${inj.primary.games.length}；`
  + `(b) ${ros.primary.games.filter((g) => g.affected).length}/${ros.primary.games.length}`);
log(`- (a) D_pre 有变化的比赛：${inj.primary.games.filter((g, i) => g.dH !== inj.off.games[i].dH || g.dA !== inj.off.games[i].dA).length}`);
log('');
log('## 主检验（Δ log loss = 回退 − 现状，四季合并，按比赛日分块 bootstrap 95% CI）');
log('| 检验 | n | 现状 log loss | 回退 Δ [95% CI] | 上界 < +0.0005 | 敏感性 ×0.85 Δ [95% CI] |');
log('|---|---:|---:|---|---|---|');
for (const [k, name] of tests) {
  const r = result.tests[k];
  log(`| ${name} | ${r.primary.all.n} | ${r.primary.all.baseLL.toFixed(4)} | ${ciStr(r.primary.all)} | ${k === 'b∞' ? '（只报告）' : r.primary.all.hi < THRESH ? '是' : '否'} | ${ciStr(r.sens.all)} |`);
}
log('');
log('## 受影响比赛子集（只报告）');
log('| 检验 | n | 现状 log loss | 回退 Δ [95% CI] | 敏感性 Δ [95% CI] |');
log('|---|---:|---:|---|---|');
for (const [k, name] of tests) {
  const r = result.tests[k];
  log(`| ${name} | ${r.primary.affected?.n ?? 0} | ${r.primary.affected ? r.primary.affected.baseLL.toFixed(4) : '—'} | ${ciStr(r.primary.affected)} | ${ciStr(r.sens.affected)} |`);
}
log('');
log('## 逐季（只报告）');
log(`| 检验 | ${SEASONS.join(' | ')} |`);
log(`|---|${SEASONS.map(() => '---').join('|')}|`);
for (const [k, name] of tests) log(`| ${name} | ${SEASONS.map((s) => ciStr(result.tests[k].primary.seasons[s])).join(' | ')} |`);
log('');
const pass = ['a', 'b'].map((k) => [k, result.tests[k].primary.all.hi < THRESH]);
result.adopt = pass.every(([, ok]) => ok);
log('## 预注册采纳规则：(a)、(b) 的 Δ 区间上界都 < +0.0005');
for (const [k, ok] of pass) log(`- ${ok ? '通过' : '不通过'}：(${k}) 上界 ${f4(result.tests[k].primary.all.hi)}`);
log(`- 结论：${result.adopt ? '采纳' : '不采纳'}`);
log('');

// ---------------------------------------------------------------- 指名球员（用于 2026-27 的那份：截至 2025-26）
const ALL = ['2021-22', ...SEASONS];
const players = {}; const lineups = {};
for (const s of ALL) {
  players[s] = read(path.join(HISTORY, `impact_${s}.json`)).players.map((p) => ({ ...p, season: s }));
  lineups[s] = read(path.join(HISTORY, `lineups_${s}.json`)).rows;
}
const box = loadBoxSeasons(HISTORY);
const ctx = { seasons: ALL, players, lineups, apmBySeason: new Map(ALL.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })])), box };
const LAST = '2025-26';
const cur = labValuesUpto(ctx, LAST);
const fbP = labValuesUpto(ctx, LAST, { fallback: 'primary' });
const fbS = labValuesUpto(ctx, LAST, { fallback: 'sens' });
// 生产口径（data/impact-model.json；上季 → 本季再平移一岁）：结论不依赖它，列出来看线上会是多少
const model = read(path.join(DATA_DIR, 'impact-model.json'));
const priorRows = players[LAST];
const muProd = populationMean(priorRows.map((p) => spmOf(model, p, { aged: true })));
const prod = productionFallback({
  model, priorSeason: LAST, priorRows,
  historyRows: (s) => box[s] ?? null,
  lineupsOf: (s) => { const f = path.join(HISTORY, `lineups_${s}.json`); return fs.existsSync(f) ? read(f).rows : null; },
  muPrior: muProd,
});
const live = fs.existsSync(path.join(DATA_DIR, 'players.json')) ? read(path.join(DATA_DIR, 'players.json')) : [];
const NAMED = ['Jayson Tatum', 'Tyrese Haliburton', 'Damian Lillard', 'Kyrie Irving', 'Trae Young', 'Domantas Sabonis',
  'Dejounte Murray', 'Fred VanVleet', 'Ty Jerome', 'Zach Edey', 'Walker Kessler'];
const nameToId = new Map();
for (const s of Object.keys(box).sort()) for (const p of box[s]) nameToId.set(p.name, p.playerId);
const f2 = (v) => (v === null || v === undefined ? '—' : v.toFixed(2));
log(`## 指名球员（价值截至 ${LAST}，即 2026-27 用的那份；实验口径 = 收缩 IMP × scale ${cur.scale.toFixed(3)}，人群均值 μ = ${(cur.mu * cur.scale).toFixed(2)}）`);
log('现状「—」= 没有价值，按替补级 −0.5。生产口径 = data/impact-model.json + 年龄再平移一岁（线上若接入会是这个数），μ = ' + muProd.toFixed(2) + '。');
log('');
log(`| 球员 | ${LAST} gp / 场均 | 合格季 | g | 整季缺阵 | 合格季 IMP（平移+收缩后） | 现状 | 回退 | 敏感性 ×0.85 | 生产口径回退 | 线上 players.json impact |`);
log('|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|');
result.named = [];
for (const name of NAMED) {
  const id = nameToId.get(name);
  const row = players[LAST].find((p) => p.playerId === id);
  const r = fbP.fallback.get(id); const rs = fbS.fallback.get(id); const rp = prod.get(id);
  const lv = live.find((p) => p.playerId === id);
  const rec = {
    name, id, gp: row?.gp ?? 0, min: row?.min ?? 0, season: r?.season ?? null, g: r?.g ?? null, missed: r?.missed ?? null,
    aged: r?.aged ?? null, current: cur.shrunk.get(id) ?? null, fallback: fbP.shrunk.get(id) ?? null, sens: fbS.shrunk.get(id) ?? null,
    prod: rp?.value ?? null, live: lv?.impact ?? null,
  };
  result.named.push(rec);
  log(`| ${name} | ${rec.gp} / ${rec.min} | ${rec.season ?? '—'} | ${rec.g ?? '—'} | ${rec.missed === null ? '—' : rec.missed ? '是' : '否'} | ${f2(rec.aged)} | ${f2(rec.current)} | ${f2(rec.fallback)} | ${f2(rec.sens)} | ${f2(rec.prod)} | ${f2(rec.live)} |`);
}
log('');
// 线上名单：没有 IMP 的人数，现状 vs 生产口径回退之后
if (live.length) {
  const roster = live.filter((p) => p.onRoster);
  const noImp = roster.filter((p) => p.impact === null || p.impact === undefined);
  const still = noImp.filter((p) => !prod.has(p.playerId));
  const rookies = still.filter((p) => p.exp === 'R').length;
  result.rosterNoImp = { roster: roster.length, before: noImp.length, after: still.length, afterRookies: rookies };
  log(`## 线上名单（data/players.json，${roster.length} 人）没有上季 IMP 的人数`);
  log(`- 现状 ${noImp.length} 人；生产口径回退之后 ${still.length} 人（其中新秀 ${rookies} 人，其余为 3 季内没有合格季、或上季 ≥20 场但场均 <10 分钟的人）`);
  log('');
}
log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

fs.writeFileSync(path.join(DATA_DIR, 'imp-fallback-lab.json'), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(ROOT, 'docs', 'imp-fallback-lab-output.txt'), `${lines.join('\n')}\n`);
