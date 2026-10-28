import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectPrice, compactBooks, BOOK_PRIORITY } from '../server/priceSelect.mjs';
import { auditSeason } from '../server/dataIntegrity.mjs';

test('选择链：先按博彩公司优先级取一家，再在这家里取时点（close > current）', () => {
  const books = { draftkings: { open: null, close: null, current: [-120, 100] }, espnbet: { open: null, close: [-130, 110], current: [-130, 110] } };
  const p = selectPrice(books, 'close', {});
  assert.deepEqual([p.books, p.priceAt, p.ml, p.flags], [['draftkings', 'draftkings'], 'current', [-120, 100], ['currentAsClose']]);
});
test('开盘情景：链上第一家有 open 的；CLV 用同一家的 close', () => {
  const books = { draftkings: { open: null, close: [-120, 100], current: null }, espnbet: { open: [-140, 120], close: [-130, 110], current: null } };
  const p = selectPrice(books, 'open', {});
  assert.deepEqual([p.books[0], p.priceAt, p.ml, p.closeMl], ['espnbet', 'open', [-140, 120], [-130, 110]]);
});
test('开盘情景：该家没有 close 时打 noCloseForClv，closeMl 为 null', () => {
  const p = selectPrice({ draftkings: { open: [-140, 120], close: null, current: null } }, 'open', {});
  assert.deepEqual([p.closeMl, p.flags], [null, ['noCloseForClv']]);
});
test('异常价顺延到下一家并打标记；全链都没有返回缺失原因', () => {
  const books = { draftkings: { open: null, close: [150, 130], current: null }, betmgm: { open: null, close: [-115, -105], current: null } };
  const p = selectPrice(books, 'close', {});
  assert.equal(p.books[0], 'betmgm'); assert.ok(p.flags.includes('skippedAnomaly'));
  assert.deepEqual(selectPrice({}, 'close', {}), { missing: 'noUsBook' });
  assert.deepEqual(selectPrice({ draftkings: { open: null, close: [-110, -110], current: null } }, 'open', {}), { missing: 'noOpen' });
  assert.deepEqual(selectPrice({ draftkings: { open: null, close: [-110, -110], current: null } }, 'close', { book: 'betmgm' }), { missing: 'bookAbsent' });
  assert.deepEqual(selectPrice({ draftkings: { open: null, close: [150, 130], current: null } }, 'close', {}), { missing: 'anomaly' });
  assert.deepEqual(selectPrice({ draftkings: { open: null, close: null, current: null } }, 'close', {}), { missing: 'noPrice' });
});
test('链顺序：优先级里的先、其余美国公司字母序补在后面；指定单家只用那一家', () => {
  assert.deepEqual(BOOK_PRIORITY, ['draftkings', 'espnbet', 'betmgm', 'caesars', 'betrivers', 'unibet', 'pointsbet', 'westgate']);
  const px = [-110, -110];
  const books = { westgate: { open: null, close: px, current: null }, caesars: { open: null, close: px, current: null }, zzz: { open: null, close: px, current: null } };
  assert.equal(selectPrice(books, 'close', {}).books[0], 'caesars');
  assert.equal(selectPrice({ ...books, aaa: { open: null, close: px, current: null }, caesars: undefined }, 'close', { book: 'zzz' }).books[0], 'zzz');
});
test('挑最优价：每方取美国公司里赔付最高的价，单独标注', () => {
  const books = { draftkings: { open: null, close: [-120, 100], current: null }, espnbet: { open: null, close: [-125, 110], current: null } };
  const p = selectPrice(books, 'close', { book: 'best' });
  assert.deepEqual([p.ml, p.books, p.flags], [[-120, 110], ['draftkings', 'espnbet'], ['bestPrice']]);
  assert.equal(p.closeMl, null);
});
test('挑最优价：异常价不参与，且打 skippedAnomaly', () => {
  const books = { draftkings: { open: null, close: [-120, 100], current: null }, espnbet: { open: null, close: [-9000, 2500], current: null } };
  const p = selectPrice(books, 'close', { book: 'best' });
  assert.deepEqual([p.ml, p.books, p.flags], [[-120, 100], ['draftkings', 'draftkings'], ['bestPrice', 'skippedAnomaly']]);
});
test('compactBooks：Betfair 不进；ESPN 主客与我们相反时三个时点都翻转；球队对不上返回 null', () => {
  const items = [
    { id: '50', name: 'Betfair', spread: -3, open: [-150, 130], close: [-150, 130], current: null },
    { id: '40', name: 'Draft Kings', spread: -3, open: [-150, 130], close: [-160, 140], current: [-160, 140] },
  ];
  assert.deepEqual(Object.keys(compactBooks({ home: 1, items }, 1, 2).books), ['draftkings']);
  const f = compactBooks({ home: 2, items }, 1, 2);
  assert.deepEqual([f.flipped, f.books.draftkings.open, f.books.draftkings.close, f.books.draftkings.current], [true, [130, -150], [140, -160], [140, -160]]);
  assert.equal(compactBooks({ home: 9, items }, 1, 2), null);
  assert.equal(compactBooks(undefined, 1, 2), null);
});

