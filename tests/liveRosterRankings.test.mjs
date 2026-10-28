import test from 'node:test';
import assert from 'node:assert/strict';
import { liveRosterRankings, shrink, projectMinutes, MINUTES, IMPACT_K, INJURY_STALE_HOURS } from '../server/liveRosterRankings.mjs';
import { conditionalMinutes, rotationProbability } from '../server/rotationMinutes.mjs';
import { fitK, checkpointSamples } from '../scripts/roster-shrinkage.mjs';

// 每队 12 人：真实名单 13–15 人，人太少时「轮换概率 × 上限 38」会凑不满 240，测的就不是常规情形了
const N = 12;
function store() {
  return {
    meta: { leagueAvg: { pace: 100 }, fetchedAt: '2026-10-27T15:00:00Z' },
    teams: [1, 2].map((teamId) => ({ teamId, adv: { pace: 100 } })),
    players: [1, 2].flatMap((teamId) => Array.from({ length: N }, (_, i) => ({
      playerId: teamId * 10 + i, teamId, onRoster: true, name: `Player ${teamId}-${i}`,
      gp: 60, min: 20, impact: teamId === 1 ? 1 : 0,
      cur: { gp: 3, min: 40, impact: teamId === 1 ? 1 : 0 },
    }))),
    injuries: { fetchedAt: '2026-10-27T15:00:00Z', players: [] },
  };
}
const legacy = [1, 2].map((teamId) => ({ teamId, elo: teamId === 1 ? 1400 : 1600,
  total: teamId === 1 ? -4 : 4, rank: teamId === 1 ? 2 : 1, turnoverAdj: 0 }));

test('ranks the current roster independently of inherited team Elo', () => {
  const rows = liveRosterRankings(store(), legacy);
  assert.equal(rows[0].teamId, 1);
  assert.equal(rows[0].total, 2.5);
  assert.equal(rows[0].legacyTotal, -4);
  assert.equal(rows[0].legacyRank, 2);
  assert.ok(Math.abs(rows[0].rosterProjection.rotation.reduce((s, p) => s + p.minutes, 0) - 240) < 1e-9);
});

test('departed players do not contribute and current roles change allocated minutes', () => {
  const s = store();
  s.players.push({ playerId: 999, teamId: 1, onRoster: false, impact: 100, gp: 82, min: 48 });
  s.players[0].cur.min = 10;
  s.players[0].cur.impact = 8;
  const row = liveRosterRankings(s, legacy)[0];
  assert.ok(!row.rosterProjection.rotation.some((p) => p.playerId === 999));
  const rot = row.rosterProjection.rotation;
  assert.ok(rot.find((p) => p.playerId === 10).minutes < rot.find((p) => p.playerId === 11).minutes);
});

test('reported absences and manual exclusions redistribute minutes against a fixed healthy baseline', () => {
  const s = store(); s.players[0].impact = 8; s.players[0].cur.impact = 8;
  const healthy = liveRosterRankings(s, legacy, { availability: 'healthy' });
  s.injuries.players.push({ teamId: 1, playerId: 10, status: 'out' });
  const absent = liveRosterRankings(s, legacy);
  const a = absent.find((r) => r.teamId === 1);
  // ESPN out = 官方 Out：P(出场) ≈ 1%（冻结的 injury-params-v1），不是硬 0
  const star = a.rosterProjection.rotation.find((p) => p.playerId === 10);
  assert.ok(star.minutes > 0 && star.minutes < 1);
  assert.ok(a.total < healthy.find((r) => r.teamId === 1).total);
  assert.ok(a.rosterAdj < 0);
  // 健康基准不随伤病变：两种模式下 healthyTotal 相同，且等于健康模式的 total
  assert.equal(a.rosterProjection.healthyTotal, healthy.find((r) => r.teamId === 1).total);
  // 手动缺阵记硬 0，且不牵动别队（去均值用不含手动缺阵的联盟均值）
  const manual = liveRosterRankings(s, legacy, { out: { 1: [11] } });
  assert.equal(manual.find((r) => r.teamId === 1).rosterProjection.rotation.find((p) => p.playerId === 11).minutes, 0);
  assert.equal(manual.find((r) => r.teamId === 2).total, absent.find((r) => r.teamId === 2).total);
  const healthyManual = liveRosterRankings(s, legacy, { availability: 'healthy', out: { 1: [10] } });
  assert.equal(healthyManual.find((r) => r.teamId === 1).rosterProjection.rotation.find((p) => p.playerId === 10).minutes, 0);
});

