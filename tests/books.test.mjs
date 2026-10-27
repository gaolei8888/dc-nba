import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trimItem, bookOf, cleanItems, priceOf, gameBooks } from '../server/books.mjs';
import { pickBook } from '../server/oddsClient.mjs';

const fx = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/books/${name}.json`, import.meta.url)));
const trimAll = (name) => fx(name).items.map(trimItem).filter(Boolean);

test('trimItem：取三时点两边钱线与顶层让分，缺时点为 null', () => {
  const it = trimAll('2023-24').find((x) => x.id === '47');
  assert.deepEqual(it, {
    id: '47', name: 'MGM', spread: -8.5,
    open: [-275, it.open[1]], close: [-350, 290], current: [-350, 290],
  });
  const dk = trimAll('2023-24').find((x) => x.id === '40');
  assert.equal(dk.open, null, '2023-24 的 DK 没有 open');
  const old = trimAll('2022-23').find((x) => x.id === '40');
  assert.deepEqual([old.close, old.current], [null, [285, -345]]);
});

test('bookOf：DK 新旧 id 合一、Caesars 各州合一、聚合源与 Live Odds 剔除', () => {
  assert.equal(bookOf({ id: '40', name: 'DraftKings' }), 'draftkings');
  assert.equal(bookOf({ id: '100', name: 'Draft Kings' }), 'draftkings');
  for (const id of ['31', '43', '45', '52', '57']) assert.equal(bookOf({ id, name: 'Caesars Sportsbook (X)' }), 'caesars');
  assert.equal(bookOf({ id: '46', name: 'Caesars Sportsbook (New Jersey) - Live Odds' }), null);
  assert.equal(bookOf({ id: '59', name: 'ESPN Bet - Live Odds' }), null);
  for (const [id, name] of [['1001', 'accuscore'], ['1004', 'consensus'], ['1002', 'teamrankings']]) {
    assert.equal(bookOf({ id, name }), null);
  }
  assert.equal(bookOf({ id: '47', name: 'MGM' }), 'betmgm');
  assert.equal(bookOf({ id: '41', name: 'SugarHouse' }), 'betrivers');
});

test('cleanItems：剔除离中位让分 >3 分的离谱线（Caesars +2.5、Unibet +4.5 vs 其余 +8.5）', () => {
  const books = cleanItems(trimAll('2022-23'));
  const ids = books.map((b) => b.book);
  assert.ok(!ids.includes('unibet'), 'Unibet +4.5 离中位 4 分');
  // Caesars 31 离谱（+2.5），但 52/45 正常 → 合并后的 Caesars 用正常那条
  const cz = books.find((b) => b.book === 'caesars');
  assert.equal(cz.spread, 9);
  assert.equal(new Set(ids).size, ids.length, '每家只留一条');
  assert.ok(ids.includes('draftkings') && ids.includes('betfair'));
  assert.ok(!ids.some((b) => b === null));
});

test('priceOf：close 优先于 current，绝不用 open 冒充收盘', () => {
  assert.deepEqual(priceOf({ open: [-200, 170], close: [-150, 130], current: [-160, 140] }), { ml: [-150, 130], at: 'close' });
  assert.deepEqual(priceOf({ open: [-200, 170], close: null, current: [-160, 140] }), { ml: [-160, 140], at: 'current' });
  assert.equal(priceOf({ open: [-200, 170], close: null, current: null }), null);
});

test('gameBooks：每家一个价、去水概率、2026-27 未开赛 DK 只有 current', () => {
  const g = gameBooks(trimAll('2026-27-upcoming'));
  assert.deepEqual(Object.keys(g), ['draftkings']);
  assert.equal(g.draftkings.at, 'current');
  assert.deepEqual(g.draftkings.ml, [-162, 136]);
  const ph = (162 / 262) / (162 / 262 + 100 / 236);
  assert.ok(Math.abs(g.draftkings.pHome - ph) < 1e-12);
  assert.deepEqual(gameBooks([]), {});
});

test('pickBook：旧赛季 DraftKings id 40 也要优先（以前回退成 Betfair）', () => {
  assert.equal(pickBook(fx('2022-23').items).provider.id, '40');
  assert.equal(pickBook(fx('2026-27-final').items).provider.id, '100');
  assert.equal(pickBook(fx('2024-25').items).provider.id, '58');
});
