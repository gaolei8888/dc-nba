#!/usr/bin/env node
/**
 * 拟合实时阵容榜（server/liveRosterRankings.mjs）用到的收缩常数，只读本地数据，不联网。
 *
 * 1. 分钟（MINUTES）：预计分钟 = 出场时场均 MPG × 出场率，两部分分别收缩，见 projectMinutes。
 *    数据：data/history/stints_*.json.gz（每段 10 名在场球员，前 5 主队后 5 客队，第 15 项为秒数）。
 *    样本：每季每队在本季第 T=1..10 场后做检查点，T 场内出过场的球员一行；
 *    目标是该队剩余场次的 MPG（出场时）、出场率，以及每场球队比赛分钟（DNP 记 0）。
 *    训练 = 前 3 组相邻赛季，留出 = 最后一组；比赛按 gameId 排序近似时间顺序（文件里没有日期）。
 *
 * 2. IMP K：本季 n 场的统计栏模型 SPM → 收缩到人群均值 m 后去预测球员 IMP。
 *      估计 = (K·m + n·SPM) / (K + n)
 *    数据：data/players.json 当前快照里「上季有 IMP 且本季已出场」的球员，
 *    目标是上季 IMP（跨赛季，且含 APM 部分，SPM 解释不了——因此 K 偏大是合理的）。
 *
 * 用法：node scripts/roster-shrinkage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply as spmOf } from '../server/impact.mjs';
import { shrink, projectMinutes, MINUTES } from '../server/liveRosterRankings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const GRID = [...Array.from({ length: 100 }, (_, i) => (i + 1) / 2), ...Array.from({ length: 50 }, (_, i) => 55 + i * 5)];

/** 网格最小二乘：samples = [{ target, n, value, y }]，返回 { k, rmse } */
export function fitK(samples, grid = GRID) {
  let best = null;
  for (const k of grid) {
    const sse = samples.reduce((s, x) => s + (x.y - shrink(x.target, k, x.value, x.n)) ** 2, 0);
    if (!best || sse < best.sse) best = { k, sse };
  }
  return { k: best.k, rmse: Math.sqrt(best.sse / samples.length), n: samples.length };
}

/** 一季 stints → { teams: Map(teamId → 按 gameId 排序的 [Map(playerId → 分钟)]), tot, gp } */
export function seasonMinutes(games) {
  const teams = new Map(); const tot = new Map(); const gp = new Map();
  for (const gameId of Object.keys(games).sort()) {
    const [home, away, stints] = games[gameId];
    const m = { [home]: new Map(), [away]: new Map() };
    for (const st of stints) st.slice(0, 10).forEach((id, i) => {
      const side = m[i < 5 ? home : away];
      side.set(id, (side.get(id) ?? 0) + st[14] / 60);
    });
    for (const t of [home, away]) {
      if (!teams.has(t)) teams.set(t, []);
      teams.get(t).push(m[t]);
      for (const [id, v] of m[t]) { tot.set(id, (tot.get(id) ?? 0) + v); gp.set(id, (gp.get(id) ?? 0) + 1); }
    }
  }
  return { teams, tot, gp };
}

/** 检查点样本：每队每个 T 一组（组内即该检查点该队全部已出场球员） */
export function checkpointSamples(prev, teams, { maxT = 10, priorMinGp = 10 } = {}) {
  const out = [];
  for (const [team, games] of teams) {
    for (let T = 1; T <= maxT && T < games.length; T++) {
      const seen = new Set(games.slice(0, T).flatMap((g) => [...g.keys()]));
      out.push([...seen].map((p) => {
        const early = games.slice(0, T).map((g) => g.get(p)).filter((v) => v != null);
        const rest = games.slice(T).map((g) => g.get(p)).filter((v) => v != null);
        const restMin = rest.reduce((a, v) => a + v, 0);
        const pg = prev.gp.get(p) ?? 0;
        return { p, team, T, n: early.length, v: mean(early), y: restMin / (games.length - T),
          rate: rest.length / (games.length - T), mpg: rest.length ? restMin / rest.length : null,
          priorMpg: pg >= priorMinGp ? prev.tot.get(p) / pg : null };
      }));
    }
  }
  return out;
}

const rmseOf = (rows, f, key) => {
  const xs = rows.filter((x) => x[key] != null);
  return Math.sqrt(xs.reduce((s, x) => s + (f(x) - x[key]) ** 2, 0) / xs.length);
};
/** 每组按 240 等比缩放（rescale）或不缩放后，对每场球队比赛分钟的 RMSE */
function groupRmse(groups, f, rescale) {
  let se = 0; let c = 0;
  for (const g of groups) {
    const pr = g.map(f); const sum = pr.reduce((a, v) => a + v, 0);
    g.forEach((x, i) => { se += ((rescale && sum > 0 ? pr[i] * 240 / sum : pr[i]) - x.y) ** 2; c += 1; });
  }
  return Math.sqrt(se / c);
}
/** 伤病已知的近似：某场前后 ±3 场内出过场即视为可用，逐场把可用者实际总分钟按预测权重分配 */
function availabilityRmse(groups, seasonTeams, f, rescale) {
  let se = 0; let c = 0;
  for (const g of groups) {
    if (!g.length) continue;
    const games = seasonTeams.get(g[0].team);
    for (let k = g[0].T; k < Math.min(games.length, g[0].T + 20); k++) {
      const near = games.slice(Math.max(0, k - 3), k + 4);
      const av = g.filter((x) => near.some((gm) => gm.has(x.p)));
      const w = av.map(f); const sw = w.reduce((a, v) => a + v, 0);
      const total = av.reduce((a, x) => a + (games[k].get(x.p) ?? 0), 0);
      av.forEach((x, i) => { se += ((rescale ? w[i] * total / sw : w[i]) - (games[k].get(x.p) ?? 0)) ** 2; c += 1; });
    }
  }
  return Math.sqrt(se / c);
}