test('day-to-day / doubtful players are weighted by the frozen P(plays | status), not treated as fully available', () => {
  const s = store(); s.players[0].impact = 8; s.players[0].cur.impact = 8;
  const minutesOf = (status) => {
    const t = structuredClone(s);
    if (status) t.injuries.players.push({ teamId: 1, playerId: 10, status });
    return find(liveRosterRankings(t, legacy), 1, 10).minutes;
  };
  const [none, dtd, doubtful, out] = [null, 'dayToDay', 'doubtful', 'out'].map(minutesOf);
  assert.ok(none > dtd && dtd > doubtful && doubtful > out);
  assert.ok(Math.abs(dtd / none - 0.5416) < 0.05); // Questionable 0.54（σ 分配让比例不完全线性）
});

test('league mean of totals is zero in each mode and stale or missing injury snapshots are flagged', () => {
  const s = store(); s.players[0].impact = 8; s.players[0].cur.impact = 8;
  s.injuries.players.push({ teamId: 1, playerId: 10, status: 'out' });
  for (const availability of ['reported', 'healthy']) {
    const rows = liveRosterRankings(s, legacy, { availability });
    assert.ok(Math.abs(rows.reduce((a, r) => a + r.total, 0)) < 0.011); // 每队保留两位小数
  }
  const fresh = liveRosterRankings(s, legacy)[0].rosterProjection;
  assert.equal(fresh.injuryStale, false);
  assert.equal(fresh.injuryLagHours, 0);
  s.injuries.fetchedAt = new Date(Date.parse(s.meta.fetchedAt) - (INJURY_STALE_HOURS + 1) * 3600e3).toISOString();
  assert.equal(liveRosterRankings(s, legacy)[0].rosterProjection.injuryStale, true);
  s.injuries = { fetchedAt: null, players: [] };
  assert.equal(liveRosterRankings(s, legacy)[0].rosterProjection.injuryStale, true);
  assert.equal(liveRosterRankings(s, legacy, { availability: 'healthy' })[0].rosterProjection.injuryStale, false);
});

test('a missing impact model is surfaced instead of silently using the replacement prior', () => {
  const s = store(); delete s.players[0].impact; s.players[0].cur.impact = null;
  const r = liveRosterRankings(s, legacy).find((x) => x.teamId === 1);
  assert.equal(r.rosterProjection.impactModelMissing, true);
  assert.equal(find([r], 1, 10).impactSource, 'replacement-prior');
  s.impactModel = { features: ['pts'], mu: [0], sd: [1], beta: [0.1], intercept: 0 };
  assert.equal(liveRosterRankings(s, legacy)[0].rosterProjection.impactModelMissing, false);
});

test('marks missing impact and prior-season minutes instead of disguising them as measured forecasts', () => {
  const s = store(); delete s.players[0].impact; s.players[0].cur = null;
  s.teams[0].cur = { wins: 1, losses: 0 }; // 球队只赛 1 场：0 出场还不算轮换外
  const r = liveRosterRankings(s, legacy).find((r) => r.teamId === 1);
  const p = r.rosterProjection.rotation.find((p) => p.playerId === 10);
  assert.equal(p.fromPrior, true);
  assert.equal(p.minutesSource, 'prior-season');
  assert.ok(r.rosterProjection.priorMinutes > 0);
  assert.ok(r.rosterProjection.knownImpactPct < 1);
});

test('an exhausted rotation is filled at replacement level instead of pushing anyone past the cap', () => {
  const s = store();
  const out = { 1: s.players.filter((p) => p.teamId === 1).slice(0, N - 5).map((p) => p.playerId) };
  const r = liveRosterRankings(s, legacy, { out }).find((x) => x.teamId === 1).rosterProjection;
  assert.ok(r.rotation.every((p) => p.minutes <= 38 + 1e-9));
  assert.ok(r.replacementMinutes > 0);
  assert.ok(Math.abs(r.rotation.reduce((a, p) => a + p.minutes, 0) + r.replacementMinutes - 240) < 0.01); // replacementMinutes 保留两位小数
});

test('one team failing does not blank the rest of the league', () => {
  const s = store(); s.players = s.players.filter((p) => p.teamId !== 1); // 队 1 没有名单
  const rows = liveRosterRankings(s, legacy);
  const bad = rows.find((r) => r.teamId === 1); const ok = rows.find((r) => r.teamId === 2);
  assert.equal(bad.total, null);
  assert.equal(bad.rank, null);
  assert.match(bad.rosterProjection.error, /rotation players/i);
  assert.equal(ok.total, 0);
  assert.equal(ok.rank, 1);
  assert.equal(ok.rosterProjection.leagueTeams, 1);
});

