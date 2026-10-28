import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SHADOW_SCHEMA } from '../server/db.mjs';
import { stintMinutes, usualRotation, weightedStints } from '../server/injuryLab.mjs';
import {
  etToUtc, captureDate, reportChain, teamReport, shadowRows, insertShadow, settleShadow,
  shadowAll, shadowSummary, storeReport, storedReports, valuesUsable,
} from '../server/injuryShadow.mjs';

const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(SHADOW_SCHEMA); return db; };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// ---------------------------------------------------------------- 时间

test('etToUtc：美东当天第几分钟 -> UTC，含夏令时切换', () => {
  assert.equal(new Date(etToUtc('2026-10-28', 9 * 60 + 45)).toISOString(), '2026-10-28T13:45:00.000Z');
  assert.equal(new Date(etToUtc('2026-12-01', 9 * 60 + 45)).toISOString(), '2026-12-01T14:45:00.000Z');
  assert.equal(new Date(etToUtc('2026-11-01', 17 * 60)).toISOString(), '2026-11-01T22:00:00.000Z', '11-01 当天已是冬令时');
});

test('captureDate：只在决策时点前后 2 小时内认出比赛日；14:30（北京）那次不是任何时点', () => {
  assert.equal(captureDate(Date.parse('2026-10-28T14:05:00Z'), '22'), '2026-10-28');
  assert.equal(captureDate(Date.parse('2026-10-28T22:33:00Z'), '0630'), '2026-10-28');
  assert.equal(captureDate(Date.parse('2026-10-28T06:30:00Z'), '22'), null);
  assert.equal(captureDate(Date.parse('2026-10-28T06:30:00Z'), '0630'), null);
  assert.equal(captureDate(Date.parse('2026-10-28T14:05:00Z'), '0630'), null);
});

// ---------------------------------------------------------------- 报告链

const rep = (name, asOf, rows = [], notSubmitted = []) => ({ name, asOf, rows, notSubmitted });
const row = (team, player, status, matchup = 'BOS@NYK') => ({ gameDate: '2026-10-28', gameTime: '07:30 (ET)', matchup, team, player, status });

test('reportChain：只要标注时间 ≤ 截止的，从新到旧；30 小时前的不要（不偷看未来）', () => {
  const cut = Date.parse('2026-10-28T13:50:00Z');
  const all = [rep('a', '2026-10-28T13:45:00.000Z'), rep('future', '2026-10-28T14:00:00.000Z'),
    rep('b', '2026-10-27T22:15:00.000Z'), rep('old', '2026-10-27T06:00:00.000Z')];
  assert.deepEqual(reportChain(all, cut).map((r) => r.name), ['a', 'b', 'old']);
  assert.deepEqual(reportChain(all, cut, Date.parse('2026-10-27T21:00:00Z')).map((r) => r.name), ['a', 'b'], '比前一天 06:30 那份更早的不用');
  const prev22 = rep('prev22', '2026-10-27T13:45:00.000Z', [row('New York Knicks', 'Brunson, Jalen', 'Out')]);
  const rows = shadowRows({ slate: slate('2026-10-28T23:30:00Z'), slot: '22', now: Date.parse('2026-10-28T14:05:00Z'), params: PARAMS, values: VALUES, reports: [prev22], teams: TEAMS });
  assert.equal(rows.find((r) => r.variant === 'r22').home_report, null, '前一天 22:00 那份实验里看不到，这里也不用');
});

test('teamReport：新的那份里这队「还没交」就往前找它交过的那份；都没有返回 null', () => {
  const newer = rep('n', '2026-10-28T13:45:00.000Z', [row('New York Knicks', 'Brunson, Jalen', 'Out')],
    [{ gameDate: '2026-10-28', matchup: 'BOS@NYK', team: 'Boston Celtics' }]);
  const older = rep('o', '2026-10-27T22:15:00.000Z', [row('Boston Celtics', 'Tatum, Jayson', 'Questionable')]);
  const game = { date: '2026-10-28', abbrs: ['NYK', 'BOS'] };
  assert.equal(teamReport([newer, older], { ...game, full: 'New York Knicks' }).name, 'n');
  const b = teamReport([newer, older], { ...game, full: 'Boston Celtics' });
  assert.equal(b.name, 'o');
  assert.deepEqual(b.rows.map((r) => r.player), ['Tatum, Jayson']);
  assert.equal(teamReport([rep('x', '2026-10-28T13:45:00.000Z', [row('Utah Jazz', 'A, B', 'Out', 'UTA@LAL')])], { ...game, full: 'Boston Celtics' }), null,
    '报告里没有这场：没有信息，不是「没人伤」');
});

