/**
 * 影响力指标的对照实验台。
 *
 *   node scripts/impact-lab.mjs
 *
 * 换了验收标准。之前用「同赛季 APM」当目标，那个标准有两个毛病：
 *   1. 循环：如果最终指标里混了当季 APM，等于拿目标的一部分去预测目标
 *   2. 不对题：这个应用是拿上赛季数据预测**下赛季**的
 *
 * 所以这里统一改成：**用第 N 季的数据算出指标，去预测第 N+1 季的真实 APM。**
 * 既不循环，也正好是我们真正需要的能力。所有候选方案在同一批球员上比。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { computeApm } from '../server/rapm.mjs';
import {
  FEATURES, buildSamples, fit, apply, corr, mean,
} from '../server/impact.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const APM_LAMBDA = Number(process.env.APM_LAMBDA) || 6000;

function load() {
  const players = {}; const lineups = {};
  for (const f of fs.readdirSync(HISTORY)) {
    let m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
    if (m) {
      players[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8'))
        .players.map((p) => ({ ...p, season: m[1] }));
      continue;
    }
    m = f.match(/^lineups_(\d{4}-\d{2})\.json$/);
    if (m) lineups[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')).rows;
  }
  return { players, lineups };
}

const { players, lineups } = load();
const seasons = Object.keys(players).sort().filter((s) => lineups[s]);
if (seasons.length < 3) {
  console.error('需要至少 3 个赛季（训练 + 当季 + 次季）');
  process.exit(1);
}

// 每季的 APM
const apm = new Map(seasons.map((s) => [s, computeApm(lineups[s], { lambda: APM_LAMBDA })]));

/**
 * 多赛季衰减 APM：把第 N 季及之前若干季的组合合并，越久远权重越低。
 * EPM 用的是 2002 年至今的全部回合做指数衰减，我们只有 5 季，思路一样。
 */
function decayedApm(uptoSeason, { halfLife = 1, span = 3 } = {}) {
  const i = seasons.indexOf(uptoSeason);
  const rows = [];
  for (let k = 0; k < span && i - k >= 0; k++) {
    const w = 0.5 ** (k / halfLife);
    for (const l of lineups[seasons[i - k]]) {
      rows.push({ ...l, poss: (l.poss ?? 0) * w });
    }
  }
  return computeApm(rows, { lambda: APM_LAMBDA });
}

const nextOf = (s) => seasons[seasons.indexOf(s) + 1];

/** 评测：对每个"当季 → 次季"的组合，算候选指标与次季真实 APM 的相关 */
function evaluate(label, valueOf, { minPoss = 500 } = {}) {
  const rs = []; const ns = [];
  for (const s of seasons) {
    const nx = nextOf(s);
    if (!nx) continue;
    const curApm = apm.get(s); const nxApm = apm.get(nx);
    const rows = players[s].filter((p) => {
      const a = curApm.get(p.playerId); const b = nxApm.get(p.playerId);
      return a && b && a.poss >= minPoss && b.poss >= minPoss
        && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10;
    });
    if (rows.length < 50) continue;
    const x = rows.map((p) => valueOf(p, s));
    const y = rows.map((p) => nxApm.get(p.playerId).apm);
    if (x.some((v) => v === null || v === undefined || Number.isNaN(v))) continue;
    rs.push(corr(x, y)); ns.push(rows.length);
  }
  return { label, r: mean(rs), rs, n: mean(ns) };
}

/** 训练一个纯 box 的 SPM，训练集排除 held 及其之后的赛季（防泄漏） */
function trainSpm(held, opts) {
  const train = seasons
    .filter((s) => s !== held && nextOf(s))
    .flatMap((s) => players[s]);
  const samples = buildSamples(train, { apmBySeason: apm });
  return fit(samples, opts.lambda ?? 3000);
}

// 每个赛季一个「没见过它」的 SPM
const spmFor = new Map(seasons.map((s) => [s, trainSpm(s, {})]));

console.log(`\n影响力指标对照实验  赛季：${seasons.join('、')}`);
console.log('评测标准：用第 N 季的数据算指标，预测第 N+1 季的真实 APM\n');

const results = [];
const push = (r) => { results.push(r); return r; };

