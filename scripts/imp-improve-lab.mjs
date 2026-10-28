/**
 * IMP 改进实验（预注册见 docs/imp-improve-verdict.md，纯函数在 server/impImproveLab.mjs）。只读 data/history/，不抓数据。
 *
 *   node scripts/imp-improve-lab.mjs              # 全部实验 → 标准输出（docs/imp-improve-lab-output.txt 即其存档）
 *   IMP_LAB_ONLY=1,8c node scripts/imp-improve-lab.mjs   # 只跑部分实验
 *
 * 口径与 scripts/impact-shrink-lab.mjs 完全相同：4 个赛季对、rowsFor 门槛、两把尺子
 * （次季单季 APM λ=6000；次季裸 on/off），SPM 训练剔除第 N 季；
 * 基线 = 现行收缩后 IMP（0.35·衰减APM + 0.65·SPM，再按分钟向人群 SPM 均值收缩 k=3200）。
 * 所有参数（含收缩 k）只用留一赛季对选。
 */
import { FEATURES, mean } from '../server/impact.mjs';
import { lopoPick, verdict } from '../server/impImproveLab.mjs';
import {
  seasons, pairs, padsOf, ageCurve, statCurves, backfillPairs, DEF, scoreCfg,
} from './imp-improve-core.mjs';

const ONLY = process.env.IMP_LAB_ONLY ? new Set(process.env.IMP_LAB_ONLY.split(',')) : null;
const t0 = Date.now();

// ---------------------------------------------------------------- 报告
const f4 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4);
const cfgStr = (c) => Object.entries(c).filter(([k, v]) => v !== DEF[k] && v !== undefined)
  .map(([k, v]) => `${k}=${typeof v === 'object' && v ? Object.values(v).join('/') : v}`).join(' ') || '现状';
const kGrid = [1600, 3200, 6400];

const BASE_CFG = {};
const base = scoreCfg(BASE_CFG);
console.log(`\n# IMP 改进实验  赛季对：${pairs.map((p) => `${p.pair}(${p.rows.length}人，可用往季 ${p.back} 季)`).join('、')}\n`);
console.log('基线（现行收缩后 IMP）逐对：');
pairs.forEach((pr, i) => console.log(`- ${pr.pair}: 次季 APM ${base[i].apm.toFixed(4)}，次季 on/off ${base[i].onoff.toFixed(4)}`));
console.log(`- 平均：次季 APM ${mean(base.map((b) => b.apm)).toFixed(4)}，次季 on/off ${mean(base.map((b) => b.onoff)).toFixed(4)}`);

