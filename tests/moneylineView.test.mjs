import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCENARIOS, SLIPPAGE_OPTIONS, validateFilters, forwardCandidates, readLedgerRows, moneylineView,
} from '../server/moneylineView.mjs';
import { openLedger } from '../server/db.mjs';
import { captureRows, insertBets, settleBets } from '../server/ledger.mjs';
import { qualityOk, STRATEGIES } from '../server/betStrategies.mjs';
import { FORWARD_PRIMARY, FORWARD_SECONDARY, SELECTABLE } from '../server/betSplits.mjs';

// ---------------------------------------------------------------------------
// 夹具：验证期 2023-24 两场、测试期 2025-26 四场（其中 1 场无美国公司 → 缺失率 0.25）、训练期 2022-23 一场

const dk = (ml, extra = {}) => ({ draftkings: { open: ml, close: ml, current: null, ...extra } });
const g = (gameId, season, date, pHome, homeWin, books) => ({
  gameId, date, season, homeId: 1, awayId: 2, homeWin, actual: homeWin ? 5 : -5, void: false,
  b2bHome: false, b2bAway: false, teamGp: 20, pHome, paramsVersion: `wf-${season}`, modelVersion: 'replay-elo-wf', books,
});
const tinyReport = {
  version: 1,
  selected: { close: 'B-edge3', open: null },
  games: [
    g('V1', '2023-24', '2023-11-01', 0.62, true, dk([-110, -110])),
    g('V2', '2023-24', '2023-11-02', 0.30, true, dk([-150, 130])),
    g('R1', '2022-23', '2022-11-01', 0.62, true, dk([-110, -110])),
    // 测试期：T1 押主 -110 赢（+0.909）；T2 押客 +130 赢（+1.3）；T3 无美国公司；T4 两边都没有 3% 优势
    g('T1', '2025-26', '2025-11-01', 0.60, true, dk([-110, -110])),
    g('T2', '2025-26', '2025-11-02', 0.30, false, dk([-150, 130])),
    g('T3', '2025-26', '2025-11-03', 0.55, true, {}),
    g('T4', '2025-26', '2025-11-03', 0.50, true, dk([-105, -115])),
  ],
};
const codes = (v) => v.warnings.map((w) => w.code);

test('常量：情景与滑点选项', () => {
  assert.deepEqual(SCENARIOS, ['close', 'open', 'closeBest', 'forward']);
  assert.deepEqual(SLIPPAGE_OPTIONS, [0, 5, 10]);
});

test('默认：收盘情景、测试期、选定策略；带「收盘价」「已被看过」警告与结论码', () => {
  const f = validateFilters({}, tinyReport);
  assert.deepEqual(f, { scenario: 'close', split: 'test', season: null, from: null, to: null, book: 'chain', strategy: 'B-edge3', slippagePts: 0, feeOnWin: 0 });
  const v = moneylineView(tinyReport, f);
  assert.deepEqual([v.filters.scenario, v.filters.split, v.strategy, v.labels.previouslySeen, v.labels.modelVersion, v.labels.historical],
    ['close', 'test', 'B-edge3', true, 'replay-elo-wf', true]);
  for (const c of ['srv.ml.warn.closingPrice', 'srv.ml.warn.previouslySeen', 'srv.ml.warn.smallSample']) assert.ok(codes(v).includes(c), c);
  assert.ok(!codes(v).includes('srv.ml.warn.inSample'));
  assert.ok(!codes(v).includes('srv.ml.warn.bestPrice'));
  // 两注：T1 主 -110 赢、T2 客 +130 赢
  assert.equal(v.summary.bets, 2);
  assert.ok(Math.abs(v.summary.profit - (100 / 110 + 1.3)) < 1e-12);
  assert.deepEqual(v.bets.map((b) => [b.gameId, b.side, b.quoted, b.result]), [['T1', 'home', -110, 'win'], ['T2', 'away', 130, 'win']]);
  // 预选策略 + 测试期 → 正式结论（注数不足 → tooFew），不是探索性
  assert.equal(v.verdict.code, 'srv.ml.verdict.test.tooFew');
  assert.equal(v.exploratory, false);
  assert.deepEqual(v.warnings.find((w) => w.code === 'srv.ml.warn.smallSample').params, { bets: 2, need: 300 });
  // 全部策略对比表：每个 STRATEGIES 一行，selectable 与 SELECTABLE 一致
  assert.deepEqual(v.strategies.map((s) => s.id), STRATEGIES.map((s) => s.id));
  assert.deepEqual(v.strategies.filter((s) => s.selectable).map((s) => s.id), SELECTABLE);
  assert.equal(v.strategies.find((s) => s.id === 'B-edge3').bets, 2);
  assert.equal(v.strategies.find((s) => s.id === 'A-home').bets, 3);
  assert.equal(v.selected, 'B-edge3');
  // 区间、分桶、校准、功效都在
  assert.equal(v.ci.day.n, 2);
  assert.equal(v.ci.season.reason, 'fewerThan2Seasons');
  assert.deepEqual(Object.keys(v.buckets), ['odds', 'edge', 'prob', 'homeAway', 'b2b', 'phase']);
  assert.equal(v.calibration.n, 3);
  assert.deepEqual(Object.keys(v.power.neededAt), ['0.01', '0.02', '0.03']);
  assert.ok(v.power.sd > 0 && v.power.deff > 0);
});

