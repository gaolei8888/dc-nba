/**
 * 实验 10（预注册见 docs/imp-improve-verdict.md「实验 10、11 预注册」）：不满 20 场门槛的球员的 IMP 兜底。只读缓存。
 *
 *   node scripts/imp-improve-lab10.mjs    # → docs/imp-improve-lab10-output.txt
 *
 *   IMP10_TARGET=replacement node scripts/imp-improve-lab10.mjs   # 事后探索：收缩目标改为替补级（非预注册，不能据此采纳）
 *
 * 现状 F0：IMP 为 null → 下游按 REPLACEMENT_IMP = −0.5。候选 F1/F2/F3 见预注册。
 * 主判据是绝对误差：每对用常规评估球员拟合「尺子目标 ≈ a + b·线上 5b IMP」，兜底球员误差 = 实际 − (a + b·兜底值)。
 */
import { corr, mean } from '../server/impact.mjs';
import { shrinkByMinutes } from '../server/impactShrink.mjs';
import { REPLACEMENT_IMP } from '../server/ratings.mjs';
import { verdict } from '../server/impImproveLab.mjs';
import {
  pairs, seasons, allSeasons, players, byId, apmBy, minutesOf, eligible, predictor, calibratedValues, idxAll,
} from './imp-improve-core.mjs';

const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const ols = (x, y) => {
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; });
  const b = sxy / sxx;
  return { a: my - b * mx, b };
};

const CANDS = {
  F1: { ageStat: 1, relaxed: true },
  F2: { ageStat: 1, relaxed: true, multi: { mode: 'lastEligible', level: 'feat', span: 4 } },
  F3: { ageStat: 1, relaxed: true, multi: { mode: 'exp', h: 1, level: 'feat', span: 3 } },
};
/** 每个兜底候选的收缩证据量：F1 第 N 季分钟；F2 选中那一季的分钟；F3 衰减加权的有效分钟 */
const evidence = (name, p) => {
  const back = [0, 1, 2, 3].map((j) => allSeasons[idxAll(p.season) - j]).map((s) => (s ? byId[s].get(p.playerId) : null));
  if (name === 'F1') return minutesOf(p);
  if (name === 'F2') { const j = back.findIndex((q, i) => i >= 1 && eligible(q)); return minutesOf(back[j >= 1 ? j : 0]); }
  return back.slice(0, 3).reduce((a, q, j) => a + (q && q.min > 0 ? 0.5 ** j * minutesOf(q) : 0), 0);
};

/** 线上量纲的兜底值：base = 该口径下 5b 的 calibratedValues（scale、mu），ctx 与之相同 */
function fallbackValues(s, train, base) {
  const seen = seasons.slice(0, seasons.indexOf(s) + 1);
  const ctx = { s, train, agePairs: seen.slice(0, -1).map((x, i) => ({ s: x, nx: seen[i + 1] })), key: `cal${s}|${s}|${train.join(',')}` };
  const out = {};
  for (const [name, cfg] of Object.entries(CANDS)) {
    const f = predictor(ctx, { ...cfg, k: 0 });
    // IMP10_TARGET=replacement：事后探索（非预注册），收缩目标改为替补级 −0.5（换回原始单位）而不是人群均值
    const target = process.env.IMP10_TARGET === 'replacement' ? REPLACEMENT_IMP / base.scale : base.mu;
    out[name] = (p) => { const raw = f(p); return raw === null ? null : shrinkByMinutes(raw, evidence(name, p), target) * base.scale; };
  }
  return out;
}

console.log('\n# 实验 10：不满门槛球员的 IMP 兜底\n');
const per = [];
for (const [i, pr] of pairs.entries()) {
  const train = seasons.filter((x) => x !== pr.s);
  const base = calibratedValues(pr.s, { ageStat: 1 }, { train });
  // 常规评估球员上拟合「尺子 ≈ a + b·线上 IMP」
  const xs = pr.rows.map((p) => base.values.get(p.playerId) ?? 0);
  const mapA = ols(xs, pr.apmY);
  const okO = pr.onoffY.map((v, j) => (v === null ? -1 : j)).filter((j) => j >= 0);
  const mapO = ols(okO.map((j) => xs[j]), okO.map((j) => pr.onoffY[j]));
  const nxt = apmBy.get(pr.nx);
  const fb = players[pr.s].filter((p) => !eligible(p) && (p.min ?? 0) > 0 && (nxt.get(p.playerId)?.poss ?? 0) >= 500);
  const yA = fb.map((p) => nxt.get(p.playerId).apm);
  const yO = fb.map((p) => { const q = byId[pr.nx].get(p.playerId); return q && Number.isFinite(q.onNet) && Number.isFinite(q.offNet) ? q.onNet - q.offNet : null; });
  const vf = fallbackValues(pr.s, train, base);
  const elig = players[pr.s].filter((p) => eligible(p) && base.values.has(p.playerId));
  const wMean = elig.reduce((a, p) => a + minutesOf(p) * base.values.get(p.playerId), 0) / elig.reduce((a, p) => a + minutesOf(p), 0);
  const vals = {
    F0: fb.map(() => REPLACEMENT_IMP),
    "F0'": fb.map(() => wMean),
    ...Object.fromEntries(Object.keys(CANDS).map((n) => [n, fb.map((p) => vf[n](p) ?? REPLACEMENT_IMP)])),
  };
  const row = { pair: pr.pair, n: fb.length, nO: yO.filter((v) => v !== null).length, mse: {}, r: {} };
  for (const [n, v] of Object.entries(vals)) {
    const eA = v.map((x, j) => yA[j] - (mapA.a + mapA.b * x));
    const idx = yO.map((y, j) => (y === null ? -1 : j)).filter((j) => j >= 0);
    const eO = idx.map((j) => yO[j] - (mapO.a + mapO.b * v[j]));
    row.mse[n] = { apm: mean(eA.map((e) => e * e)), onoff: mean(eO.map((e) => e * e)) };
    const sd = Math.max(...v) - Math.min(...v);
    row.r[n] = { apm: sd > 0 ? corr(v, yA) : 0, onoff: sd > 0 ? corr(idx.map((j) => v[j]), idx.map((j) => yO[j])) : 0 };
  }
  per.push(row);
}

