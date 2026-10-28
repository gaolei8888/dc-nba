import test from 'node:test';
import assert from 'node:assert/strict';
import { ANOMALY, priceAnomaly, homeAwayStatus, auditSeason } from '../server/dataIntegrity.mjs';

test('priceAnomaly：正常价、滚球价、非法美式、过低 / 过高抽水', () => {
  assert.equal(priceAnomaly([-110, -110]), null);
  assert.equal(priceAnomaly([-150, 130]), null);
  assert.equal(priceAnomaly(null), 'missing');
  assert.equal(priceAnomaly([50, -110]), 'invalidAmerican');      // |A| < 100
  assert.equal(priceAnomaly([null, -110]), 'invalidAmerican');
  assert.equal(priceAnomaly([-100000, 5000]), 'liveLike');        // |A| > 5000
  assert.equal(priceAnomaly([150, 130]), 'overroundLow');         // 两边都正：隐含概率和 < 1
  assert.equal(priceAnomaly([-1000, -1000]), 'overroundHigh');    // 和 > 1.15
  assert.deepEqual(ANOMALY, { maxAbs: 5000, overroundLo: 1.0, overroundHi: 1.15 });
});

test('homeAwayStatus：共享的主客判定', () => {
  const r = { homeId: 1, awayId: 2 };
  assert.equal(homeAwayStatus(r, { home: 1 }), 'ok');
  assert.equal(homeAwayStatus(r, { home: 2 }), 'flipped');
  assert.equal(homeAwayStatus(r, { home: 9 }), 'teamMismatch');
  assert.equal(homeAwayStatus(r, undefined), 'unmatched');
});

const item = (id, ml, extra = {}) => ({ id, name: 'x', spread: -3, open: ml, close: ml, current: ml, ...extra });
const rec = (gameId, homeId, awayId, extra = {}) => ({ gameId, homeId, awayId, homeWin: true, actual: 5, ...extra });

test('auditSeason：主客翻转计数、球队对不上、重复 gameId / eventId、结算错误、覆盖率与缺失', () => {
  const records = [
    rec('g1', 1, 2),
    rec('g2', 3, 4),                                  // ESPN home = 4：翻转
    rec('g3', 5, 6),                                  // ESPN home = 9：对不上
    rec('g4', 7, 8, { homeWin: true, actual: -3 }),   // 结算错误
    rec('g1', 1, 2),                                  // 重复 gameId
  ];
  const cache = {
    g1: { eventId: 'e1', home: 1, items: [item('40', [-150, 130]), item('58', [-140, 120], { open: null })] },
    g2: { eventId: 'e1', home: 4, items: [item('40', [-110, -110])] },           // 同 eventId
    g3: { eventId: 'e3', home: 9, items: [item('40', [-110, -110])] },
    g4: { eventId: 'e4', home: 7, items: [item('50', [-110, -110])] },           // 只有 Betfair
  };
  const a = auditSeason({ season: '2024-25', records, cache });
  assert.equal(a.games, 5);
  assert.equal(a.fetched, 4);
  assert.equal(a.flipped, 1);
  assert.deepEqual(a.teamMismatch, ['g3']);
  assert.deepEqual(a.duplicateGameIds, ['g1']);
  assert.deepEqual(a.duplicateEventIds, ['e1']);
  assert.deepEqual(a.settlementErrors, ['g4']);
  assert.equal(a.matched, 3);   // g1 g2 g4（g3 对不上；重复的 g1 不重复计）
  assert.equal(a.missing.close, 1);   // g4 只有 Betfair
  assert.equal(a.coverage.draftkings.close, 2);
  assert.equal(a.coverage.draftkings.open, 2);
  assert.equal(a.coverage.espnbet.open, 0);
  assert.equal(a.coverage.espnbet.close, 1);
  assert.equal(a.coverage.betfair, undefined);
  assert.deepEqual(a.anomalies, []);
});

test('auditSeason：异常价进 anomalies，带书、时点与原因', () => {
  const records = [rec('g1', 1, 2)];
  const cache = { g1: { eventId: 'e1', home: 1, items: [
    item('40', [-110, -110], { close: [-100000, 5000] }),
    item('47', [150, 130], { open: null, close: null }),
  ] } };
  const a = auditSeason({ season: 's', records, cache });
  assert.deepEqual(a.anomalies.map((x) => [x.gameId, x.book, x.at, x.reason]), [
    ['g1', 'draftkings', 'close', 'liveLike'],
    ['g1', 'betmgm', 'current', 'overroundLow'],
  ]);
});
