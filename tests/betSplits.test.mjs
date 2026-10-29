import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  SPLITS, SELECTABLE, FORWARD_PRIMARY, FORWARD_SECONDARY, splitsFor,
  splitOf, selectStrategy, selectionScenario, selectForScenario, multipleComparisons,
} from '../server/betSplits.mjs';
import { STRATEGIES } from '../server/betStrategies.mjs';
import { buildCandidates } from '../server/betBacktest.mjs';
import { walkForward } from '../server/walkForward.mjs';
import { rng } from '../server/fusionLab.mjs';

test('切分：收盘 / 开盘 / 前向', () => {
  assert.deepEqual(['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'].map((s) => splitOf('close', s)), [null, 'train', 'validate', 'validate', 'test']);
  assert.deepEqual(['2022-23', '2023-24', '2024-25', '2025-26'].map((s) => splitOf('open', s)), [null, 'train', 'validate', 'test']);
  assert.equal(splitOf('closeBest', '2023-24'), 'validate');
  // 前向赛季不写死（随目标赛季由 splitsFor 填入）；历史赛季不属于前向
  assert.equal(splitOf('forward', '2026-27'), null);
  assert.equal(splitOf('forward', '2025-26'), null);
  // closeBest 沿用 close 的切分
  assert.deepEqual(['2022-23', '2025-26'].map((s) => splitOf('closeBest', s)), ['train', 'test']);
  assert.throws(() => splitOf('nope', '2023-24'), /情景/);
});

test('SPLITS：选择期、测试期「已被看过」标注、前向不选', () => {
  assert.deepEqual(SPLITS.close, { train: ['2022-23'], validate: ['2023-24', '2024-25'], test: ['2025-26'], selectOn: 'validate', previouslySeen: ['2025-26'] });
  assert.deepEqual(SPLITS.open, { train: ['2023-24'], validate: ['2024-25'], test: ['2025-26'], selectOn: 'train', previouslySeen: ['2025-26'] });
  assert.deepEqual(SPLITS.forward, { train: [], validate: [], test: [], selectOn: null, previouslySeen: [] });
  assert.ok(Object.isFrozen(SPLITS) && Object.isFrozen(SPLITS.close) && Object.isFrozen(SPLITS.close.validate));
  // 每个情景的选择期都不与测试期重叠
  for (const k of ['close', 'open']) {
    const sel = SPLITS[k][SPLITS[k].selectOn];
    assert.equal(sel.filter((s) => SPLITS[k].test.includes(s)).length, 0, k);
  }
});

test('SELECTABLE 与 STRATEGIES 一致：只有固定金额 B/C 参与选择', () => {
  assert.deepEqual(SELECTABLE, ['B-edge2', 'B-edge3', 'B-edge5', 'B-edge7', 'B-edge10', 'C-ev']);
  const fam = Object.fromEntries(STRATEGIES.map((s) => [s.id, s.family]));
  assert.deepEqual(SELECTABLE.map((id) => fam[id]), ['B', 'B', 'B', 'B', 'B', 'C']);
});

test('selectStrategy：注数不足的排除，并列取靠前者', () => {
  assert.equal(selectStrategy({ 'B-edge2': { bets: 500, roi: 0.01 }, 'B-edge3': { bets: 300, roi: 0.03 }, 'B-edge5': { bets: 80, roi: 0.08 }, 'C-ev': { bets: 600, roi: 0.03 } }), 'B-edge3');
  assert.equal(selectStrategy({ 'B-edge5': { bets: 80, roi: 0.08 } }), null);
  // 并列与输入键顺序无关：C-ev 写在前面，仍取 SELECTABLE 中靠前的 B-edge3
  assert.equal(selectStrategy({ 'C-ev': { bets: 600, roi: 0.03 }, 'B-edge3': { bets: 300, roi: 0.03 } }), 'B-edge3');
  // 恰好 100 注合格、99 注不合格；minBets 可配置
  assert.equal(selectStrategy({ 'B-edge7': { bets: 100, roi: 0.02 }, 'B-edge2': { bets: 99, roi: 0.5 } }), 'B-edge7');
  assert.equal(selectStrategy({ 'B-edge7': { bets: 100, roi: 0.02 } }, { minBets: 101 }), null);
  // 非 SELECTABLE（A 对照、D 资金管理）即使 ROI 更高也不参与；roi null / NaN 不参与
  assert.equal(selectStrategy({ 'A-model': { bets: 1000, roi: 0.9 }, 'D-kelly-full': { bets: 1000, roi: 0.9 }, 'B-edge10': { bets: 200, roi: -0.04 } }), 'B-edge10');
  assert.equal(selectStrategy({ 'B-edge2': { bets: 500, roi: null }, 'B-edge3': { bets: 500, roi: Number.NaN } }), null);
  // 全为负 ROI 仍选最高者（是否「有证据」由测试期结论标准决定，不在这里）
  assert.equal(selectStrategy({ 'B-edge2': { bets: 500, roi: -0.05 }, 'B-edge3': { bets: 400, roi: -0.02 } }), 'B-edge3');
  assert.equal(selectStrategy({}), null);
});

