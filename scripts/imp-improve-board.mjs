/**
 * IMP 改进实验：最新赛季的球员与球队示意（只读缓存，不抓数据，不参与任何判定）。
 *
 *   node scripts/imp-improve-board.mjs
 *
 * 每个候选都用全部赛季训练 SPM、全部相邻赛季对拟合逐项年龄曲线，按线上口径校准与收缩
 * （calibratedValues，见 imp-improve-core.mjs），单位与「IMP 准不准」/阵容榜相同。
 * 注意：示意统一按第 N 季分钟、k=3200 收缩（与线上同），不复现 8 系列里 mEff / k=1600 之类的折内选择。
 * 球队示意 = 2025-26 各队球员价值 × 该季出场分钟，按队分钟归一后 ×5（与 fit-impact 的量纲口径相同）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { players, seasons, minutesOf, calibratedValues } from './imp-improve-core.mjs';

const last = seasons.at(-1);
const CANDS = {
  '现行（v1）': {},
  '采纳 5b（逐项年龄）': { ageStat: 1 },
  '9a 年龄对齐长记忆（候选，未接入）': { ageStat: 1, span: 4, hl: 3, apmAge: 1 },
  '8c×5b（通过但未接入）': { span: 4, hl: 3, ageStat: 1 },
  '仅 8c（未接入）': { span: 4, hl: 3 },
  '8d 年龄对齐多季 h=5 span5（未采纳）': { multi: { mode: 'exp', h: 5, level: 'feat', span: 5 }, ageStat: 1 },
};
const vals = Object.fromEntries(Object.entries(CANDS).map(([k, c]) => [k, calibratedValues(last, c)]));
const names = Object.keys(CANDS);
const fmt = (v) => (v === undefined || v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2));
const board = (k) => players[last].filter((p) => (p.gp ?? 0) >= 40 && (p.min ?? 0) >= 20 && vals[k].values.has(p.playerId))
  .sort((a, b) => vals[k].values.get(b.playerId) - vals[k].values.get(a.playerId));
const rankOf = Object.fromEntries(names.map((k) => [k, new Map(board(k).map((p, i) => [p.playerId, i + 1]))]));

console.log(`\n# ${last} 球员价值示意（量纲：${names.map((k) => `${k} ×${vals[k].scale.toFixed(3)}`).join('，')}）\n`);
const WATCH = [
  'Matisse Thybulle', 'Jalen Brunson', 'Luka Dončić', 'Nikola Jokić', 'Shai Gilgeous-Alexander', 'Ja Morant',
  'LeBron James', 'Stephen Curry', 'Kevin Durant', 'James Harden', 'Damian Lillard', 'Chris Paul', 'Al Horford',
  'Victor Wembanyama', 'Stephon Castle', 'Amen Thompson', 'Zaccharie Risacher',
  'Cooper Flagg', 'Dylan Harper', 'Kon Knueppel', 'VJ Edgecombe', 'Ace Bailey', 'Jeremiah Fears',
];
console.log(`| 球员 | 年龄 | 场×分钟 | ${names.join(' | ')} |`);
console.log(`|---|---:|---|${names.map(() => '---').join('|')}|`);
for (const n of WATCH) {
  const p = players[last].find((q) => q.name === n);
  if (!p) { console.log(`| ${n} | | ${last} 无数据 |${names.map(() => ' |').join('')}`); continue; }
  const cell = (k) => {
    const v = vals[k].values.get(p.playerId);
    const r = rankOf[k].get(p.playerId);
    return v === undefined ? '不在训练区间' : `${fmt(v)}${r ? `（#${r}）` : ''}`;
  };
  console.log(`| ${n} | ${p.age} | ${p.gp}×${p.min} | ${names.map(cell).join(' | ')} |`);
}
console.log('\n（#名次 = 本季 ≥40 场且场均 ≥20 分钟球员中的排名；不够这个门槛的只给值）');

// 5b 相对现行：涨跌最多的人（本季 ≥1000 分钟），以及 33 岁以上
{
  const [k0, k1] = names;
  const moved = players[last].filter((p) => minutesOf(p) >= 1000 && vals[k0].values.has(p.playerId) && vals[k1].values.has(p.playerId))
    .map((p) => ({ p, a: vals[k0].values.get(p.playerId), b: vals[k1].values.get(p.playerId) }))
    .map((r) => ({ ...r, d: r.b - r.a }));
  const line = (r) => `| ${r.p.name} | ${r.p.age} | ${r.p.gp}×${r.p.min} | ${fmt(r.a)}${rankOf[k0].get(r.p.playerId) ? `（#${rankOf[k0].get(r.p.playerId)}）` : ''} | ${fmt(r.b)}${rankOf[k1].get(r.p.playerId) ? `（#${rankOf[k1].get(r.p.playerId)}）` : ''} | ${fmt(r.d)} |`;
  const head = `| 球员 | 年龄 | 场×分钟 | ${k0} | ${k1} | Δ |\n|---|---:|---|---|---|---:|`;
  console.log(`\n## ${k1} 相对 ${k0}：涨最多的 5 人（本季 ≥1000 分钟）\n\n${head}`);
  [...moved].sort((x, y) => y.d - x.d).slice(0, 5).forEach((r) => console.log(line(r)));
  console.log(`\n## 跌最多的 5 人\n\n${head}`);
  [...moved].sort((x, y) => x.d - y.d).slice(0, 5).forEach((r) => console.log(line(r)));
  const old = moved.filter((r) => r.p.age >= 33).sort((x, y) => y.a - x.a);
  console.log(`\n## 33 岁及以上（本季 ≥1000 分钟，${old.length} 人；涨 ${old.filter((r) => r.d > 0.005).length}，跌 ${old.filter((r) => r.d < -0.005).length}，Δ 均值 ${fmt(old.reduce((a, r) => a + r.d, 0) / old.length)}；名次涨 ${old.filter((r) => rankOf[k1].get(r.p.playerId) < rankOf[k0].get(r.p.playerId)).length}、跌 ${old.filter((r) => rankOf[k1].get(r.p.playerId) > rankOf[k0].get(r.p.playerId)).length}）\n\n${head}`);
  old.forEach((r) => console.log(line(r)));
  const all = moved.reduce((a, r) => a + r.d, 0) / moved.length;
  console.log(`\n（全体 ≥1000 分钟球员 Δ 均值 ${fmt(all)}：量纲与人群均值随年龄平移整体有变化，老将要和这个均值比）`);
}

for (const k of names.slice(0, 2)) {
  console.log(`\n${k} 前 15：`);
  board(k).slice(0, 15).forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(26)} ${fmt(vals[k].values.get(p.playerId))}`));
}

// 球队示意：2025-26 各队（球员行的 teamId）分钟加权 ×5
console.log(`\n## 球队示意（${last} 各队球员价值 × 出场分钟，分钟归一 ×5；只示意，不是阵容榜）\n`);
const teams = new Map();
for (const p of players[last]) {
  if (!p.teamId || !(minutesOf(p) > 0)) continue;
  if (!teams.has(p.teamId)) teams.set(p.teamId, []);
  teams.get(p.teamId).push(p);
}
const teamVal = (k) => new Map([...teams].map(([t, sq]) => {
  const tot = sq.reduce((a, p) => a + minutesOf(p), 0);
  return [t, (5 * sq.reduce((a, p) => a + minutesOf(p) * (vals[k].values.get(p.playerId) ?? -2), 0)) / tot];
}));
const tv = Object.fromEntries(names.slice(0, 2).map((k) => [k, teamVal(k)]));
const rank = (m) => new Map([...m].sort((a, b) => b[1] - a[1]).map(([t], i) => [t, i + 1]));
const r0 = rank(tv[names[0]]); const r1 = rank(tv[names[1]]);
const teamNames = new Map((JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'history', `teamadv_${last}.json`), 'utf8')) ?? []).map((r) => [r.TEAM_ID, r.TEAM_NAME]));
const abbr = (t) => teamNames.get(t) ?? t;
const moves = [...r0.keys()].map((t) => ({ t, a: r0.get(t), b: r1.get(t) })).sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
console.log(`| 队 | ${names[0]} 名次（值） | ${names[1]} 名次（值） |`);
console.log('|---|---|---|');
for (const m of moves.slice(0, 10)) console.log(`| ${abbr(m.t)} | #${m.a}（${fmt(tv[names[0]].get(m.t))}） | #${m.b}（${fmt(tv[names[1]].get(m.t))}） |`);
const sp = (() => {
  const ids = [...r0.keys()]; const n = ids.length;
  const d2 = ids.reduce((a, t) => a + (r0.get(t) - r1.get(t)) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
})();
console.log(`\n两版球队名次的 Spearman 相关：${sp.toFixed(3)}；名次变动最大的 10 队如上（按变动幅度排）。`);
