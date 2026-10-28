/**
 * 实验 11（预注册见 docs/imp-improve-verdict.md「实验 10、11 预注册」）：高使用率得分手偏差；分钟收缩放大是否过度。只读缓存。
 *
 *   node scripts/imp-improve-lab11.mjs    # → docs/imp-improve-lab11-output.txt
 */
import { corr, mean, features } from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { calibratedResiduals, verdict } from '../server/impImproveLab.mjs';
import { pairs, seasons, players, minutesOf, predictor, calibratedValues } from './imp-improve-core.mjs';

const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const { k: K, pivot: PIVOT } = MINUTES_SHRINK;
// 正态近似的双侧 p 值（n ~ 1300，t 与正态无差）
const pOf = (r, n) => { const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r)); return Math.min(1, 2 * (1 - cdf(t))); };
function cdf(z) { // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * z / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}
const cappedShrink = (raw, m, mu) => mu + (raw - mu) * Math.min(1, (m / (m + K)) * ((PIVOT + K) / PIVOT));

// 每对：线上 5b 值、C1 封顶值、两把尺子的残差与协变量
const P = pairs.map((pr) => {
  const train = seasons.filter((x) => x !== pr.s);
  const base = calibratedValues(pr.s, { ageStat: 1 }, { train });
  const seen = seasons.slice(0, seasons.indexOf(pr.s) + 1);
  const ctx = { s: pr.s, train, agePairs: seen.slice(0, -1).map((x, i) => ({ s: x, nx: seen[i + 1] })), key: `cal${pr.s}|${pr.s}|${train.join(',')}` };
  const raw = predictor(ctx, { ageStat: 1, k: 0 });
  const x = pr.rows.map((p) => base.values.get(p.playerId) ?? 0);
  const xC = pr.rows.map((p) => { const r = raw(p); return r === null ? 0 : cappedShrink(r, minutesOf(p), base.mu) * base.scale; });
  const ok = pr.onoffY.map((v, j) => (v === null ? -1 : j)).filter((j) => j >= 0);
  const resA = calibratedResiduals(x, pr.apmY);
  const resOsub = calibratedResiduals(ok.map((j) => x[j]), ok.map((j) => pr.onoffY[j]));
  const resO = pr.rows.map(() => null); ok.forEach((j, t) => { resO[j] = resOsub[t]; });
  const cov = pr.rows.map((p) => {
    const f = features(p);
    return { usg: (p.usgPct ?? 0) * 100, pts36: f.pts, create36: f.pts + ((p.astPtsCreated ?? 0) * 36) / p.min };
  });
  return { pr, x, xC, ok, resA, resO, cov };
});

console.log('\n# 实验 11：高使用率得分手偏差 / 分钟收缩放大\n');
console.log('## 11-i 残差与协变量的相关（4 对合并；残差 = 实际 − 同对 OLS 映射值，>0 = 模型低估）\n');
console.log('| 协变量 | 尺子 | n | 合并 r | p | 逐对 r | 同号对数 |');
console.log('|---|---|---:|---:|---:|---|---:|');
const sig = {};
for (const c of ['usg', 'pts36', 'create36']) {
  sig[c] = {};
  for (const ruler of ['apm', 'onoff']) {
    const res = []; const cv = []; const perPair = [];
    for (const d of P) {
      const r0 = []; const c0 = [];
      d.pr.rows.forEach((_, j) => {
        const e = ruler === 'apm' ? d.resA[j] : d.resO[j];
        if (e === null) return;
        r0.push(e); c0.push(d.cov[j][c]);
      });
      // 协变量按对去均值后合并，避免赛季间水平差
      const mc = mean(c0);
      res.push(...r0); cv.push(...c0.map((v) => v - mc));
      perPair.push(corr(r0, c0));
    }
    const r = corr(res, cv); const p = pOf(r, res.length);
    const same = perPair.filter((v) => Math.sign(v) === Math.sign(r)).length;
    sig[c][ruler] = { r, p, same };
    console.log(`| ${c} | ${ruler} | ${res.length} | ${f4(r)} | ${p.toExponential(2)} | ${perPair.map((v) => v.toFixed(3)).join(', ')} | ${same}/4 |`);
  }
}
const ALPHA = 0.05 / 3;
console.log('\n预注册判定（两尺都 p < 0.05/3 且同号，且 ≥3 对同号）：');
let anySig = false;
for (const c of Object.keys(sig)) {
  const a = sig[c].apm; const o = sig[c].onoff;
  const ok = a.p < ALPHA && o.p < ALPHA && Math.sign(a.r) === Math.sign(o.r) && a.same >= 3 && o.same >= 3;
  anySig = anySig || ok;
  console.log(`- ${c}：${ok ? `**显著**（方向 ${a.r > 0 ? '模型低估高值者' : '模型高估高值者'}）` : '不显著'}`);
}
console.log(anySig ? '\n→ 有显著偏差：需要测 U1/U2（见下）' : '\n→ 没有预注册意义上的显著偏差：按预注册不测 U1/U2');

// ---------------------------------------------------------------- 11-iii 分钟分段
console.log('\n## 11-iii 分钟分段校准（只报告）：每段「尺子目标对线上 IMP」的斜率（每对去均值后合并）\n');
const BANDS = [[0, 1000], [1000, 1600], [1600, 2200], [2200, 1e9]];
const slope = (xs, ys) => { const mx = mean(xs); const my = mean(ys); let a = 0; let b = 0; xs.forEach((v, i) => { a += (v - mx) * (ys[i] - my); b += (v - mx) ** 2; }); return a / b; };
for (const ruler of ['apm', 'onoff']) {
  const all = { x: [], y: [] }; const by = BANDS.map(() => ({ x: [], y: [] }));
  for (const d of P) {
    const idx = ruler === 'apm' ? d.pr.rows.map((_, j) => j) : d.ok;
    const ys = idx.map((j) => (ruler === 'apm' ? d.pr.apmY[j] : d.pr.onoffY[j]));
    const xs = idx.map((j) => d.x[j]);
    const mx = mean(xs); const my = mean(ys);
    idx.forEach((j, t) => {
      const m = minutesOf(d.pr.rows[j]);
      all.x.push(xs[t] - mx); all.y.push(ys[t] - my);
      const b = BANDS.findIndex(([lo, hi]) => m >= lo && m < hi);
      by[b].x.push(xs[t] - mx); by[b].y.push(ys[t] - my);
    });
  }
  const s0 = slope(all.x, all.y);
  console.log(`${ruler}：全体斜率 ${s0.toFixed(3)}；` + BANDS.map(([lo, hi], b) => `${lo}–${hi > 1e8 ? '' : hi} 分钟（n=${by[b].x.length}）${slope(by[b].x, by[b].y).toFixed(3)}（×${(slope(by[b].x, by[b].y) / s0).toFixed(2)}）`).join('；'));
}
for (const ruler of ['apm', 'onoff']) {
  const rr = [];
  for (const d of P) d.pr.rows.forEach((p, j) => {
    const e = ruler === 'apm' ? d.resA[j] : d.resO[j];
    if (e !== null && minutesOf(p) >= 1600 && d.x[j] < 0) rr.push(e);
  });
  console.log(`- ≥1600 分钟且 IMP<0 的球员（n=${rr.length}），${ruler} 平均残差 ${f4(mean(rr))}（<0 = 被高估，>0 = 被低估即被压得太低）`);
}

// ---------------------------------------------------------------- 11-iv C1 封顶
console.log('\n## 11-iv C1：收缩因子封顶 1（>1600 分钟不再放大），与 5b 比\n');
const dA = []; const dO = [];
console.log('| 赛季对 | 次季 APM 5b → C1 | Δ | 次季 on/off 5b → C1 | Δ |\n|---|---|---:|---|---:|');
for (const d of P) {
  const a0 = corr(d.x, d.pr.apmY); const a1 = corr(d.xC, d.pr.apmY);
  const o0 = corr(d.ok.map((j) => d.x[j]), d.ok.map((j) => d.pr.onoffY[j])); const o1 = corr(d.ok.map((j) => d.xC[j]), d.ok.map((j) => d.pr.onoffY[j]));
  dA.push(a1 - a0); dO.push(o1 - o0);
  console.log(`| ${d.pr.pair} | ${a0.toFixed(4)} → ${a1.toFixed(4)} | ${f4(a1 - a0)} | ${o0.toFixed(4)} → ${o1.toFixed(4)} | ${f4(o1 - o0)} |`);
}
const v = verdict(dA, dO);
console.log(`| 平均 | | ${f4(v.mA)} | | ${f4(v.mO)} |\n\n输的对数 APM ${v.loseA}/4，on/off ${v.loseO}/4 → 预注册规则：**${v.adopt ? '通过' : '不通过'}**`);

// ---------------------------------------------------------------- 球员
const last = seasons.at(-1);
const baseL = calibratedValues(last, { ageStat: 1 }, { train: seasons });
const ctxL = { s: last, train: seasons, agePairs: seasons.slice(0, -1).map((x, i) => ({ s: x, nx: seasons[i + 1] })), key: `cal${last}|${last}|${seasons.join(',')}` };
const rawL = predictor(ctxL, { ageStat: 1, k: 0 });
console.log(`\n## ${last} 高使用率球员（usg ≥ 28%，或点名的几位；≥1500 分钟）：线上 5b 与 C1 封顶\n`);
console.log('| 球员 | usg | 每36分 | TS | 场×分钟 | 收缩前 | 5b（线上） | C1 封顶 |\n|---|---:|---:|---:|---|---:|---:|---:|');
const NAMED = ['Paolo Banchero', 'Zion Williamson', 'Trae Young', 'Jalen Green', 'Jordan Poole', 'Anfernee Simons', 'Brandon Miller'];
const rows = players[last].filter((p) => ((p.usgPct ?? 0) >= 0.28 || NAMED.includes(p.name)) && minutesOf(p) >= 1500 && baseL.values.has(p.playerId))
  .sort((a, b) => baseL.values.get(a.playerId) - baseL.values.get(b.playerId));
for (const p of rows) {
  const r = rawL(p);
  const c1 = cappedShrink(r, minutesOf(p), baseL.mu) * baseL.scale;
  console.log(`| ${p.name} | ${(p.usgPct * 100).toFixed(1)} | ${features(p).pts.toFixed(1)} | ${p.tsPct} | ${p.gp}×${p.min} | ${(r * baseL.scale).toFixed(2)} | ${baseL.values.get(p.playerId).toFixed(2)} | ${c1.toFixed(2)} |`);
}
