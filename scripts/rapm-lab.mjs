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
// 抓到一半的赛季必须排除：半个赛季的 RAPM 噪声大得没法比，
// 混进来会把整张表带偏，而且看不出是数据不全造成的。
const MIN_GAMES = Number(process.env.MIN_GAMES ?? 800);
const seasons = Object.keys(players).sort().filter((s) => {
  if (!lineups[s] || !stints[s]) return false;
  const n = Object.keys(stints[s].games).length;
  if (n < MIN_GAMES) { console.log(`  跳过 ${s}：只抓了 ${n} 场（不足 ${MIN_GAMES}）`); return false; }
  return true;
});
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

// ---------------------------------------------------------------- 正则强度
//
// 上面单季 RAPM 输给 APM，但那个对比有个明显的混淆：RAPM 的 lambda 是随手写的
// 2000，APM 的 6000 是扫过的。RAPM 每条观测多了防守方五人，参数量翻倍，
// 欠正则会直接变成噪声。不扫一遍就下结论等于拿没调过的新方法去比调过的旧方法。
//
// 而且线上真正用的是 3 季衰减，不是单季——那才是该比的配置。

if (canPair) {
  const evalStability = (get, seasonsPair) => {
    const rs = [];
    for (const s of seasonsPair) {
      const c = commonRows(s);
      if (!c) continue;
      const ids = c.rows.map((p) => p.playerId);
      const a = get(s); const b = get(c.nx);
      const x = ids.map((i) => a.get(i)); const y = ids.map((i) => b.get(i));
      if (x.some((v) => v == null) || y.some((v) => v == null)) continue;
      rs.push(corr(x, y));
    }
    return rs.length ? mean(rs) : null;
  };
  const evalOnoff = (get) => {
    const rs = [];
    for (const s of seasons) {
      const c = commonRows(s);
      if (!c) continue;
      const byId = new Map(players[c.nx].map((p) => [p.playerId, p]));
      const keep = c.rows.filter((p) => byId.has(p.playerId) && get(s).get(p.playerId) != null);
      if (keep.length < 50) continue;
      rs.push(corr(
        keep.map((p) => get(s).get(p.playerId)),
        keep.map((p) => (byId.get(p.playerId).onNet ?? 0) - (byId.get(p.playerId).offNet ?? 0)),
      ));
    }
    return rs.length ? mean(rs) : null;
  };

  console.log('\nRAPM 正则强度扫描（单季）');
  console.log('  lambda   年度稳定性   预测次季on/off');
  for (const lam of [2000, 6000, 12000, 20000, 35000, 60000]) {
    const cache = new Map();
    const get = (s) => {
      if (!cache.has(s)) {
        const r = computeRapm(stintsOf(stints[s]), { lambda: lam });
        r.delete('__hca');
        cache.set(s, new Map([...r].map(([k, v]) => [k, v.rapm])));
      }
      return cache.get(s);
    };
    const st = evalStability(get, seasons);
    const oo = evalOnoff(get);
    console.log(`  ${String(lam).padStart(6)}      ${st?.toFixed(3) ?? '—'}        ${oo?.toFixed(3) ?? '—'}`);
  }
  console.log('  对照 APM(6000)  '
    + `${evalStability((s) => new Map([...apmBy.get(s)].map(([k, v]) => [k, v.apm])), seasons)?.toFixed(3)}`
    + `        ${evalOnoff((s) => new Map([...apmBy.get(s)].map(([k, v]) => [k, v.apm])))?.toFixed(3)}`);
}

// ---------------------------------------------------------------- 真正该比的配置
//
// 上面比的是单季，而线上用的是 3 季衰减，而且外面还套了一层与 SPM 的混合。
// 单季 RAPM 抖是意料之中的——衰减和先验正是治这个的。这一节比的才是决策点：
// 把 IMP 里那一半「场上实测」从 APM 换成 RAPM，到底好不好。
//
// 三把尺子一起报，包括对 RAPM 不利的那两把：
//   · 次季 on/off —— 独立，两者都不含它，这把是主判据
//   · 次季 APM   —— 偏袒 IMP(APM)
//   · 次季 RAPM  —— 偏袒 IMP(RAPM)
// 只报对自己有利的那把尺子，等于自己给自己打分。