test('多重比较：只用选择期（收盘 = 验证期）的可选策略，附完整结果表', () => {
  const v = moneylineView(tinyReport, validateFilters({}, tinyReport));
  const mc = v.multipleComparisons;
  assert.equal(mc.selectOn, 'validate');
  assert.deepEqual(mc.rows.map((r) => r.id), SELECTABLE);
  assert.ok(mc.rows.every((r) => r.split === 'validate' && r.inSelection));
  assert.equal(mc.tried, SELECTABLE.length);
  assert.ok(Math.abs(mc.bonferroniAlpha - 0.05 / SELECTABLE.length) < 1e-15);
  assert.deepEqual(Object.keys(mc.results), SELECTABLE);
  // 验证期 V1 主 -110、V2 客 +130 都过 B-edge3
  assert.equal(mc.results['B-edge3'].bets, 2);
  assert.equal(mc.selected, 'B-edge3');
});

test('缺价警告带缺失率；最优价情景带 bestPrice 警告、沿用收盘选定策略', () => {
  const v = moneylineView(tinyReport, validateFilters({}, tinyReport));
  assert.deepEqual(v.coverage, { total: 4, priced: 3, missingRate: 0.25, missing: { noUsBook: 1 } });
  assert.deepEqual(v.warnings.find((w) => w.code === 'srv.ml.warn.missingPrices').params, { rate: 0.25 });

  const fb = validateFilters({ scenario: 'closeBest' }, tinyReport);
  assert.equal(fb.book, 'best');
  assert.equal(fb.strategy, 'B-edge3');
  const b = moneylineView(tinyReport, fb);
  assert.ok(codes(b).includes('srv.ml.warn.bestPrice'));
  assert.ok(codes(b).includes('srv.ml.warn.closingPrice'));
  assert.equal(b.labels.priceScenario, 'closeBest');
  assert.ok(b.bets.every((x) => x.flags.includes('bestPrice')));
  // 敏感性情景仍按预选策略给测试期结论
  assert.equal(b.verdict.code, 'srv.ml.verdict.test.tooFew');
});

test('currentAsClose 警告带场数；含训练期 2022-23 时带 inSample 警告', () => {
  const rep = { ...tinyReport, games: [...tinyReport.games, g('T5', '2025-26', '2025-11-04', 0.6, true, { draftkings: { open: null, close: null, current: [-110, -110] } })] };
  const v = moneylineView(rep, validateFilters({}, rep));
  assert.deepEqual(v.warnings.find((w) => w.code === 'srv.ml.warn.currentAsClose').params, { n: 1 });
  const all = moneylineView(tinyReport, validateFilters({ split: 'all' }, tinyReport));
  assert.ok(codes(all).includes('srv.ml.warn.inSample'));
  const tr = moneylineView(tinyReport, validateFilters({ split: 'train' }, tinyReport));
  assert.ok(codes(tr).includes('srv.ml.warn.inSample'));
  assert.equal(tr.labels.previouslySeen, false);
  assert.ok(!codes(tr).includes('srv.ml.warn.previouslySeen'));
});

