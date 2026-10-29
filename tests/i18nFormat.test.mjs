import test from 'node:test';
import assert from 'node:assert/strict';
import zhLoc from '../web/src/i18n/locales/zh.js';
import enLoc from '../web/src/i18n/locales/en.js';
import { createT } from '../web/src/i18n/core.js';
import { createFormat, tzDateOf, tzTimeOf, tzToday, shiftDate, TIMEZONES } from '../web/src/i18n/fmt.js';

const mk = (loc, tz) => createFormat({ locale: loc, fallback: zhLoc, tz });
const zh = mk(zhLoc, 'Asia/Shanghai'); const en = mk(enLoc, 'America/New_York');
const enET = en; const zhBJ = zh; const zhET = mk(zhLoc, 'America/New_York'); const enBJ = mk(enLoc, 'Asia/Shanghai');
const T = '2026-10-28T23:30:00Z';

test('TIMEZONES', () => {
  assert.deepEqual(TIMEZONES, [{ id: 'et', iana: 'America/New_York' }, { id: 'bj', iana: 'Asia/Shanghai' }]);
});
test('tzDateOf / tzTimeOf：美东与北京', () => {
  assert.equal(tzDateOf(T, 'America/New_York'), '2026-10-28'); assert.equal(tzTimeOf(T, 'America/New_York'), '19:30');
  assert.equal(tzDateOf(T, 'Asia/Shanghai'), '2026-10-29'); assert.equal(tzTimeOf(T, 'Asia/Shanghai'), '07:30');
  assert.equal(tzDateOf(null, 'Asia/Shanghai'), null);
  assert.equal(tzTimeOf(null, 'Asia/Shanghai'), '');
});
test('夏令时结束（2026-11-01）前后美东仍是 19:30', () => {
  assert.equal(tzTimeOf('2026-10-31T23:30:00Z', 'America/New_York'), '19:30');
  assert.equal(tzDateOf('2026-11-02T00:30:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(tzTimeOf('2026-11-02T00:30:00Z', 'America/New_York'), '19:30');
});
test('tzToday：同一时刻两地日期不同', () => {
  const now = Date.parse('2026-10-28T16:30:00Z');
  assert.equal(tzToday('Asia/Shanghai', now), '2026-10-29'); assert.equal(tzToday('America/New_York', now), '2026-10-28');
});
test('北京时间结果固定期望值（原 bjDateOf / bjTimeOf 口径）', () => {
  const cases = [
    ['2026-10-28T15:59:00Z', '2026-10-28', '23:59'], ['2026-10-28T16:00:00Z', '2026-10-29', '00:00'],
    ['2026-12-31T16:00:00Z', '2027-01-01', '00:00'], ['2026-03-01T00:00:00Z', '2026-03-01', '08:00'],
    ['2026-10-28T23:30:00Z', '2026-10-29', '07:30'],
  ];
  for (const [u, d, tm] of cases) {
    assert.equal(tzDateOf(u, 'Asia/Shanghai'), d);
    assert.equal(tzTimeOf(u, 'Asia/Shanghai'), tm);
  }
});
test('shiftDate 与旧实现一致', () => {
  assert.equal(shiftDate('2026-10-31', 2), '2026-11-02');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});
test('日期：中文沿用旧格式，英文用 Intl', () => {
  assert.equal(zh.date('2026-10-20'), '10月20日 周二'); assert.equal(en.date('2026-10-20'), 'Tue, Oct 20');
  assert.equal(zh.dateFull('2026-10-20'), '2026年10月20日 周二'); assert.equal(en.dateFull('2026-10-20'), 'Tue, Oct 20, 2026');
  assert.equal(zh.dateMD('2026-10-20'), '10月20日');
  assert.equal(zh.dateShort('2026-10-20'), '10/20'); assert.equal(zh.month(10), '10月'); assert.equal(en.month(10), 'Oct');
  assert.equal(zh.date(''), '');
});
test('开打时间带时区标签', () => {
  assert.equal(enET.timeZoned(T), '7:30 PM ET'); assert.equal(zhBJ.timeZoned(T), '07:30 北京时间');
  assert.equal(zhET.timeZoned(T), '19:30 美东时间'); assert.equal(enBJ.timeZoned(T), '7:30 AM Beijing');
  assert.equal(enET.zoneLabel(), 'ET'); assert.equal(zhBJ.time(T), '07:30');
});
test('数字：中英文输出逐字相同，且与旧 format.js 一致', () => {
  for (const [f, args] of [['num', [1596, 0]], ['num', [-0.1182, 3]], ['pct', [0.4783, 1]], ['pct100', [47.83, 1]], ['signed', [2.345, 1]], ['signed', [-2.345, 1]], ['rate', [0.478, 1]], ['num', [null]]])
    assert.equal(zh[f](...args), en[f](...args));
  assert.equal(en.num(1596, 0), '1596'); assert.equal(en.pct(0.4783, 1), '47.8%');
  assert.equal(en.signed(2.345, 1), '+2.3'); assert.equal(en.num(null), '—');
});
test('formatters：与服务端既有格式逐字一致', () => {
  const f = en.formatters;
  assert.equal(f.int(1596.4), '1596'); assert.equal(f.fix1(2.25), '2.3'); assert.equal(f.fix2(0.5), '0.50'); assert.equal(f.fix3(0.1234), '0.123');
  assert.equal(f.pct0(0.478), '48%'); assert.equal(f.pct1(0.4783), '47.8%');
  assert.equal(f.pctTiny1(0.0004), '<0.1%'); assert.equal(f.pctTiny1(0.0008), '0.1%');
  assert.equal(f.pctTiny1(0.25), '25.0%'); assert.equal(f.pctTiny1(0), '0.0%');
  assert.equal(f.signed1(2.34), '+2.3'); assert.equal(f.signed1(-2.34), '-2.3');
  assert.equal(f.pctSigned1(-0.052), '−5.2%'); assert.equal(f.pctSigned1(0.052), '+5.2%'); assert.equal(f.pctSigned1(0), '0.0%');
  assert.equal(f.roi(-0.052), '−5.2%'); assert.equal(f.roi(0.052), '5.2%');
  assert.equal(f.date('2026-10-20'), 'Tue, Oct 20'); assert.equal(zh.formatters.dateFull('2026-10-20'), '2026年10月20日 周二');
  assert.equal(zh.formatters.dateMD('2026-10-20'), '10月20日');
  assert.equal(zh.formatters.fix1(null), '—');
});
test('formatters 可直接交给 createT', () => {
  const t = createT({ dict: {  a: 'ROI {r, roi}，{d, dateMD}' }, fallback: zhLoc, lang: 'zh', formatters: zh.formatters });
  assert.equal(t('a', { r: -0.052, d: '2026-10-20' }), 'ROI −5.2%，10月20日');
});
test('球队名、分区、休息天数', () => {
  const okc = { teamId: 1, abbr: 'OKC', cn: '俄克拉荷马城雷霆', full: 'Oklahoma City Thunder', name: 'Thunder' };
  assert.equal(en.teamName(okc), 'Oklahoma City Thunder'); assert.equal(zh.teamName(okc), '俄克拉荷马城雷霆');
  assert.equal(en.teamName({ abbr: 'OKC' }), 'OKC'); assert.equal(en.teamName(undefined), '—');
  assert.equal(en.conf('East'), 'East'); assert.equal(zh.conf('East'), '东部'); assert.equal(zh.div('Atlantic'), '大西洋');
  assert.equal(en.div('Pacific'), 'Pacific'); assert.equal(zh.conf('Nope'), 'Nope');
  assert.deepEqual(zh.DIV_CODES, ['Atlantic', 'Central', 'Southeast', 'Northwest', 'Pacific', 'Southwest']);
  assert.equal(zh.pos('G-F'), '锋卫摇摆'); assert.equal(zh.pos('F-G'), '锋卫摇摆'); assert.equal(zh.pos('F-C'), '大前/中锋'); assert.equal(zh.pos('C-F'), '中锋/大前'); assert.equal(en.pos('G-F'), 'G-F'); assert.equal(en.pos('X'), 'X');
  assert.equal(zh.rest(0), '背靠背'); assert.equal(en.rest(0), 'B2B'); assert.equal(zh.rest(2), '休2天'); assert.equal(en.rest(1), '1 day rest'); assert.equal(en.rest(3), '3 days rest'); assert.equal(en.rest(null), '—');
});
test('球队 formatter 与排序', () => {
  const teams = [{ teamId: 1, abbr: 'OKC', cn: '俄克拉荷马城雷霆', full: 'Oklahoma City Thunder' }, { teamId: 2, abbr: 'BOS', cn: '波士顿凯尔特人', full: 'Boston Celtics' }];
  const e2 = createFormat({ locale: enLoc, fallback: zhLoc, tz: 'America/New_York', teamById: new Map(teams.map((x) => [x.teamId, x])) });
  assert.equal(e2.formatters.team(2), 'Boston Celtics');
  assert.deepEqual(e2.sortTeams(teams).map((x) => x.abbr), ['BOS', 'OKC']);
  assert.deepEqual(teams.map((x) => x.abbr), ['OKC', 'BOS']); // 不改原数组
});
test('snapshotAge：文字随语言，stale 判定不变', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const h3 = '2026-10-28T09:00:00Z';
  assert.equal(zh.snapshotAge(h3, { now }).text, '3 小时前抓取');
  assert.equal(en.snapshotAge(h3, { now }).text, 'fetched 3 hours ago');
  assert.equal(en.snapshotAge('2026-10-28T11:00:00Z', { now }).text, 'fetched 1 hour ago');
  assert.equal(en.snapshotAge('2026-10-28T11:50:00Z', { now }).text, 'fetched just now');
  assert.equal(zh.snapshotAge('2026-10-25T09:00:00Z', { now }).text, '3 天前抓取');
  assert.equal(zh.snapshotAge(h3, { now }).stale, false);
  assert.equal(en.snapshotAge('2026-10-25T09:00:00Z', { now }).stale, true);
  assert.equal(zh.snapshotAge(null, { now }), null);
});

test('日期格式化：畸形 ISO 原样返回，不抛 RangeError', () => {
  for (const f of [zh, en]) {
    for (const k of ['date', 'dateFull', 'dateMD']) assert.equal(f[k]('xyz'), 'xyz');
  }
});