// ---- 真实数据回归（tests/fixtures/books/real-anomalies.json，Task 2 审计固定下来的异常）----
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/books/real-anomalies.json', import.meta.url)));
const rec = (id) => fx.records.find((r) => r.gameId === id);
const pick = (id, scenario, opts = {}) => {
  const r = rec(id);
  const b = compactBooks(fx.cache[id], r.homeId, r.awayId);
  return selectPrice(b.books, scenario, opts);
};
test('真实：翻转场次（0022400633）钱线对调后再选价，开盘 / 收盘都是 ESPN BET', () => {
  // ESPN 主队 = 我们的客队：缓存 open [105,-125] / close [125,-145] -> 对调
  assert.equal(compactBooks(fx.cache['0022400633'], rec('0022400633').homeId, rec('0022400633').awayId).flipped, true);
  const o = pick('0022400633', 'open');
  assert.deepEqual([o.books[0], o.ml, o.closeMl], ['espnbet', [-125, 105], [-145, 125]]);
  assert.deepEqual(pick('0022400633', 'close').ml, [-145, 125]);
  // 未翻转场次对照
  assert.equal(compactBooks(fx.cache['0022500001'], rec('0022500001').homeId, rec('0022500001').awayId).flipped, false);
  assert.deepEqual(pick('0022500001', 'close').ml, [-240, 200]);
});
test('真实：DK 开盘 [-305,-305] 过高抽水 -> 开盘情景缺失（该场只有 DK），收盘情景正常', () => {
  assert.deepEqual(pick('0022500325', 'open'), { missing: 'anomaly' });
  assert.deepEqual(pick('0022500325', 'close').ml, [250, -310]);
});
test('真实：滚球价（DK close/current ±9000）被拒；开盘价正常可用，但无合格 close -> noCloseForClv', () => {
  assert.deepEqual(pick('0022501139', 'close'), { missing: 'anomaly' });
  const o = pick('0022501139', 'open');
  assert.deepEqual([o.ml, o.closeMl, o.flags], [[-4500, 1700], null, ['noCloseForClv']]);
});
test('真实：2022-23 没有 open；BetMGM current 低抽水价顺延，链上先取 DK current（收盘情景标 currentAsClose）', () => {
  assert.deepEqual(pick('0022200683', 'open'), { missing: 'noOpen' });
  const c = pick('0022200683', 'close');
  assert.deepEqual([c.books[0], c.priceAt, c.ml, c.flags], ['draftkings', 'current', [-110, -110], ['currentAsClose']]);
  // 指定 BetMGM：current [110,-105] 是低抽水异常
  assert.deepEqual(pick('0022200683', 'close', { book: 'betmgm' }), { missing: 'anomaly' });
  // 最优价里 BetMGM 的异常价不参与
  const best = pick('0022200683', 'close', { book: 'best' });
  assert.ok(best.flags.includes('skippedAnomaly'));
  // BetRivers 主 -105、PointsBet 客 -105 各自最高；BetMGM 的主 +110 异常价不参与
  assert.deepEqual([best.ml, best.books], [[-105, -105], ['betrivers', 'pointsbet']]);
});
test('真实：审计与选价链共用 homeAwayStatus，翻转场数一致', () => {
  const a = auditSeason({ season: 'real', records: fx.records, cache: fx.cache });
  const n = fx.records.filter((r) => compactBooks(fx.cache[r.gameId], r.homeId, r.awayId)?.flipped).length;
  assert.equal(n, a.flipped);
});
