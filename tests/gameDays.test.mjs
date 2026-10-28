import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gameDay, gameDates, gamesOn, fetchRangeFor, groupByDay, nextGameDay,
} from '../web/src/lib/gameDays.js';
import zhLoc from '../web/src/i18n/locales/zh.js';
import enLoc from '../web/src/i18n/locales/en.js';
import { createFormat, tzDateOf } from '../web/src/i18n/fmt.js';

const ET = 'America/New_York';
const BJ = 'Asia/Shanghai';
const g = (id, utc, date, extra = {}) => ({ gameId: id, type: 'regular', dateTimeUtc: utc, date, ...extra });
const games = [
  g('a', '2026-10-28T23:30:00Z', '2026-10-28'),
  g('b', '2026-10-29T02:00:00Z', '2026-10-28'),
  g('c', '2026-10-29T16:00:00Z', '2026-10-29'),
];
const shape = (r) => r.map(([d, l]) => [d, l.map((x) => x.gameId)]);

test('同一批比赛：美东与北京分到不同的天', () => {
  assert.deepEqual(shape(groupByDay(games, ET)), [['2026-10-28', ['a', 'b']], ['2026-10-29', ['c']]]);
  assert.deepEqual(shape(groupByDay(games, BJ)), [['2026-10-29', ['a', 'b']], ['2026-10-30', ['c']]]);
});

test('gamesOn 只用所选时区的日期，按开打时间升序', () => {
  assert.deepEqual(gamesOn(games, '2026-10-29', BJ).map((x) => x.gameId), ['a', 'b']);
  assert.deepEqual(gamesOn(games, '2026-10-29', ET).map((x) => x.gameId), ['c']);
  assert.deepEqual(gamesOn([games[1], games[0]], '2026-10-29', BJ).map((x) => x.gameId), ['a', 'b']);
});

test('fetchRangeFor 覆盖前后各一天', () => {
  assert.deepEqual(fetchRangeFor('2026-11-01'), { from: '2026-10-31', to: '2026-11-02' });
});

test('任一时区的某天都落在 fetchRangeFor 的美东三天内', () => {
  for (const tz of [ET, BJ]) {
    for (const x of games) {
      const day = tzDateOf(x.dateTimeUtc, tz);
      const { from, to } = fetchRangeFor(day);
      assert.ok(x.date >= from && x.date <= to, `${tz} ${x.gameId}`);
    }
  }
});

test('没有 dateTimeUtc 的比赛按 g.date 分组', () => {
  assert.equal(gameDay({ date: '2026-12-25' }, BJ), '2026-12-25');
  assert.equal(gameDay({ dateTimeUtc: 'bad', date: '2026-12-25' }, ET), '2026-12-25');
});

test('gameDates 去重升序并跳过季前赛', () => {
  const pre = g('p', '2026-10-01T23:00:00Z', '2026-10-01', { type: 'preseason' });
  assert.deepEqual(gameDates([games[2], pre, ...games], ET), ['2026-10-28', '2026-10-29']);
  // groupByDay 不过滤类型：赛程页可以单看季前赛
  assert.deepEqual(groupByDay([pre, ...games], ET).map(([d]) => d), ['2026-10-01', '2026-10-28', '2026-10-29']);
});

test('夏令时结束周（2026-11-01）：美东分日与开打时间不差一小时、不差一天', () => {
  // 美东 11-01 02:00 EDT 回拨到 01:00 EST；凌晨 06:00Z 为界
  const dst = [
    g('d1', '2026-10-31T23:30:00Z', '2026-10-31'), // EDT 19:30
    g('d2', '2026-11-01T05:30:00Z', '2026-11-01'), // EDT 01:30（第一个 1:30）
    g('d3', '2026-11-01T06:30:00Z', '2026-11-01'), // EST 01:30（第二个 1:30）
    g('d4', '2026-11-01T23:30:00Z', '2026-11-01'), // EST 18:30
    g('d5', '2026-11-02T04:30:00Z', '2026-11-01'), // EST 23:30，仍是 11-01（按 -4 会错成 11-02）
    g('d6', '2026-11-02T05:30:00Z', '2026-11-02'), // EST 00:30
  ];
  assert.deepEqual(shape(groupByDay(dst, ET)), [
    ['2026-10-31', ['d1']], ['2026-11-01', ['d2', 'd3', 'd4', 'd5']], ['2026-11-02', ['d6']],
  ]);
  const fmt = createFormat({ locale: enLoc, fallback: zhLoc, tz: ET });
  assert.equal(fmt.time('2026-10-31T23:30:00Z'), '19:30');
  assert.equal(fmt.time('2026-11-01T23:30:00Z'), '18:30');
  assert.equal(fmt.timeZoned('2026-11-01T23:30:00Z'), '6:30 PM ET');
  assert.equal(fmt.time('2026-11-02T04:30:00Z'), '23:30');
  // 北京无夏令时：同一批比赛的北京日期恒为 UTC+8
  assert.deepEqual(groupByDay(dst, BJ).map(([d]) => d), ['2026-11-01', '2026-11-02']);
});

test('nextGameDay：未出比分、非季前赛、不早于所选时区今天的最早一天', () => {
  const list = [
    g('x', '2026-10-27T23:00:00Z', '2026-10-27', { homeScore: 100 }),
    g('p', '2026-10-28T23:00:00Z', '2026-10-28', { type: 'preseason' }),
    g('y', '2026-10-29T23:00:00Z', '2026-10-29'),
    g('z', '2026-10-30T23:00:00Z', '2026-10-30'),
  ];
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(nextGameDay(list, ET, now), '2026-10-29');
  assert.equal(nextGameDay(list, BJ, now), '2026-10-30');
  assert.equal(nextGameDay([], ET, now), null);
  // 北京已是 10-30 时，y（北京 10-30 07:00）仍在今天
  assert.equal(nextGameDay(list, BJ, Date.parse('2026-10-29T17:00:00Z')), '2026-10-30');
});

test('R16：team 格式化器有 teamById 时英文 full、中文 cn，未知 id 为破折号', () => {
  const teams = [{ teamId: 1, abbr: 'OKC', cn: '俄克拉荷马城雷霆', full: 'Oklahoma City Thunder' }];
  const teamById = new Map(teams.map((x) => [x.teamId, x]));
  const en = createFormat({ locale: enLoc, fallback: zhLoc, tz: ET, teamById });
  const zh = createFormat({ locale: zhLoc, fallback: zhLoc, tz: BJ, teamById });
  assert.equal(en.formatters.team(1), 'Oklahoma City Thunder');
  assert.equal(zh.formatters.team(1), '俄克拉荷马城雷霆');
  assert.equal(en.formatters.team(999), '—');
  assert.equal(zh.formatters.team(999), '—');
  assert.equal(createFormat({ locale: enLoc, fallback: zhLoc, tz: ET }).formatters.team(1), '—');
});
