import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LIVE_SCHEMA } from '../server/db.mjs';
import {
  scorePick, slateDays, submitLivePicks, livePickRows, settleLive, liveBoard,
} from '../server/livePlay.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(LIVE_SCHEMA); return db; };

// 开赛时间放在真实未来（2099），库里按真实时钟的触发器不碍事；应用层用注入的 now
const T0 = Date.parse('2099-01-02T00:00:00Z');
const game = (id, hours, extra = {}) => ({
  gameId: id, type: 'regular', date: '2099-01-01', dateTimeUtc: new Date(T0 + hours * 3600e3).toISOString(),
  homeId: 1, awayId: 2, ...extra,
});
const GAMES = new Map([
  ['g1', game('g1', 0)],
  ['g2', game('g2', 3)],
  ['pre', game('pre', 5, { type: 'preseason' })],
  ['done', game('done', -30, { homeScore: 100, awayScore: 90 })],
]);
let quoteP = 0.62;
const quote = (g) => ({ pHome: quoteP, homeElo: 1600 + g.homeId, awayElo: 1500 });
const submit = (db, picks, now, player = 'p1') => submitLivePicks(db, player, picks, {
  games: GAMES, quote, dataAt: '2099-01-01T15:00:00.000Z', now,
});

test('计分与回放同口径：(信心 − 50%) × 200，猜错扣同样多；模型按自己的信心计分', () => {
  assert.deepEqual(scorePick({ side: 'home', conf: 0.75 }, 0.4, true),
    { correct: true, points: 50, brier: 0.0625, modelCorrect: false, modelPoints: -20, modelBrier: 0.36 });
  const s = scorePick({ side: 'away', conf: 0.95 }, 0.7, true);
  assert.equal(s.points, -90);
  assert.equal(s.modelPoints, 40);
  near(s.brier, 0.95 ** 2);
});

test('开赛前提交：记下用户选择与此刻模型的赛前预测（概率、所用 Elo、数据快照时间）', () => {
  const db = fresh();
  const now = T0 - 5 * 3600e3;
  const r = submit(db, [{ gameId: 'g1', side: 'home', conf: 0.75 }], now);
  assert.deepEqual(r, { saved: 1, rejected: [] });
  const [row] = livePickRows(db, 'p1');
  assert.equal(row.side, 'home');
  assert.equal(row.conf, 0.75);
  assert.equal(row.model_p_home, 0.62);
  assert.equal(row.home_elo, 1601);
  assert.equal(row.away_elo, 1500);
  assert.equal(row.data_at, '2099-01-01T15:00:00.000Z');
  assert.equal(row.created_at, new Date(now).toISOString());
  assert.equal(row.tipoff_utc, new Date(T0).toISOString());
});

test('开赛前可以改：选择与模型快照一起更新到改的那一刻，首次提交时间不变', () => {
  const db = fresh();
  submit(db, [{ gameId: 'g1', side: 'home', conf: 0.75 }], T0 - 5 * 3600e3);
  quoteP = 0.55;
  const r = submit(db, [{ gameId: 'g1', side: 'away', conf: 0.55 }], T0 - 3600e3);
  quoteP = 0.62;
  assert.equal(r.saved, 1);
  const [row] = livePickRows(db, 'p1');
  assert.equal(row.side, 'away');
  assert.equal(row.model_p_home, 0.55);
  assert.equal(row.edits, 1);
  assert.equal(row.created_at, new Date(T0 - 5 * 3600e3).toISOString());
  assert.equal(row.updated_at, new Date(T0 - 3600e3).toISOString());
});

test('开赛即锁：到点后新提交和修改一律拒绝（服务端时钟，可注入），原记录不变', () => {
  const db = fresh();
  submit(db, [{ gameId: 'g1', side: 'home', conf: 0.75 }], T0 - 3600e3);
  const r = submit(db, [
    { gameId: 'g1', side: 'away', conf: 0.95 },   // 恰好开赛那一刻也算锁
    { gameId: 'g2', side: 'home', conf: 0.65 },   // 还没开赛，照收
  ], T0);
  assert.equal(r.saved, 1);
  assert.deepEqual(r.rejected, [{ gameId: 'g1', reason: 'locked' }]);
  const rows = livePickRows(db, 'p1');
  assert.equal(rows.find((x) => x.game_id === 'g1').side, 'home');
  assert.equal(rows.find((x) => x.game_id === 'g1').conf, 0.75);
  assert.equal(submit(db, [{ gameId: 'g2', side: 'away', conf: 0.65 }], T0 + 3 * 3600e3 + 1).rejected[0].reason, 'locked');
});

test('只收本季正赛未开打的比赛；信心夹在 50%–95%；方向只认 home/away', () => {
  const db = fresh();
  const r = submit(db, [
    { gameId: 'nope', side: 'home', conf: 0.7 },
    { gameId: 'pre', side: 'home', conf: 0.7 },
    { gameId: 'done', side: 'home', conf: 0.7 },
    { gameId: 'g1', side: 'draw', conf: 0.7 },
    { gameId: 'g2', side: 'away', conf: 3 },
  ], T0 - 3600e3);
  assert.deepEqual(r.rejected.map((x) => [x.gameId, x.reason]),
    [['nope', 'unknown'], ['pre', 'unknown'], ['done', 'locked'], ['g1', 'side']]);
  assert.equal(livePickRows(db, 'p1')[0].conf, 0.95);
});