// ---------------------------------------------------------------- 轮换（与实验同一口径）

test('stintMinutes / usualRotation：段秒数折成分钟；只用比赛日之前的最近 10 场，缺席算 0，不足 3 场为 null', () => {
  const st = [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 1, 2, 2, 600], [1, 2, 3, 4, 11, 6, 7, 8, 9, 10, 1, 1, 0, 0, 120]];
  const m = stintMinutes(st);
  assert.equal(m.home.get(1), 12);
  assert.equal(m.home.get(5), 10);
  assert.equal(m.home.get(11), 2);
  assert.equal(m.away.get(6), 12);
  const g = (date, mins) => ({ date, mins });
  const recent = [g('2026-10-20', { 1: 30 }), g('2026-10-22', { 1: 30, 2: 20 }), g('2026-10-24', { 2: 10 }), g('2026-10-28', { 1: 48 })];
  assert.equal(usualRotation(recent.slice(0, 2), '2026-10-28'), null);
  const u = usualRotation(recent, '2026-10-28');
  assert.deepEqual(u.sort((a, b) => a.id - b.id), [{ id: 1, m: 20 }, { id: 2, m: 10 }], '10-28 当天的不算');
});

test('weightedStints：本季只取决策日之前，往季按 0.5、0.25 缩放回合与得分，秒数不变', () => {
  const s = (p) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, p, p, 60];
  const out = weightedStints([
    { w: 1, games: [{ date: '2026-10-20', st: [s(12)] }, { date: '2026-10-28', st: [s(99)] }] },
    { w: 0.5, games: [{ date: '2026-03-01', st: [s(12)] }] },
    { w: 0.25, games: [{ date: '2025-03-01', st: [s(12)] }] },
  ], '2026-10-28');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x[12]), [12, 6, 3]);
  assert.deepEqual(out.map((x) => x[10]), [10, 5, 2.5]);
  assert.deepEqual(out.map((x) => x[14]), [60, 60, 60]);
});

// ---------------------------------------------------------------- 三套预测

const PARAMS = {
  version: 1, opts: { unknownV: -1, repl: -2 },
  slots: { 22: { beta: 0.6, pPlay: { Out: 0, Doubtful: 0.06, Questionable: 0.5, Probable: 0.9, Available: 0.94 } },
    '0630': { beta: 0.65, pPlay: { Out: 0, Doubtful: 0.02, Questionable: 0.5, Probable: 0.95, Available: 0.95 } } },
};
const TEAMS = [{ teamId: 10, abbr: 'NYK', full: 'New York Knicks' }, { teamId: 20, abbr: 'BOS', full: 'Boston Celtics' }];
// 每队 5 人各 48 分钟：缺一个 RAPM +5 的主力，轮换价值从 5·48/48 = 5 掉到替补补齐的 −2·48/48 = −2，调整 −7
const five = (base) => Object.fromEntries([0, 1, 2, 3, 4].map((i) => [base + i, 48]));
const VALUES = {
  version: 1, builtAt: '2026-10-28T12:00:00.000Z', fittedAt: '2026-10-25T12:00:00.000Z',
  rapm: { 101: 5, 102: 0, 103: 0, 104: 0, 105: 0, 201: 0, 202: 0, 203: 0, 204: 0, 205: 0 },
  recent: {
    10: ['2026-10-20', '2026-10-22', '2026-10-24'].map((date) => ({ date, mins: five(101) })),
    20: ['2026-10-20', '2026-10-22', '2026-10-24'].map((date) => ({ date, mins: five(201) })),
  },
  firstSeen: { 10: Object.fromEntries([101, 102, 103, 104, 105].map((id) => [id, '2026-10-20'])), 20: {} },
  people: [[101, 'Jalen Brunson'], [102, 'Josh Hart'], [201, 'Jayson Tatum']],
};
const slate = (tipoff) => [{ gameId: 'g1', date: '2026-10-28', tipoff, homeId: 10, awayId: 20, margin: 2, homeElo: 1550, awayElo: 1500, dataAt: '2026-10-28T13:00:00.000Z' }];
const REPORTS = [rep('2026-10-28_09_30AM', '2026-10-28T13:30:00.000Z', [row('New York Knicks', 'Brunson, Jalen', 'Out')])];

