// 服务端消息码的前端渲染：中文与改造前逐字一致（快照在改代码前生成），英文无中文、数字相同、诚实表述直白
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zh from '../web/src/i18n/locales/zh.js';
import en from '../web/src/i18n/locales/en.js';
import { createFormat } from '../web/src/i18n/fmt.js';
import { lookup } from '../web/src/i18n/core.js';
import { renderMsg, createMsgT, rosterSourceMsg } from '../web/src/i18n/msg.js';
import { msg } from '../server/messages.mjs';
import { buildBoard, SPLITS, MIN_MARKET } from '../server/predictionBoard.mjs';
import { verdictOf, verdictMsg, paperHeadlineMsg, PAPER_LINE_CODE } from '../server/paperBetting.mjs';
import { SLICE_DEFS, GAP_SLICE_DEFS, EDGE_BUCKETS } from '../server/lab.mjs';
import { FACTOR_KEYS } from '../server/predict.mjs';
import { liveRosterRankings, PRIOR_SOURCES, TARGET_KINDS } from '../server/liveRosterRankings.mjs';
import { boardFixtures, verdictCases, rosterSourceStore, rosterLegacy, MIN_MARKET_FIXTURE } from './fixtures/msgFixtures.mjs';

const snap = JSON.parse(fs.readFileSync(new URL('./fixtures/board-summary-zh.json', import.meta.url), 'utf8'));
const CJK = /[㐀-鿿＀-￯　-〿]/;

const makeT = (lang, teamById) => {
  const locale = lang === 'zh' ? zh : en;
  const tz = locale.meta.defaultTz;
  const fmt = createFormat({ locale, fallback: zh, tz, teamById });
  const warnings = [];
  const t = createMsgT({ dict: locale, fallback: zh, lang, formatters: fmt.formatters, warn: (w) => warnings.push(w) });
  return { t, fmt, warnings };
};
// 快照用的队名是 T<id>
const tTeams = new Map([1, 2, 3, 4].map((id) => [id, { teamId: id, cn: `T${id}`, full: `Team T${id}`, abbr: `T${id}` }]));
// 数字比对用不含数字的队名，免得队名里的数字混进来
const NAMES = { 1: ['甲队', 'Alpha'], 2: ['乙队', 'Bravo'], 3: ['丙队', 'Charlie'], 4: ['丁队', 'Delta'] };
const plainTeams = new Map(Object.entries(NAMES).map(([id, [cn, full]]) => [Number(id), { teamId: Number(id), cn, full, abbr: full.slice(0, 3).toUpperCase() }]));

const paperLine = (verdict) => msg(PAPER_LINE_CODE, { verdict });

test('fixture 夹具与 predictionBoard 常量同步', () => {
  assert.equal(MIN_MARKET_FIXTURE, MIN_MARKET);
});

test('中文渲染与改造前逐字相同（预测总表总结）', () => {
  const { t, warnings } = makeT('zh', tTeams);
  for (const [name, f] of Object.entries(boardFixtures)) {
    const b = buildBoard(f(), { teamName: (id) => `T${id}` });
    assert.deepEqual(b.summaryMsg.map((m) => renderMsg(m, t)), snap.board[name], name);
    // 服务端仍给中文 summary（脚本 / 日志），且与快照一致
    assert.deepEqual(b.summary, snap.board[name], name);
  }
  assert.deepEqual(warnings, []);
});

test('中文渲染与改造前逐字相同（模拟投注结论与样本外前缀、总表合并句）', () => {
  const { t, warnings } = makeT('zh', tTeams);
  for (const [name, s, seasons] of verdictCases) {
    assert.equal(renderMsg(verdictMsg(s, { seasons }), t), snap.verdict[name], name);
    assert.equal(verdictOf(s, { seasons }), snap.verdict[name], name);
  }
  const head = paperHeadlineMsg(snap.headline.input);
  assert.equal(renderMsg(head, t), snap.headline.verdict);
  assert.equal(renderMsg(head, t), snap.headline.stored);
  assert.equal(renderMsg(paperLine(head), t), snap.headline.paperLine);
  assert.deepEqual(warnings, []);
});

