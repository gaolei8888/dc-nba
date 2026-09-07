/**
 * 拟合并**验证**综合影响力指标（IMP），把系数写进 data/impact-model.json。
 *
 *   node scripts/fit-impact.mjs
 *
 * 验证是这个脚本的重点，不是附带的。两项都用「留出一个赛季」的方式做，
 * 训练时完全看不到被留出的赛季：
 *
 *   个人层面：在留出赛季上，IMP 与该球员真实 on/off 的相关系数，对比 PIE
 *   球队层面：把 IMP 按分钟加权聚合，预测留出赛季的球队净效率，对比 PIE
 *
 * 之所以这么较真：这个项目已经否掉过一个自己做的功能（阵容更迭修正），
 * 那次的教训是"看着有道理"不等于"有用"。一个连留出赛季都过不了的指标，
 * 不配放到界面上占一列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from '../server/nbaClient.mjs';
import {
  FEATURES, buildSamples, fit, apply, features, corr, mean, sdOf,
} from '../server/impact.mjs';

const HISTORY = path.join(DATA_DIR, 'history');

function loadSeasons() {
  if (!fs.existsSync(HISTORY)) return {};
  const out = {};
  for (const f of fs.readdirSync(HISTORY)) {
    const m = f.match(/^impact_(\d{4}-\d{2})\.json$/);
    if (!m) continue;
    const c = JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8'));
    out[m[1]] = c.players.map((p) => ({ ...p, season: m[1] }));
  }
  return out;
}

const r2Of = (pred, act) => {
  const m = mean(act);
  const ssRes = act.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  const ssTot = act.reduce((s, v) => s + (v - m) ** 2, 0);
  return ssTot ? 1 - ssRes / ssTot : 0;
};

/** 单变量最小二乘的 R²——用来公平地比较"这个数聚合后能解释多少球队净效率" */
function lineR2(rows) {
  if (rows.length < 3) return 0;
  const mx = mean(rows.map((r) => r.x));
  const my = mean(rows.map((r) => r.y));
  const den = rows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
  if (!den) return 0;
  const sl = rows.reduce((s, r) => s + (r.x - mx) * (r.y - my), 0) / den;
  return r2Of(rows.map((r) => my + sl * (r.x - mx)), rows.map((r) => r.y));
}

/** 球队层面：分钟加权聚合某个球员指标，配上该赛季球队真实净效率 */
function teamRows(seasonRows, valueOf) {
  const byTeam = new Map();
  for (const p of seasonRows) {
    if (!p.teamId || !(p.min > 0) || !(p.gp > 0)) continue;
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
    byTeam.get(p.teamId).push(p);
  }
  const out = [];
  for (const [teamId, squad] of byTeam) {
    const tot = squad.reduce((s, p) => s + p.min * p.gp, 0);
    if (!tot) continue;
    // 球队净效率：用在场时间最多的球员的球队净效率近似不可靠，
    // 改用全队分钟加权的 netRtg——它本身就是"在场时球队净效率"，
    // 按分钟加权后等于球队整体净效率。
    const teamNet = squad.reduce((s, p) => s + ((p.min * p.gp) / tot) * (p.netRtg ?? 0), 0);
    const v = squad.reduce((s, p) => s + ((p.min * p.gp) / tot) * (valueOf(p) ?? 0), 0);
    out.push({ teamId, x: v, y: teamNet });
  }
  return out;
}

