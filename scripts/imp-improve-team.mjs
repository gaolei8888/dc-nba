/**
 * IMP 改进实验的球队层面检查（只报告，不进采纳规则；若显著变差则不采纳）。
 *
 *   node scripts/imp-improve-team.mjs
 *
 * 复用延续度回测（scripts/continuity-backtest.mjs 的「旁证」段）的同一套机器：
 * 第 N 季的比赛只用第 N−1 季的球员价值（SPM 只在 ≤N−1 季训练，APM 只用 ≤N−1 季的组合，
 * 逐项年龄曲线只用 ≤N−1 季内的相邻赛季对，量纲校准也只用 ≤N−1 季），
 * 在「纯阵容」与「延续度混合（pow+lin）」两族里分别只换球员价值、各自调 a 与 sd，留一赛季，
 * 按场配对 bootstrap 比较 log loss。需要 data/backtest.json（scripts/build-dataset.mjs 从缓存重建）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJsonAuto } from '../server/nbaClient.mjs';
import {
  replaySeason, eloStartFor, teamGamesFromStints, leagueCenter, predict, tune, logLoss,
} from '../server/continuityLab.mjs';
import { expand, score } from '../server/lab.mjs';
import { bootstrapCI } from '../server/fusionLab.mjs';
import { players, seasons, minutesOf, calibratedValues } from './imp-improve-core.mjs';

const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };
const EVAL = seasons.slice(1);
const prevOf = (s) => seasons[seasons.indexOf(s) - 1];
const dataset = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backtest.json'), 'utf8'));
const stintFiles = Object.fromEntries(seasons.map((s) => [s, readJsonAuto(path.join(DATA_DIR, 'history', `stints_${s}.json.gz`))]));

const CANDS = {
  base: {},                                  // 现行收缩 IMP
  combo: { span: 4, hl: 3, ageStat: 1 },     // 组合（8c × 5b，多数折选中的参数）
  apm8c: { span: 4, hl: 3 },                 // 仅 8c
  age5b: { ageStat: 1 },                     // 仅 5b（线上采纳的配置，与 fit-impact 一致：APM 3 季/半衰期 1、k=3200）
  exp9a: { ageStat: 1, span: 4, hl: 3, apmAge: 1 }, // 实验 9a 候选
};

/** 截至 upto 季（含）的球员价值，只用 ≤upto 季的数据（calibratedValues 见 imp-improve-core.mjs） */
function valuesUpto(upto) {
  const out = new Map(); const scales = {};
  for (const [name, cfg] of Object.entries(CANDS)) {
    const r = calibratedValues(upto, cfg);
    out.set(name, r.values); scales[name] = r.scale;
  }
  const minutes = new Map(); const priorMpg = new Map();
  for (const p of players[upto]) {
    minutes.set(p.playerId, minutesOf(p));
    if ((p.gp ?? 0) >= 10 && p.min > 0) priorMpg.set(p.playerId, p.min);
  }
  return { values: out, minutes, priorMpg, scales };
}

const rowsBy = {};
for (const s of EVAL) {
  const prev = prevOf(s);
  const v = valuesUpto(prev);
  const center = new Map([...v.values].map(([k, m]) => [k, leagueCenter(v.minutes, m)]));
  const { rows } = replaySeason(expand(dataset.seasons[s]), eloStartFor(dataset, s, P), P, {
    stints: new Map(Object.entries(stintFiles[s].games)),
    prevGames: teamGamesFromStints(stintFiles[prev]),
    priorMpg: v.priorMpg, values: v.values, center, window: 82,
  });
  rowsBy[s] = rows.map((r) => ({ ...r, season: s }));
  console.log(`- ${s}: ${rows.length} 场；量纲 ${Object.entries(v.scales).map(([k, x]) => `${k} ×${x.toFixed(3)}`).join('，')}`);
}

const SDS = [11, 11.5, 12, 12.5, 13];
const AS = [0.5, 0.75, 1, 1.25, 1.5];
const fam = (value, modes) => [
  { mode: 'roster' },
  ...[0.5, 1, 2, 4].map((gamma) => ({ mode: 'pow', gamma })),
  ...[0.5, 1, 1.5, 2, 3].map((beta) => ({ mode: 'lin', beta })),
].filter((m) => modes.includes(m.mode)).flatMap((m) => AS.flatMap((a) => SDS.map((sd) => ({ ...m, a, sd, value }))));
const train = (held) => EVAL.filter((s) => s !== held).flatMap((s) => rowsBy[s]);
const run = (value, modes) => EVAL.flatMap((s) => {
  const cfg = tune(train(s), fam(value, modes)).cfg;
  return rowsBy[s].map((r) => ({ row: r, ...predict(r, cfg) }));
});
const fmt = (v) => v.toFixed(4);
console.log('\n| 模型族 | 阶段 | 场数 | 现行收缩 IMP | 候选 | 候选 log loss | Δ（候选 − 现行）[95% CI] |');
console.log('|---|---|---:|---:|---|---:|---|');
for (const [famName, modes] of [['纯阵容', ['roster']], ['延续度混合（pow+lin）', ['pow', 'lin']]]) {
  const a = run('base', modes);
  for (const name of Object.keys(CANDS).filter((k) => k !== 'base')) {
    const b = run(name, modes);
    for (const [ph, inPh] of [['全部', () => true], ['已赛 <10', (r) => r.teamGp < 10]]) {
      const idx = a.map((x, i) => (inPh(x.row) ? i : -1)).filter((i) => i >= 0);
      const ci = bootstrapCI(idx.map((i) => logLoss(b[i]) - logLoss(a[i])));
      console.log(`| ${famName} | ${ph} | ${idx.length} | ${fmt(score(idx.map((i) => a[i])).logloss)} | ${name} | ${fmt(score(idx.map((i) => b[i])).logloss)} | ${fmt(ci.mean)} [${fmt(ci.lo)}, ${fmt(ci.hi)}] |`);
    }
  }
}