test('中文渲染与改造前逐字相同（阵容先验说明，含新秀有样本的分支与替补级回退）', () => {
  const { t, warnings } = makeT('zh', tTeams);
  for (const model of [true, false]) {
    const { store, ids } = rosterSourceStore({ model });
    const rot = liveRosterRankings(store, rosterLegacy).find((r) => r.teamId === 1).rosterProjection.rotation;
    for (const id of ids) {
      const p = rot.find((x) => x.playerId === id);
      const want = snap.roster[`${model ? 'model' : 'noModel'}:${id}`];
      assert.equal(p.impactSource, want.impactSource);
      assert.equal(p.impactPrior.source, want.source);
      assert.equal(renderMsg(rosterSourceMsg(p), t), want.source, `${model}:${id}`);
    }
  }
  assert.deepEqual(warnings, []);
});

// 去掉日期渲染后抽数字，排序后比多重集（英文语序可以不同）
const numbersOf = (s) => (s.match(/\d+(?:\.\d+)?%?/g) ?? []).sort();
const stripDates = (s, fmt, dates) => dates.reduce((acc, d) => acc.split(fmt.dateMD(d)).join(' '), s);

test('英文渲染无中文、数字与中文版相同', () => {
  const Z = makeT('zh', plainTeams); const E = makeT('en', plainTeams);
  const cases = [];
  for (const [name, f] of Object.entries(boardFixtures)) {
    const games = f();
    const dates = [...new Set(games.map((g) => g.date))];
    for (const m of buildBoard(games).summaryMsg) cases.push([name, m, dates]);
  }
  for (const [name, s, seasons] of verdictCases) cases.push([`verdict:${name}`, verdictMsg(s, { seasons }), []]);
  cases.push(['paperLine', paperLine(paperHeadlineMsg(snap.headline.input)), []]);
  const { store, ids } = rosterSourceStore();
  const rot = liveRosterRankings(store, rosterLegacy).find((r) => r.teamId === 1).rosterProjection.rotation;
  for (const id of ids) cases.push([`roster:${id}`, rosterSourceMsg(rot.find((x) => x.playerId === id)), []]);
  assert.ok(cases.length > 30);
  for (const [name, m, dates] of cases) {
    const zs = renderMsg(m, Z.t); const es = renderMsg(m, E.t);
    assert.doesNotMatch(es, CJK, `${name}: ${es}`);
    assert.doesNotMatch(es, /\{|\}|srv\.|undefined|NaN/, `${name}: ${es}`);
    assert.deepEqual(numbersOf(stripDates(es, E.fmt, dates)), numbersOf(stripDates(zs, Z.fmt, dates)), `${name}\n${zs}\n${es}`);
  }
  assert.deepEqual(E.warnings, []);
  // 参数里只有数字、日期与 teamId，与语言无关
  const json = JSON.stringify(cases.map(([, m]) => m));
  assert.doesNotMatch(json, CJK);
});

test('英文队名用 full，日期用英文月份', () => {
  const { t } = makeT('en', plainTeams);
  const b = buildBoard(boardFixtures.basic());
  const upset = b.summaryMsg.find((m) => m.code === 'srv.board.upsetAway');
  assert.equal(renderMsg(upset, t),
    'Biggest upset: on Oct 20, Delta beat Charlie on the road, and we had given Delta only a 25% chance before the game.');
});

test('negative / noEvidence 英文保持直白', () => {
  const { t } = makeT('en', plainTeams);
  const neg = { bets: 500, roi: -0.08, ci: { lo: -0.13, hi: -0.02 } };
  const none = { bets: 500, roi: -0.01, ci: { lo: -0.05, hi: 0.03 } };
  for (const s of [neg, none]) {
    const text = renderMsg(verdictMsg(s, { seasons: 2 }), t);
    assert.match(text, /no evidence the model beats the market/i);
    assert.match(text, /not recommend/i);
    assert.doesNotMatch(text, /may|might|could|promising|slight/i);
  }
  assert.match(renderMsg(verdictMsg(neg, { seasons: 2 }), t), /ROI −8\.0% \(95% CI \[−13\.0%, −2\.0%\]\)/);
  assert.match(renderMsg(verdictMsg(neg, { seasons: 2 }), t), /consistent losses/i);
  const pos = renderMsg(verdictMsg({ bets: 500, roi: 0.06, ci: { lo: 0.01, hi: 0.11 } }, { seasons: 2 }), t);
  assert.match(pos, /historical backtest/i);
  assert.doesNotMatch(pos, /no evidence/i);
});

