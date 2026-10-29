import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTER_KEYS, SCENARIOS, SLIPPAGE_OPTIONS, modelOf, scenariosOf, bookOptions, splitOptions, seasonsOf,
  defaultState, withScenario, bookLabelKey, shownScenario, withModel, withSplit, toFilters, clvNotApplicable, domainOf, linear, ciDomain,
} from '../web/src/lib/moneylineUi.js';
import * as view from '../server/moneylineView.mjs';
import { splitsFor } from '../server/betSplits.mjs';

const splits = JSON.parse(JSON.stringify(splitsFor('2026-27')));   // 同 meta.splits 的 JSON 形状（前向赛季 = 服务端目标赛季）

test('前端常量与服务端一致', () => {
  assert.deepEqual(FILTER_KEYS, view.FILTER_KEYS);
  assert.deepEqual(SCENARIOS, view.SCENARIOS);
  assert.deepEqual(SLIPPAGE_OPTIONS, view.SLIPPAGE_OPTIONS);
});

test('默认状态 → 请求体只有 scenario / split / slippagePts，且能通过服务端校验得到默认口径', () => {
  const f = toFilters(defaultState());
  assert.deepEqual(f, { scenario: 'close', split: 'test', slippagePts: 0 });
  const v = view.validateFilters(f, { selected: { close: 'B-edge7' } });
  assert.equal(v.book, 'chain');
  assert.equal(v.strategy, 'B-edge7');
});

test('toFilters：只发 Filters 字段，省略空值与默认博彩公司，滑点保持数字', () => {
  const f = toFilters({ ...defaultState(), model: 'replay', extra: 1, season: '', from: '2025-11-01', book: 'betmgm', slippagePts: '5', strategy: 'B-edge3' });
  assert.deepEqual(f, { scenario: 'close', split: 'test', slippagePts: 5, from: '2025-11-01', strategy: 'B-edge3', book: 'betmgm' });
  for (const k of Object.keys(f)) assert.ok(FILTER_KEYS.includes(k));
  assert.equal(toFilters({ ...defaultState(), scenario: 'closeBest', book: 'best' }).book, undefined);
});

test('模型版本决定可选情景；换情景时博彩公司与策略回默认、切分与赛季按范围修正', () => {
  assert.equal(modelOf('forward'), 'production');
  assert.equal(modelOf('closeBest'), 'replay');
  assert.deepEqual(scenariosOf('production'), ['forward']);
  assert.deepEqual(scenariosOf('replay'), ['close', 'open', 'closeBest']);

  const s0 = { ...defaultState(), split: 'train', season: '2022-23', book: 'betmgm', strategy: 'B-edge3' };
  const fwd = withModel(s0, 'production', splits);
  assert.equal(fwd.scenario, 'forward');
  assert.equal(fwd.split, 'test');          // 前向没有训练期
  assert.equal(fwd.season, null);
  assert.equal(fwd.book, 'chain');
  assert.equal(fwd.strategy, null);
  assert.equal(withModel(s0, 'replay', splits), s0);   // 已是该模型：不变

  const best = withScenario(s0, 'closeBest', splits);
  assert.equal(best.book, 'best');
  assert.equal(best.split, 'train');
  assert.equal(best.season, '2022-23');       // closeBest 沿用 close 切分
  const open = withScenario(s0, 'open', splits);
  assert.equal(open.season, null);            // 开盘情景训练期是 2023-24
});

test('可选项：博彩公司、切分、赛季', () => {
  assert.deepEqual(bookOptions('closeBest', ['draftkings']), ['best']);
  assert.deepEqual(bookOptions('forward', ['draftkings', 'betmgm']), ['chain']);
  assert.equal(bookLabelKey('forward', 'chain'), 'lab.beat.filter.forwardBook');
  assert.equal(bookLabelKey('close', 'chain'), 'lab.beat.filter.chain');
  assert.equal(bookLabelKey('close', 'betmgm'), 'board.book.betmgm');
  assert.deepEqual(bookOptions('close', ['draftkings', 'betmgm']), ['chain', 'draftkings', 'betmgm']);
  assert.deepEqual(splitOptions('forward'), ['test', 'all']);
  assert.deepEqual(seasonsOf('close', 'validate', splits), ['2023-24', '2024-25']);
  assert.deepEqual(seasonsOf('closeBest', 'all', splits), ['2022-23', '2023-24', '2024-25', '2025-26']);
  assert.deepEqual(seasonsOf('forward', 'test', splits), ['2026-27']);
  assert.deepEqual(seasonsOf('close', 'test', undefined), []);
  const s = withSplit({ ...defaultState(), season: '2025-26' }, 'validate', splits);
  assert.equal(s.season, null);
});

test('CLV 在收盘价情景不适用', () => {
  assert.equal(clvNotApplicable('close'), true);
  assert.equal(clvNotApplicable('closeBest'), true);
  assert.equal(clvNotApplicable('open'), false);
  assert.equal(clvNotApplicable('forward'), false);
});

test('比例尺：数值域含额外值、全等时扩宽、无值为 null；线性映射按比例', () => {
  assert.deepEqual(domainOf([3, 5], [0]), [0, 5]);
  assert.deepEqual(domainOf([2, 2]), [1, 3]);
  assert.equal(domainOf([null, NaN]), null);
  assert.deepEqual(ciDomain([{ value: -0.1, lo: -0.2, hi: 0.03 }, { value: null, lo: null, hi: null }]), [-0.2, 0.03]);
  assert.deepEqual(ciDomain([{ value: 0.1, lo: 0.05, hi: 0.2 }]), [0, 0.2]);
  const x = linear([-0.2, 0.2], [0, 400]);
  assert.equal(x(0), 200);
  assert.equal(x(-0.2), 0);
  assert.ok(Math.abs(x(0.1) - 300) < 1e-9);
  const y = linear([0, 1], [100, 0]);          // 倒置值域（SVG 纵轴）
  assert.equal(y(0.25), 75);
});

test('结果区按已显示视图的情景标注：加载新筛选时旧视图不被新情景的来源条冒认', () => {
  const st = { ...defaultState(), scenario: 'forward' };
  assert.equal(shownScenario({ filters: { scenario: 'close' } }, st), 'close');   // 旧视图仍是收盘情景
  assert.equal(shownScenario({ filters: { scenario: 'forward' } }, st), 'forward');
  assert.equal(shownScenario(null, st), 'forward');                              // 还没有视图
  assert.equal(shownScenario({ available: false }, st), 'forward');              // 前向不可用的回应没有 filters
});

test('报告缺失文案对访客中性：不让访客去跑 npm（运维提示只进服务端日志）', async () => {
  const zh = (await import('../web/src/i18n/locales/zh.js')).default;
  const en = (await import('../web/src/i18n/locales/en.js')).default;
  for (const loc of [zh, en]) {
    const text = loc.srv.ml.reason.noData;
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text, /npm|ml:backtest|run /i);
  }
  assert.equal(zh.srv.ml.reason.noData, '回测报告尚未生成。');
  assert.equal(en.srv.ml.reason.noData, 'The backtest report has not been generated yet.');
});