test('开盘情景：不带收盘价警告；选定为 null 时结论为「无策略合格」', () => {
  const f = validateFilters({ scenario: 'open' }, tinyReport);
  assert.equal(f.strategy, null);
  const v = moneylineView(tinyReport, f);
  assert.ok(!codes(v).includes('srv.ml.warn.closingPrice'));
  assert.equal(v.strategy, null);
  assert.equal(v.summary.bets, 0);
  assert.equal(v.verdict.code, 'srv.ml.verdict.test.noStrategy');
  assert.equal(v.verdict.params.reason, 'noStrategyQualified');
  assert.equal(v.exploratory, false);
  assert.equal(v.multipleComparisons.selectOn, 'train');
});

test('closeBest：收盘未选出策略 → noStrategy（M6）', () => {
  const rep = { ...tinyReport, selected: { close: null, open: null } };
  const v = moneylineView(rep, validateFilters({ scenario: 'closeBest' }, rep));
  assert.equal(v.strategy, null);
  assert.equal(v.verdict.code, 'srv.ml.verdict.test.noStrategy');
});

test('探索性：非预选策略 / 非测试期 / 改成本 / 缩日期 → 无结论、exploratory true（M5）', () => {
  for (const body of [{ strategy: 'A-home' }, { split: 'validate' }, { split: 'all' }, { slippagePts: 5 }, { feeOnWin: 0.02 },
    { from: '2025-11-02' }, { book: 'draftkings' }]) {
    const v = moneylineView(tinyReport, validateFilters(body, tinyReport));
    assert.equal(v.verdict, null, JSON.stringify(body));
    assert.equal(v.exploratory, true, JSON.stringify(body));
  }
  // 测试期只有 2025-26：显式选这一季等于不筛
  const s = moneylineView(tinyReport, validateFilters({ season: '2025-26' }, tinyReport));
  assert.equal(s.exploratory, false);
  assert.equal(s.verdict.code, 'srv.ml.verdict.test.tooFew');
});

test('滑点与手续费进入结算', () => {
  const v = moneylineView(tinyReport, validateFilters({ slippagePts: 10, feeOnWin: 0.1 }, tinyReport));
  assert.deepEqual(v.bets.map((b) => b.american), [-120, 120]);
  assert.ok(Math.abs(v.summary.profit - 0.9 * (100 / 120 + 1.2)) < 1e-12);
});

test('validateFilters：非法情景 / 策略 / 滑点等报 err.badFilter 并指明字段', () => {
  const bad = (body, field) => assert.throws(() => validateFilters(body, tinyReport),
    (e) => e.code === 'err.badFilter' && e.params.field === field && /筛选条件不合法/.test(e.message), JSON.stringify(body));
  bad({ scenario: 'spread' }, 'scenario');
  bad({ slippagePts: 7 }, 'slippagePts');
  bad({ slippagePts: '5' }, 'slippagePts');
  bad({ strategy: 'Z-magic' }, 'strategy');
  bad({ strategy: FORWARD_PRIMARY }, 'strategy');   // 账本原样规则只属于前向
  bad({ split: 'holdout' }, 'split');
  bad({ season: '2025' }, 'season');
  bad({ from: '2025-13-01' }, 'from');
  bad({ to: 'tomorrow' }, 'to');
  bad({ from: '2025-11-03', to: '2025-11-01' }, 'to');
  bad({ book: 'betfair' }, 'book');
  bad({ book: 'best' }, 'book');                     // 最优价只能经 closeBest 情景（单独标注）
  bad({ scenario: 'forward', book: 'espnbet' }, 'book');
  bad({ feeOnWin: -0.1 }, 'feeOnWin');
  bad({ feeOnWin: 1 }, 'feeOnWin');
  bad({ lang: 'en' }, 'lang');                        // 未知字段同样明确报错
  assert.throws(() => validateFilters(null, tinyReport), (e) => e.code === 'err.badFilter' && e.params.field === 'body');
  assert.throws(() => validateFilters([], tinyReport), (e) => e.code === 'err.badFilter' && e.params.field === 'body');
  // 合法：单家、全部切分、前向两种标记
  assert.equal(validateFilters({ book: 'espnbet', split: 'all' }, tinyReport).book, 'espnbet');
  assert.equal(validateFilters({ scenario: 'forward' }, tinyReport).strategy, FORWARD_PRIMARY);
  assert.equal(validateFilters({ scenario: 'forward', strategy: FORWARD_SECONDARY }, tinyReport).strategy, 'B-edge3');
  assert.equal(validateFilters({ scenario: 'forward', book: 'draftkings' }, tinyReport).book, 'draftkings');
  // 没有报告时历史情景默认策略为 null，前向仍是预注册主规则
  assert.equal(validateFilters({}, null).strategy, null);
  assert.equal(validateFilters({ scenario: 'forward' }, null).strategy, FORWARD_PRIMARY);
});