if (canPair && seasons.length >= 3) {
  const SPAN = 3; const HALF = 1;
  const decayed = (make, upto, lambda) => {
    const i = seasons.indexOf(upto);
    const slice = [];
    for (let k = SPAN - 1; k >= 0; k--) if (i - k >= 0) slice.push(seasons[i - k]);
    return make(slice, lambda);
  };
  const decApm = new Map();
  const decRapm = new Map();
  const getDecApm = (s, lam = APM_LAMBDA) => {
    const key = `${s}|${lam}`;
    if (!decApm.has(key)) {
      const rows = [];
      const i = seasons.indexOf(s);
      for (let k = 0; k < SPAN && i - k >= 0; k++) {
        const w = 0.5 ** (k / HALF);
        for (const l of lineups[seasons[i - k]]) rows.push({ ...l, poss: (l.poss ?? 0) * w });
      }
      decApm.set(key, new Map([...computeApm(rows, { lambda: lam })].map(([k, v]) => [k, v.apm])));
    }
    return decApm.get(key);
  };
  const getDecRapm = (s, lam) => {
    const key = `${s}|${lam}`;
    if (!decRapm.has(key)) {
      const merged = [];
      const i = seasons.indexOf(s);
      for (let k = 0; k < SPAN && i - k >= 0; k++) {
        const w = 0.5 ** (k / HALF);
        for (const st of stintsOf(stints[seasons[i - k]])) {
          merged.push([...st.slice(0, 10), st[10] * w, st[11] * w, st[12] * w, st[13] * w, st[14]]);
        }
      }
      const r = computeRapm(merged, { lambda: lam, minPoss: 0.25 });
      r.delete('__hca');
      decRapm.set(key, new Map([...r].map(([k, v]) => [k, v.rapm])));
    }
    return decRapm.get(key);
  };

  // 次季的三个目标
  const targets = {
    'on/off（独立）': (nx) => {
      const byId = new Map(players[nx].map((p) => [p.playerId, p]));
      return (id) => {
        const p = byId.get(id);
        return p ? (p.onNet ?? 0) - (p.offNet ?? 0) : null;
      };
    },
    APM: (nx) => (id) => apmBy.get(nx).get(id)?.apm ?? null,
    RAPM: (nx) => (id) => rapmBy.get(nx).get(id)?.rapm ?? null,
  };

  const evalAgainst = (valueOf, targetName) => {
    const rs = [];
    for (const s of seasons) {
      const c = commonRows(s);
      if (!c) continue;
      const target = targets[targetName](c.nx);
      const keep = c.rows.filter((p) => valueOf(p, s) != null && target(p.playerId) != null);
      if (keep.length < 50) continue;
      rs.push(corr(keep.map((p) => valueOf(p, s)), keep.map((p) => target(p.playerId))));
    }
    return rs.length ? mean(rs) : null;
  };

  const spmOf = (p, s) => apply(spmFor.get(s), p);
  const RAPM_LAMS = [6000, 20000, 60000];
  console.log('\n3 季衰减 · 单独看实测那一半');
  console.log('  方案                     次季on/off   次季APM   次季RAPM');
  const show = (label, f) => {
    console.log(`  ${label.padEnd(24)}  ${(evalAgainst(f, 'on/off（独立）') ?? 0).toFixed(3)}`
      + `        ${(evalAgainst(f, 'APM') ?? 0).toFixed(3)}     ${(evalAgainst(f, 'RAPM') ?? 0).toFixed(3)}`);
  };
  show('衰减 APM', (p, s) => getDecApm(s).get(p.playerId) ?? null);
  for (const lam of RAPM_LAMS) show(`衰减 RAPM λ=${lam}`, (p, s) => getDecRapm(s, lam).get(p.playerId) ?? null);
  show('纯 SPM', spmOf);

  console.log('\n混合 w·实测 + (1−w)·SPM —— 主判据是「次季 on/off」');
  console.log('  w      IMP(APM)   IMP(RAPM λ=6000)   IMP(RAPM λ=20000)');
  for (const w of [0, 0.2, 0.3, 0.35, 0.5, 0.7, 1]) {
    const mk = (get) => (p, s) => {
      const a = get(s).get(p.playerId);
      const sp = spmOf(p, s);
      if (sp == null) return null;
      return a == null ? sp : w * a + (1 - w) * sp;
    };
    const a = evalAgainst(mk((s) => getDecApm(s)), 'on/off（独立）');
    const b = evalAgainst(mk((s) => getDecRapm(s, 6000)), 'on/off（独立）');
    const c = evalAgainst(mk((s) => getDecRapm(s, 20000)), 'on/off（独立）');
    console.log(`  ${w.toFixed(2)}    ${a.toFixed(4)}       ${b.toFixed(4)}            ${c.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------- EPM 的原方法
//
// 固定权重线性混合是我们自己的简化。EPM 的做法是把 SPM 当**贝叶斯先验**
// 内嵌进岭回归：没有证据就当他值 box score 说的那么多，回合数越多越敢偏离。
// 这比线性混合更正统——收缩是逐人按证据量来的，不是全联盟一个权重。
//
// 上一轮用 APM 试过，比线性混合差（0.3988 对 0.4061）。但那时缺的正是
// 对手调整这一块，所以有了 RAPM 之后值得再试一次。
// 先验只有一个总值，按进攻/防守各一半分——粗糙，但混合后看的是两者之和。

if (canPair && seasons.length >= 3) {
  const SPAN = 3; const HALF = 1;
  const decPrior = new Map();
  const getPriorRapm = (s, lam) => {
    const key = `${s}|${lam}`;
    if (!decPrior.has(key)) {
      const merged = [];
      const i = seasons.indexOf(s);
      for (let k = 0; k < SPAN && i - k >= 0; k++) {
        const w = 0.5 ** (k / HALF);
        for (const st of stintsOf(stints[seasons[i - k]])) {
          merged.push([...st.slice(0, 10), st[10] * w, st[11] * w, st[12] * w, st[13] * w, st[14]]);
        }
      }
      const half = new Map();
      for (const p of players[s]) {
        const v = apply(spmFor.get(s), p);
        if (v != null) half.set(p.playerId, v / 2);
      }
      const r = computeRapm(merged, { lambda: lam, minPoss: 0.25, priorO: half, priorD: half });
      r.delete('__hca');
      decPrior.set(key, new Map([...r].map(([k, v]) => [k, v.rapm])));
    }
    return decPrior.get(key);
  };

  const onoffTarget = (nx) => {
    const byId = new Map(players[nx].map((p) => [p.playerId, p]));
    return (id) => {
      const p = byId.get(id);
      return p ? (p.onNet ?? 0) - (p.offNet ?? 0) : null;
    };
  };
  const evalOn = (valueOf) => {
    const rs = [];
    for (const s of seasons) {
      const c = commonRows(s);
      if (!c) continue;
      const t = onoffTarget(c.nx);
      const keep = c.rows.filter((p) => valueOf(p, s) != null && t(p.playerId) != null);
      if (keep.length < 50) continue;
      rs.push(corr(keep.map((p) => valueOf(p, s)), keep.map((p) => t(p.playerId))));
    }
    return rs.length ? mean(rs) : null;
  };

  console.log('\nEPM 原方法：SPM 当先验内嵌进 RAPM 岭回归（判据：预测次季 on/off）');
  console.log('  收缩强度 λ    结果      对比');
  for (const lam of [3000, 8000, 20000, 50000]) {
    const r = evalOn((p, s) => getPriorRapm(s, lam).get(p.playerId) ?? apply(spmFor.get(s), p));
    console.log(`  ${String(lam).padStart(8)}     ${r.toFixed(4)}`);
  }
  console.log(`  线性混合最优（IMP(APM) w=0.30）  0.3492`);
  console.log('  纯 SPM                          0.3331');
}

// ---------------------------------------------------------------- 三方混合
//
// 单换 RAPM 输了，但那是「二选一」的问法。两者的误差结构其实不同：
// APM 有对手污染（系统性偏差），RAPM 没有污染但方差大。
// 误差不相关的两个估计，加权平均往往比任何一个都好——这是最后一个
// 值得试的配置，也是唯一还能让 play-by-play 这三小时回本的路。

if (canPair && seasons.length >= 3) {
  const SPAN = 3; const HALF = 1;
  const cA = new Map(); const cR = new Map();
  const dApm = (s) => {
    if (!cA.has(s)) {
      const rows = []; const i = seasons.indexOf(s);
      for (let k = 0; k < SPAN && i - k >= 0; k++) {
        const w = 0.5 ** (k / HALF);
        for (const l of lineups[seasons[i - k]]) rows.push({ ...l, poss: (l.poss ?? 0) * w });
      }
      cA.set(s, new Map([...computeApm(rows, { lambda: APM_LAMBDA })].map(([k, v]) => [k, v.apm])));
    }
    return cA.get(s);
  };
  const dRapm = (s) => {
    if (!cR.has(s)) {
      const merged = []; const i = seasons.indexOf(s);
      for (let k = 0; k < SPAN && i - k >= 0; k++) {
        const w = 0.5 ** (k / HALF);
        for (const st of stintsOf(stints[seasons[i - k]])) {
          merged.push([...st.slice(0, 10), st[10] * w, st[11] * w, st[12] * w, st[13] * w, st[14]]);
        }
      }
      const r = computeRapm(merged, { lambda: 6000, minPoss: 0.25 });
      r.delete('__hca');
      cR.set(s, new Map([...r].map(([k, v]) => [k, v.rapm])));
    }
    return cR.get(s);
  };
  const evalOn2 = (valueOf) => {
    const rs = [];
    for (const s of seasons) {
      const c = commonRows(s);
      if (!c) continue;
      const byId = new Map(players[c.nx].map((p) => [p.playerId, p]));
      const keep = c.rows.filter((p) => byId.has(p.playerId) && valueOf(p, s) != null);
      if (keep.length < 50) continue;
      rs.push(corr(keep.map((p) => valueOf(p, s)),
        keep.map((p) => (byId.get(p.playerId).onNet ?? 0) - (byId.get(p.playerId).offNet ?? 0))));
    }
    return rs.length ? mean(rs) : null;
  };

  console.log('\n三方混合 wA·APM + wR·RAPM + (1−wA−wR)·SPM（判据：预测次季 on/off）');
  console.log('  wA\wR    0.00     0.10     0.15     0.20     0.30');
  const WR = [0, 0.1, 0.15, 0.2, 0.3];
  let best = { r: -1 };
  for (const wA of [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) {
    const cells = WR.map((wR) => {
      if (wA + wR > 0.7) return '  —   ';
      const r = evalOn2((p, s) => {
        const sp = apply(spmFor.get(s), p);
        if (sp == null) return null;
        const a = dApm(s).get(p.playerId) ?? sp;
        const rr = dRapm(s).get(p.playerId) ?? sp;
        return wA * a + wR * rr + (1 - wA - wR) * sp;
      });
      if (r > best.r) best = { r, wA, wR };
      return r.toFixed(4);
    });
    console.log(`  ${wA.toFixed(2)}   ${cells.join('   ')}`);
  }
  console.log(`\n  最优：wA=${best.wA} wR=${best.wR}  r=${best.r.toFixed(4)}`);
  console.log('  对比 只用 APM w=0.30       0.3507');
  console.log('  对比 只用 RAPM w=0.30      0.3452');
  console.log('  对比 纯 SPM                0.3271');
}
