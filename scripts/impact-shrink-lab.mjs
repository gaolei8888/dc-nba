/**
 * 实验 1：IMP 按样本量收缩（server/impactShrink.mjs）。只读 data/history/，不抓数据。
 *
 *   node scripts/impact-shrink-lab.mjs
 *
 * 判据沿用 fit-impact / impact-lab 的「用第 N 季预测第 N+1 季」，两把尺子：
 *   · 次季真实 APM（单季，λ=6000）
 *   · 次季裸 on/off（独立尺子，缺陷来源与 APM 不同）
 * 球员范围与 fit-impact 的 rowsFor 相同：两季 APM 回合 ≥500、当季 ≥20 场且场均 ≥10 分钟。
 * SPM 训练时看不到第 N 季（trainSpm(held)，与 fit-impact 同）。
 *
 * 预注册的采纳规则：k 在两把尺子上的赛季对平均都变好，且在多数赛季对上不输。
 * k 的选择用「留一赛季对」：在另外 3 对上按两尺平均选 k，只在留出那对上打分，
 * 这样报出来的每对数字都没有用到那一对自己。全网格也照列，供核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import {
  buildSamples, fit, apply, corr, mean, BLEND_W, DECAY_SPAN, DECAY_HALFLIFE,
} from '../server/impact.mjs';
import { shrunkImpact, shrinkToward } from '../server/impactShrink.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const APM_LAMBDA = 6000;
const SPM_LAMBDA = 3000;

const players = {}; const lineups = {};
for (const f of fs.readdirSync(HISTORY)) {
  let m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
  if (m) {
    players[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')).players.map((p) => ({ ...p, season: m[1] }));
    continue;
  }
  m = f.match(/^lineups_(\d{4}-\d{2})\.json$/);
  if (m) lineups[m[1]] = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')).rows;
}
const seasons = Object.keys(players).sort().filter((s) => lineups[s]);
if (seasons.length < 3) {
  console.error('缺 data/history/impact_*.json / lineups_*.json（从 GB10 的 ~/dc-nba-refresh/data/history 拷，别冷抓）');
  process.exit(1);
}
const nextOf = (s) => seasons[seasons.indexOf(s) + 1];
const apmBySeason = new Map(seasons.map((s) => [s, computeApm(lineups[s], { lambda: APM_LAMBDA })]));
const decay = new Map(seasons.map((s) => {
  const i = seasons.indexOf(s);
  const slice = seasons.slice(Math.max(0, i - DECAY_SPAN + 1), i + 1).map((x) => ({ season: x, rows: lineups[x] }));
  return [s, decayedApm(slice, { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: APM_LAMBDA })];
}));

// 每个赛季对：输入、两把尺子的目标
const pairs = [];
for (const s of seasons) {
  const nx = nextOf(s);
  if (!nx) continue;
  const cur = apmBySeason.get(s); const nxt = apmBySeason.get(nx);
  const nxById = new Map(players[nx].map((p) => [p.playerId, p]));
  const rows = players[s].filter((p) => {
    const a = cur.get(p.playerId); const b = nxt.get(p.playerId);
    return a && b && a.poss >= 500 && b.poss >= 500 && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10;
  });
  const spmModel = fit(buildSamples(seasons.filter((x) => x !== s).flatMap((x) => players[x]), { apmBySeason }), SPM_LAMBDA);
  const inputs = rows.map((p) => {
    const d = decay.get(s).get(p.playerId);
    return { spm: apply(spmModel, p), apm: d?.apm ?? null, apmPoss: d?.poss ?? 0, minutes: (p.gp ?? 0) * (p.min ?? 0) };
  });
  // B 的收缩目标：该季够门槛球员的 SPM 简单均值（只用输入赛季，不看次季）
  const pool = players[s].map((p) => apply(spmModel, p)).filter((v) => v !== null);
  const onoff = rows.map((p) => {
    const q = nxById.get(p.playerId);
    return q && Number.isFinite(q.onNet) && Number.isFinite(q.offNet) ? q.onNet - q.offNet : null;
  });
  pairs.push({
    pair: `${s}→${nx}`, n: rows.length, inputs, spmTarget: mean(pool),
    apmY: rows.map((p) => nxt.get(p.playerId).apm), onoffY: onoff,
  });
}

/** 一组参数在一个赛季对上的两把尺子 */
function scorePair(pr, opt) {
  const x = pr.inputs.map((inp) => {
    const v = shrunkImpact(inp, { w: BLEND_W, spmTarget: pr.spmTarget, ...opt }) ?? 0;
    // C：收缩对象是混合后的 IMP，目标同样是人群 SPM 均值，证据量用出场分钟
    return opt.kImp ? shrinkToward(v, pr.spmTarget, inp.minutes, opt.kImp) : v;
  });
  const ok = pr.onoffY.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  return { apm: corr(x, pr.apmY), onoff: corr(ok.map((i) => x[i]), ok.map((i) => pr.onoffY[i])) };
}

