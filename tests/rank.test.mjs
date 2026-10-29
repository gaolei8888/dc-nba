import test from 'node:test';
import assert from 'node:assert/strict';
import { competitionRanks } from '../web/src/lib/rank.js';

test('并列同名次，后面跳号', () => {
  assert.deepEqual(competitionRanks([30, 28, 28, 25]), [1, 2, 2, 4]);
});

test('缺值不参与排名', () => {
  assert.deepEqual(competitionRanks([30, 25, null, undefined]), [1, 2, null, null]);
});

test('非数值按位置', () => {
  assert.deepEqual(competitionRanks(['Adams', 'Adams', 'Brown']), [1, 2, 3]);
});

test('空表', () => {
  assert.deepEqual(competitionRanks([]), []);
});
