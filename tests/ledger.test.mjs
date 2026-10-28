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
  assert.deepEqual(rows.map((r) => r.rule), RULES.filter((r) => !r.late).map((r) => r.rule));
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

test('结算前也不能偷偷填/改结果：比分与盈亏只能和 settled_at 一起写；收盘价只能和 close_home_ml 一起写', () => {
  const db = fresh();
  insertBets(db, captureRows([slateGame('g1', 0.66, 10)], { now: NOW }));
  assert.throws(() => db.exec("UPDATE paper_bets SET home_score = 1, won = 1, profit = 99 WHERE game_id = 'g1'"), /只追加/);
  assert.throws(() => db.exec("UPDATE paper_bets SET clv = 0.7, close_away_ml = 100 WHERE game_id = 'g1'"), /只追加/);
  assert.equal(ledgerRows(db).every((r) => r.profit == null && r.clv == null), true);
});

test('captureRows 记下赔率快照时间；ledgerReport 的今晚列表不含已过开赛 12 小时以上的旧单', () => {
  const rows = captureRows([slateGame('g1', 0.66, 10)], { now: NOW, oddsFetchedAt: '2026-10-28T13:55:00Z' });
  assert.equal(rows[0].odds_fetched_at, '2026-10-28T13:55:00Z');
  const db = fresh();
  insertBets(db, rows);
  assert.equal(ledgerReport(ledgerRows(db), { B: 50, now: NOW }).open.length, 1);
  assert.equal(ledgerReport(ledgerRows(db), { B: 50, now: NOW + 30 * 3600e3 }).open.length, 0, '延期/漏结算的旧单不算今晚');
});

// ---- 临近开赛规则 edge3-late（北京 06:30 那次 --late 运行记录）
const LATE_NOW = Date.parse('2026-10-28T22:30:00Z');   // 北京 06:30
const lateGame = (id, pHome, hours, odds) => ({ ...slateGame(id, pHome, 0, odds), tipoff: new Date(LATE_NOW + hours * 3600e3).toISOString() });
const FRESH = new Date(LATE_NOW - 10 * 60e3).toISOString();

test('按运行身份选规则：默认（早）只记 edge0/3/6，--late 只记 edge3-late', () => {
  const early = captureRows([slateGame('g1', 0.66, 10)], { now: NOW });
  assert.deepEqual(early.map((r) => r.rule), ['edge0', 'edge3', 'edge6']);
  const late = captureRows([lateGame('g1', 0.66, 2)], { now: LATE_NOW, run: 'late', oddsFetchedAt: FRESH });
  assert.deepEqual(late.map((r) => r.rule), ['edge3-late']);
  assert.equal(late[0].threshold, 0.03);
  assert.equal(late[0].odds_fetched_at, FRESH, '记下赔率快照时间');
  assert.throws(() => captureRows([], { run: 'noon' }), /run/);
});

test('--late：已开赛的不记；赔率快照不新（> 2 小时）或晚于开赛的不记；超出 8 小时窗口的不记', () => {
  const games = [lateGame('started', 0.7, -0.1), lateGame('ok', 0.7, 0.5), lateGame('far', 0.7, 9)];
  assert.deepEqual(captureRows(games, { now: LATE_NOW, run: 'late', oddsFetchedAt: FRESH }).map((r) => r.game_id), ['ok']);
  const stale = new Date(LATE_NOW - 8.5 * 3600e3).toISOString();   // 前一晚 22:00 的快照（刷新失败时）
  assert.equal(captureRows(games, { now: LATE_NOW, run: 'late', oddsFetchedAt: stale }).length, 0);
  assert.equal(captureRows(games, { now: LATE_NOW, run: 'late', oddsFetchedAt: null }).length, 0, '不知道快照时间就不算临近收盘');
  assert.equal(captureRows(games, { now: LATE_NOW, run: 'late', oddsFetchedAt: new Date(LATE_NOW + 60e3).toISOString() }).length, 0, '快照时间在未来（时钟错）不认');
  const afterTip = new Date(LATE_NOW + 3600e3).toISOString();
  assert.equal(captureRows([lateGame('g', 0.7, 0.5)], { now: LATE_NOW + 3600e3 - 1, run: 'late', oddsFetchedAt: afterTip }).length, 0, '开赛后的价是滚球价');
});

test('同一场早晚两条规则并存；各自只追加、不可改', () => {
  const db = fresh();
  assert.equal(insertBets(db, captureRows([slateGame('g1', 0.66, 10)], { now: NOW })), 3);
  const lateOdds = { provider: 'Draft Kings', homeMl: -170, awayMl: 145, eventId: 'eg1' };
  const late = () => captureRows([{ ...slateGame('g1', 0.66, 0, lateOdds), tipoff: new Date(NOW + 10 * 3600e3).toISOString() }],
    { now: NOW + 8.5 * 3600e3, run: 'late', oddsFetchedAt: new Date(NOW + 8.4 * 3600e3).toISOString() });
  assert.equal(insertBets(db, late()), 1);
  assert.equal(insertBets(db, late()), 0, '再跑一次 --late 被忽略');
  const rows = ledgerRows(db);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((r) => r.rule === 'edge3').home_ml, -150);
  assert.equal(rows.find((r) => r.rule === 'edge3-late').home_ml, -170);
  assert.throws(() => db.exec("UPDATE paper_bets SET home_ml = 1 WHERE rule = 'edge3-late'"), /只追加/);
  assert.throws(() => db.exec("DELETE FROM paper_bets WHERE rule = 'edge3-late'"), /只追加/);

  settleBets(db, { g1: { homeScore: 110, awayScore: 100, close: [-180, 150] } }, 'x');
  const rep = ledgerReport(ledgerRows(db), { B: 50 });
  const e3 = rep.rules.find((r) => r.rule === 'edge3');
  const e3l = rep.rules.find((r) => r.rule === 'edge3-late');
  assert.equal(e3l.late, true);
  assert.equal(e3.bets, 1); assert.equal(e3l.bets, 1);
  near(e3l.profit ?? e3l.units, 100 / 170);
  assert.ok(e3.clv.mean > e3l.clv.mean, '早记的价离收盘更远，CLV 更大');
  assert.equal(rep.captured, 1);
});

test('今晚列表同时列出早、晚两条规则的未结算下注', () => {
  const db = fresh();
  insertBets(db, captureRows([slateGame('g1', 0.66, 10)], { now: NOW }));
  insertBets(db, captureRows([slateGame('g1', 0.66, 10)], { now: NOW + 8 * 3600e3, run: 'late', oddsFetchedAt: new Date(NOW + 7.9 * 3600e3).toISOString() }));
  assert.deepEqual(ledgerReport(ledgerRows(db), { B: 50, now: NOW }).open.map((r) => r.rule).sort(), ['edge3', 'edge3-late']);
});