function fitMinutes(train) {
  const P = train.filter((x) => x.priorMpg != null); const N = train.filter((x) => x.priorMpg == null);
  let priorK = null;
  for (const k of GRID) {
    const e = rmseOf(P, (x) => shrink(x.priorMpg, k, x.v, x.n), 'mpg');
    if (!priorK || e < priorK.e) priorK = { k, e };
  }
  let noPrior = null;
  for (let a = 0; a <= 24; a += 1) for (let b = 0; b <= 1.0001; b += 0.05) for (const k of [0.5, 1, 2, 3, 4, 6, 8, 12, 16]) {
    const e = rmseOf(N, (x) => shrink(a + b * x.v, k, x.v, x.n), 'mpg');
    if (!noPrior || e < noPrior.e) noPrior = { a, b: Math.round(b * 100) / 100, k, e };
  }
  const rateFit = (xs) => {
    let best = null;
    for (let R = 0.2; R <= 1.0001; R += 0.01) for (const k of [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]) {
      const e = rmseOf(xs, (x) => shrink(R, k, x.n / x.T, x.T), 'rate');
      if (!best || e < best.e) best = { R: Math.round(R * 100) / 100, k, e };
    }
    return best;
  };
  return { priorK, noPrior, rate: { prior: rateFit(P), noPrior: rateFit(N) } };
}

function main() {
  const dir = path.join(root, 'data/history');
  const raw = fs.readdirSync(dir).filter((f) => /^stints_.*\.json\.gz$/.test(f)).sort()
    .map((f) => seasonMinutes(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f)))).games));
  const pairs = raw.slice(1).map((s, i) => checkpointSamples(raw[i], s.teams));
  const train = pairs.slice(0, -1).flat(); const hold = pairs.at(-1);
  const fit = fitMinutes(train.flat());
  console.log('分钟拟合（训练集）：', JSON.stringify(fit));
  console.log('当前 MINUTES 常数：', JSON.stringify(MINUTES));
  const projected = (x) => projectMinutes(x.priorMpg, x.v, x.n, x.T);
  // 上一版：只有 MPG 收缩（K=3；无先验向单一均值 21、K=2），不乘出场率
  const previous = (x) => (x.priorMpg != null ? shrink(x.priorMpg, 3, x.v, x.n) : shrink(21, 2, x.v, x.n));
  const holdTeams = raw.at(-1).teams;
  for (const [name, f] of [['上一版', previous], ['本模型', projected]]) {
    console.log(`留出集 ${name}：每场分钟 RMSE 不缩放 ${groupRmse(hold, f, false).toFixed(3)} / 等比缩放 ${groupRmse(hold, f, true).toFixed(3)}；`
      + `伤病已知逐场分配 RMSE 缩放 ${availabilityRmse(hold, holdTeams, f, true).toFixed(3)} / 不缩放 ${availabilityRmse(hold, holdTeams, f, false).toFixed(3)}；`
      + `每队预测总和均值 ${(hold.reduce((a, g) => a + g.reduce((b, x) => b + f(x), 0), 0) / hold.length).toFixed(0)}`);
  }
  const flatHold = hold.flat().filter((x) => x.priorMpg == null && x.mpg != null);
  const { a, b, k } = MINUTES.noPrior;
  for (const [lo, hi] of [[0, 8], [8, 15], [15, 25], [25, 49]]) {
    const xs = flatHold.filter((x) => x.v >= lo && x.v < hi);
    const avg = (f) => (xs.reduce((s, x) => s + f(x), 0) / xs.length).toFixed(1);
    console.log(`  无先验、早期 MPG [${lo},${hi})：n=${xs.length} 剩余实际 MPG ${avg((x) => x.mpg)}`
      + `  本模型 ${avg((x) => shrink(a + b * x.v, k, x.v, x.n))}  上一版 ${avg((x) => shrink(21, 2, x.v, x.n))}`);
  }

  const players = JSON.parse(fs.readFileSync(path.join(root, 'data/players.json')));
  const model = JSON.parse(fs.readFileSync(path.join(root, 'data/impact-model.json')));
  const m = mean(players.filter((p) => Number.isFinite(p.impact)).map((p) => p.impact));
  const imp = players.filter((p) => Number.isFinite(p.impact) && p.cur?.gp > 0)
    .map((p) => ({ target: m, n: p.cur.gp, value: spmOf(model, p.cur, { minGp: 1 }), y: p.impact }))
    .filter((x) => x.value !== null);
  const ki = fitK(imp);
  console.log(`IMP：人群均值 m=${m.toFixed(3)}  K=${ki.k}  RMSE=${ki.rmse.toFixed(3)}  样本=${ki.n}`
    + `  （K→∞ RMSE=${fitK(imp, [1e9]).rmse.toFixed(3)}，K=0 RMSE=${fitK(imp, [0]).rmse.toFixed(3)}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
