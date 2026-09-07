/**
 * APM（只有进攻方五人）对 RAPM（攻守双方十人）的对照实验。
 *
 *   node scripts/rapm-lab.mjs
 *
 * 要回答的就一件事：解析 play-by-play、把对手阵容也放进回归，值不值。
 *
 * 已知的缺陷是这样来的：`leaguedashlineups` 只给进攻方五人，回归看不见
 * 对手是谁。于是一支强队的角色球员会被双重抬高——队友好，碰上的对手
 * 也被队友压住了，两份好处全算在他头上。RAPM 把防守方也放进设计矩阵，
 * 理论上能拆开。理论归理论，下面全部用数字说话。
 *
 * 三条判据，都不循环：
 *   1 年度稳定性：第 N 季的值预测第 N+1 季**同一指标**。噪声大的指标必然低。
 *   2 预测次季 on/off：完全独立的一把尺子（缺陷来源不同，不共享偏差）。
 *   3 主场优势：回归自己解出来的主场项，能不能对上实测的 1.6~2.4 分。
 *     我们从没告诉它主场是什么，对得上就说明阵容还原是对的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { computeApm } from '../server/rapm.mjs';
import { computeRapm, stintsOf } from '../server/stintRapm.mjs';
import { corr, mean, apply, fit, buildSamples } from '../server/impact.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const APM_LAMBDA = Number(process.env.APM_LAMBDA) || 6000;
const RAPM_LAMBDA = Number(process.env.RAPM_LAMBDA) || 2000;
const readIf = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

const players = {}; const lineups = {}; const stints = {};
for (const f of fs.readdirSync(HISTORY)) {
  let m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
  if (m) { players[m[1]] = readIf(path.join(HISTORY, f)).players.map((p) => ({ ...p, season: m[1] })); continue; }
  m = f.match(/^lineups_(\d{4}-\d{2})\.json$/);
  if (m) { lineups[m[1]] = readIf(path.join(HISTORY, f)).rows; continue; }
  m = f.match(/^stints_(\d{4}-\d{2})\.json$/);
  if (m) stints[m[1]] = readIf(path.join(HISTORY, f));
}
const seasons = Object.keys(players).sort().filter((s) => lineups[s] && stints[s]);
if (!seasons.length) {
  console.error('还没有 stints_*.json。先跑 npm run pbp:fetch');
  process.exit(1);
}
// 跨季判据要成对的赛季，单季只能跑主场优势和「对手调整改了谁」。
// 抓取是分季进行的，中途想看一眼不该被拦住。
const canPair = seasons.length >= 2;
if (!canPair) console.log('（只有一个赛季，跨季判据跳过）');
console.log(`\nAPM vs RAPM 对照  赛季：${seasons.join('、')}`);
for (const s of seasons) {
  const g = Object.keys(stints[s].games).length;
  const f = Object.keys(stints[s].failed ?? {}).length;
  console.log(`  ${s}  ${g} 场可用 / 丢弃 ${f}  段 ${stintsOf(stints[s]).length.toLocaleString()}`);
}

const nextOf = (s) => seasons[seasons.indexOf(s) + 1];

// ---- 单季指标
const apmBy = new Map(seasons.map((s) => [s, computeApm(lineups[s], { lambda: APM_LAMBDA })]));
const rapmBy = new Map();
console.log('\n主场优势（判据 3：回归自己解出来的，我们没喂过这个信息）');
for (const s of seasons) {
  const r = computeRapm(stintsOf(stints[s]), { lambda: RAPM_LAMBDA });
  const h = r.get('__hca');
  r.delete('__hca');
  rapmBy.set(s, r);
  console.log(`  ${s}  ${h.hca.toFixed(2)} 每百回合 ≈ ${(h.hca * 0.99).toFixed(2)} 分/场`
    + `   球员 ${r.size} 人  观测 ${h.rows.toLocaleString()} 条`);
}

/** 共同样本：两季都够回合数、当季有正经轮换角色 */
function commonRows(s, minPoss = 1000) {
  const nx = nextOf(s);
  if (!nx) return null;
  const a = apmBy.get(s); const b = apmBy.get(nx);
  const ra = rapmBy.get(s); const rb = rapmBy.get(nx);
  const rows = players[s].filter((p) => {
    const id = p.playerId;
    return a.get(id) && b.get(id) && ra.get(id) && rb.get(id)
      && a.get(id).poss >= minPoss && b.get(id).poss >= minPoss
      && ra.get(id).poss >= minPoss && rb.get(id).poss >= minPoss
      && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10;
  });
  return rows.length >= 50 ? { rows, nx } : null;
}