function main() {
  const bySeason = loadSeasons();
  const seasons = Object.keys(bySeason).sort();
  if (seasons.length < 2) {
    console.error(`需要至少 2 个赛季，当前只有 ${seasons.length} 个。先运行 npm run impact:fetch`);
    process.exit(1);
  }

  console.log(`\n拟合综合影响力指标  赛季：${seasons.join('、')}\n`);
  for (const s of seasons) {
    const all = bySeason[s];
    const usable = buildSamples(all).length;
    console.log(`  ${s}  ${all.length} 人，可用于训练 ${usable} 人`);
  }

  // ---- 选 lambda：对每个候选值做"留出一个赛季"，取平均相关最高的
  const LAMBDAS = [100, 300, 1000, 3000, 10000, 30000, 100000];
  console.log('\n选择正则强度（留出一个赛季，训练时看不到它）：');
  let best = null;
  for (const lam of LAMBDAS) {
    const rs = [];
    for (const held of seasons) {
      const train = buildSamples(seasons.filter((s) => s !== held).flatMap((s) => bySeason[s]));
      const test = buildSamples(bySeason[held]);
      if (!train.length || !test.length) continue;
      const model = fit(train, lam);
      const pred = test.map((t) => {
        let v = model.intercept;
        model.features.forEach((k, i) => { v += model.beta[i] * ((t.x[FEATURES.indexOf(k)] - model.mu[i]) / model.sd[i]); });
        return v;
      });
      rs.push(corr(pred, test.map((t) => t.y)));
    }
    const avg = mean(rs);
    console.log(`  lambda=${String(lam).padStart(6)}  平均 r=${avg.toFixed(3)}   [${rs.map((r) => r.toFixed(2)).join(' ')}]`);
    if (!best || avg > best.avg) best = { lam, avg };
  }
  console.log(`\n选定 lambda=${best.lam}\n`);

  // ---- 验证一：个人层面，留出赛季上与真实 on/off 的相关
  console.log('验证一 · 个人层面：在留出赛季上预测该球员的真实 on/off');
  console.log('  赛季       人数    IMP      PIE     净效率');
  const indiv = [];
  for (const held of seasons) {
    const train = buildSamples(seasons.filter((s) => s !== held).flatMap((s) => bySeason[s]));
    const model = fit(train, best.lam);
    const testRows = bySeason[held].filter((p) => {
      const s = buildSamples([p]);
      return s.length > 0;
    });
    if (!testRows.length) continue;
    const y = testRows.map((p) => (p.onNet ?? 0) - (p.offNet ?? 0));
    const rImp = corr(testRows.map((p) => apply(model, p) ?? 0), y);
    const rPie = corr(testRows.map((p) => p.pie ?? 0), y);
    const rNet = corr(testRows.map((p) => p.netRtg ?? 0), y);
    indiv.push({ held, n: testRows.length, rImp, rPie, rNet });
    console.log(`  ${held}   ${String(testRows.length).padStart(4)}   ${rImp.toFixed(3)}   ${rPie.toFixed(3)}   ${rNet.toFixed(3)}`);
  }
  console.log(`  平均              ${mean(indiv.map((r) => r.rImp)).toFixed(3)}   ${mean(indiv.map((r) => r.rPie)).toFixed(3)}   ${mean(indiv.map((r) => r.rNet)).toFixed(3)}`);

  // ---- 验证二：球队层面，留出赛季上还原球队净效率
  console.log('\n验证二 · 球队层面：分钟加权后还原留出赛季的球队净效率（R²）');
  console.log('  赛季       队数    IMP      PIE');
  const teamOut = [];
  for (const held of seasons) {
    const train = buildSamples(seasons.filter((s) => s !== held).flatMap((s) => bySeason[s]));
    const model = fit(train, best.lam);
    const rowsImp = teamRows(bySeason[held], (p) => apply(model, p));
    const rowsPie = teamRows(bySeason[held], (p) => p.pie);
    const a = lineR2(rowsImp); const b = lineR2(rowsPie);
    teamOut.push({ held, n: rowsImp.length, a, b });
    console.log(`  ${held}   ${String(rowsImp.length).padStart(4)}   ${a.toFixed(3)}   ${b.toFixed(3)}`);
  }
  console.log(`  平均              ${mean(teamOut.map((r) => r.a)).toFixed(3)}   ${mean(teamOut.map((r) => r.b)).toFixed(3)}`);

  // ---- 全量拟合，写出模型
  const allSamples = buildSamples(seasons.flatMap((s) => bySeason[s]));
  const model = fit(allSamples, best.lam);

  console.log('\n系数（标准化后，绝对值大 = 影响大）：');
  FEATURES.map((f, i) => ({ f, b: model.beta[i] }))
    .sort((a, b) => Math.abs(b.b) - Math.abs(a.b))
    .forEach((r) => console.log(`  ${r.f.padEnd(9)} ${r.b >= 0 ? '+' : ''}${r.b.toFixed(3)}`));

  const last = seasons[seasons.length - 1];
  const board = bySeason[last]
    .filter((p) => (p.gp ?? 0) >= 40 && (p.min ?? 0) >= 20)
    .map((p) => ({ name: p.name, v: apply(model, p), pie: p.pie }))
    .filter((r) => r.v !== null)
    .sort((a, b) => b.v - a.v);
  console.log(`\n${last} IMP 前 15：`);
  board.slice(0, 15).forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(24)} ${r.v >= 0 ? '+' : ''}${r.v.toFixed(2)}   PIE ${((r.pie ?? 0) * 100).toFixed(1)}`));

  const vals = board.map((r) => r.v);
  writeJson('impact-model.json', {
    ...model,
    builtAt: new Date().toISOString(),
    seasons,
    validation: {
      individual: indiv.map((r) => ({ season: r.held, n: r.n, imp: r.rImp, pie: r.rPie, netRtg: r.rNet })),
      team: teamOut.map((r) => ({ season: r.held, n: r.n, imp: r.a, pie: r.b })),
    },
    distribution: { mean: mean(vals), sd: sdOf(vals), min: Math.min(...vals), max: Math.max(...vals) },
  });
  console.log('\n已写入 data/impact-model.json');
}

main();
