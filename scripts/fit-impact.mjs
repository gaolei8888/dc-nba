/**
 * 拟合并**验证**综合影响力指标（IMP），把系数写进 data/impact-model.json。
 *
 *   node scripts/fit-impact.mjs
 *   TARGET=onoff node scripts/fit-impact.mjs    # 用旧目标跑一遍做对照
 *
 * 方法对齐 EPM 的公开做法：先用 box+追踪 拟合一个 SPM，目标取阵容级的 APM。
 * EPM 用的是完整 RAPM（逐回合、含对手阵容），我们只有球队自己的五人组合数据，
 * 所以是**未做对手调整**的 APM——这个差别在 server/rapm.mjs 里写清楚了。
 *
 * 验证是这个脚本的重点，全部用「留出一个赛季」，训练时完全看不到被留出的赛季：
 *   个人层面：在留出赛季上与该球员真实 APM、真实 on/off 的相关，对比 PIE
 *   球队层面：分钟加权聚合后还原留出赛季的球队净效率，对比 PIE
 *
 * 之所以这么较真：这个项目已经否掉过一个自己做的功能（阵容更迭修正）。
 * 一个连留出赛季都过不了的指标，不配放到界面上占一列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from '../server/nbaClient.mjs';
import { computeApm } from '../server/rapm.mjs';
import {
  FEATURES, buildSamples, fit, apply, corr, mean, sdOf,
} from '../server/impact.mjs';

const HISTORY = path.join(DATA_DIR, 'history');
const USE_APM = (process.env.TARGET ?? 'apm') !== 'onoff';
const APM_LAMBDA = Number(process.env.APM_LAMBDA) || 6000;

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

function loadApm(seasons) {
  const out = new Map();
  for (const s of seasons) {
    const f = path.join(HISTORY, `lineups_${s}.json`);
    if (!fs.existsSync(f)) continue;
    const { rows } = JSON.parse(fs.readFileSync(f, 'utf8'));
    out.set(s, computeApm(rows, { lambda: APM_LAMBDA }));
  }
  return out;
}

const r2Of = (pred, act) => {
  const m = mean(act);
  const ssRes = act.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  const ssTot = act.reduce((s, v) => s + (v - m) ** 2, 0);
  return ssTot ? 1 - ssRes / ssTot : 0;
};

/** 单变量最小二乘的 R²——公平比较「这个数聚合后能解释多少球队净效率」 */
function lineR2(rows) {
  if (rows.length < 3) return 0;
  const mx = mean(rows.map((r) => r.x));
  const my = mean(rows.map((r) => r.y));
  const den = rows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
  if (!den) return 0;
  const sl = rows.reduce((s, r) => s + (r.x - mx) * (r.y - my), 0) / den;
  return r2Of(rows.map((r) => my + sl * (r.x - mx)), rows.map((r) => r.y));
}

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
  const apmBySeason = USE_APM ? loadApm(seasons) : null;
  if (USE_APM && apmBySeason.size < seasons.length) {
    console.error('缺少五人组合数据，先运行 npm run lineups:fetch');
    process.exit(1);
  }
  const opts = USE_APM ? { apmBySeason } : {};

  console.log(`\n拟合综合影响力指标  赛季：${seasons.join('、')}`);
  console.log(`回归目标：${USE_APM ? `阵容级 APM（岭回归 lambda=${APM_LAMBDA}）` : '裸 on/off 差'}\n`);
  for (const s of seasons) {
    console.log(`  ${s}  ${bySeason[s].length} 人，可用于训练 ${buildSamples(bySeason[s], opts).length} 人`);
  }

  // ---- 选 lambda
  const LAMBDAS = [100, 300, 1000, 3000, 10000, 30000, 100000];
  console.log('\n选择正则强度（留出一个赛季，训练时看不到它）：');
  let best = null;
  for (const lam of LAMBDAS) {
    const rs = [];
    for (const held of seasons) {
      const train = buildSamples(seasons.filter((s) => s !== held).flatMap((s) => bySeason[s]), opts);
      const test = buildSamples(bySeason[held], opts);
      if (!train.length || !test.length) continue;
      const model = fit(train, lam);
      const pred = test.map((t) => {
        let v = model.intercept;
        model.features.forEach((k, i) => {
          v += model.beta[i] * ((t.x[FEATURES.indexOf(k)] - model.mu[i]) / model.sd[i]);
        });
        return v;
      });
      rs.push(corr(pred, test.map((t) => t.y)));
    }
    const avg = mean(rs);
    console.log(`  lambda=${String(lam).padStart(6)}  平均 r=${avg.toFixed(3)}   [${rs.map((r) => r.toFixed(2)).join(' ')}]`);
    if (!best || avg > best.avg) best = { lam, avg };
  }
  console.log(`\n选定 lambda=${best.lam}\n`);

  // ---- 验证一：个人层面
  console.log('验证一 · 个人层面（留出赛季，模型没见过）');
  console.log('  与真实 APM 的相关 / 与真实 on/off 的相关');
  console.log('  赛季       人数    IMP(APM)  PIE(APM)   IMP(on/off)  PIE(on/off)');
  const indiv = [];
  for (const held of seasons) {
    const train = buildSamples(seasons.filter((s) => s !== held).flatMap((s) => bySeason[s]), opts);
    const model = fit(train, best.lam);
    const apmMap = apmBySeason?.get(held);

    const rowsApm = bySeason[held].filter((p) => {
      const a = apmMap?.get(p.playerId);
      return a && a.poss >= 500 && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10;
    });
    const rowsOn = bySeason[held].filter((p) => p.onPoss > 500 && p.offPoss > 500
      && (p.gp ?? 0) >= 20 && (p.min ?? 0) >= 10);

    const yApm = rowsApm.map((p) => apmMap.get(p.playerId).apm);
    const yOn = rowsOn.map((p) => (p.onNet ?? 0) - (p.offNet ?? 0));
    const rec = {
      held,
      n: rowsApm.length,
      impApm: corr(rowsApm.map((p) => apply(model, p) ?? 0), yApm),
      pieApm: corr(rowsApm.map((p) => p.pie ?? 0), yApm),
      impOn: corr(rowsOn.map((p) => apply(model, p) ?? 0), yOn),
      pieOn: corr(rowsOn.map((p) => p.pie ?? 0), yOn),
    };
    indiv.push(rec);
    console.log(`  ${held}   ${String(rec.n).padStart(4)}    ${rec.impApm.toFixed(3)}    ${rec.pieApm.toFixed(3)}     ${rec.impOn.toFixed(3)}       ${rec.pieOn.toFixed(3)}`);
  }
  console.log(`  平均              ${mean(indiv.map((r) => r.impApm)).toFixed(3)}    ${mean(indiv.map((r) => r.pieApm)).toFixed(3)}     ${mean(indiv.map((r) => r.impOn)).toFixed(3)}       ${mean(indiv.map((r) => r.pieOn)).toFixed(3)}`);

  // ---- 验证二：球队层面
  console.log('\n验证二 · 球队层面：分钟加权后还原留出赛季的球队净效率（R²）');
  console.log('  赛季       队数    IMP      PIE');
  const teamOut = [];
  for (const held of seasons) {
    const train = buildSamples(seasons.filter((s) => s !== held).flatMap((s) => bySeason[s]), opts);
    const model = fit(train, best.lam);
    const a = lineR2(teamRows(bySeason[held], (p) => apply(model, p)));
    const b = lineR2(teamRows(bySeason[held], (p) => p.pie));
    teamOut.push({ held, n: 30, a, b });
    console.log(`  ${held}     30    ${a.toFixed(3)}   ${b.toFixed(3)}${a >= b ? '' : '   ← 输'}`);
  }
  console.log(`  平均              ${mean(teamOut.map((r) => r.a)).toFixed(3)}   ${mean(teamOut.map((r) => r.b)).toFixed(3)}`);

  // ---- 全量拟合
  const allSamples = buildSamples(seasons.flatMap((s) => bySeason[s]), opts);
  const raw = fit(allSamples, best.lam);

  // ---- 量纲校准
  //
  // APM 被岭回归压缩过，直接用会让 SGA 只有 +3.6，读者无从判断这个数大不大。
  // 校准的办法是把单位钉死在一个有物理含义的量上：**球队净效率**。
  // 求一个系数 k，使得「全队分钟加权的 k·IMP」最接近球队真实净效率，
  // 那么 IMP 就读作"这名球员每百回合给球队净效率贡献几分"——与 EPM 同一个单位。
  //
  // 这一步不改变任何排序，也不影响上面两项验证（相关系数与 R² 都对线性缩放免疫），
  // 纯粹是让数值可读。
  // teamRows 给的是**分钟加权平均**（权重和为 1），而球队净效率对应的是
  // **场上五个人之和**。所以回归斜率要再除以 5，否则每个人都会被放大五倍
  // ——第一版就是这么把 SGA 算成 +39.12 的。
  const calRows = seasons.flatMap((s) => teamRows(bySeason[s], (p) => apply(raw, p)));
  const mx = mean(calRows.map((r) => r.x));
  const my = mean(calRows.map((r) => r.y));
  const denom = calRows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
  const slope = denom ? calRows.reduce((s, r) => s + (r.x - mx) * (r.y - my), 0) / denom : 1;
  const scale = slope / 5;
  console.log(`\n量纲校准：×${scale.toFixed(3)}（回归斜率 ${slope.toFixed(2)} ÷ 场上 5 人）`);
  console.log('  校准后 IMP 读作：这名球员每百回合给球队净效率贡献几分，与 EPM 同一单位');

  const model = {
    ...raw,
    beta: raw.beta.map((b) => b * scale),
    intercept: raw.intercept * scale,
    scale,
  };

  console.log('\n系数（标准化后）：');
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
  board.slice(0, 15).forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(24)} ${r.v >= 0 ? '+' : ''}${r.v.toFixed(2)}`));

  const vals = board.map((r) => r.v);
  writeJson('impact-model.json', {
    ...model,
    builtAt: new Date().toISOString(),
    seasons,
    target: USE_APM ? 'lineupApm' : 'onoff',
    apmLambda: USE_APM ? APM_LAMBDA : null,
    validation: {
      individual: indiv.map((r) => ({
        season: r.held, n: r.n, impApm: r.impApm, pieApm: r.pieApm, impOnoff: r.impOn, pieOnoff: r.pieOn,
      })),
      team: teamOut.map((r) => ({ season: r.held, n: r.n, imp: r.a, pie: r.b })),
    },
    distribution: { mean: mean(vals), sd: sdOf(vals), min: Math.min(...vals), max: Math.max(...vals) },
  });
  console.log('\n已写入 data/impact-model.json');
}

main();