// --- 基线
push(evaluate('PIE', (p) => p.pie ?? 0));
push(evaluate('净效率 NET_RATING', (p) => p.netRtg ?? 0));
push(evaluate('官方估计净效率 E_NET', (p) => p.estNet ?? 0));
push(evaluate('裸 on/off 差', (p) => (p.onNet ?? 0) - (p.offNet ?? 0)));
push(evaluate('当季 APM（原始）', (p, s) => apm.get(s).get(p.playerId)?.apm ?? 0));

// --- 当前上线的做法：纯 box 的 SPM
push(evaluate('IMP 现状（纯 box SPM）', (p, s) => apply(spmFor.get(s), p) ?? 0));

// --- 多赛季衰减 APM
const decayCache = new Map();
const getDecay = (s, span) => {
  const k = `${s}|${span}`;
  if (!decayCache.has(k)) decayCache.set(k, decayedApm(s, { span }));
  return decayCache.get(k);
};
for (const span of [2, 3, 4]) {
  push(evaluate(`衰减 APM（${span} 季）`, (p, s) => getDecay(s, span).get(p.playerId)?.apm ?? 0));
}

// --- 混合：SPM 先验 + 实际 APM。这是 EPM 的第二步在做的事
console.log('混合权重扫描（w·APM + (1-w)·SPM）：');
let bestBlend = null;
for (const w of [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1]) {
  const r = evaluate(`混合 w=${w}`, (p, s) => {
    const a = getDecay(s, 3).get(p.playerId)?.apm ?? 0;
    const sp = apply(spmFor.get(s), p) ?? 0;
    return w * a + (1 - w) * sp;
  });
  console.log(`  w=${w.toFixed(1)}  r=${r.r.toFixed(4)}`);
  if (!bestBlend || r.r > bestBlend.r) bestBlend = r;
}
results.push(bestBlend);

// --- APM 岭回归强度扫描（固定 w=0.4、3 季衰减）
console.log('\nAPM lambda 扫描：');
for (const lam of [2000, 4000, 6000, 10000, 16000, 24000]) {
  const cache = new Map();
  const dec = (s) => {
    if (!cache.has(s)) {
      const i = seasons.indexOf(s);
      const rows = [];
      for (let k = 0; k < 3 && i - k >= 0; k++) {
        const w = 0.5 ** k;
        for (const l of lineups[seasons[i - k]]) rows.push({ ...l, poss: (l.poss ?? 0) * w });
      }
      cache.set(s, computeApm(rows, { lambda: lam }));
    }
    return cache.get(s);
  };
  const r = evaluate('', (p, s) => 0.4 * (dec(s).get(p.playerId)?.apm ?? 0)
    + 0.6 * (apply(spmFor.get(s), p) ?? 0));
  console.log(`  lambda=${String(lam).padStart(6)}  r=${r.r.toFixed(4)}`);
}

// --- 年龄项：EPM 明说用了，我们看看值不值
console.log('\n加入年龄项：');
{
  const withAge = (p) => Number.isFinite(p.age);
  const cover = seasons.map((s) => players[s].filter(withAge).length / players[s].length);
  console.log(`  年龄字段覆盖率 ${(mean(cover) * 100).toFixed(0)}%`);
  const spmAge = new Map(seasons.map((s) => {
    const train = seasons.filter((x) => x !== s && nextOf(x)).flatMap((x) => players[x]);
    return [s, fit(buildSamples(train, { apmBySeason: apm, withAge: true }), 3000)];
  }));
  const r = evaluate('', (p, s) => 0.4 * (getDecay(s, 3).get(p.playerId)?.apm ?? 0)
    + 0.6 * (apply(spmAge.get(s), p) ?? 0));
  console.log(`  混合 w=0.4 + 年龄  r=${r.r.toFixed(4)}   逐季 [${r.rs.map((v) => v.toFixed(2)).join(' ')}]`);
  results.push({ ...r, label: '混合 w=0.4 + 年龄' });
}

console.log('\n结果（与次季真实 APM 的相关，越高越好）：');
[...results].sort((a, b) => b.r - a.r).forEach((r, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${r.label.padEnd(24)} r=${r.r.toFixed(4)}   逐季 [${r.rs.map((v) => v.toFixed(2)).join(' ')}]`);
});