// ---- 判据 1：年度稳定性
if (canPair) console.log('\n判据 1 · 年度稳定性（第 N 季的值 → 第 N+1 季同一指标）');
const stab = { APM: [], RAPM: [] };
for (const s of canPair ? seasons : []) {
  const c = commonRows(s);
  if (!c) continue;
  const ids = c.rows.map((p) => p.playerId);
  const ra = corr(ids.map((i) => apmBy.get(s).get(i).apm), ids.map((i) => apmBy.get(c.nx).get(i).apm));
  const rr = corr(ids.map((i) => rapmBy.get(s).get(i).rapm), ids.map((i) => rapmBy.get(c.nx).get(i).rapm));
  stab.APM.push(ra); stab.RAPM.push(rr);
  console.log(`  ${s}→${c.nx}  n=${String(c.rows.length).padStart(3)}   APM ${ra.toFixed(3)}   RAPM ${rr.toFixed(3)}`
    + `   ${rr > ra ? '← RAPM 赢' : ''}`);
}
if (stab.APM.length) {
  console.log(`  平均            APM ${mean(stab.APM).toFixed(3)}   RAPM ${mean(stab.RAPM).toFixed(3)}`);
}

// ---- 判据 2：预测次季 on/off（独立尺子）
if (canPair) console.log('\n判据 2 · 预测次季裸 on/off（独立尺子，缺陷来源与两者都不同）');
const onoff = { APM: [], RAPM: [], SPM: [] };
// SPM 训练要留出当季（防泄漏），只有一个赛季时训练集为空，跑不了
const spmFor = canPair ? new Map(seasons.map((s) => [s,
  fit(buildSamples(seasons.filter((x) => x !== s).flatMap((x) => players[x]),
    { apmBySeason: apmBy }), 3000)])) : new Map();
for (const s of canPair ? seasons : []) {
  const c = commonRows(s);
  if (!c) continue;
  const byId = new Map(players[c.nx].map((p) => [p.playerId, p]));
  const keep = c.rows.filter((p) => byId.has(p.playerId));
  if (keep.length < 50) continue;
  const y = keep.map((p) => {
    const n = byId.get(p.playerId);
    return (n.onNet ?? 0) - (n.offNet ?? 0);
  });
  const ra = corr(keep.map((p) => apmBy.get(s).get(p.playerId).apm), y);
  const rr = corr(keep.map((p) => rapmBy.get(s).get(p.playerId).rapm), y);
  const rs = corr(keep.map((p) => apply(spmFor.get(s), p) ?? 0), y);
  onoff.APM.push(ra); onoff.RAPM.push(rr); onoff.SPM.push(rs);
  console.log(`  ${s}→${c.nx}  n=${String(keep.length).padStart(3)}   APM ${ra.toFixed(3)}   RAPM ${rr.toFixed(3)}   SPM ${rs.toFixed(3)}`);
}
if (onoff.APM.length) {
  console.log(`  平均            APM ${mean(onoff.APM).toFixed(3)}   RAPM ${mean(onoff.RAPM).toFixed(3)}`
    + `   SPM ${mean(onoff.SPM).toFixed(3)}`);
}

// ---- 对手调整到底改了谁
const last = seasons[seasons.length - 1];
const names = new Map(players[last].map((p) => [p.playerId, p.name]));
const teamNet = new Map();
{
  const adv = readIf(path.join(HISTORY, `teamadv_${last}.json`));
  if (adv) for (const r of adv) teamNet.set(r.TEAM_ID, Number(r.NET_RATING) || 0);
}
console.log(`\n对手调整改了谁（${last}，回合 ≥2000）`);
const cmp = [...rapmBy.get(last)]
  .filter(([id, v]) => v.poss >= 2000 && apmBy.get(last).get(id))
  .map(([id, v]) => {
    const p = players[last].find((x) => x.playerId === id);
    return {
      id, name: names.get(id) ?? id, rapm: v.rapm,
      apm: apmBy.get(last).get(id).apm,
      d: v.rapm - apmBy.get(last).get(id).apm,
      teamNet: teamNet.get(p?.teamId) ?? null,
    };
  });
const fmt = (x) => `  ${String(x.name).padEnd(24)} APM ${String(x.apm).padStart(6)} → RAPM ${String(x.rapm).padStart(6)}`
  + `  (${x.d >= 0 ? '+' : ''}${x.d.toFixed(2)})  所在队净效率 ${x.teamNet ?? '—'}`;
console.log(' 被压得最狠的 8 人：');
[...cmp].sort((a, b) => a.d - b.d).slice(0, 8).forEach((x) => console.log(fmt(x)));
console.log(' 被抬得最多的 8 人：');
[...cmp].sort((a, b) => b.d - a.d).slice(0, 8).forEach((x) => console.log(fmt(x)));

// 如果对手调整真的起作用，「球员值」与「所在队净效率」的相关应该下降
const withTeam = cmp.filter((x) => x.teamNet !== null);
if (withTeam.length > 30) {
  const tn = withTeam.map((x) => x.teamNet);
  console.log(`\n 与所在队净效率的相关：APM ${corr(withTeam.map((x) => x.apm), tn).toFixed(3)}`
    + `  →  RAPM ${corr(withTeam.map((x) => x.rapm), tn).toFixed(3)}`);
  console.log(' （好球员本来就在好队，这个相关不该归零；但对手调整应该让它降下来一些）');
}