const summary = []; const allTables = [];
function experiment(id, title, grid, { pool = true } = {}) {
  if (ONLY && !ONLY.has(id)) return null;
  const t = Date.now();
  const table = grid.map((cfg) => ({ cfg, s: scoreCfg(cfg) }));
  if (pool) allTables.push(...table);
  console.log(`\n## ${id} ${title}（${grid.length} 个候选，${((Date.now() - t) / 1000).toFixed(1)} 秒）\n`);
  const top = [...table].sort((a, b) => mean(b.s.map((v) => v.apm + v.onoff)) - mean(a.s.map((v) => v.apm + v.onoff))).slice(0, 3);
  console.log('样本内两尺平均前 3（仅供核对，不用于判定）：');
  for (const { cfg, s } of top) console.log(`  ${cfgStr(cfg).padEnd(48)} APM ${mean(s.map((v) => v.apm)).toFixed(4)}  on/off ${mean(s.map((v) => v.onoff)).toFixed(4)}`);
  return judge(id, title, table);
}
function judge(id, title, table) {
  const held = lopoPick(table);
  console.log('\n| 留出对 | 选中参数 | 次季 APM 基线 → 变体 | Δ | 次季 on/off 基线 → 变体 | Δ |');
  console.log('|---|---|---|---:|---|---:|');
  const dA = []; const dO = [];
  held.forEach((h, i) => {
    dA.push(h.s.apm - base[i].apm); dO.push(h.s.onoff - base[i].onoff);
    console.log(`| ${pairs[i].pair} | ${cfgStr(h.cfg)} | ${base[i].apm.toFixed(4)} → ${h.s.apm.toFixed(4)} | ${f4(dA[i])} | ${base[i].onoff.toFixed(4)} → ${h.s.onoff.toFixed(4)} | ${f4(dO[i])} |`);
  });
  const v = verdict(dA, dO);
  console.log(`| **平均** | | ${mean(base.map((b) => b.apm)).toFixed(4)} → ${mean(held.map((h) => h.s.apm)).toFixed(4)} | ${f4(v.mA)} | ${mean(base.map((b) => b.onoff)).toFixed(4)} → ${mean(held.map((h) => h.s.onoff)).toFixed(4)} | ${f4(v.mO)} |`);
  console.log(`\n输的对数：次季 APM ${v.loseA}/4，次季 on/off ${v.loseO}/4 → 预注册规则：**${v.adopt ? '通过' : '不通过'}**`);
  summary.push({ id, title, ...v, picks: held.map((h) => cfgStr(h.cfg)) });
  return { ...v, held };
}
/** 固定参数（无需选）的一行：只报，不选 */
function fixedRow(label, cfg) {
  const s = scoreCfg(cfg);
  const dA = s.map((x, i) => x.apm - base[i].apm); const dO = s.map((x, i) => x.onoff - base[i].onoff);
  console.log(`- ${label.padEnd(30)} 逐对 Δ APM [${dA.map(f4).join(', ')}] 平均 ${f4(mean(dA))}；Δ on/off [${dO.map(f4).join(', ')}] 平均 ${f4(mean(dO))}`);
  return s;
}
const withK = (cfgs) => cfgs.flatMap((c) => kGrid.map((k) => ({ ...c, k })));

// 0. 基线在同一 k 网格下（应 4 折都选 3200）
experiment('0', '现状只调收缩 k（对照）', withK([{}]), { pool: true });

// 1. APM 权重随回合数增长
experiment('1', 'APM 权重随回合数增长 w = wmax·n/(n+c)',
  withK([0.35, 0.5, 0.7, 1].flatMap((w) => [0, 1000, 2000, 4000, 8000, 16000, 32000].map((c) => ({ w, c })))));

// 2. 攻防分开
const W2 = [0.2, 0.35, 0.5, 0.65]; const K2 = [1600, 3200, 6400];
const grid2a = W2.flatMap((wO) => W2.flatMap((wD) => K2.flatMap((kO) => K2.map((kD) => ({ sides: true, wO, wD, kO, kD })))));
experiment('2a', '攻防分开：两侧各自的混合权重与收缩', grid2a);
experiment('2b', '攻防分开 + 两侧 SPM λ 各自可选', grid2a.flatMap((c) => [1000, 3000, 10000].flatMap((lamO) => [1000, 3000, 10000].map((lamD) => ({ ...c, lamO, lamD })))));

// 3. SPM 作岭回归先验（lineups APM）
const L3 = [3000, 6000, 12000, 24000, 48000, 96000];
experiment('3a', 'SPM 作 APM 岭回归先验，不再混合', withK(L3.flatMap((srcLam) => ['side', 'half'].map((prior) => ({ prior, srcLam, w: 1 })))));
experiment('3b', 'SPM 作先验 + 再与 SPM 混合', withK(L3.flatMap((srcLam) => ['side', 'half'].flatMap((prior) => [0.35, 0.5, 0.7].map((w) => ({ prior, srcLam, w }))))));

// 4. 运气调整：数据不支持（见文档），不跑
if (!ONLY || ONLY.has('4')) {
  console.log('\n## 4 运气调整（对手三分/罚球按期望值）\n\n未做：stints_* 每段只存双方得分与估算回合，没有投篮/罚球事件；本机 data/raw/nba 只有 70 个汇总接口缓存，GB10 上也没有原始 play-by-play。做它需要重抓约 6000 场 PBP，不在本次许可内。');
}