test('前向主规则（M3）：账本原样记录的 edge3，不从历史中挑；B-edge3 重算只作次要', () => {
  assert.equal(FORWARD_PRIMARY, 'ledger-edge3');
  assert.equal(FORWARD_SECONDARY, 'B-edge3');
  assert.ok(!STRATEGIES.some((s) => s.id === FORWARD_PRIMARY), '主规则不是可重算的历史策略');
  const sel = selectForScenario([{ season: '2026-27' }], 'forward');
  assert.deepEqual(sel, { scenario: 'forward', selectOn: null, seasons: [], selected: FORWARD_PRIMARY, source: 'pre-registered', results: {}, tried: 0 });
});

test('selectionScenario（M6）：最优价敏感性不单独选择，沿用收盘情景', () => {
  assert.deepEqual(['close', 'open', 'closeBest', 'forward'].map(selectionScenario), ['close', 'open', 'close', null]);
  assert.throws(() => selectForScenario([], 'closeBest'), /closeBest/);
});

test('多重比较（M9）：按选择期比较过的不同策略配置计数，不按策略×切分行数', () => {
  const m = multipleComparisons([{ id: 'B-edge2', split: 'validate' }, { id: 'B-edge3', split: 'validate' }, { id: 'C-ev', split: 'validate' }, { id: 'B-edge3', split: 'test' }]);
  assert.equal(m.tried, 3); assert.ok(Math.abs(m.bonferroniAlpha - 0.05 / 3) < 1e-12);
  assert.equal(m.rows.length, 4);   // 清单列出全部行
  assert.deepEqual(m.rows.map((r) => r.inSelection), [true, true, true, false]);
  // 开盘情景在 train 上选：指定 selectSplit 后只数该切分
  const o = multipleComparisons([
    ...SELECTABLE.map((id) => ({ id, split: 'train' })), ...SELECTABLE.map((id) => ({ id, split: 'validate' })), { id: 'B-edge3', split: 'test' },
  ], { selectSplit: 'train' });
  assert.equal(o.tried, 6); assert.ok(Math.abs(o.bonferroniAlpha - 0.05 / 6) < 1e-12);
  assert.equal(o.rows.filter((r) => r.inSelection).length, 6);
  // 收盘情景两季验证期各一行：同一策略不重复计数
  const c = multipleComparisons(SELECTABLE.flatMap((id) => [{ id, split: 'validate' }, { id, split: 'validate' }]), { selectSplit: 'validate' });
  assert.equal(c.tried, 6);
  // 只有测试期 / 空：未做选择，α 不校正
  assert.deepEqual([multipleComparisons([{ id: 'B-edge3', split: 'test' }]).tried, multipleComparisons([]).bonferroniAlpha], [0, 0.05]);
  assert.ok(Math.abs(multipleComparisons(SELECTABLE.map((id) => ({ id, split: 'validate' })), { alpha: 0.1 }).bonferroniAlpha - 0.1 / 6) < 1e-12);
});

// ---- 端到端：提交在库的真实裁剪件 + 测试里确定性生成的小价格表 ----
const FIXTURE = fileURLToPath(new URL('./fixtures/backtest-mini.json.gz', import.meta.url));
const loadFixture = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'));

const toAmerican = (q) => (q >= 0.5 ? -Math.round((100 * q) / (1 - q)) : Math.round((100 * (1 - q)) / q));
/** 每场一家 DK：市场概率 = 模型概率 + 固定种子噪声，两边各加 2.25% 水；2023-24 起才有 open */
function priceTable(records) {
  const rand = rng(7);
  const table = new Map();
  for (const r of records) {
    const noise = (rand() - 0.5) * 0.3;
    const q = Math.min(0.9, Math.max(0.1, r.pWF + noise));
    const line = (x) => [toAmerican(x + 0.0225), toAmerican(1 - x + 0.0225)];
    const qOpen = Math.min(0.9, Math.max(0.1, q + (rand() - 0.5) * 0.04));
    table.set(r.gameId, { draftkings: { open: r.season === '2022-23' ? null : line(qOpen), close: line(q), current: null } });
  }
  return table;
}
const gamesOf = (records, table) => records.map((r) => ({ ...r, pHome: r.pWF, void: false, books: table.get(r.gameId) }));

