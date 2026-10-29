import test from 'node:test';
import assert from 'node:assert/strict';
import { computeApm, decayedApm } from '../server/rapm.mjs';
import { apply, impactOf, buildSamples, fit, blend, mean, FEATURES, DECAY_SPAN, DECAY_HALFLIFE } from '../server/impact.mjs';
import { shrinkByMinutes, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import {
  FALLBACK, seasonBack, goodSeason, missedFullSeason, fallbackValue, fallbackPriors, productionFallback,
} from '../server/impFallback.mjs';
import { labValuesUpto } from '../server/impFallbackLab.mjs';

// ---------------------------------------------------------------- 夹具

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const row = (id, age, extra = {}) => ({
  playerId: id, name: `P${id}`, age, gp: 60, min: 30, pts: 18, fga: 14, ast: 4, tov: 2, oreb: 1, dreb: 5, stl: 1, blk: 0.5, pf: 2,
  tsPct: 0.57, usgPct: 0.22, deflections: 2, contested: 5, screenAstPts: 1, dFga: 8, diffPct: 0, potentialAst: 7, ...extra,
});
const rows = (...list) => new Map(list.map((r) => [r.playerId, r]));
const flatModel = (ageCurves = null) => ({
  features: FEATURES, mu: FEATURES.map(() => 0), sd: FEATURES.map(() => 1),
  beta: FEATURES.map((k) => (k === 'pts' ? 0.1 : 0)), intercept: 0, ...(ageCurves ? { ageCurves } : {}),
});
// pts 特征（每 36 分钟）的一年变化：27 岁后 −(age − 27)
const CURVES = { knots: [27], clip: [19, 38], coef: { pts: [0, 0, -1] } };

/** 合成的多季数据：4 队 × 9 人，五人组合随机，用来跑完整的 valuesUpto */
function synth(seasons, seed = 11) {
  const r = rng(seed);
  const players = {}; const lineups = {};
  for (const [si, s] of seasons.entries()) {
    players[s] = []; lineups[s] = [];
    for (let t = 0; t < 4; t += 1) {
      const ids = Array.from({ length: 9 }, (_, i) => 1000 + t * 9 + i);
      for (const id of ids) {
        const k = id % 9;
        players[s].push(row(id, 22 + (id % 12) + si, {
          season: s, teamId: 100 + t, gp: k === 8 && si === seasons.length - 1 ? 7 : 25 + Math.floor(r() * 50),
          min: 12 + r() * 22, pts: 6 + r() * 20, ast: 1 + r() * 6, dreb: 2 + r() * 6, stl: 0.3 + r(), netRtg: -8 + r() * 16,
          tsPct: 0.5 + r() * 0.12, usgPct: 0.15 + r() * 0.12,
        }));
      }
      for (let l = 0; l < 40; l += 1) {
        const five = [...ids].sort(() => r() - 0.5).slice(0, 5);
        lineups[s].push({ teamId: 100 + t, players: five, poss: 150 + Math.floor(r() * 200), off: 105 + r() * 15, def: 105 + r() * 15 });
      }
    }
  }
  return { players, lineups };
}

/** 抽出之前 scripts/roster-results-backtest.mjs 里的 valuesUpto，逐字照抄（只把全局变量换成参数），用来锁定「输出不变」 */
function legacyValuesUpto({ ALL_SEASONS, players, lineups, apmBySeason }, upto) {
  const seen = ALL_SEASONS.slice(0, ALL_SEASONS.indexOf(upto) + 1);
  const spm = fit(buildSamples(seen.flatMap((s) => players[s]), { apmBySeason }), 3000);
  const dec = decayedApm(seen.slice(-DECAY_SPAN).map((s) => ({ season: s, rows: lineups[s] })),
    { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
  const rawOf = (p, s) => blend(apply(spm, p), (s === upto ? dec : null)?.get(p.playerId)?.apm ?? null);
  const cal = [];
  for (const s of seen) {
    const decS = decayedApm(ALL_SEASONS.slice(Math.max(0, ALL_SEASONS.indexOf(s) - DECAY_SPAN + 1), ALL_SEASONS.indexOf(s) + 1)
      .map((x) => ({ season: x, rows: lineups[x] })), { span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: 6000 });
    const byTeam = new Map();
    for (const p of players[s]) {
      if (!p.teamId || !(p.min > 0) || !(p.gp > 0)) continue;
      if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
      byTeam.get(p.teamId).push(p);
    }
    for (const squad of byTeam.values()) {
      const tot = squad.reduce((a, p) => a + p.min * p.gp, 0);
      cal.push({
        x: squad.reduce((a, p) => a + ((p.min * p.gp) / tot) * (blend(apply(spm, p), decS.get(p.playerId)?.apm ?? null) ?? 0), 0),
        y: squad.reduce((a, p) => a + ((p.min * p.gp) / tot) * (p.netRtg ?? 0), 0),
      });
    }
  }
  const mx = mean(cal.map((r) => r.x)); const my = mean(cal.map((r) => r.y));
  const scale = cal.reduce((a, r) => a + (r.x - mx) * (r.y - my), 0) / cal.reduce((a, r) => a + (r.x - mx) ** 2, 0) / 5;
  const imp = new Map(); const shrunk = new Map(); const minutes = new Map(); const priorMpg = new Map();
  const pool = players[upto].map((p) => apply(spm, p)).filter((v) => v !== null);
  const mu = mean(pool);
  for (const p of players[upto]) {
    const m = (p.gp ?? 0) * (p.min ?? 0);
    minutes.set(p.playerId, m);
    if ((p.gp ?? 0) >= 10 && p.min > 0) priorMpg.set(p.playerId, p.min);
    const raw = rawOf(p, upto);
    if (raw === null) continue;
    imp.set(p.playerId, raw * scale);
    shrunk.set(p.playerId, shrinkByMinutes(raw, m, mu, MINUTES_SHRINK) * scale);
  }
  return { imp, shrunk, minutes, priorMpg, scale };
}

// ---------------------------------------------------------------- impact.apply 的 ageYears

test('apply ageYears：1 与 aged 逐位相同，n 岁 = 逐岁累加（第 y 次用 age + y 岁）', () => {
  const m = flatModel(CURVES);
  const p = row(1, 29);
  assert.equal(apply(m, p, { ageYears: 1 }), apply(m, p, { aged: true }));
  assert.equal(apply(m, p, { ageYears: 0 }), apply(m, p));
  // 29→30→31：曲线（作用在每 36 分钟特征上）在 29、30 岁各 −2、−3，pts 系数 0.1
  assert.equal(apply(m, p, { ageYears: 2 }), Math.round((apply(m, p) - 0.1 * (2 + 3)) * 100) / 100);
  assert.equal(impactOf(m, p, null, { ageYears: 1 }), impactOf(m, p, null, { aged: true }));
});

// ---------------------------------------------------------------- 规则

test('seasonBack', () => {
  assert.equal(seasonBack('2025-26', 1), '2024-25');
  assert.equal(seasonBack('2025-26', 3), '2022-23');
  assert.equal(seasonBack('2000-01', 1), '1999-00');
});

test('合格季：最近的 gp≥20 且场均≥10；最多往前 3 季；g 按季数算', () => {
  const by = {
    '2025-26': rows(row(1, 30, { gp: 5 })),
    '2024-25': rows(row(1, 29, { gp: 19 }), row(2, 25, { gp: 40, min: 9.9 })),
    '2023-24': rows(row(1, 28, { gp: 50, min: 10 }), row(2, 24, { gp: 40, min: 20 })),
    '2022-23': rows(row(3, 30)),
    '2021-22': rows(row(4, 30)),
  };
  const rowsOf = (s) => by[s];
  assert.deepEqual(goodSeason(1, '2025-26', rowsOf).season, '2023-24');
  assert.equal(goodSeason(1, '2025-26', rowsOf).g, 2);
  assert.equal(goodSeason(2, '2025-26', rowsOf).season, '2023-24');   // 2024-25 场均 9.9 不合格
  assert.equal(goodSeason(3, '2025-26', rowsOf).g, 3);
  assert.equal(goodSeason(4, '2025-26', rowsOf), null);                // 4 季前，超出范围
  assert.equal(goodSeason(5, '2025-26', rowsOf), null);                // 新秀 / 没有数据
});

test('整季缺阵：合格季之后到上季（含）有一季没有行或 gp=0', () => {
  const by = {
    '2025-26': rows(row(1, 30, { gp: 0 }), row(2, 30, { gp: 3 })),
    '2024-25': rows(row(1, 29), row(2, 29, { gp: 10 })),
    '2023-24': rows(row(2, 28)),
  };
  const rowsOf = (s) => by[s];
  assert.equal(missedFullSeason(1, '2025-26', 1, rowsOf), true);
  assert.equal(missedFullSeason(2, '2025-26', 2, rowsOf), false);
  assert.equal(missedFullSeason(3, '2025-26', 1, rowsOf), true);       // 上季根本没有他的行
});

test('fallbackValue：μ + 0.8^g·(aged − μ)，不向替补级收缩；K=20 混上季少量出场；敏感性只对整季缺阵', () => {
  assert.equal(FALLBACK.decay, 0.8); assert.equal(FALLBACK.kGames, 20);
  assert.equal(fallbackValue({ aged: 3, mu: 0.5, g: 1 }), 0.5 + 0.8 * 2.5);
  assert.ok(Math.abs(fallbackValue({ aged: 3, mu: 0.5, g: 3 }) - (0.5 + 0.512 * 2.5)) < 1e-12);
  assert.equal(fallbackValue({ aged: -2, mu: 0, g: 1 }), -1.6);        // 低于均值的人往上收，不是往 −0.5 收
  const fb = 0.5 + 0.8 * 2.5;
  assert.equal(fallbackValue({ aged: 3, mu: 0.5, g: 1, partial: -1, priorGp: 5 }), (20 * fb + 5 * -1) / 25);
  assert.equal(fallbackValue({ aged: 3, mu: 0.5, g: 1, partial: null, priorGp: 5 }), fb);   // 场均 <10：不混
  assert.equal(fallbackValue({ aged: 3, mu: 0.5, g: 1, missed: true }), fb);                // 主规则不折扣
  assert.equal(fallbackValue({ aged: 3, mu: 0.5, g: 1, missed: true, sensitivity: true }), 0.5 + 0.85 * 0.8 * 2.5);
  assert.equal(fallbackValue({ aged: 3, mu: 0.5, g: 1, missed: false, sensitivity: true }), fb);
});

test('fallbackPriors：上季 ≥20 场的人、新秀不动；年龄按 g + extraAgeYears 平移；只读上季及更早', () => {
  const by = {
    '2025-26': rows(row(1, 30, { gp: 8, min: 25, pts: 10 }), row(2, 30), row(3, 22, { gp: 5 }), row(6, 30, { gp: 40, min: 8 })),
    '2024-25': rows(row(1, 29, { pts: 25 })),
    '2023-24': rows(row(4, 27)),
    '2022-23': rows(row(6, 27)),
  };
  const asked = new Set();
  const rowsOf = (s) => { asked.add(s); return by[s]; };
  const model = flatModel(CURVES);
  const calls = [];
  const valueAt = (r, s, ageYears) => { calls.push([r.playerId, s, ageYears]); return apply(model, r, { ageYears }); };
  const res = fallbackPriors({
    ids: [1, 2, 3, 4, 5, 6], priorSeason: '2025-26', rowsOf, valueAt, muPrior: 0.2, extraAgeYears: 1,
    partialOf: (r) => apply(model, r, { minGp: 1, aged: true }),
  });
  assert.deepEqual([...res.keys()].sort(), [1, 4]);      // 2 上季满 20 场；3 新秀；5 没数据；6 上季 40 场 × 8 分钟（不动）
  assert.deepEqual(calls.sort(), [[1, '2024-25', 2], [4, '2023-24', 3]]);
  const r1 = res.get(1);
  assert.equal(r1.g, 1); assert.equal(r1.priorGp, 8); assert.equal(r1.missed, false);
  const aged = apply(model, by['2024-25'].get(1), { ageYears: 2 });
  const partial = apply(model, by['2025-26'].get(1), { minGp: 1, aged: true });
  assert.equal(r1.value, (20 * (0.2 + 0.8 * (aged - 0.2)) + 8 * partial) / 28);
  assert.equal(res.get(4).missed, true);
  assert.ok([...asked].every((s) => s <= '2025-26'));    // 不泄漏：不读上季之后
});

// ---------------------------------------------------------------- 实验价值表

const SEASONS = ['2019-20', '2020-21', '2021-22'];
const { players, lineups } = synth(SEASONS);
const apmBySeason = new Map(SEASONS.map((s) => [s, computeApm(lineups[s], { lambda: 6000 })]));

test('labValuesUpto 不补回退时与原 valuesUpto 逐位相同', () => {
  for (const upto of SEASONS) {
    const a = labValuesUpto({ seasons: SEASONS, players, lineups, apmBySeason }, upto);
    const b = legacyValuesUpto({ ALL_SEASONS: SEASONS, players, lineups, apmBySeason }, upto);
    assert.equal(a.scale, b.scale);
    for (const k of ['imp', 'shrunk', 'minutes', 'priorMpg']) assert.deepEqual([...a[k]], [...b[k]], `${upto} ${k}`);
    assert.equal(a.fallback.size, 0);
  }
});

test('labValuesUpto 补回退：原有值逐位不变，只新增；不读 upto 之后的数据', () => {
  const box = Object.fromEntries(SEASONS.map((s) => [s, players[s]]));
  const ctx = { seasons: SEASONS, players, lineups, apmBySeason, box };
  const base = labValuesUpto({ seasons: SEASONS, players, lineups, apmBySeason }, '2021-22');
  const v = labValuesUpto(ctx, '2021-22', { fallback: 'primary' });
  for (const [id, x] of base.shrunk) assert.equal(v.shrunk.get(id), x);
  assert.ok(v.fallback.size > 0);
  for (const [id, r] of v.fallback) {
    assert.ok(!base.shrunk.has(id));
    assert.equal(v.shrunk.get(id), r.value);
    assert.equal(r.season, '2020-21'); assert.equal(r.g, 1);
  }
  // 往 box 里加一个「未来」季（且改动它会改变一切），upto=2020-21 的结果不变
  const v0 = labValuesUpto({ ...ctx, cache: new Map() }, '2020-21', { fallback: 'primary' });
  const future = players['2021-22'].map((p) => ({ ...p, pts: p.pts + 50, age: p.age + 5 }));
  const v1 = labValuesUpto({ ...ctx, box: { ...box, '2021-22': future }, cache: new Map() }, '2020-21', { fallback: 'primary' });
  assert.deepEqual([...v1.shrunk], [...v0.shrunk]);
});

test('productionFallback：与规则核心同一套，管线 = impactOf + 该季 aged SPM 均值收缩，上季 → 本季再平移一岁', () => {
  const model = { ...flatModel(CURVES), scale: 1, blendW: 0.35 };
  const prior = [row(1, 30, { gp: 4, min: 20, pts: 30 }), row(2, 26), row(3, 33)];
  const hist = { '2024-25': [row(1, 29, { pts: 24 }), row(2, 25), row(3, 32)] };
  const res = productionFallback({ model, priorSeason: '2025-26', priorRows: prior, historyRows: (s) => hist[s] ?? null, lineupsOf: () => null, muPrior: 0.3 });
  assert.deepEqual([...res.keys()], [1]);
  const muGood = mean(hist['2024-25'].map((p) => apply(model, p, { aged: true })));
  const aged = shrinkByMinutes(impactOf(model, hist['2024-25'][0], null, { ageYears: 2 }), 60 * 30, muGood);
  const fb = 0.3 + 0.8 * (aged - 0.3);
  const partial = apply(model, prior[0], { minGp: 1, aged: true });
  assert.equal(res.get(1).value, Math.round(((20 * fb + 4 * partial) / 24) * 100) / 100);
});