test('22:00 那次：记基线 + 22:00 方案；报告里主队缺主力 → 净胜分 += β·调整', () => {
  const now = Date.parse('2026-10-28T14:05:00Z');
  const rows = shadowRows({ slate: slate('2026-10-28T23:30:00Z'), slot: '22', now, params: PARAMS, values: VALUES, reports: REPORTS, teams: TEAMS });
  assert.deepEqual(rows.map((r) => r.variant), ['base', 'r22']);
  const [b, r] = rows;
  near(b.margin, 2); assert.ok(b.beta == null && b.home_report == null, "基线不用报告");
  near(r.adj_home, -7); near(r.adj_away, 0);
  near(r.margin, 2 + 0.6 * -7);
  assert.ok(r.p_home < b.p_home);
  assert.equal(r.home_report, '2026-10-28_09_30AM');
  assert.equal(r.away_report, '2026-10-28_09_30AM', '这场在报告上、客队交了名单但没人上报：没人缺，调整 0');
  assert.ok(r.home_report_as_of < r.captured_at);
  assert.equal(r.values_fitted_at, VALUES.fittedAt);
  assert.deepEqual(JSON.parse(r.inputs).home.statuses, [[101, 'Out']]);
});

test('22:00 那次：06:30 之前就开打的场，06:30 方案沿用 22:00 的报告、用 06:30 的参数（与实验同）', () => {
  const now = Date.parse('2026-10-28T14:05:00Z');
  const rows = shadowRows({ slate: slate('2026-10-28T19:00:00Z'), slot: '22', now, params: PARAMS, values: VALUES, reports: REPORTS, teams: TEAMS });
  assert.deepEqual(rows.map((r) => r.variant), ['base', 'r22', 'r0630']);
  near(rows[2].margin, 2 + 0.65 * -7);
  assert.equal(rows[2].home_report, '2026-10-28_09_30AM');
});

test('06:30 那次：只记 06:30 方案；已开赛的、不在时点窗口里的、时点之后的报告都不用', () => {
  const now = Date.parse('2026-10-28T22:35:00Z');
  const late = [...REPORTS, rep('future', '2026-10-28T22:30:00.000Z', [row('New York Knicks', 'Hart, Josh', 'Out')])];
  const rows = shadowRows({ slate: slate('2026-10-28T23:30:00Z'), slot: '0630', now, params: PARAMS, values: VALUES, reports: late, teams: TEAMS });
  assert.deepEqual(rows.map((r) => r.variant), ['r0630']);
  assert.equal(rows[0].home_report, '2026-10-28_09_30AM', '22:30 标注的那份离 22:35 不到 15 分钟，当时看不到');
  assert.equal(shadowRows({ slate: slate('2026-10-28T22:00:00Z'), slot: '0630', now, params: PARAMS, values: VALUES, reports: late, teams: TEAMS }).length, 0);
  assert.equal(shadowRows({ slate: slate('2026-10-28T23:30:00Z'), slot: '0630', now: Date.parse('2026-10-28T06:30:00Z'), params: PARAMS, values: VALUES, reports: late, teams: TEAMS }).length, 0);
});

test('球员价值缺失或过期：只记基线，不记方案', () => {
  const now = Date.parse('2026-10-28T14:05:00Z');
  assert.equal(valuesUsable(VALUES, now), true);
  assert.equal(valuesUsable({ ...VALUES, fittedAt: '2026-10-15T00:00:00.000Z' }, now), false);
  assert.equal(valuesUsable({ ...VALUES, builtAt: '2026-10-24T00:00:00.000Z' }, now), false);
  assert.equal(valuesUsable(null, now), false);
  const rows = shadowRows({ slate: slate('2026-10-28T23:30:00Z'), slot: '22', now, params: PARAMS, values: null, reports: REPORTS, teams: TEAMS });
  assert.deepEqual(rows.map((r) => r.variant), ['base']);
});

// ---------------------------------------------------------------- 只追加的库

const capture = (db, slot, now, tipoff = '2026-10-28T23:30:00Z') => insertShadow(db, shadowRows({
  slate: slate(tipoff), slot, now: Date.parse(now), params: PARAMS, values: VALUES, reports: REPORTS, teams: TEAMS,
})).n;