const KAPM = [0, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000];
const KSPM = [0, 100, 200, 400, 800, 1600, 3200, 6400, 12800];
const FORMS = {
  'A 实测半向 SPM 收缩（k 单位：回合）': KAPM.map((k) => ({ kApm: k })),
  'B SPM 向人群均值收缩（k 单位：分钟）': KSPM.map((k) => ({ kSpm: k })),
  'C 整个 IMP 向人群均值收缩（k 单位：分钟）': KSPM.map((k) => ({ kImp: k })),
  'A+B 两者叠加': KAPM.flatMap((ka) => KSPM.map((ks) => ({ kApm: ka, kSpm: ks }))),
};
// 形式本身也是一次选择：把所有形式的所有 k 放在一起，按同样的留一对协议选，防止事后挑形式
FORMS['★ 全部候选一起选（形式 + k）'] = Object.values(FORMS).flat();
const BASE = { kApm: 0, kSpm: 0 };
const f4 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(4);
const optStr = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || '不收缩';

console.log(`\nIMP 收缩实验  赛季对：${pairs.map((p) => `${p.pair}(${p.n})`).join('、')}`);
console.log(`现状 IMP = ${BLEND_W}·衰减APM + ${(1 - BLEND_W).toFixed(2)}·SPM（单位：未校准 APM 单位，相关系数与量纲无关）\n`);

const base = pairs.map((pr) => scorePair(pr, BASE));
console.log('现状逐对：', pairs.map((pr, i) => `${pr.pair} APM ${base[i].apm.toFixed(4)} on/off ${base[i].onoff.toFixed(4)}`).join('；'));
console.log(`现状平均：次季 APM ${mean(base.map((b) => b.apm)).toFixed(4)}，次季 on/off ${mean(base.map((b) => b.onoff)).toFixed(4)}`);

const summary = [];
for (const [form, grid] of Object.entries(FORMS)) {
  console.log(`\n## ${form}\n`);
  const table = grid.map((opt) => ({ opt, s: pairs.map((pr) => scorePair(pr, opt)) }));
  if (grid.length <= 10) {
    console.log('| k | 次季 APM 平均 | Δ | 次季 on/off 平均 | Δ | 两尺平均 |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const { opt, s } of table) {
      const a = mean(s.map((x) => x.apm)); const o = mean(s.map((x) => x.onoff));
      console.log(`| ${optStr(opt)} | ${a.toFixed(4)} | ${f4(a - mean(base.map((b) => b.apm)))} | ${o.toFixed(4)} | ${f4(o - mean(base.map((b) => b.onoff)))} | ${((a + o) / 2).toFixed(4)} |`);
    }
  } else {
    const best = [...table].sort((x, y) => mean(y.s.map((v) => (v.apm + v.onoff) / 2)) - mean(x.s.map((v) => (v.apm + v.onoff) / 2))).slice(0, 5);
    console.log('全网格两尺平均前 5（样本内，仅供核对）：');
    for (const { opt, s } of best) console.log(`  ${optStr(opt).padEnd(22)} APM ${mean(s.map((v) => v.apm)).toFixed(4)}  on/off ${mean(s.map((v) => v.onoff)).toFixed(4)}`);
  }

  // 留一赛季对：在其余 3 对上选 k，只在留出对上打分
  console.log('\n留一赛季对（k 只在其余 3 对上选）：\n');
  console.log('| 留出对 | 选中 k | 次季 APM 现状 → 收缩 | Δ | 次季 on/off 现状 → 收缩 | Δ |');
  console.log('|---|---|---|---:|---|---:|');
  const held = pairs.map((pr, i) => {
    let pick = null;
    for (const { opt, s } of table) {
      const v = mean(s.filter((_, j) => j !== i).map((x) => (x.apm + x.onoff) / 2));
      if (!pick || v > pick.v + 1e-12) pick = { opt, v, s: s[i] };
    }
    const dA = pick.s.apm - base[i].apm; const dO = pick.s.onoff - base[i].onoff;
    console.log(`| ${pr.pair} | ${optStr(pick.opt)} | ${base[i].apm.toFixed(4)} → ${pick.s.apm.toFixed(4)} | ${f4(dA)} | ${base[i].onoff.toFixed(4)} → ${pick.s.onoff.toFixed(4)} | ${f4(dO)} |`);
    return { dA, dO, opt: pick.opt };
  });
  const mA = mean(held.map((h) => h.dA)); const mO = mean(held.map((h) => h.dO));
  const loseA = held.filter((h) => h.dA < -1e-9).length; const loseO = held.filter((h) => h.dO < -1e-9).length;
  console.log(`| **平均** | | | ${f4(mA)} | | ${f4(mO)} |`);
  // 预注册规则：两尺平均都变好；任一尺子都不在多数（>一半）赛季对上输
  const adopt = mA > 0 && mO > 0 && loseA <= pairs.length / 2 && loseO <= pairs.length / 2;
  const strict = mA > 0 && mO > 0 && loseA <= 1 && loseO <= 1;
  console.log(`\n输的赛季对：次季 APM ${loseA}/${pairs.length}，次季 on/off ${loseO}/${pairs.length}`);
  console.log(`预注册规则（平均两尺都变好，且输的对数不过半）：${adopt ? '通过' : '不通过'}；更严口径（最多输 1 对）：${strict ? '通过' : '不通过'}`);
  summary.push({ form, mA, mO, loseA, loseO, adopt, strict, picks: held.map((h) => optStr(h.opt)) });
}