test('筛选到 0 注：不抛错，summary.bets 0，结论 tooFew', () => {
  const v = moneylineView(tinyReport, validateFilters({ season: '2025-26', from: '2025-12-25', to: '2025-12-25' }, tinyReport));
  assert.equal(v.summary.bets, 0);
  assert.equal(v.ci.day, null);
  assert.equal(v.coverage.total, 0);
  assert.equal(v.coverage.missingRate, null);
  assert.equal(v.power.needed, null);
  assert.deepEqual(v.bets, []);
  assert.ok(codes(v).includes('srv.ml.warn.smallSample'));
  // 缩了日期 → 探索性，无正式结论；同样的 0 注在不缩日期时给 tooFew
  assert.equal(v.verdict, null);
  const rep = { ...tinyReport, games: tinyReport.games.filter((x) => x.season !== '2025-26') };
  const z = moneylineView(rep, validateFilters({}, rep));
  assert.equal(z.summary.bets, 0);
  assert.equal(z.verdict.code, 'srv.ml.verdict.test.tooFew');
});

test('逐注明细只给最近 200 注', () => {
  const many = Array.from({ length: 230 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 10, 1) + i * 86400e3).toISOString().slice(0, 10);
    return g(`M${String(i).padStart(3, '0')}`, '2025-26', d, 0.6, i % 2 === 0, dk([-110, -110]));
  });
  const rep = { ...tinyReport, games: many };
  const v = moneylineView(rep, validateFilters({}, rep));
  assert.equal(v.summary.bets, 230);
  assert.equal(v.bets.length, 200);
  assert.equal(v.bets[0].gameId, 'M030');
  assert.equal(v.bets[199].gameId, 'M229');
  assert.deepEqual(v.warnings.find((w) => w.code === 'srv.ml.warn.smallSample').params, { bets: 230, need: 300 });
});

test('同一输入重复计算，视图逐字节一致', () => {
  const f = validateFilters({}, tinyReport);
  assert.equal(JSON.stringify(moneylineView(tinyReport, f)), JSON.stringify(moneylineView(tinyReport, f)));
});

// ---------------------------------------------------------------------------
// 前向账本：临时库（绝不碰 data/app.db），经真实的 insertBets / settleBets 写入，再只读读回

