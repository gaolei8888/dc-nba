import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildMoneylineReport } from '../server/moneylineReport.mjs';
import { moneylineView, validateFilters } from '../server/moneylineView.mjs';
import { MODEL_VERSION_REPLAY } from '../server/walkForward.mjs';
import { SELECTABLE, SPLITS, MIN_SELECT_BETS } from '../server/betSplits.mjs';

// 提交在库里的裁剪件（data/ 下的真实文件被 gitignore，测试不读）：裁剪赛季数据 + 与之对应的小份钱线缓存
const fx = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)))).toString('utf8'));
const loadInputs = () => ({ dataset: fx('backtest-mini.json.gz'), books: fx('books/mini-cache.json.gz'), inputsSha: { 'backtest.json': 'test', 'books': 'test' } });

test('同一输入两次结果逐字节一致（逐注流水与 ROI 可复现）', () => {
  const a = JSON.stringify(buildMoneylineReport(loadInputs()));
  const b = JSON.stringify(buildMoneylineReport(loadInputs()));
  assert.equal(a, b);
  const r = JSON.parse(a);
  assert.equal(r.version, 1);
  assert.ok(!('builtAt' in r));
  assert.deepEqual(Object.keys(r), ['version', 'inputs', 'fits', 'integrity', 'games', 'selected', 'selection', 'headline', 'perBook', 'slippage']);
  assert.equal(r.games.length, 4 * 1230);
  assert.ok(r.games.every((g) => g.modelVersion === MODEL_VERSION_REPLAY && g.season !== '2021-22'));
  assert.deepEqual(r.fits.map((f) => f.season), ['2022-23', '2023-24', '2024-25', '2025-26']);
  assert.equal(r.integrity.length, 4);
  // 视图可直接消费这份报告
  for (const scenario of ['close', 'open', 'closeBest']) {
    const v = moneylineView(r, validateFilters({ scenario }, r));
    assert.equal(v.labels.modelVersion, MODEL_VERSION_REPLAY);
  }
});

test('选择：每个历史情景都有键；只在选择期、SELECTABLE 内、minBets 用共享常量；多重比较计数 = 6', () => {
  const r = buildMoneylineReport(loadInputs());
  assert.equal(MIN_SELECT_BETS, 100);
  for (const s of ['close', 'open']) {
    assert.ok(Object.hasOwn(r.selected, s));
    assert.ok(r.selected[s] === null || SELECTABLE.includes(r.selected[s]), `${s}=${r.selected[s]}`);
    const sel = r.selection[s];
    assert.equal(sel.selectOn, SPLITS[s].selectOn);
    assert.deepEqual(sel.seasons, SPLITS[s][SPLITS[s].selectOn]);
    assert.equal(sel.tried, 6);
    assert.equal(sel.minBets, MIN_SELECT_BETS);
    assert.deepEqual(sel.rows.map((x) => x.id), SELECTABLE);
    assert.ok(sel.rows.every((x) => x.split === SPLITS[s].selectOn && x.inSelection === true));
    assert.equal(sel.selected, r.selected[s]);
    // 选定者在合格者中 ROI 最高
    if (r.selected[s]) {
      const best = sel.rows.filter((x) => x.bets >= MIN_SELECT_BETS).reduce((m, x) => Math.max(m, x.roi), -Infinity);
      assert.equal(sel.rows.find((x) => x.id === r.selected[s]).roi, best);
    }
  }
  assert.equal(r.headline.close.tried, 6);
});

test('选择只看选择期：2025-26 结果全翻 → selected 与选择行不变，headline 变', () => {
  const inp = loadInputs();
  const flipped = structuredClone(inp);
  for (const g of flipped.dataset.seasons['2025-26']) { const [x, y] = g.s; [x[1], y[1]] = [y[1], x[1]]; }
  const a = buildMoneylineReport(inp);
  const b = buildMoneylineReport(flipped);
  assert.deepEqual(b.selected, a.selected);
  assert.deepEqual(b.selection, a.selection);
  const key = (r) => JSON.stringify([r.headline.close.roi, r.headline.close.bets, r.headline.open.roi]);
  assert.notEqual(key(a), key(b));
  // 非空检验：测试期有注
  assert.ok(a.headline.close.strategy === null || a.headline.close.bets > 0);
});

test('games 方向已对齐我们的主客：ESPN 主客相反的场次钱线已对调；缺缓存的场次无价；2021-22 不出现', () => {
  const inp = loadInputs();
  const r = buildMoneylineReport(inp);
  const byId = new Map(r.games.map((g) => [g.gameId, g]));
  let flipped = 0; let checked = 0; let noCache = 0;
  for (const [season, c] of Object.entries(inp.books)) {
    for (const [id, e] of Object.entries(c.games)) {
      const g = byId.get(id);
      const dk = e.items.find((i) => i.name === 'DraftKings');
      if (e.home === g.homeId) {
        assert.deepEqual(g.books.draftkings.close, dk.close, id);
      } else {
        assert.equal(e.home, g.awayId);
        assert.deepEqual(g.books.draftkings.close, [dk.close[1], dk.close[0]], `${season} ${id}`);
        flipped += 1;
      }
      checked += 1;
    }
  }
  for (const g of r.games) if (!inp.books[g.season].games[g.gameId]) { assert.deepEqual(g.books, {}); noCache += 1; }
  assert.ok(flipped > 100, `flipped=${flipped}`);
  assert.ok(noCache > 100 && checked + noCache === 4 * 1230);
  assert.deepEqual([...new Set(r.games.map((g) => g.season))], ['2022-23', '2023-24', '2024-25', '2025-26']);
  // 完整性审计也看到了反向场次
  assert.equal(r.integrity.reduce((s, a) => s + a.flipped, 0), flipped);
});

test('perBook / slippage / headline 结构：滑点三档单调不升，数字与视图一致', () => {
  const r = buildMoneylineReport(loadInputs());
  for (const s of ['close', 'open']) {
    const rows = r.slippage.filter((x) => x.scenario === s);
    assert.deepEqual(rows.map((x) => x.slippagePts), [0, 5, 10]);
    if (r.selected[s]) {
      assert.ok(rows[0].roi >= rows[1].roi && rows[1].roi >= rows[2].roi, JSON.stringify(rows));
      const v = moneylineView(r, validateFilters({ scenario: s }, r));
      assert.equal(rows[0].bets, v.summary.bets);
      assert.equal(rows[0].roi, v.summary.roi);
      assert.equal(r.headline[s].roi, v.summary.roi);
      assert.deepEqual(r.headline[s].ci, v.ci);
      assert.equal(r.headline[s].verdict.code, v.verdict.code);
    }
  }
  assert.ok(r.perBook.length > 0);
  assert.ok(r.perBook.every((x) => ['close', 'open'].includes(x.scenario) && typeof x.book === 'string' && x.coverage > 0));
  assert.ok(r.perBook.some((x) => x.book === 'draftkings'));
});

test('选择非空检验：夹具里至少一个情景选出了策略（否则上面的断言形同虚设）', () => {
  const r = buildMoneylineReport(loadInputs());
  assert.ok(Object.values(r.selected).some((x) => x != null), JSON.stringify(r.selected));
  assert.ok(r.slippage.length >= 3 && r.perBook.length >= 3);
});
