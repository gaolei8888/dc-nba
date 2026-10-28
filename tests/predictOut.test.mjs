import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, teamStrength, predictGame, FACTOR_KEYS } from '../server/predict.mjs';
import zh from '../web/src/i18n/locales/zh.js';
import { rotationImpact, VALUE_IMP } from '../server/ratings.mjs';

// 两支队的最小数据集。名单总分钟不到球队上限，移出一个人后空出的时间算替补级（贡献 0），
// 这样每个人的边际就是 −(IMP − 替补级) × 分钟，结果好手算。
const adv = { pace: 100, netRtg: 0, offRtg: 115, defRtg: 115 };
const player = (playerId, teamId, impact, min = 30, gp = 70) => ({
  playerId, teamId, priorTeamId: teamId, onRoster: true, name: `P${playerId}`, min, gp, impact,
});
const store = {
  teams: [
    { teamId: 1, elo: 1500, adv, rotationPrior: 0 },
    { teamId: 2, elo: 1500, adv, rotationPrior: 0 },
  ],
  players: [
    player(11, 1, 3.0),     // 高于替补级：缺阵是损失
    player(12, 1, -3.0),    // 低于替补级（−0.5）：单独移出算出来是正数
    player(13, 1, 1.0),
    player(21, 2, 1.0),
    player(22, 2, 0.5),
  ],
  schedule: { games: [] },
  meta: { leagueAvg: { pace: 100, offRtg: 115 }, impactFit: { b: 1 }, rotationBasis: 'imp' },
};
const model = buildModel(store);
const pts = (raw) => raw; // b = 1、pace = 100，影响力原值即每场分

test('低于替补级的缺阵者不能抵消别人的缺阵损失（逐人取下限）', () => {
  const onlyStar = teamStrength(model, 1, [11]).rosterAdj;
  assert.ok(onlyStar < 0);
  // 旧算法：两人一起移出后再对合计取 min(0, …)，低于替补级者的正数把损失抵掉
  const roster = store.players.filter((p) => p.teamId === 1);
  const base = rotationImpact(roster, { basis: VALUE_IMP });
  const jointOld = Math.min(0, pts(rotationImpact(roster, { basis: VALUE_IMP, exclude: new Set([11, 12]) }) - base));
  assert.ok(jointOld > onlyStar, '用例要能复现旧 bug：合计被抵消');

  const both = teamStrength(model, 1, [11, 12]);
  assert.equal(both.rosterAdj, onlyStar);
  const cost = Object.fromEntries(both.missing.map((m) => [m.playerId, m.costPts]));
  assert.equal(cost[12], 0);
  assert.equal(cost[11], onlyStar);
});

test('单个高于替补级的缺阵者：结果与原算法一致', () => {
  const roster = store.players.filter((p) => p.teamId === 1);
  const base = rotationImpact(roster, { basis: VALUE_IMP });
  const expected = Math.min(0, pts(rotationImpact(roster, { basis: VALUE_IMP, exclude: new Set([11]) }) - base));
  const s = teamStrength(model, 1, [11]);
  assert.equal(s.rosterAdj, Math.round(expected * 100) / 100);
  assert.equal(s.missing[0].costPts, s.rosterAdj);
  // 只勾低于替补级的人：缺阵修正为 0，不会让球队变强
  assert.equal(teamStrength(model, 1, [12]).rosterAdj, 0);
});

test('不勾缺阵时预测不受影响', () => {
  const a = predictGame(model, { homeId: 1, awayId: 2 });
  const b = predictGame(model, { homeId: 1, awayId: 2, out: { 1: [], 2: [] } });
  assert.deepEqual(a, b);
  assert.equal(a.strength.home.rosterAdj, 0);
});

test('因素分解的 key 与导出的 FACTOR_KEYS 一致，中文标签与 srv.predict.factor 逐字相同', () => {
  const { factors } = predictGame(model, { homeId: 1, awayId: 2 });
  assert.deepEqual(factors.map((f) => f.key), FACTOR_KEYS);
  for (const f of factors) assert.equal(zh.srv.predict.factor[f.key], f.label);
});