// 极简 SPM 模型：SPM = 0.1 × 每 36 分钟得分，便于手算
const tinyModel = { features: ['pts'], mu: [0], sd: [1], beta: [0.1], intercept: 0 };
const box = (pts, min, gp) => ({ gp, min, base: { pts } });
const find = (rows, teamId, playerId) => rows.find((r) => r.teamId === teamId)
  .rosterProjection.rotation.find((p) => p.playerId === playerId);

test('shrink is a sample-size weighted average toward the target', () => {
  assert.equal(shrink(10, 3, 20, 1), 12.5);
  assert.equal(shrink(10, 0, 20, 4), 20);
  assert.ok(MINUTES.priorK > 0 && IMPACT_K > 0 && MINUTES.noPrior.k > 0 && MINUTES.rate.prior.R > 0);
});

const rate = (r, n, T) => shrink(r.R, r.k, Math.min(1, n / T), T);

test('projected minutes per team game = shrunk MPG x shrunk appearance rate', () => {
  assert.equal(projectMinutes(20, 40, 3, 3), shrink(20, MINUTES.priorK, 40, 3) * rate(MINUTES.rate.prior, 3, 3));
  const { a, b, k } = MINUTES.noPrior;
  assert.equal(projectMinutes(null, 2, 1, 4), shrink(a + b * 2, k, 2, 1) * rate(MINUTES.rate.noPrior, 1, 4));
  // 早期 <8 分钟、无先验的球员：历史上剩余场均约 9 分钟（出场时），不能被拉到 20 分钟附近
  assert.ok(shrink(a + b * 2, k, 2, 1) < 12);
  assert.ok(projectMinutes(null, 2, 1, 4) < projectMinutes(null, 30, 1, 4));
  // 本季还没出场但有上季分钟：MPG 取上季，出场率随球队已赛场数下降
  assert.equal(projectMinutes(30, null, 0, 4), 30 * rate(MINUTES.rate.prior, 0, 4));
  assert.equal(projectMinutes(null, null, 0, 4), 0);
});

test('live board projects minutes conditional on playing; appearances only move the rotation probability', () => {
  const s = store();
  s.teams[0].cur = { wins: 3, losses: 1 };
  s.players[1].cur = { gp: 2, min: 40, impact: 1 };
  s.players[2].gp = 2; s.players[2].cur = { gp: 2, min: 30, impact: 1 };
  s.players[3].cur = { gp: 4, min: 34.6, impact: 1 };
  const rows = liveRosterRankings(s, legacy);
  const a = find(rows, 1, 11); const b = find(rows, 1, 12); const c = find(rows, 1, 13);
  assert.equal(a.minutesSource, 'current+prior');
  assert.equal(a.projectedMinutes, conditionalMinutes(20, 40, 2));
  assert.equal(a.rotation, rotationProbability(conditionalMinutes(20, 40, 2), 2, 4));
  assert.equal(b.minutesSource, 'current+population');
  assert.equal(b.projectedMinutes, conditionalMinutes(null, 30, 2));
  // 场场出场的人轮换概率接近 1，不再被「出场率向 0.60 收缩」压掉一截
  assert.ok(c.rotation > 0.95);
});

test('healthy players with zero appearances after two team games lose their rotation minutes (DNP-CD)', () => {
  const s = store();
  s.teams[0].cur = { wins: 1, losses: 3 };
  Object.assign(s.players[4], { gp: 13, min: 30.9, cur: null }); // 上季 13 场 30.9 分钟、本季 4 场一场没上
  const benched = find(liveRosterRankings(s, legacy), 1, 14);
  assert.equal(benched.minutesSource, 'dnp-benched');
  assert.ok(benched.minutes < 1);
  // 同样 0 出场，但在伤病名单上（伤停而非不用）：保留上季角色，按伤病概率打折
  s.injuries.players.push({ teamId: 1, playerId: 14, status: 'dayToDay' });
  const injured = find(liveRosterRankings(s, legacy), 1, 14);
  assert.equal(injured.minutesSource, 'prior-season');
  assert.ok(injured.minutes > 5);
});

