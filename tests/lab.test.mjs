import test from 'node:test';
import assert from 'node:assert/strict';
import { expand } from '../server/lab.mjs';

test('expand：中立场两行都标客场时，主客仍是两支不同球队', () => {
  // 真实数据 0022400147（2024-11-02 巴黎赛）：两行 MATCHUP 都是 "@"
  const [g] = expand([{ i: '0022400147', d: '2024-11-02', s: [[1610612748, 118, 0], [1610612764, 98, 0]] }]);
  assert.equal(g.neutral, true);
  assert.notEqual(g.home.teamId, g.away.teamId);
  assert.deepEqual([g.home.teamId, g.away.teamId].sort(), [1610612748, 1610612764]);
  assert.equal(g.home.win !== g.away.win, true);
});

test('expand：正常主客场不受影响', () => {
  const [g] = expand([{ i: 'x', d: '2024-11-02', s: [[2, 90, 0], [1, 100, 1]] }]);
  assert.deepEqual([g.home.teamId, g.away.teamId, g.neutral, g.home.win], [1, 2, false, true]);
});
