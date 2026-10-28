import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fillMinutes, projectExpectedRotation, rosterRating, healthyRosterRating, availabilityScenarios, ROTATION_CAP,
} from '../server/rosterProjection.mjs';
import {
  playProbability, conditionalMinutes, rotationMinutes, rotationProbability, INJURY_PARAMS, MPG_SHRINK, DNP_GAMES,
} from '../server/rotationMinutes.mjs';

const total = (xs) => xs.reduce((s, v) => s + v, 0);
// OKC 式名单：一个 28 分钟的主力 + 一串 20–30 分钟的轮换 + 替补
const okc = [28.2, 30, 29, 27, 26, 25, 22, 20, 16, 12, 8, 5, 3];

test('fillMinutes sums to exactly 240 and never exceeds the cap', () => {
  const deep = [...okc, 14, 12, 10]; // 出场时分钟合计 267 > 240：人多分钟不够
  const { minutes, replacement } = fillMinutes(deep, deep.map(() => 1));
  assert.ok(Math.abs(total(minutes) - 240) < 1e-9);
  assert.equal(replacement, 0);
  assert.ok(minutes.every((m) => m < ROTATION_CAP));
  // 人多分钟不够：压缩主要落在替补，主力几乎不动
  assert.ok(minutes[1] > 0.9 * deep[1]);
  assert.ok(minutes[11] < 0.75 * deep[11]);
  assert.ok(minutes[1] / deep[1] > minutes[11] / deep[11]);
});

test('freed minutes go mostly to the next players in the rotation, not pro-rata to the star', () => {
  const healthy = fillMinutes(okc, okc.map(() => 1)).minutes;
  const w = okc.map((m, i) => ([1, 2, 3, 4].includes(i) ? 0 : 1)); // 四名轮换球员缺阵
  const hurt = fillMinutes(okc, w).minutes;
  assert.ok(Math.abs(total(hurt) - 240) < 1e-9);
  const starGain = hurt[0] - healthy[0];
  const benchGain = hurt[8] - healthy[8];
  assert.ok(starGain > 0 && starGain < 10, `star +${starGain}`); // 旧版等比上限 48：这里会推到 48
  assert.ok(benchGain > starGain);
  assert.ok(hurt[0] < ROTATION_CAP);
});

test('an exhausted rotation fills the remainder at replacement level', () => {
  const { minutes, replacement } = fillMinutes([30, 30, 30, 30, 30], [1, 1, 1, 1, 1]);
  assert.deepEqual(minutes, [38, 38, 38, 38, 38]);
  assert.equal(replacement, 50);
  const rot = projectExpectedRotation([1, 2, 3, 4, 5].map((id) => ({ playerId: id, projectedMinutes: 30, availability: 1, impact: 1 })),
    { replacementImpact: -2 });
  assert.ok(Math.abs(rosterRating(rot) - (190 * 1 + 50 * -2) / 48) < 1e-12);
});

test('expected minutes weight players by P(plays) and stay at 240 in both modes', () => {
  const players = okc.map((m, i) => ({ playerId: i + 1, projectedMinutes: m, availability: i === 0 ? 0.5 : 1, impact: i === 0 ? 5 : 0 }));
  const mf = projectExpectedRotation(players);
  const en = projectExpectedRotation(players, { mode: 'enumerate' });
  for (const r of [mf, en]) {
    assert.ok(Math.abs(total(r.players.map((p) => p.minutes)) + r.replacementMinutes - 240) < 1e-9);
    assert.ok(Math.abs(total(r.players.map((p) => p.healthyMinutes)) - 240) < 1e-9);
    assert.ok(r.players[0].minutes < r.players[0].healthyMinutes * 0.6);
    assert.ok(rosterRating(r) < healthyRosterRating(r));
  }
  assert.ok(Math.abs(mf.players[0].minutes - en.players[0].minutes) < 1);
});

test('availability scenarios enumerate uncertain players with probabilities summing to 1', () => {
  const sc = availabilityScenarios([1, 0, 0.5, 0.25]);
  assert.equal(sc.length, 4);
  assert.ok(Math.abs(total(sc.map((s) => s.p)) - 1) < 1e-12);
  assert.ok(sc.every((s) => s.playing[0] === 1 && s.playing[1] === 0));
});

test('rotation probability lowers expected minutes without touching the conditional projection', () => {
  const base = okc.map((m, i) => ({ playerId: i + 1, projectedMinutes: m, availability: 1, impact: 0 }));
  const r = projectExpectedRotation(base.map((p, i) => ({ ...p, rotation: i === 12 ? 0.2 : 1 })));
  const r0 = projectExpectedRotation(base);
  assert.ok(r.players[12].healthyMinutes < r0.players[12].healthyMinutes);
  assert.equal(r.players[12].projectedMinutes, 3);
  assert.throws(() => projectExpectedRotation(base.map((p) => ({ ...p, rotation: 2 }))), /rotation/);
});

test('P(plays | status) comes from the frozen injury-params-v1 table, ESPN day-to-day = Questionable', () => {
  const p = INJURY_PARAMS.slots['22'].pPlay;
  assert.equal(playProbability(null), 1);
  assert.equal(playProbability('out'), p.Out);
  assert.equal(playProbability('doubtful'), p.Doubtful);
  assert.equal(playProbability('dayToDay'), p.Questionable);
  assert.equal(playProbability('Probable'), p.Probable);
  assert.ok(playProbability('dayToDay') > 0.5 && playProbability('doubtful') < 0.1);
});

test('conditional minutes ignore appearance rate; DNP-CD applies only to healthy zero-appearance players', () => {
  assert.equal(conditionalMinutes(20, 40, 3), (MPG_SHRINK.priorK * 20 + 3 * 40) / (MPG_SHRINK.priorK + 3));
  assert.equal(conditionalMinutes(30, null, 0), 30);
  assert.equal(conditionalMinutes(null, null, 0), null);
  // 场场打满 34.6 分钟的人：出场时分钟就是 ~34.6，轮换概率 ~1
  const regular = rotationMinutes({ priorMpg: 34, curMpg: 34.6, n: 4, teamGames: 4 });
  assert.ok(Math.abs(regular.minutes - 34.6) < 0.5);
  assert.ok(regular.rotation > 0.97);
  const benched = rotationMinutes({ priorMpg: 30.9, n: 0, teamGames: DNP_GAMES });
  assert.equal(benched.minutesSource, 'dnp-benched');
  assert.equal(rotationMinutes({ priorMpg: 30.9, n: 0, teamGames: DNP_GAMES, listed: true }).minutesSource, 'prior-season');
  assert.equal(rotationMinutes({ priorMpg: 30.9, n: 0, teamGames: DNP_GAMES - 1 }).minutes, 30.9);
  assert.equal(rotationMinutes({}).minutesSource, 'replacement');
  // 出场率越低、出场时分钟越少，轮换概率越低
  assert.ok(rotationProbability(8, 1, 6) < rotationProbability(8, 6, 6));
  assert.ok(rotationProbability(8, 6, 6) < rotationProbability(30, 6, 6));
});