// 5. 年龄曲线
if (!ONLY || ONLY.has('5')) {
  const g = ageCurve(seasons, pairs);
  console.log(`\n年龄曲线（全部 4 对拟合，仅展示；判定用的是每折只在其余 3 对上拟合的版本，n=${g.n}）：`);
  console.log('  ' + [20, 22, 24, 26, 28, 30, 32, 34, 36].map((a) => `${a}岁 ${f4(g.at(a))}`).join('  '));
}
experiment('5', '年龄曲线 α=1（delta 法，节点 23/27/31）', withK([{ age: 1 }]));
if (!ONLY || ONLY.has('5')) {
  console.log('\n敏感性（k=3200 固定，不参与判定）：');
  for (const a of [0.5, 1.5, 2]) fixedRow(`age α=${a}`, { age: a });
}

// 6. 逐项 padding
if (!ONLY || ONLY.has('6')) {
  console.log('\n逐项 padding（分钟；各季矩估计，σ²≤0 取上限 100000）：');
  console.log(`| 特征 | ${seasons.join(' | ')} |`);
  console.log(`|---|${seasons.map(() => '---:').join('|')}|`);
  FEATURES.forEach((k, j) => console.log(`| ${k} | ${seasons.map((s) => Math.round(padsOf(s)[j].pad)).join(' | ')} |`));
}
experiment('6', '逐项 padding α=1（季内矩估计）', withK([{ pad: 1 }]));
if (!ONLY || ONLY.has('6')) {
  console.log('\n敏感性（k=3200 固定，不参与判定）：');
  for (const a of [0.5, 2]) fixedRow(`pad α=${a}`, { pad: a });
}

// 7. 双侧 RAPM
experiment('7a', '双侧 RAPM（stints）线性混合', withK([0.2, 0.35, 0.5].flatMap((w) => [2000, 6000, 20000].map((srcLam) => ({ src: 'rapm', srcLam, w })))));
experiment('7b', '双侧 RAPM + 分侧 SPM 先验', withK([6000, 12000, 24000, 48000, 96000].flatMap((srcLam) => [1, 0.5, 0.7].map((w) => ({ src: 'rapm', prior: 'side', srcLam, w })))));

// 8. 多季统计栏 + 更长记忆
const DECAYS = [{ mode: 'marcel' }, { mode: 'exp', h: 0.5 }, { mode: 'exp', h: 1 }, { mode: 'exp', h: 2 }, { mode: 'exp', h: 3 }, { mode: 'exp', h: 5 }, { mode: 'equal' }];
const grid8 = (level) => withK([3, 5].flatMap((span) => DECAYS.flatMap((d) => [false, true].map((mEff) => ({ multi: { ...d, level, span }, mEff })))));
experiment('8a', '多季 SPM（SPM 层面）', grid8('spm'));
experiment('8b', '多季 SPM（逐项速率层面）', grid8('feat'));
experiment('8c', 'APM 衰减更长记忆（span × 半衰期）', withK([3, 4, 5].flatMap((span) => [1, 1.5, 2, 3].map((hl) => ({ span, hl })))));

