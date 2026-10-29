import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPositions, fantasySeason } from '../server/espnPositions.mjs';

test('fantasySeason：取赛季结束的年份', () => {
  assert.equal(fantasySeason('2026-27'), 2027);
  assert.equal(fantasySeason('bad'), null);
});

test('matchPositions：按归一化姓名匹配五档位置', () => {
  const espn = [
    { fullName: 'Nikola Jokić', defaultPositionId: 5, proTeamId: 7 },
    { fullName: 'Stephen Curry', defaultPositionId: 1, proTeamId: 9 },
    { fullName: 'Jaren Jackson Jr.', defaultPositionId: 4, proTeamId: 29 },
  ];
  const ours = [
    { playerId: 1, name: 'Nikola Jokic' },
    { playerId: 2, name: 'Stephen Curry' },
    { playerId: 3, name: 'Jaren Jackson Jr.' },
    { playerId: 4, name: 'Nobody Here' },
  ];
  const r = matchPositions(espn, ours);
  assert.deepEqual(r.byPlayerId, { 1: 'C', 2: 'PG', 3: 'PF' });
  assert.equal(r.matched, 3);
  assert.deepEqual(r.unmatched, ['Nobody Here']);
});

test('matchPositions：ESPN 同名时只取在队的；仍不唯一就不匹配', () => {
  const espn = [
    { fullName: 'Jamaal Tatum', defaultPositionId: 2, proTeamId: 0 },
    { fullName: 'Jamaal Tatum', defaultPositionId: 3, proTeamId: 5 },
    { fullName: 'Two Same', defaultPositionId: 1, proTeamId: 1 },
    { fullName: 'Two Same', defaultPositionId: 2, proTeamId: 2 },
  ];
  const ours = [{ playerId: 1, name: 'Jamaal Tatum' }, { playerId: 2, name: 'Two Same' }];
  const r = matchPositions(espn, ours);
  assert.deepEqual(r.byPlayerId, { 1: 'SF' });
  assert.deepEqual(r.ambiguous, ['Two Same']);
});

test('matchPositions：我们这边同名多人也不匹配；未知位置 id 忽略', () => {
  const espn = [{ fullName: 'Dup Name', defaultPositionId: 1, proTeamId: 1 }, { fullName: 'X Y', defaultPositionId: 0, proTeamId: 1 }];
  const ours = [{ playerId: 1, name: 'Dup Name' }, { playerId: 2, name: 'Dup Name' }, { playerId: 3, name: 'X Y' }];
  const r = matchPositions(espn, ours);
  assert.deepEqual(r.byPlayerId, {});
  assert.deepEqual(r.ambiguous, ['Dup Name', 'Dup Name']);
  assert.deepEqual(r.unmatched, ['X Y']);
});
