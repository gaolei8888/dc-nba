import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LEDGER_SCHEMA } from '../server/db.mjs';
import {
  captureRows, insertBets, settleBets, unsettled, ledgerRows, ledgerReport, RULES,
} from '../server/ledger.mjs';
import { devigHomeProb } from '../server/oddsClient.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(LEDGER_SCHEMA); return db; };

const NOW = Date.parse('2026-10-28T14:00:00Z');   // 北京 22:00
const slateGame = (id, pHome, hours, odds = { provider: 'Draft Kings', homeMl: -150, awayMl: 130, homeMlOpen: -140, awayMlOpen: 120, eventId: `e${id}` }) => ({
  gameId: id, date: '2026-10-28', tipoff: new Date(NOW + hours * 3600e3).toISOString(),
  homeId: 1, awayId: 2, pHome, homeElo: 1600, awayElo: 1500, odds,
});

test('captureRows：每场按三条预注册规则各记一行，edge 与方向来自 DK 去水概率', () => {
  const rows = captureRows([slateGame('g1', 0.66, 10)], { now: NOW });
  assert.deepEqual(rows.map((r) => r.rule), RULES.map((r) => r.rule));
  const pBook = devigHomeProb(-150, 130);
  for (const r of rows) {
    assert.equal(r.book, 'draftkings');
    assert.equal(r.price_at, 'current', 'scoreboard 上赛前价标着 close，其实是抓取时的 current');
    near(r.book_p_home, pBook);
    near(r.edge, 0.66 - pBook);
  }
  const e3 = rows.find((r) => r.rule === 'edge3');
  assert.equal(e3.bet, 1); assert.equal(e3.side, 'home'); assert.equal(e3.bet_ml, -150);
  assert.equal(rows.find((r) => r.rule === 'edge6').bet, pBook + 0.06 <= 0.66 ? 1 : 0);
});

test('captureRows：已开赛、超出时间窗、非 DK、缺钱线的都不记', () => {
  const rows = captureRows([
    slateGame('started', 0.7, -0.5),
    slateGame('far', 0.7, 20),
    slateGame('espnbet', 0.7, 10, { provider: 'ESPN BET', homeMl: -150, awayMl: 130 }),
    slateGame('noml', 0.7, 10, { provider: 'Draft Kings', homeMl: null, awayMl: 130 }),
  ], { now: NOW });
  assert.equal(rows.length, 0);
});

test('账本只追加：重复插入（含 INSERT OR REPLACE）被忽略，不改已有价格与选择', () => {
  const db = fresh();
  assert.equal(insertBets(db, captureRows([slateGame('g1', 0.66, 10)], { now: NOW })), 3);
  const later = captureRows([slateGame('g1', 0.40, 9, { provider: 'Draft Kings', homeMl: -300, awayMl: 250 })], { now: NOW + 3600e3 });
  assert.equal(insertBets(db, later), 0);
  const r = ledgerRows(db).find((x) => x.rule === 'edge3');
  assert.equal(r.home_ml, -150);
  assert.equal(r.side, 'home');
  db.prepare("INSERT OR REPLACE INTO paper_bets (game_id, rule, book, captured_at, game_date, home_id, away_id, model_p_home, home_ml, away_ml, price_at, book_p_home, edge, threshold, bet) VALUES ('g1','edge3','draftkings','x','2026-10-28',1,2,0.1,100,-120,'current',0.4,-0.3,0.03,0)").run();
  assert.equal(ledgerRows(db).find((x) => x.rule === 'edge3').home_ml, -150, 'REPLACE 也改不了');
  assert.equal(ledgerRows(db).length, 3);
});

test('账本不可删除、记录字段不可改', () => {
  const db = fresh();
  insertBets(db, captureRows([slateGame('g1', 0.66, 10)], { now: NOW }));
  assert.throws(() => db.exec("DELETE FROM paper_bets WHERE game_id = 'g1'"), /只追加/);
  assert.throws(() => db.exec("UPDATE paper_bets SET home_ml = 999 WHERE game_id = 'g1'"), /只追加/);
  assert.throws(() => db.exec("UPDATE paper_bets SET side = 'away' WHERE game_id = 'g1'"), /只追加/);
  assert.equal(ledgerRows(db).length, 3);
});

test('结算只写结算字段，且只写一次；收盘价可以晚到补上，也只写一次', () => {
  const db = fresh();
  insertBets(db, captureRows([slateGame('g1', 0.66, 10), slateGame('g2', 0.30, 10)], { now: NOW }));
  assert.deepEqual(unsettled(db).map((u) => u.game_id).sort(), ['g1', 'g2']);
  const at = '2026-10-29T06:30:00Z';
  // g1 主队赢；g2 收盘价暂时拿不到
  const n = settleBets(db, { g1: { homeScore: 110, awayScore: 100, close: [-170, 145] }, g2: { homeScore: 99, awayScore: 101, close: null } }, at);
  assert.equal(n, 6);
  const r1 = ledgerRows(db).find((x) => x.game_id === 'g1' && x.rule === 'edge3');
  assert.equal(r1.won, 1);
  near(r1.profit, 100 / 150);
  assert.equal(r1.close_home_ml, -170);
  assert.ok(r1.clv > 0, '收盘往我们押的主队走');
  const r2 = ledgerRows(db).find((x) => x.game_id === 'g2' && x.rule === 'edge3');
  assert.equal(r2.side, 'away'); assert.equal(r2.won, 1); near(r2.profit, 1.3);
  assert.equal(r2.close_home_ml, null);
  const noBet = ledgerRows(db).find((x) => x.game_id === 'g1' && x.rule === 'edge6');
  if (!noBet.bet) assert.equal(noBet.profit, null, '没下注的行不记盈亏');

  // 第二次结算：比分不能被覆盖，g2 的收盘价补上
  settleBets(db, { g1: { homeScore: 0, awayScore: 200, close: [500, -900] }, g2: { homeScore: 99, awayScore: 101, close: [120, -140] } }, 'later');
  const again = ledgerRows(db).find((x) => x.game_id === 'g1' && x.rule === 'edge3');
  assert.equal(again.home_score, 110);
  assert.equal(again.close_home_ml, -170);
  assert.equal(again.settled_at, at);
  assert.equal(ledgerRows(db).find((x) => x.game_id === 'g2' && x.rule === 'edge3').close_home_ml, 120);
  assert.equal(unsettled(db).length, 0);
  assert.throws(() => db.exec("UPDATE paper_bets SET profit = 5 WHERE game_id = 'g1'"), /只追加/);
});

test('ledgerReport：按规则汇总已结算注单，今晚列表只含未结算的已下注行', () => {
  const db = fresh();
  insertBets(db, captureRows([slateGame('g1', 0.66, 10), slateGame('g2', 0.30, 10)], { now: NOW }));
  settleBets(db, { g1: { homeScore: 110, awayScore: 100, close: null } }, 'x');
  const rep = ledgerReport(ledgerRows(db), { B: 100 });
  const e3 = rep.rules.find((r) => r.rule === 'edge3');
  assert.equal(e3.bets, 1);
  assert.equal(e3.pending, 1);
  assert.deepEqual(rep.open.map((r) => r.game_id), ['g2']);
  assert.equal(rep.captured, 2);
});