test('影子表只追加：重复插入忽略（含 OR REPLACE）、不能删、预测字段不能改、开赛后/偷看未来的插不进', () => {
  const db = fresh();
  assert.equal(capture(db, '22', '2026-10-28T14:05:00Z'), 2);
  assert.equal(capture(db, '22', '2026-10-28T15:05:00Z'), 0);
  db.exec("INSERT OR REPLACE INTO shadow_predictions (game_id, variant, params_version, captured_at, game_date, tipoff_utc, home_id, away_id, base_margin, margin, p_home) VALUES ('g1','base',1,'2026-10-28T15:00:00.000Z','2026-10-28','2099-01-01T00:00:00.000Z',10,20,9,9,0.9)");
  assert.equal(shadowAll(db).find((r) => r.variant === 'base').margin, 2);
  assert.throws(() => db.exec('DELETE FROM shadow_predictions'), /只追加/);
  assert.throws(() => db.exec("UPDATE shadow_predictions SET p_home = 0.99 WHERE variant = 'base'"), /只追加/);
  const ins = (tip, cap, asOf) => db.prepare(`INSERT INTO shadow_predictions (game_id, variant, params_version, captured_at, game_date, tipoff_utc, home_id, away_id, base_margin, margin, p_home, home_report_as_of)
    VALUES (?, 'r22', 1, ?, '2026-10-28', ?, 10, 20, 0, 0, 0.5, ?)`).run(`x${tip}${cap}`, cap, tip, asOf);
  assert.throws(() => ins('2020-01-01T00:00:00.000Z', '2019-12-31T00:00:00.000Z', null), /开赛/);
  assert.throws(() => ins('2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z', null), /开赛/);
  assert.throws(() => ins('2099-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z', '2097-12-31T23:50:00.000Z'), /未来/, '离记录不到 15 分钟也算未来');
  ins('2099-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z', '2097-12-31T23:45:00.000Z');
});

test('一行被触发器拒（运行中恰好开赛）只丢这一行，其余照记', () => {
  const db = fresh();
  const rows = shadowRows({ slate: slate('2026-10-28T23:30:00Z'), slot: '22', now: Date.parse('2026-10-28T14:05:00Z'), params: PARAMS, values: VALUES, reports: REPORTS, teams: TEAMS });
  const res = insertShadow(db, [{ ...rows[0], game_id: 'tipped', tipoff_utc: '2020-01-01T00:00:00.000Z' }, ...rows]);
  assert.equal(res.n, 2);
  assert.deepEqual(res.rejected.map((r) => r.game_id), ['tipped']);
});

test('结算：比分只写一次；结算后改不了', () => {
  const db = fresh();
  capture(db, '22', '2026-10-28T14:05:00Z');
  assert.equal(settleShadow(db, { g1: { homeScore: 100, awayScore: 90 } }), 2);
  assert.equal(settleShadow(db, { g1: { homeScore: 80, awayScore: 90 } }), 0);
  assert.ok(shadowAll(db).every((r) => r.home_win === 1 && r.home_score === 100));
  assert.throws(() => db.exec('UPDATE shadow_predictions SET home_win = 0'), /只追加/);
});

test('报告存档：同名只存一次，按标注时间取', () => {
  const db = fresh();
  assert.equal(storeReport(db, { ...REPORTS[0], fetchedAt: '2026-10-28T14:01:00.000Z' }), 1);
  assert.equal(storeReport(db, { ...REPORTS[0], rows: [], fetchedAt: '2026-10-28T15:00:00.000Z' }), 0);
  const got = storedReports(db, '2026-10-27T00:00:00.000Z');
  assert.equal(got.length, 1);
  assert.equal(got[0].rows.length, 1);
  assert.equal(storedReports(db, '2026-10-29T00:00:00.000Z').length, 0);
  assert.throws(() => storeReport(db, { ...REPORTS[0], name: 'x', asOf: '10/27/26 09:45 AM', fetchedAt: 'x' }), /UTC ISO/,
    'PDF 里的标注写法不能进库：按字符串比较时间会全乱');
});

// ---------------------------------------------------------------- 页面汇总

test('shadowSummary：只比两边都已结算的同一批场次；Δ 为负 = 方案更好；进度按 300 场', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const won = i % 4 !== 0 ? 1 : 0;
    const base = { game_id: `g${i}`, settled_at: 'x', home_win: won };
    rows.push({ ...base, variant: 'base', p_home: 0.6 });
    rows.push({ ...base, variant: 'r0630', p_home: won ? 0.7 : 0.55 });
    if (i < 10) rows.push({ ...base, variant: 'r22', p_home: 0.6 });
  }
  rows.push({ game_id: 'open', variant: 'base', p_home: 0.5, settled_at: null, home_win: null });
  const s = shadowSummary(rows, { B: 200 });
  const v = Object.fromEntries(s.variants.map((x) => [x.variant, x]));
  assert.equal(v.base.n, 40);
  assert.equal(v.r0630.n, 40);
  assert.equal(v.r22.n, 10);
  near(v.r22.dLogLoss.mean, 0);
  assert.ok(v.r0630.dLogLoss.mean < 0 && v.r0630.dLogLoss.hi < 0);
  assert.ok(v.r0630.dBrier.mean < 0);
  assert.equal(s.target, 300);
  assert.equal(s.pending, 1);
  assert.equal(s.progress, 40);
});