const NOW = Date.parse('2026-11-01T12:00:00Z');
const slate = [
  { gameId: 'F1', date: '2026-11-01', tipoff: '2026-11-01T23:30:00Z', homeId: 1, awayId: 2, pHome: 0.62, odds: { provider: 'DraftKings', homeMl: -110, awayMl: -110 } },
  { gameId: 'F2', date: '2026-11-01', tipoff: '2026-11-01T23:30:00Z', homeId: 3, awayId: 4, pHome: 0.40, odds: { provider: 'DraftKings', homeMl: -150, awayMl: 130 } },
  { gameId: 'F3', date: '2026-11-01', tipoff: '2026-11-02T00:30:00Z', homeId: 5, awayId: 6, pHome: 0.55, odds: { provider: 'DraftKings', homeMl: -200, awayMl: 170 } },
];
function tmpLedger() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ml-fwd-')), 'ledger.db');
  const db = openLedger(dbPath);
  assert.ok(db, '临时账本打不开');
  assert.equal(insertBets(db, captureRows(slate, { now: NOW })), 9);   // 3 场 × edge0/3/6
  // F1 主胜、F2 主胜（押客输）；F3 未结算
  settleBets(db, { F1: { homeScore: 110, awayScore: 100, close: [-120, 100] }, F2: { homeScore: 105, awayScore: 99, close: [-160, 140] } }, '2026-11-02T08:00:00Z');
  db.close();
  return dbPath;
}

test('前向账本：只取已结算的早规则行，未结算计 pending；概率原样、模型版本 production-logged', () => {
  const dbPath = tmpLedger();
  const rows = readLedgerRows(dbPath);
  assert.equal(rows.length, 9);
  const fwd = forwardCandidates(rows);
  assert.equal(fwd.candidates.length, 2);
  assert.equal(fwd.pending, 1);
  const r1 = rows.find((r) => r.game_id === 'F1' && r.rule === 'edge0');
  const c1 = fwd.candidates[0];
  assert.equal(c1.pHome, r1.model_p_home);
  assert.deepEqual([c1.gameId, c1.date, c1.season, c1.split, c1.modelVersion, c1.paramsVersion, c1.priceAt, c1.scenario],
    ['F1', '2026-11-01', '2026-27', 'test', 'production-logged', 'production', 'current', 'forward']);
  assert.deepEqual(c1.books, ['draftkings', 'draftkings']);
  assert.deepEqual(c1.ml, [-110, -110]);
  assert.deepEqual(c1.closeMl, [-120, 100]);
  assert.equal(c1.capturedAt, r1.captured_at);
  assert.equal(c1.tipoff, '2026-11-01T23:30:00Z');
  assert.deepEqual([c1.homeWin, c1.actual], [true, 10]);
  // 账本自己记下的 edge3 决定原样带上
  assert.deepEqual([c1.logged.rule, c1.logged.bet, c1.logged.side, c1.logged.betMl], ['edge3', 1, 'home', -110]);

  // 主结果：账本 edge3 原样
  const v = moneylineView(tinyReport, validateFilters({ scenario: 'forward' }, tinyReport), { forward: fwd });
  assert.equal(v.strategy, FORWARD_PRIMARY);
  assert.deepEqual([v.labels.historical, v.labels.modelVersion, v.labels.previouslySeen, v.labels.forwardBasis], [false, 'production-logged', false, 'asLogged']);
  assert.deepEqual(v.coverage, { total: 2, priced: 2, missingRate: 0, missing: {}, pending: 1 });
  assert.deepEqual(v.bets.map((b) => [b.gameId, b.side, b.quoted, b.result, b.strategy]),
    [['F1', 'home', -110, 'win', FORWARD_PRIMARY], ['F2', 'away', 130, 'loss', FORWARD_PRIMARY]]);
  // 0 成本时盈亏与账本记下的 profit 完全一致
  const logged = rows.filter((r) => r.rule === 'edge3' && r.settled_at && r.bet).reduce((s, r) => s + r.profit, 0);
  assert.ok(Math.abs(v.summary.profit - logged) < 1e-12);
  assert.equal(v.verdict.code, 'srv.ml.verdict.live.tooFew');
  assert.equal(v.exploratory, false);
  assert.ok(!codes(v).includes('srv.ml.warn.closingPrice'));
  assert.ok(!codes(v).includes('srv.ml.warn.previouslySeen'));
  // 账本原样规则作为一行出现在策略表里（不可选），前向不做选择
  assert.deepEqual(v.strategies[0], { ...v.strategies[0], id: FORWARD_PRIMARY, family: 'ledger', bets: 2, selectable: false });
  assert.equal(v.selected, FORWARD_PRIMARY);
  assert.equal(v.multipleComparisons.tried, 0);

  // 次要结果：按盈亏平衡重算的 B-edge3，单独标注、无正式结论
  const s = moneylineView(tinyReport, validateFilters({ scenario: 'forward', strategy: FORWARD_SECONDARY }, tinyReport), { forward: fwd });
  assert.equal(s.strategy, 'B-edge3');
  assert.equal(s.labels.forwardBasis, 'recomputed');
  assert.equal(s.verdict, null);
  assert.equal(s.exploratory, true);
  assert.equal(s.summary.bets, 2);
});