test('库里也锁：不能删；已开赛的行改不了（按真实时钟）；首次提交时间、开赛时间改不了', () => {
  const db = fresh();
  submit(db, [{ gameId: 'g1', side: 'home', conf: 0.75 }], T0 - 3600e3);
  assert.throws(() => db.exec("DELETE FROM live_picks WHERE game_id = 'g1'"), /不能删除/);
  assert.throws(() => db.exec("UPDATE live_picks SET created_at = 'x'"), /开赛后不能改/);
  assert.throws(() => db.exec("UPDATE live_picks SET tipoff_utc = '2100-01-01T00:00:00.000Z'"), /开赛后不能改/);
  db.exec(`INSERT INTO live_picks (player_id, game_id, game_date, tipoff_utc, home_id, away_id, side, conf, model_p_home,
    created_at, updated_at) VALUES ('p1', 'old', '2020-01-01', '2020-01-02T00:00:00.000Z', 1, 2, 'home', 0.6, 0.5, 'a', 'a')`);
  assert.throws(() => db.exec("UPDATE live_picks SET side = 'away' WHERE game_id = 'old'"), /开赛后不能改/);
  db.exec(`INSERT OR REPLACE INTO live_picks (player_id, game_id, game_date, tipoff_utc, home_id, away_id, side, conf, model_p_home,
    created_at, updated_at) VALUES ('p1', 'old', '2020-01-01', '2020-01-02T00:00:00.000Z', 1, 2, 'away', 0.95, 0.5, 'b', 'b')`);
  assert.equal(livePickRows(db, 'p1').find((x) => x.game_id === 'old').side, 'home', 'INSERT OR REPLACE 也绕不过去');
});

test('结算：有比分才翻牌；模型按提交时的快照计分，不用后来的评级', () => {
  const db = fresh();
  submit(db, [{ gameId: 'g1', side: 'away', conf: 0.85 }, { gameId: 'g2', side: 'home', conf: 0.65 }], T0 - 3600e3);
  const later = new Map(GAMES);
  later.set('g1', { ...GAMES.get('g1'), homeScore: 99, awayScore: 104 });
  const rows = settleLive(livePickRows(db, 'p1'), later);
  const g1 = rows.find((r) => r.gameId === 'g1');
  assert.deepEqual(g1.result, { homeScore: 99, awayScore: 104, homeWin: false });
  assert.equal(g1.correct, true);
  assert.equal(g1.points, 70);
  assert.equal(g1.modelProb, 0.62, '快照里的模型概率');
  assert.equal(g1.modelCorrect, false);
  assert.equal(g1.modelPoints, -24);
  const g2 = rows.find((r) => r.gameId === 'g2');
  assert.equal(g2.result, null);
  assert.equal(g2.modelProb, undefined, '没结果前不透露模型的选择');
  assert.equal(g2.points, undefined);
});

test('本季实战排行：只算已结算的，按积分排序，至少 min 场', () => {
  const db = fresh();
  submit(db, [{ gameId: 'g1', side: 'away', conf: 0.85 }, { gameId: 'g2', side: 'home', conf: 0.65 }], T0 - 3600e3, 'a');
  submit(db, [{ gameId: 'g1', side: 'home', conf: 0.95 }], T0 - 3600e3, 'b');
  const done = new Map(GAMES);
  done.set('g1', { ...GAMES.get('g1'), homeScore: 99, awayScore: 104 });
  const names = new Map([['a', '甲'], ['b', '乙']]);
  const rows = livePickRows(db).map((r) => ({ ...r, name: names.get(r.player_id) }));
  const board = liveBoard(rows, done, { min: 1 });
  assert.deepEqual(board.map((r) => [r.id, r.name, r.n, r.points]), [['a', '甲', 1, 70], ['b', '乙', 1, -90]]);
  assert.equal(board[0].model_points, -24);
  assert.equal(board[0].correct, 1);
  assert.deepEqual(liveBoard(rows, done, { min: 2 }), []);
});

test('比赛日：最早一个还有未开赛比赛的美东日期在前，当天已开赛的标锁定', () => {
  const sched = [
    game('a', -40, { date: '2098-12-31', homeScore: 1, awayScore: 2 }),
    game('b', -1, { date: '2099-01-01' }),
    game('c', 2, { date: '2099-01-01' }),
    game('d', 26, { date: '2099-01-02' }),
    game('p', 30, { date: '2099-01-02', type: 'preseason' }),
  ];
  const days = slateDays(sched, T0);
  assert.deepEqual(days.map((d) => [d.date, d.games, d.open]), [['2099-01-01', 2, 1], ['2099-01-02', 1, 1]]);
  assert.equal(days[0].nextTipoff, new Date(T0 + 2 * 3600e3).toISOString());
});