test('renderMsg：数组按语言连接、嵌套消息、字符串原样、空值为空串', () => {
  const Z = makeT('zh', plainTeams); const E = makeT('en', plainTeams);
  const arr = [msg('srv.board.noneFinished'), msg('srv.board.noUpcoming')];
  assert.equal(renderMsg(arr, Z.t), `${zh.srv.board.noneFinished}${zh.srv.board.noUpcoming}`);
  assert.equal(renderMsg(arr, E.t), `${en.srv.board.noneFinished} ${en.srv.board.noUpcoming}`);
  assert.equal(renderMsg('旧接口的中文句子', E.t), '旧接口的中文句子');
  assert.equal(renderMsg(null, E.t), '');
  assert.equal(renderMsg(undefined, E.t), '');
  const nested = msg('srv.paper.oos', { after: '2022-23', verdict: msg('srv.paper.verdict.none') });
  assert.equal(renderMsg(nested, E.t), `Out-of-sample (after 2022-23): ${en.srv.paper.verdict.none}`);
  assert.equal(renderMsg(nested, Z.t), '样本外（2022-23 之后）没有可回测的下注，无法评估。');
  // 缺码不抛错，退回键名（与 t 一致）
  assert.equal(renderMsg(msg('srv.nope'), E.t), 'srv.nope');
  // 没有 impactPrior 的球员（实测 IMP）没有说明
  assert.equal(rosterSourceMsg({ impactSource: 'current-blended' }), null);
  assert.equal(rosterSourceMsg(null), null);
});

test('所有 SPLITS / lab slices / EDGE_BUCKETS / factor / 先验来源的 key 在每种语言都有译文', () => {
  const keys = [
    ...SPLITS.map((g) => `srv.board.splitGroup.${g.key}`),
    ...SPLITS.flatMap((g) => g.rows.map((r) => `srv.board.split.${r.key}`)),
    ...['model', 'home', 'elo'].map((k) => `srv.board.baseline.${k}`),
    ...SLICE_DEFS.map(([k]) => `srv.lab.slice.${k}`),
    ...GAP_SLICE_DEFS.map(([k]) => `srv.lab.slice.${k}`),
    ...EDGE_BUCKETS.map(([k]) => `srv.lab.edge.${k}`),
    ...FACTOR_KEYS.map((k) => `srv.predict.factor.${k}`),
    ...PRIOR_SOURCES.map((k) => `srv.roster.source.${k}`),
    ...TARGET_KINDS.map((k) => `srv.roster.target.${k}`),
    'srv.roster.insufficient',
  ];
  assert.equal(SPLITS.length, 3);
  assert.equal(SLICE_DEFS.length, 11);
  assert.equal(EDGE_BUCKETS.length, 5);
  assert.deepEqual(FACTOR_KEYS, ['elo', 'net', 'turnover', 'hca', 'rest', 'roster']);
  assert.equal(new Set(keys).size, keys.length - GAP_SLICE_DEFS.filter(([k]) => SLICE_DEFS.some(([s]) => s === k)).length);
  for (const k of keys) {
    for (const [lang, dict] of [['zh', zh], ['en', en]]) {
      assert.equal(typeof lookup(dict, k), 'string', `${lang} 缺 ${k}`);
    }
    assert.doesNotMatch(lookup(en, k), CJK, k);
  }
  // 中文标签与服务端保留的 label 字段逐字一致
  for (const g of SPLITS) {
    assert.equal(zh.srv.board.splitGroup[g.key], g.title);
    for (const r of g.rows) assert.equal(zh.srv.board.split[r.key], r.label);
  }
  for (const [k, label] of [...SLICE_DEFS, ...GAP_SLICE_DEFS]) assert.equal(zh.srv.lab.slice[k], label);
  for (const [k, label] of EDGE_BUCKETS) assert.equal(zh.srv.lab.edge[k], label);
});