// 5b / 8d / 8e：年龄对齐
const AGES = [20, 22, 24, 26, 28, 30, 32, 34, 36];
if (!ONLY || ONLY.has('5b')) {
  console.log(`\n逐项年龄曲线（全部评估对${backfillPairs.length ? ` + ${backfillPairs.length} 个回填相邻对` : '，无历史回填'}拟合，仅展示；判定用每折只在其余 3 对上拟合的版本）。`);
  console.log('数值为「从该岁到下一岁」每 36 分钟速率的平均变化；特征含义见 server/impact.mjs：\n');
  const variants = [['主口径（调和均值加权）', {}], ['不加权', { weight: 'none' }], ['幸存者粗修正', { impute: true }]];
  for (const [label, opt] of variants) {
    const cs = statCurves(pairs, opt);
    console.log(`${label}：\n\n| 特征 | ${AGES.map((a) => `${a}岁`).join(' | ')} |`);
    console.log(`|---|${AGES.map(() => '---:').join('|')}|`);
    FEATURES.forEach((k, j) => console.log(`| ${k} | ${AGES.map((a) => cs[j].at(a).toFixed(3)).join(' | ')} |`));
    console.log('');
  }
  console.log('总值曲线（IMP 收缩前，未校准单位）敏感性：');
  for (const [label, opt] of variants) {
    const g = ageCurve(seasons, pairs, opt);
    console.log(`  ${label.padEnd(16)} ${AGES.map((a) => `${a}岁 ${f4(g.at(a))}`).join('  ')}`);
  }
}
experiment('5b', '逐项年龄曲线 α=1（单季特征平移到 N+1 岁）', withK([{ ageStat: 1 }]));
if (!ONLY || ONLY.has('5b')) {
  console.log('\n敏感性（k=3200 固定，不参与判定）：');
  fixedRow('5b 不加权曲线', { ageStat: 1, ageOpt: { weight: 'none' } });
  fixedRow('5b 幸存者粗修正', { ageStat: 1, ageOpt: { impute: true } });
  fixedRow('5 总值曲线 幸存者粗修正', { age: 1, ageOpt: { impute: true } });
  fixedRow('5 总值曲线 不加权', { age: 1, ageOpt: { weight: 'none' } });
  for (const a of [0.5, 1.5]) fixedRow(`5b α=${a}`, { ageStat: a });
}
experiment('8d', '年龄对齐后的逐项多季平均（8b × 5b）',
  grid8('feat').map((c) => ({ ...c, ageStat: 1 })));
experiment('8e', '年龄对齐后的多季 SPM（8a × 总值曲线）',
  grid8('spm').map((c) => ({ ...c, align: true, age: 1 })));

// ★ 全部候选一起选
if (!ONLY) judge('★', '全部实验候选一起选（不经人挑）', allTables);

// 组合：通过规则的部件是 8c（APM 衰减 span × 半衰期）与 5b（逐项年龄曲线）；全部参数放进同一网格
const COMBO_GRID = withK([3, 4, 5].flatMap((span) => [1, 1.5, 2, 3].flatMap((hl) => [0, 1].map((ageStat) => ({ span, hl, ageStat })))));
const COMBO_PICK = { span: 4, hl: 3, ageStat: 1 };
experiment('C', '组合：8c × 5b（同一网格按留一对选）', COMBO_GRID, { pool: false });
if (!ONLY || ONLY.has('C')) {
  console.log('\n固定组合（span=4 hl=3 ageStat=1 k=3200，即各部件多数折选中的值；只报，不参与判定）：');
  fixedRow('span4 hl3 + 逐项年龄', { ...COMBO_PICK });
  fixedRow('span4 hl3（仅 8c）', { span: 4, hl: 3 });
  fixedRow('逐项年龄（仅 5b）', { ageStat: 1 });
}

// 事后诊断（看过结果才想到，不能据此采纳）：实验 5 的 g 量在「收缩前」单位上，却加在 shrinkToward 后的值上；
// 收缩把偏离压到约 1/3（线上靠 pivot 补乘 3），所以单位一致的写法相当于 α≈1/3。
if (!ONLY || ONLY.has('5')) {
  console.log('\n事后诊断（非预注册，不参与判定）：实验 5 单位修正 α=1/3');
  fixedRow('age α=1/3', { age: 1 / 3 });
  fixedRow('age α=1/3 + 8c', { age: 1 / 3, span: 4, hl: 3 });
}

console.log('\n## 汇总\n');
console.log('| 实验 | Δ 次季 APM | 输 | Δ 次季 on/off | 输 | 规则 | 4 折选中 |');
console.log('|---|---:|---:|---:|---:|---|---|');
for (const r of summary) console.log(`| ${r.id} ${r.title} | ${f4(r.mA)} | ${r.loseA}/4 | ${f4(r.mO)} | ${r.loseO}/4 | ${r.adopt ? '通过' : '不通过'} | ${r.picks.join(' ‖ ')} |`);
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);