function selectionFor(ds, table, scenario) {
  const wf = walkForward(ds);
  const { candidates } = buildCandidates(gamesOf(wf.records, table), { scenario, splitOf: (s) => splitOf(scenario, s) });
  return { sel: selectForScenario(candidates, scenario), candidates };
}

test('选择从不读测试期结果：改动 2025-26 的比分与胜负，selected 与选择期结果完全不变', () => {
  const ds = loadFixture();
  const table = priceTable(walkForward(ds).records);
  const altered = structuredClone(ds);
  for (const g of altered.seasons['2025-26']) { const [x, y] = g.s; [x[1], y[1]] = [y[1], x[1]]; }

  for (const scenario of ['close', 'open']) {
    const a = selectionFor(ds, table, scenario);
    const b = selectionFor(altered, table, scenario);
    // 非空检验：测试期胜负确实被改了
    const testWins = (cs) => cs.filter((c) => c.season === '2025-26').map((c) => c.homeWin);
    const wa = testWins(a.candidates); const wb = testWins(b.candidates);
    assert.equal(wa.length, 1230);
    assert.ok(wa.filter((w, i) => w !== wb[i]).length > 1000, `${scenario} 测试期胜负应大面积改变`);

    assert.deepEqual(b.sel, a.sel, scenario);
    assert.equal(a.sel.scenario, scenario);
    assert.equal(a.sel.tried, 6);
    assert.deepEqual(Object.keys(a.sel.results), SELECTABLE);
    assert.deepEqual(a.sel.seasons, scenario === 'close' ? ['2023-24', '2024-25'] : ['2023-24']);
    assert.equal(a.sel.selectOn, scenario === 'close' ? 'validate' : 'train');
    assert.ok(SELECTABLE.includes(a.sel.selected), `${scenario} selected=${a.sel.selected}`);
    assert.equal(a.sel.selected, selectStrategy(a.sel.results));
    for (const id of SELECTABLE) assert.ok(a.sel.results[id].bets > 0, `${scenario} ${id}`);
  }
});

test('选择只用选择期：测试期候选被直接改写/删除也不影响；改动选择期结果则结果变化（非空检验）', () => {
  const wf = walkForward(loadFixture());
  const table = priceTable(wf.records);
  const { candidates } = buildCandidates(gamesOf(wf.records, table), { scenario: 'close', splitOf: (s) => splitOf('close', s) });
  const base = selectForScenario(candidates, 'close');

  // 测试期全部翻转胜负，或干脆删除；候选上的 split 字段被篡改成 validate 也无效（按赛季重新判定）
  const flipped = candidates.map((c) => (c.season === '2025-26' ? { ...c, homeWin: !c.homeWin, actual: -c.actual, split: 'validate' } : c));
  assert.deepEqual(selectForScenario(flipped, 'close'), base);
  assert.deepEqual(selectForScenario(candidates.filter((c) => c.season !== '2025-26'), 'close'), base);
  // 训练期（2022-23，样本内）也不参与收盘情景的选择
  assert.deepEqual(selectForScenario(candidates.filter((c) => c.season !== '2022-23'), 'close'), base);

  // 非空检验：翻转验证期胜负，选择期 ROI 必然改变
  const flipVal = candidates.map((c) => (c.season === '2024-25' ? { ...c, homeWin: !c.homeWin, actual: -c.actual } : c));
  const other = selectForScenario(flipVal, 'close');
  assert.notDeepEqual(other.results, base.results);
});

test('无策略达到 100 注（M6）：selected = null，结果照常列出', () => {
  const wf = walkForward(loadFixture());
  const table = priceTable(wf.records);
  const { candidates } = buildCandidates(gamesOf(wf.records, table), { scenario: 'open', splitOf: (s) => splitOf('open', s) });
  const few = candidates.filter((c) => c.season !== '2023-24' || c.date < '2023-10-27');
  const sel = selectForScenario(few, 'open');
  assert.equal(sel.selected, null);
  assert.ok(SELECTABLE.every((id) => sel.results[id].bets < 100));
  assert.deepEqual(Object.keys(sel.results), SELECTABLE);
  // minBets 可下调，此时可以选出
  assert.ok(SELECTABLE.includes(selectForScenario(few, 'open', { minBets: 1 }).selected));
});

test('splitsFor：前向测试期 = 给定的目标赛季，历史切分不变；非法赛季 → 前向留空', () => {
  const sp = splitsFor('2027-28');
  assert.deepEqual(sp.forward.test, ['2027-28']);
  assert.deepEqual(sp.close, SPLITS.close);
  assert.deepEqual(sp.open, SPLITS.open);
  assert.ok(Object.isFrozen(sp.forward.test));
  assert.deepEqual(splitsFor(undefined).forward.test, []);
  assert.deepEqual(SPLITS.forward.test, []);   // 不改共享常量
});
