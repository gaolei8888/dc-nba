/**
 * 实验 9（预注册见 docs/imp-improve-verdict.md「实验 9 预注册」）：年龄对齐的长记忆。只读缓存，不抓数据。
 *
 *   node scripts/imp-improve-lab9.mjs     # → docs/imp-improve-lab9-output.txt
 *
 * 基线 = 线上 5b（ageStat=1，APM 3 季/半衰期 1，k=3200）。规则同前：留一赛季对两尺平均都变好、任一尺子最多输 2 对。
 * 9a：衰减 APM 的每季组合目标先按总值年龄曲线对齐到 N+1 岁（imp-improve-core.mjs 的 measAged），α 与 span/半衰期/k 按留一对选。
 * 9b：9a × 8d（逐项特征对齐到 N+1 岁后多季平均）。
 * 子群（只报告）：伤病/低迷季、32 岁及以上，在两把尺子上的校准残差。
 */
import { mean, corr } from '../server/impact.mjs';
import {
  lopoPick, verdict, calibratedResiduals, residualStats, isSlumpSeason,
} from '../server/impImproveLab.mjs';
import { pairs, predictor, CTX, scoreCfg, byId, allSeasons, minutesOf } from './imp-improve-core.mjs';

const t0 = Date.now();
const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const str = (c) => Object.entries(c).map(([k, v]) => `${k}=${typeof v === 'object' && v ? Object.values(v).join('/') : v}`).join(' ');

const BASE = { ageStat: 1 };
const V1 = {};
const base = scoreCfg(BASE);
const v1 = scoreCfg(V1);
console.log('\n# 实验 9：年龄对齐的长记忆（基线 = 线上 5b）\n');
console.log('| 赛季对 | v1 次季APM | 5b 次季APM | v1 on/off | 5b on/off |\n|---|---:|---:|---:|---:|');
pairs.forEach((pr, i) => console.log(`| ${pr.pair} | ${v1[i].apm.toFixed(4)} | ${base[i].apm.toFixed(4)} | ${v1[i].onoff.toFixed(4)} | ${base[i].onoff.toFixed(4)} |`));
console.log(`| 平均 | ${mean(v1.map((x) => x.apm)).toFixed(4)} | ${mean(base.map((x) => x.apm)).toFixed(4)} | ${mean(v1.map((x) => x.onoff)).toFixed(4)} | ${mean(base.map((x) => x.onoff)).toFixed(4)} |`);

const K = [1600, 3200, 6400];
const grid9a = [3, 4, 5].flatMap((span) => [1, 1.5, 2, 3].flatMap((hl) => [0, 0.5, 1].flatMap((apmAge) => K.map((k) => ({
  ageStat: 1, span, hl, apmAge, k,
})))));
// 基线排在最前，平局取它
grid9a.sort((a, b) => (a.span === 3 && a.hl === 1 && a.apmAge === 0 && a.k === 3200 ? -1 : 0) - (b.span === 3 && b.hl === 1 && b.apmAge === 0 && b.k === 3200 ? -1 : 0));
const SPM_OPTS = [null, ...[{ mode: 'exp', h: 1 }, { mode: 'exp', h: 3 }, { mode: 'exp', h: 5 }, { mode: 'equal' }]
  .flatMap((d) => [false, true].map((mEff) => ({ multi: { ...d, level: 'feat', span: 5 }, mEff })))];
const grid9b = grid9a.flatMap((c) => SPM_OPTS.map((o) => (o ? { ...c, ...o } : c)));

const results = {};
function run(id, title, grid) {
  const t = Date.now();
  const table = grid.map((cfg) => ({ cfg, s: scoreCfg(cfg) }));
  const held = lopoPick(table);
  const dA = held.map((h, i) => h.s.apm - base[i].apm); const dO = held.map((h, i) => h.s.onoff - base[i].onoff);
  const dA1 = held.map((h, i) => h.s.apm - v1[i].apm); const dO1 = held.map((h, i) => h.s.onoff - v1[i].onoff);
  const v = verdict(dA, dO);
  console.log(`\n## ${id} ${title}（${grid.length} 个候选，${((Date.now() - t) / 1000).toFixed(1)} 秒）\n`);
  const top = [...table].sort((a, b) => mean(b.s.map((x) => x.apm + x.onoff)) - mean(a.s.map((x) => x.apm + x.onoff))).slice(0, 3);
  console.log('样本内两尺平均前 3（仅供核对）：');
  top.forEach(({ cfg, s }) => console.log(`  ${str(cfg).padEnd(70)} APM ${mean(s.map((x) => x.apm)).toFixed(4)} on/off ${mean(s.map((x) => x.onoff)).toFixed(4)}`));
  console.log('\n| 留出对 | 选中参数 | 次季 APM 5b → 变体 | Δ vs 5b | Δ vs v1 | 次季 on/off 5b → 变体 | Δ vs 5b | Δ vs v1 |');
  console.log('|---|---|---|---:|---:|---|---:|---:|');
  held.forEach((h, i) => console.log(`| ${pairs[i].pair} | ${str(h.cfg)} | ${base[i].apm.toFixed(4)} → ${h.s.apm.toFixed(4)} | ${f4(dA[i])} | ${f4(dA1[i])} | ${base[i].onoff.toFixed(4)} → ${h.s.onoff.toFixed(4)} | ${f4(dO[i])} | ${f4(dO1[i])} |`));
  console.log(`| **平均** | | | ${f4(v.mA)} | ${f4(mean(dA1))} | | ${f4(v.mO)} | ${f4(mean(dO1))} |`);
  console.log(`\n相对 5b 输的对数：次季 APM ${v.loseA}/4，次季 on/off ${v.loseO}/4 → 预注册规则：**${v.adopt ? '通过' : '不通过'}**`);
  results[id] = { ...v, held };
}
run('9a', '年龄对齐的长记忆 APM', grid9a);
run('9b', '9a × 8d（年龄对齐后多季逐项平均）', grid9b);