const names = Object.keys(per[0].mse);
console.log('| 赛季对 | 人数（on/off） | ' + names.map((n) => `${n} MSE APM / on/off`).join(' | ') + ' |');
console.log('|---|---|' + names.map(() => '---').join('|') + '|');
per.forEach((r) => console.log(`| ${r.pair} | ${r.n}（${r.nO}） | ${names.map((n) => `${r.mse[n].apm.toFixed(3)} / ${r.mse[n].onoff.toFixed(1)}`).join(' | ')} |`));
console.log('\n相关系数（参照；常数记 0）：');
per.forEach((r) => console.log(`- ${r.pair}: ${names.filter((n) => !n.startsWith('F0')).map((n) => `${n} APM ${r.r[n].apm.toFixed(3)} on/off ${r.r[n].onoff.toFixed(3)}`).join('；')}`));

// 留一对：在其余 3 对上按两尺「MSE ÷ F0 MSE」的平均选 F1/F2/F3
const score = (r, n) => (r.mse[n].apm / r.mse.F0.apm + r.mse[n].onoff / r.mse.F0.onoff) / 2;
const picks = per.map((_, i) => {
  let best = null;
  for (const n of Object.keys(CANDS)) {
    const v = mean(per.filter((_, j) => j !== i).map((r) => score(r, n)));
    if (!best || v < best.v - 1e-12) best = { n, v };
  }
  return best.n;
});
const dA = per.map((r, i) => r.mse.F0.apm - r.mse[picks[i]].apm);
const dO = per.map((r, i) => r.mse.F0.onoff - r.mse[picks[i]].onoff);
const v = verdict(dA, dO);
console.log('\n留一对选中：' + per.map((r, i) => `${r.pair} ${picks[i]}`).join('，'));
console.log(`ΔMSE（F0 − 选中，>0 更好）次季 APM [${dA.map(f4).join(', ')}] 平均 ${f4(v.mA)}；次季 on/off [${dO.map((x) => x.toFixed(2)).join(', ')}] 平均 ${v.mO.toFixed(2)}`);
console.log(`输的对数 APM ${v.loseA}/4，on/off ${v.loseO}/4 → 预注册规则：**${v.adopt ? '通过' : '不通过'}**`);
const finalPick = Object.keys(CANDS).reduce((b, n) => (mean(per.map((r) => score(r, n))) < mean(per.map((r) => score(r, b))) ? n : b), 'F1');
console.log(`四对合并选中（供线上用）：${finalPick}`);

// ---------------------------------------------------------------- 2025-26 受影响的球员
const last = seasons.at(-1);
const baseL = calibratedValues(last, { ageStat: 1 }, { train: seasons });
const vfL = fallbackValues(last, seasons, baseL);
const aff = players[last].filter((p) => !eligible(p) && (p.min ?? 0) > 0)
  .map((p) => ({ p, v: vfL[finalPick](p), all: Object.fromEntries(Object.keys(CANDS).map((n) => [n, vfL[n](p)])) }))
  .filter((r) => r.v !== null);
console.log(`\n## ${last}：线上原本为 null（按 −0.5）的 ${players[last].filter((p) => !eligible(p) && (p.min ?? 0) > 0).length} 人中，兜底后有值 ${aff.length} 人`);
const fmt = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2));
const show = (r) => `| ${r.p.name} | ${r.p.age} | ${r.p.gp}×${r.p.min} | −0.50 | ${Object.keys(CANDS).map((n) => fmt(r.all[n])).join(' | ')} |`;
console.log(`\n| 球员 | 年龄 | 场×分钟 | 现状 | ${Object.keys(CANDS).join(' | ')} |\n|---|---:|---|---:|${Object.keys(CANDS).map(() => '---:').join('|')}|`);
const named = ['Jayson Tatum', 'Ja Morant', 'Tyrese Haliburton', 'Damian Lillard', 'Kyrie Irving', 'Joel Embiid', 'Dejounte Murray', 'Fred VanVleet', 'Jalen Green'];
for (const n of named) { const r = aff.find((x) => x.p.name === n); if (r) console.log(show(r)); }
console.log('\n兜底后最高的 10 人（选中口径）：');
[...aff].sort((a, b) => b.v - a.v).slice(0, 10).forEach((r) => console.log(show(r)));
const dist = aff.map((r) => r.v).sort((a, b) => a - b);
console.log(`\n选中口径兜底值分布：中位 ${fmt(dist[Math.floor(dist.length / 2)])}，10% ${fmt(dist[Math.floor(dist.length * 0.1)])}，90% ${fmt(dist[Math.floor(dist.length * 0.9)])}；高于 −0.5 的 ${dist.filter((x) => x > -0.5).length} 人`);