console.log('\n## 汇总\n');
for (const s of summary) {
  console.log(`- ${s.form}：留一对 Δ 次季 APM ${f4(s.mA)}（输 ${s.loseA} 对），Δ 次季 on/off ${f4(s.mO)}（输 ${s.loseO} 对）；`
    + `选中 [${s.picks.join(' | ')}]；预注册规则 ${s.adopt ? '通过' : '不通过'}，严口径 ${s.strict ? '通过' : '不通过'}`);
}

// ---------------------------------------------------------------- 量纲
//
// 相关系数与量纲无关，所以上面的判据定不了「收缩后一分 IMP 值多少」。
// 而阵容榜是把 IMP × 分钟直接加总的，量纲会变。这里用同一批赛季对，
// 算「次季目标对预测值」的合并 OLS 斜率（每对先去均值）：斜率之比就是要补乘的系数，
// 让收缩后的 IMP 每一分对应的次季实测与现状相同。只用来定量纲，不参与选 k。
function pooledSlope(opt) {
  let sxy = 0; let sxx = 0; let oxy = 0; let oxx = 0;
  for (const pr of pairs) {
    const x = pr.inputs.map((inp) => {
      const v = shrunkImpact(inp, { w: BLEND_W, spmTarget: pr.spmTarget, ...opt }) ?? 0;
      return opt.kImp ? shrinkToward(v, pr.spmTarget, inp.minutes, opt.kImp) : v;
    });
    const mx = mean(x); const my = mean(pr.apmY);
    x.forEach((v, i) => { sxy += (v - mx) * (pr.apmY[i] - my); sxx += (v - mx) ** 2; });
    const ok = pr.onoffY.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
    const mo = mean(ok.map((i) => pr.onoffY[i])); const mxo = mean(ok.map((i) => x[i]));
    for (const i of ok) { oxy += (x[i] - mxo) * (pr.onoffY[i] - mo); oxx += (x[i] - mxo) ** 2; }
  }
  return { apm: sxy / sxx, onoff: oxy / oxx };
}
console.log('\n## 量纲：次季目标对预测值的合并斜率（只定量纲，不参与选 k）\n');
const s0 = pooledSlope(BASE);
for (const opt of [BASE, { kImp: 1600 }, { kImp: 3200 }, { kImp: 6400 }, { kApm: 16000, kSpm: 6400 }]) {
  const s = pooledSlope(opt);
  console.log(`- ${optStr(opt).padEnd(22)} 斜率 次季APM ${s.apm.toFixed(3)}（÷现状 ${(s.apm / s0.apm).toFixed(3)}）`
    + `  次季on/off ${s.onoff.toFixed(3)}（÷现状 ${(s.onoff / s0.onoff).toFixed(3)}）`);
}