test('players without any IMP get a data-derived estimate instead of the replacement prior', () => {
  const s = store(); s.impactModel = tinyModel;
  // 上季 15 场（低于 IMP 门槛）、每 36 分钟 36 分 → SPM 3.6；本季 4 场每 36 分钟 18 分 → SPM 1.8
  Object.assign(s.players[0], { impact: null, gp: 15, min: 36, base: { pts: 36 }, cur: { ...box(18, 36, 4), impact: null } });
  // 新秀：本季分钟不足 10，没有 SPM → 用上季新秀（exp=1）的分钟加权 SPM 均值
  Object.assign(s.players[1], { exp: 'R', impact: null, gp: 0, min: 0, cur: { ...box(10, 8, 2), impact: null } });
  s.players.push({ playerId: 500, teamId: 2, onRoster: false, exp: '1', gp: 50, min: 20, ...{ base: { pts: 10 } } });
  const rows = liveRosterRankings(s, legacy);
  const vet = find(rows, 1, 10); const rookie = find(rows, 1, 11);
  const m = (N - 2) / (2 * N - 2); // 上季有 IMP 球员的均值：队1 其余 N−2 人 IMP=1、队2 N 人 IMP=0
  assert.equal(vet.impactSource, 'estimated-shrunk-spm');
  assert.ok(Math.abs(vet.impact - (IMPACT_K * m + 15 * 3.6 + 4 * 1.8) / (IMPACT_K + 19)) <= 0.005); // 与 ingest 一样保留两位小数
  assert.equal(rookie.impactSource, 'estimated-rookie-prior');
  assert.ok(Math.abs(rookie.impact - 1.8) < 1e-9);
  assert.notEqual(vet.impact, -0.5);
  assert.match(vet.impactPrior.source, /未验证/);
  assert.deepEqual(Object.keys(vet.impactPrior.sourceParams), ['n', 'k', 'target', 'targetKind']);
  assert.deepEqual(vet.impactPrior.sourceParams, { n: 19, k: IMPACT_K, target: m, targetKind: 'population' });
  assert.equal(rookie.impactPrior.sourceParams.targetKind, 'rookie');
  assert.equal(rookie.impactPrior.sourceParams.n, 0);
});

test('team rows report how much of the rating is estimated versus measured', () => {
  const s = store(); s.impactModel = tinyModel;
  Object.assign(s.players[0], { impact: null, gp: 15, min: 36, base: { pts: 36 }, cur: { ...box(18, 36, 4), impact: null } });
  const r = liveRosterRankings(s, legacy).find((x) => x.teamId === 1).rosterProjection;
  const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum(r.impactSourceShares) - 1) < 1e-9);
  assert.ok(Math.abs(sum(r.minutesSourceShares) - 1) < 1e-9);
  assert.ok(r.impactSourceShares['estimated-shrunk-spm'] > 0);
  assert.ok(Math.abs(r.knownImpactPct - (1 - r.impactSourceShares['estimated-shrunk-spm'])) < 1e-9);
});

test('shrinkage fitting recovers the constant that generated the data', () => {
  const samples = [];
  for (let i = 0; i < 200; i++) for (const n of [1, 2, 5]) {
    const value = (i % 7) * 3; const target = 15;
    samples.push({ target, n, value, y: shrink(target, 6, value, n) });
  }
  assert.equal(fitK(samples).k, 6);
  // 一支球队 4 场：球员 1 每场 30 分钟；球员 2 只在第 1、3 场各打 10 分钟
  const games = [new Map([[1, 30], [2, 10]]), new Map([[1, 30]]), new Map([[1, 30], [2, 10]]), new Map([[1, 30]])];
  const prev = { tot: new Map([[1, 600]]), gp: new Map([[1, 20]]) };
  const rows = checkpointSamples(prev, new Map([[7, games]]), { maxT: 1 }).flat();
  assert.deepEqual(rows.find((x) => x.p === 1), { p: 1, team: 7, T: 1, n: 1, v: 30, y: 30, rate: 1, mpg: 30, priorMpg: 30 });
  assert.deepEqual(rows.find((x) => x.p === 2), { p: 2, team: 7, T: 1, n: 1, v: 10, y: 10 / 3, rate: 1 / 3, mpg: 10, priorMpg: null });
});

test('阵容先验算不出来的队带 errorCode（中文 error 保留）', () => {
  const s = store();
  s.teams[1].adv.pace = 0; s.meta.leagueAvg.pace = 0;
  const bad = liveRosterRankings(s, legacy).find((r) => r.teamId === 2).rosterProjection;
  assert.equal(bad.error, '缺少有效节奏数据');
  assert.equal(bad.errorCode, 'srv.roster.insufficient');
  const good = liveRosterRankings(store(), legacy).find((r) => r.teamId === 2).rosterProjection;
  assert.equal(good.errorCode, undefined);
  // 实测 IMP 的球员没有先验说明
  assert.equal(liveRosterRankings(store(), legacy)[0].rosterProjection.rotation[0].impactPrior, undefined);
});
