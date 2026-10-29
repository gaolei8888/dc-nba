import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SHADOW_SCHEMA, RR_SHADOW_SCHEMA, INJ_ELO_SHADOW_SCHEMA } from '../server/db.mjs';
import { insertShadow, settleShadow } from '../server/injuryShadow.mjs';
import {
  INJ_ELO_COLS, dayBlockCI, injEloAll, injEloRows, injEloSummary, playedIndex, replaySeason, usableChain,
} from '../server/injuryEloShadow.mjs';
import { computeElo, scheduleEloGames } from '../server/ratings.mjs';
import { normalCdf } from '../server/lab.mjs';
import { decisionInstant } from '../server/injuryReport.mjs';

const FROZEN = JSON.parse(fs.readFileSync(new URL('../server/injury-elo-params-v1.json', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// ---------------------------------------------------------------- 小联盟：4 队，每队 8 人；1 号队的 11 号是球星
const TEAMS = [
  { teamId: 1, abbr: 'AAA', full: 'Alpha A', eloPreseasonExact: 1550 },
  { teamId: 2, abbr: 'BBB', full: 'Beta B', eloPreseasonExact: 1500 },
  { teamId: 3, abbr: 'CCC', full: 'Gamma C', eloPreseasonExact: 1480 },
  { teamId: 4, abbr: 'DDD', full: 'Delta D', eloPreseasonExact: 1470 },
];
const ROSTER = Object.fromEntries(TEAMS.map(({ teamId: t }) => [t, Array.from({ length: 8 }, (_, i) => t * 10 + 1 + i)]));
const MINS = [36, 34, 32, 30, 30, 28, 26, 24];   // 合计 240
const VALUES = { 11: 6, 12: 1, 21: 1, 31: 1, 41: 1 };
const PARAMS = {
  ...FROZEN, values: VALUES,
  eloStartA: Object.fromEntries(TEAMS.map((t) => [t.teamId, t.eloPreseasonExact])),
  eloStartP: Object.fromEntries(TEAMS.map((t) => [t.teamId, t.eloPreseasonExact])),
};
/** 姓名不能带数字（规范化会去掉），用字母编码 id */
const word = (id) => String(id).split('').map((c) => 'abcdefghij'[Number(c)]).join('');
const PEOPLE = Object.values(ROSTER).flat().map((id) => [id, `F${word(id)} L${word(id)}`]);
const D = '2026-11-05';
const NOW22 = decisionInstant(D, '22') + 5 * 60000;   // 北京 22:05
const TIP = Date.parse(`${D}T23:30:00Z`);
const day = (k) => new Date(Date.parse('2026-10-22T00:00:00Z') + k * 86400e3).toISOString().slice(0, 10);

/** 已结束的比赛 + 每场出场；absent: Set(pid) 那场没上 */
function season({ n = 6, absent = () => new Set(), sameDay = false } = {}) {
  const games = []; const played = {};
  const add = (date, h, a, hs, as, gid) => {
    games.push({ gameId: gid, type: 'regular', date, dateTimeUtc: `${date}T23:30:00.000Z`, homeId: h, awayId: a, neutral: false, homeScore: hs, awayScore: as });
    for (const t of [h, a]) {
      const out = absent(gid, t);
      (played[t] ??= []).push({ date, gameId: gid, mins: Object.fromEntries(ROSTER[t].map((id, i) => [id, MINS[i]]).filter(([id]) => !out.has(id))) });
    }
  };
  for (let k = 0; k < n; k += 1) {
    add(day(k * 2), 1, 2, 100 + (k % 3) * 4, 98 + k, `g${k}a`);
    add(day(k * 2), 3, 4, 101 - k, 99 + (k % 2) * 5, `g${k}b`);
  }
  if (sameDay) add(D, 3, 4, 150, 60, 'gSame');
  games.push({ gameId: 'today', type: 'regular', date: D, dateTimeUtc: new Date(TIP).toISOString(), homeId: 1, awayId: 2, neutral: false, homeScore: null, awayScore: null });
  return { games, played };
}
const slateOf = (o = {}) => [{ gameId: 'today', date: D, tipoff: new Date(TIP).toISOString(), homeId: 1, awayId: 2, margin: 3, dataAt: '2026-11-05T13:00:00.000Z', ...o }];
const valuesOf = (played, o = {}) => ({ builtAt: '2026-11-05T11:00:00.000Z', gamesThrough: day(10), played, people: PEOPLE, ...o });
const rep = (name, asOf, rows) => ({ name, asOf, rows, notSubmitted: [] });
const outRow = (pid, status = 'Out', date = D) => ({ gameDate: date, matchup: 'BBB@AAA', team: 'Alpha A', player: `L${word(pid)}, F${word(pid)}`, status });
const run = (o = {}) => {
  const s = o.season ?? season();
  return injEloRows({
    slate: slateOf(o.slate), slot: o.slot ?? '22', now: o.now ?? NOW22, params: o.params ?? PARAMS,
    store: { schedule: { games: s.games }, teams: o.teams ?? TEAMS }, values: o.values ?? valuesOf(s.played),
    reports: o.reports ?? [], baseMargins: o.baseMargins ?? new Map(),
  });
};
const byV = (rows) => Object.fromEntries(rows.map((r) => [r.variant, r]));

test('冻结参数：s=0.75、β=0.5、sd 12、延迟 15 分钟；P(出场|状态) 单调；D=0 的开季 Elo 已在冻结时与线上核对', () => {
  assert.equal(FROZEN.version, 1);
  assert.equal(FROZEN.s, 0.75);
  assert.equal(FROZEN.beta, 0.5);
  assert.equal(FROZEN.spreadSd, 12);
  assert.equal(FROZEN.lagMin, 15);
  assert.equal(FROZEN.valuesThrough, '2025-26');
  assert.deepEqual(FROZEN.valueOpts, { unknownV: -0.5, repl: -0.5 });
  assert.ok(FROZEN.pPlay.Out < FROZEN.pPlay.Doubtful && FROZEN.pPlay.Doubtful < FROZEN.pPlay.Questionable && FROZEN.pPlay.Questionable < FROZEN.pPlay.Probable);
  assert.equal(Object.keys(FROZEN.eloStartA).length, 30);
  assert.ok(Object.keys(FROZEN.values).length > 300);
});

test('没人缺阵（D_post 全为 0）：A 的 Elo 与线上 computeElo 逐位相同，inj-a 退化为 P1(β=s)', () => {
  const s = season();
  const { rows } = run({ season: s });
  const r = byV(rows);
  const prod = computeElo(scheduleEloGames(s.games, TEAMS), { initial: Object.fromEntries(TEAMS.map((t) => [t.teamId, t.eloPreseasonExact])) }).final;
  const inp = JSON.parse(r['inj-a-22'].inputs);
  assert.deepEqual(inp.eloA, inp.eloP);
  assert.equal(inp.eloP[0], prod[1]);
  assert.equal(inp.eloP[1], prod[2]);
  assert.equal(r['inj-a-22'].elo_adj, 0);
  assert.equal(r['inj-p1-22'].elo_adj, null);
  near(r['inj-a-22'].margin, 3);
  near(r['inj-p1-22'].margin, 3);
  assert.equal(r['inj-a-22'].dpost_coverage, 1);
});

test('球星缺阵的比赛：D_post > 0，A 的期望按缺人算，1 号队少掉分 → elo_adj > 0', () => {
  const s = season({ absent: (gid, t) => (t === 1 && ['g3a', 'g4a'].includes(gid) ? new Set([11]) : new Set()) });
  const { rows } = run({ season: s });
  const a = byV(rows)['inj-a-22'];
  const inp = JSON.parse(a.inputs);
  assert.ok(a.elo_adj > 0, `elo_adj ${a.elo_adj}`);
  assert.ok(inp.eloA[0] > inp.eloP[0]);
  near(a.margin, 3 + a.elo_adj);
});

test('赛前报告：Out 的球星按 P(出场|Out) 扣分；inj-p1 = base − 0.5·ΔD_pre，inj-a = base + elo_adj − 0.75·ΔD_pre', () => {
  const asOf = new Date(NOW22 - 30 * 60000).toISOString();
  const { rows } = run({ reports: [rep('2026-11-05_09_30AM', asOf, [outRow(11)])] });
  const r = byV(rows);
  const p1 = r['inj-p1-22']; const a = r['inj-a-22'];
  assert.ok(p1.dpre_home > 0);
  assert.equal(p1.dpre_away, 0);
  assert.equal(p1.home_report, '2026-11-05_09_30AM');
  assert.equal(p1.away_report, '2026-11-05_09_30AM');   // 这场在报告上、客队没列人：有报告，没人缺阵
  near(p1.margin, 3 - 0.5 * p1.dpre_home);
  near(a.margin, 3 + a.elo_adj - 0.75 * a.dpre_home);
  near(p1.p_home, normalCdf(p1.margin, 12));
});

test('防泄漏：标注时间晚于「记录时刻 − 15 分钟」或不早于开赛的报告不用；没有开赛时间就不用任何报告', () => {
  const lagMs = 15 * 60000;
  const mk = (min) => rep(`r${min}`, new Date(NOW22 + min * 60000).toISOString(), []);
  const reports = [mk(-30), mk(-10), mk(+5)];
  assert.deepEqual(usableChain(reports, { cutoffMs: NOW22, tipMs: TIP, date: D, lagMs }).map((r) => r.name), ['r-30']);
  // 开赛比决策时点还早（理论上）：开赛之后标注的报告不用
  assert.deepEqual(usableChain(reports, { cutoffMs: NOW22, tipMs: NOW22 - 20 * 60000, date: D, lagMs }).map((r) => r.name), []);
  assert.deepEqual(usableChain(reports, { cutoffMs: NOW22, tipMs: NaN, date: D, lagMs }), []);
  // 行级：10 分钟前的报告（在发布延迟内）不进 D_pre
  const { rows } = run({ reports: [rep('late', new Date(NOW22 - 10 * 60000).toISOString(), [outRow(11)])] });
  assert.equal(byV(rows)['inj-p1-22'].dpre_home, 0);
  assert.equal(byV(rows)['inj-p1-22'].home_report, null);
});

test('保守分支：没有开赛时间不记；已开赛的不记', () => {
  const noTip = run({ slate: { tipoff: null } });
  assert.equal(noTip.rows.length, 0);
  assert.ok(noTip.skipped.length && noTip.skipped.every((x) => /没有开赛时间/.test(x.why)));
  const tipped = run({ now: TIP + 1000, slot: '22' });
  assert.equal(tipped.rows.length, 0);
});

test('防泄漏：比赛日当天（含早场）及之后的赛果与出场不进健康基线、D_post 与 Elo', () => {
  const plain = run({ season: season() });
  const withSame = run({ season: season({ sameDay: true }) });
  const a = byV(plain.rows)['inj-a-22']; const b = byV(withSame.rows)['inj-a-22'];
  assert.equal(b.results_through, a.results_through);
  assert.ok(b.results_through < D);
  assert.equal(b.inputs, a.inputs);
  assert.equal(b.games_home, a.games_home);
  // 健康基线只用更早日期：同日 D 的出场即使在 played 里也不算
  const s = season({ sameDay: true });
  const st = replaySeason({
    games: scheduleEloGames(s.games, TEAMS), D, byGame: playedIndex(valuesOf(s.played)).byGame, reports: [], teams: TEAMS,
    params: PARAMS, eloStartP: PARAMS.eloStartP, idx: new Map(), nameOf: () => null,
  });
  assert.equal(st.resultsN, 12);
  assert.ok(!st.dPost.has('gSame'));
});

test('健康基线只用更早日期：长期缺阵的人在赛前报告上就留在基线里（缺阵 > 10 场仍扣分）', () => {
  const s = season({ n: 14, absent: (gid, t) => (t === 1 && Number(gid.slice(1, -1)) >= 2 ? new Set([11]) : new Set()) });
  const asOf = new Date(NOW22 - 30 * 60000).toISOString();
  const onRep = byV(run({ season: s, reports: [rep('x', asOf, [outRow(11)])] }).rows)['inj-p1-22'];
  const off = byV(run({ season: s }).rows)['inj-p1-22'];
  assert.ok(onRep.dpre_home > 0);
  assert.equal(off.dpre_home, 0);   // 近 10 场没上、又不在报告上：掉出基线
});

test('缺出场数据的比赛看得见：覆盖场数、缺的 gameId 记在行里，不是悄悄记 0', () => {
  const s = season();
  s.played[1] = s.played[1].filter((g) => g.gameId !== 'g2a');
  s.played[2] = s.played[2].filter((g) => g.gameId !== 'g2a');
  const a = byV(run({ season: s }).rows)['inj-a-22'];
  assert.equal(a.games_home, 6);
  assert.equal(a.covered_home, 5);
  assert.equal(a.covered_away, 5);
  near(a.dpost_coverage, 10 / 12);
  assert.deepEqual(JSON.parse(a.inputs).home.missing, ['g2a']);
});

test('旧 player-values 只有 recent：照样用，并记下来源', () => {
  const s = season();
  const r = byV(run({ season: s, values: valuesOf(undefined, { recent: s.played }) }).rows)['inj-a-22'];
  assert.equal(JSON.parse(r.inputs).playedSrc, 'recent');
  const none = run({ season: s, values: { builtAt: '2026-11-05T11:00:00.000Z', people: PEOPLE } });
  assert.equal(none.rows.length, 0);
  assert.ok(none.skipped.every((x) => /player-values/.test(x.why)));
});

test('时点：22:00 记 *-22（06:30 前开打的另记 *-0630）；06:30 记 *-0630，沿用 22:00 的 base', () => {
  assert.deepEqual(run().rows.map((r) => r.variant).sort(), ['inj-a-22', 'inj-p1-22']);
  const early = Date.parse(`${D}T20:00:00Z`);   // 美东 16:00，早于北京 06:30（22:30Z）
  assert.deepEqual(run({ slate: { tipoff: new Date(early).toISOString() } }).rows.map((r) => r.variant).sort(),
    ['inj-a-0630', 'inj-a-22', 'inj-p1-0630', 'inj-p1-22']);
  const late = run({ slot: '0630', now: decisionInstant(D, '0630') + 60000, baseMargins: new Map([['today', 4.2]]) });
  assert.deepEqual(late.rows.map((r) => r.variant).sort(), ['inj-a-0630', 'inj-p1-0630']);
  assert.ok(late.rows.every((r) => r.base_margin === 4.2 && r.base_source === 'shadow-base'));
});

// ---------------------------------------------------------------- 库

const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(SHADOW_SCHEMA + RR_SHADOW_SCHEMA + INJ_ELO_SHADOW_SCHEMA); return db; };
const FUT = '2099-01-01T23:30:00.000Z';
const dbRow = (o = {}) => ({
  game_id: 'g1', variant: 'inj-a-0630', params_version: 1, captured_at: '2099-01-01T14:05:00.000Z', game_date: '2099-01-01', tipoff_utc: FUT,
  home_id: 1, away_id: 2, base_margin: 2, base_source: 'live', elo_adj: 0.3, scale: 0.75, dpre_home: 1, dpre_away: 0, margin: 1.55, p_home: 0.55,
  home_report: 'x', home_report_as_of: '2099-01-01T13:30:00.000Z', away_report: null, away_report_as_of: null, results_through: '2098-12-31',
  games_home: 5, games_away: 5, covered_home: 5, covered_away: 4, dpost_coverage: 0.9,
  values_built_at: '2099-01-01T11:00:00.000Z', data_at: '2099-01-01T13:00:00.000Z', inputs: '{}', ...o,
});
const ins = (db, o) => insertShadow(db, [dbRow(o)], { table: 'shadow_inj_elo_predictions', cols: INJ_ELO_COLS });

test('库：只追加——重复忽略、不能删、预测字段不能改、比分只写一次', () => {
  const db = fresh();
  assert.equal(ins(db).n, 1);
  assert.equal(ins(db, { p_home: 0.9 }).n, 0);
  assert.equal(injEloAll(db)[0].p_home, 0.55);
  assert.throws(() => db.prepare("UPDATE shadow_inj_elo_predictions SET p_home = 0.6 WHERE game_id = 'g1'").run(), /只追加/);
  assert.throws(() => db.prepare("UPDATE shadow_inj_elo_predictions SET covered_away = 5 WHERE game_id = 'g1'").run(), /只追加/);
  assert.throws(() => db.prepare('DELETE FROM shadow_inj_elo_predictions').run(), /不能删除/);
  assert.equal(settleShadow(db, { g1: { homeScore: 100, awayScore: 90 } }, 'T', 'shadow_inj_elo_predictions'), 1);
  assert.equal(settleShadow(db, { g1: { homeScore: 90, awayScore: 100 } }, 'T2', 'shadow_inj_elo_predictions'), 0);
  assert.equal(injEloAll(db)[0].home_win, 1);
});

test('库兜底：开赛后、用了未来报告 / 开赛后报告、用了比赛日当天赛果、未来数据、覆盖数不合法、inj-a 缺 elo_adj，都插不进', () => {
  const db = fresh();
  const rej = (o) => { const r = ins(db, { game_id: `x${Math.random()}`, ...o }); assert.equal(r.n, 0, JSON.stringify(o)); assert.equal(r.rejected.length, 1); };
  rej({ tipoff_utc: '2020-01-01T00:00:00.000Z', captured_at: '2019-12-31T00:00:00.000Z' });   // 已开赛（真实时钟）
  rej({ captured_at: FUT });
  rej({ home_report_as_of: '2099-01-01T13:55:00.000Z' });   // 记录前 10 分钟：在发布延迟内
  rej({ away_report_as_of: '2099-01-01T13:51:00.000Z' });
  rej({ results_through: '2099-01-01' });
  rej({ values_built_at: '2099-01-01T15:00:00.000Z' });
  rej({ data_at: '2099-01-01T15:00:00.000Z' });
  rej({ covered_home: 6 });
  rej({ games_home: null });
  rej({ elo_adj: null });
  rej({ variant: 'inj-p1-0630', elo_adj: 0.3 });
  rej({ variant: 'inj-x' });
  assert.equal(ins(db, { game_id: 'ok', variant: 'inj-p1-0630', elo_adj: null, scale: 0.5 }).n, 1);
});

test('读数：base / inj-p1-0630 / inj-a-0630 共同结算的场，按比赛日分块 bootstrap 的配对差', () => {
  const rows = [];
  for (let k = 0; k < 20; k += 1) {
    const g = `g${k}`; const date = `2099-01-${String(1 + (k % 5)).padStart(2, '0')}`; const y = k % 3 ? 1 : 0;
    const s = { game_id: g, game_date: date, settled_at: 'T', home_win: y };
    rows.push({ ...s, variant: 'base', p_home: 0.6 }, { ...s, variant: 'inj-p1-0630', p_home: 0.62 },
      { ...s, variant: 'inj-a-0630', p_home: 0.64, games_home: 4, games_away: 4, covered_home: 4, covered_away: k ? 4 : 3 },
      { ...s, variant: 'rr0630', p_home: 0.5 });
  }
  rows.push({ game_id: 'only-base', game_date: '2099-01-09', settled_at: 'T', home_win: 1, variant: 'base', p_home: 0.5 });
  const s = injEloSummary(rows, { B: 200 });
  assert.equal(s.n, 20);
  assert.deepEqual(s.arms.map((a) => [a.variant, a.n]), [['base', 20], ['inj-p1-0630', 20], ['inj-a-0630', 20], ['rr0630', 20]]);
  const d = s.deltas.find((x) => x.a === 'inj-a-0630' && x.b === 'inj-p1-0630');
  assert.equal(d.dLogLoss.days, 5);
  assert.ok(d.dLogLoss.lo <= d.dLogLoss.mean && d.dLogLoss.mean <= d.dLogLoss.hi);
  assert.equal(s.fullCoverage.n, 19);
  near(s.dpostCoverage, 159 / 160);
  // 分块：同一天的差值整体抽取
  const ci = dayBlockCI([{ day: 'a', d: 1 }, { day: 'a', d: 1 }, { day: 'b', d: -1 }], { B: 500 });
  assert.equal(ci.days, 2);
  near(ci.mean, 1 / 3);
});