// ---------------------------------------------------------------- 子群
const predsOf = (cfgs) => pairs.map((pr, i) => { const f = predictor(CTX[i], cfgs[i]); return pr.rows.map((p) => f(p) ?? 0); });
const MODELS = {
  v1: predsOf(pairs.map(() => V1)),
  '5b（线上）': predsOf(pairs.map(() => BASE)),
  '9a（留一对选中）': predsOf(results['9a'].held.map((h) => h.cfg)),
  '9b（留一对选中）': predsOf(results['9b'].held.map((h) => h.cfg)),
};
const priorMins = (p) => [1, 2].map((k) => {
  const s = allSeasons[allSeasons.indexOf(p.season) - k];
  return s ? minutesOf(byId[s].get(p.playerId)) : NaN;
});
const GROUPS = {
  '伤病/低迷季（分钟 < 前两季均值 60%）': (p) => isSlumpSeason(minutesOf(p), priorMins(p)),
  '32 岁及以上': (p) => Number.isFinite(p.age) && p.age >= 32,
  全体: () => true,
};
console.log('\n## 子群检查（预注册，只报告；残差 = 实际 − 同对 OLS 映射值，<0 表示被高估；4 对合并）\n');
console.log('| 子群 | 人数 | 模型 | 次季 APM 平均残差 | 平均绝对残差 | 次季 on/off 平均残差 | 平均绝对残差 |');
console.log('|---|---:|---|---:|---:|---:|---:|');
const oldBias = {};
for (const [g, inG] of Object.entries(GROUPS)) {
  for (const [name, preds] of Object.entries(MODELS)) {
    const rA = []; const rO = [];
    pairs.forEach((pr, i) => {
      const resA = calibratedResiduals(preds[i], pr.apmY);
      const ok = pr.onoffY.map((v, j) => (v === null ? -1 : j)).filter((j) => j >= 0);
      const resO = calibratedResiduals(ok.map((j) => preds[i][j]), ok.map((j) => pr.onoffY[j]));
      const oIdx = new Map(ok.map((j, t) => [j, t]));
      pr.rows.forEach((p, j) => {
        if (!inG(p)) return;
        rA.push(resA[j]);
        if (oIdx.has(j)) rO.push(resO[oIdx.get(j)]);
      });
    });
    const a = residualStats(rA); const o = residualStats(rO);
    if (g === '32 岁及以上') oldBias[name] = { apm: a.bias, onoff: o.bias };
    console.log(`| ${g} | ${a.n} | ${name} | ${f4(a.bias)} | ${a.mae.toFixed(4)} | ${f4(o.bias)} | ${o.mae.toFixed(4)} |`);
  }
}

console.log('\n## 候选判定（预注册：通过规则，且 32 岁以上平均残差在两把尺子上都不比 5b 更负）\n');
for (const id of ['9a', '9b']) {
  const ob = oldBias[`${id}（留一对选中）`]; const bb = oldBias['5b（线上）'];
  const notWorse = ob.apm >= bb.apm && ob.onoff >= bb.onoff;
  console.log(`- ${id}：规则 ${results[id].adopt ? '通过' : '不通过'}；32+ 残差 APM ${f4(ob.apm)}（5b ${f4(bb.apm)}）、on/off ${f4(ob.onoff)}（5b ${f4(bb.onoff)}）→ 老将偏差${notWorse ? '不比 5b 差' : '比 5b 差'} → ${results[id].adopt && notWorse ? '**候选**（不接入，待用户决定）' : '不是候选'}`);
}
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