test('前向账本：真实适配结果经 qualityOk 合格，C-ev 能下注（字段名不对会静默变 0 注）', () => {
  const fwd = forwardCandidates(readLedgerRows(tmpLedger()));
  assert.ok(fwd.candidates.length > 0);
  assert.ok(fwd.candidates.every(qualityOk));
  const v = moneylineView(tinyReport, validateFilters({ scenario: 'forward', strategy: 'C-ev' }, tinyReport), { forward: fwd });
  assert.equal(v.summary.bets, 2);
  // 开赛后抓的价不合格（门槛真的在起作用）
  const late = fwd.candidates.map((c) => ({ ...c, capturedAt: '2026-11-02T01:00:00Z' }));
  assert.ok(late.every((c) => !qualityOk(c)));
});

test('前向账本：晚规则只取 edge3-late 行；读库为只读', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ml-fwd-')), 'ledger.db');
  const db = openLedger(dbPath);
  const lateNow = Date.parse('2026-11-01T22:30:00Z');
  insertBets(db, captureRows(slate, { now: NOW }));
  insertBets(db, captureRows(slate.map((x) => ({ ...x, odds: { ...x.odds, homeMl: -115, awayMl: -105 } })), { now: lateNow, run: 'late', oddsFetchedAt: '2026-11-01T22:00:00Z' }));
  settleBets(db, { F1: { homeScore: 110, awayScore: 100, close: null } }, '2026-11-02T08:00:00Z');
  db.close();
  const rows = readLedgerRows(dbPath);
  const late = forwardCandidates(rows, { run: 'late' });
  assert.equal(late.candidates.length, 1);
  assert.equal(late.pending, 2);
  assert.deepEqual([late.candidates[0].ml, late.candidates[0].logged.rule], [[-115, -105], 'edge3-late']);
  assert.throws(() => forwardCandidates(rows, { run: 'noon' }), /run/);
  // 晚规则不是预注册主规则 → 探索性
  const v = moneylineView(tinyReport, validateFilters({ scenario: 'forward' }, tinyReport), { forward: late });
  assert.equal(v.verdict, null);
  assert.equal(v.exploratory, true);
  // 只读读取不改库（行数不变）；库文件不存在时抛错（readOnly 不会新建库）
  assert.equal(readLedgerRows(dbPath).length, rows.length);
  assert.throws(() => readLedgerRows(path.join(os.tmpdir(), 'nope-ml-fwd', 'missing.db')));
});

test('前向：日期筛选与切分筛选作用在账本上；无账本数据时 0 注不抛错', () => {
  const fwd = forwardCandidates(readLedgerRows(tmpLedger()));
  const none = moneylineView(tinyReport, validateFilters({ scenario: 'forward', split: 'validate' }, tinyReport), { forward: fwd });
  assert.equal(none.summary.bets, 0);
  const d = moneylineView(tinyReport, validateFilters({ scenario: 'forward', from: '2026-11-02' }, tinyReport), { forward: fwd });
  assert.equal(d.summary.bets, 0);
  assert.equal(d.verdict, null);
  const empty = moneylineView(tinyReport, validateFilters({ scenario: 'forward' }, tinyReport));
  assert.equal(empty.summary.bets, 0);
  assert.equal(empty.coverage.pending, 0);
  assert.equal(empty.verdict.code, 'srv.ml.verdict.live.tooFew');
});
