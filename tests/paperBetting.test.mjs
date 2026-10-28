import test from 'node:test';
import assert from 'node:assert/strict';
import {
  profitOf, impliedOf, decide, settle, bestPrice, placeBets, summarize, maxDrawdown, clvOf, verdictOf, verdictMsg, paperHeadlineMsg, TUNING_SEASON,
  PRIMARY, THRESHOLDS,
} from '../server/paperBetting.mjs';
import { devigHomeProb } from '../server/oddsClient.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('预注册：主规则 3%，对照 0/3/6%', () => {
  assert.equal(PRIMARY, 0.03);
  assert.deepEqual(THRESHOLDS, [0, 0.03, 0.06]);
});

test('去水：两边隐含概率按比例归一', () => {
  // -150 / +130：0.6 与 0.4348，和 1.0348
  near(devigHomeProb(-150, 130), 0.6 / (0.6 + 100 / 230));
  near(devigHomeProb(-110, -110), 0.5);
  assert.equal(devigHomeProb(null, 120), null);
});

test('钱线换算：赢一注的净利与含水隐含概率', () => {
  near(profitOf(-110), 100 / 110);
  near(profitOf(150), 1.5);
  near(impliedOf(-110), 110 / 210);
  near(impliedOf(150), 0.4);
});

test('decide：edge = 模型 − 该家去水；≥ 门槛才下，押有正 edge 的一边', () => {
  assert.deepEqual(decide(0.6, 0.55, 0.03), { side: 'home', edge: 0.6 - 0.55 });
  const a = decide(0.40, 0.45, 0.03);
  assert.equal(a.side, 'away'); near(a.edge, 0.05);
  assert.equal(decide(0.57, 0.55, 0.03), null, '2% < 3%');
  assert.equal(decide(0.58, 0.55, 0.03)?.side, 'home', '恰好 3%（浮点）也算');
  assert.equal(decide(0.55, 0.55, 0), null, '门槛 0 时 edge 必须 > 0');
  assert.equal(decide(0.5501, 0.55, 0)?.side, 'home');
  assert.equal(decide(null, 0.55, 0), null);
});

test('settle：按所押一边的含水美式赔率结算，输 −1', () => {
  assert.deepEqual(settle('home', [-150, 130], true), { ml: -150, won: true, profit: 100 / 150 });
  assert.deepEqual(settle('away', [-150, 130], true), { ml: 130, won: false, profit: -1 });
  assert.deepEqual(settle('away', [-150, 130], false), { ml: 130, won: true, profit: 1.3 });
});

test('bestPrice：每方取各家最高赔率（赔付最多）', () => {
  const books = { a: { ml: [-150, 130] }, b: { ml: [-140, 120] }, c: { ml: [-160, 135] } };
  assert.deepEqual(bestPrice(books, 'home'), { ml: -140, book: 'b' });
  assert.deepEqual(bestPrice(books, 'away'), { ml: 135, book: 'c' });
  assert.deepEqual(bestPrice({ a: { ml: [105, -125] }, b: { ml: [-102, -118] } }, 'home'), { ml: 105, book: 'a' });
});

const g = (id, pHome, homeWin, books, extra = {}) => ({
  gameId: id, date: `2023-01-${String(id).padStart(2, '0')}`, season: '2022-23', pHome, homeWin, books, ...extra,
});
const bk = (h, a, more = {}) => ({ ml: [h, a], at: 'current', open: null, pHome: devigHomeProb(h, a), ...more });

test('placeBets：单家规则只看该家；没有该家价格的比赛不下', () => {
  const games = [
    g(1, 0.70, true, { draftkings: bk(-150, 130), betmgm: bk(-200, 170) }),   // DK 去水约 0.58 → edge 0.12
    g(2, 0.40, true, { draftkings: bk(-110, -110) }),                         // edge 客 0.10，客输
    g(3, 0.52, false, { draftkings: bk(-110, -110) }),                        // 2% 不下
    g(4, 0.90, true, { betmgm: bk(-300, 250) }),                              // 没有 DK
  ];
  const bets = placeBets(games, { book: 'draftkings', threshold: 0.03 });
  assert.deepEqual(bets.map((b) => [b.gameId, b.side, b.won]), [[1, 'home', true], [2, 'away', false]]);
  near(bets[0].profit, 100 / 150);
  assert.equal(bets[0].book, 'draftkings');
});

test('placeBets 挑最优价：用各家去水中位数判断，按最高赔率结算', () => {
  const games = [g(1, 0.70, true, { a: bk(-150, 130), b: bk(-140, 120), c: bk(-160, 135) })];
  const [b] = placeBets(games, { book: 'best', threshold: 0.03 });
  assert.equal(b.side, 'home');
  assert.equal(b.ml, -140);
  assert.equal(b.book, 'b');
  near(b.edge, 0.70 - devigHomeProb(-150, 130), 1e-9);   // 中位数 = a 那家
});

test('placeBets at=open：按开盘价下注，CLV = 收盘去水 − 开盘去水（所押一边）', () => {
  const games = [g(1, 0.70, true, { draftkings: bk(-150, 130, { at: 'close', open: [-120, 100] }) })];
  const [b] = placeBets(games, { book: 'draftkings', threshold: 0.03, at: 'open' });
  assert.equal(b.ml, -120);
  near(b.clv, devigHomeProb(-150, 130) - devigHomeProb(-120, 100));
  assert.ok(b.clv > 0, '盘口往我们押的方向走 = 正 CLV');
  assert.equal(placeBets([g(2, 0.7, true, { draftkings: bk(-150, 130) })], { book: 'draftkings', threshold: 0.03, at: 'open' }).length, 0,
    '没有开盘价不下');
});

test('clvOf：客队一边取 1 − 主队去水', () => {
  near(clvOf('away', [-120, 100], [-150, 130]), (1 - devigHomeProb(-150, 130)) - (1 - devigHomeProb(-120, 100)));
  assert.equal(clvOf('home', [-120, 100], null), null);
});

test('maxDrawdown：累计盈亏从高点回落的最大幅度', () => {
  assert.equal(maxDrawdown([1, -1, -1, 2, -3, 1]), 3);
  assert.equal(maxDrawdown([1, 1]), 0);
  assert.equal(maxDrawdown([-1, -1]), 2, '从 0 起算');
  assert.equal(maxDrawdown([]), 0);
});

test('summarize：注数、胜率、单位盈亏、ROI、bootstrap 区间、保本胜率、累计曲线', () => {
  const rows = [
    { date: '2023-01-01', ml: -150, won: true, profit: 100 / 150 },
    { date: '2023-01-02', ml: 130, won: false, profit: -1 },
    { date: '2023-01-02', ml: 150, won: true, profit: 1.5 },
  ];
  const s = summarize(rows, { B: 300 });
  assert.equal(s.bets, 3);
  assert.equal(s.wins, 2);
  near(s.units, 100 / 150 - 1 + 1.5);
  near(s.roi, s.units / 3);
  near(s.breakEven, (0.6 + 100 / 230 + 0.4) / 3);
  assert.ok(s.ci.lo <= s.roi && s.roi <= s.ci.hi);
  assert.equal(s.maxDrawdown, 1);
  assert.deepEqual(s.curve.map((c) => c.date), ['2023-01-01', '2023-01-02']);
  near(s.curve.at(-1).units, s.units);
  assert.deepEqual(summarize([]), {
    bets: 0, wins: 0, winRate: null, units: 0, roi: null, ci: { lo: null, hi: null },
    breakEven: null, maxDrawdown: 0, curve: [], clv: null,
  });
});

test('verdictOf：区间整体 > 0 才允许「有正收益证据」，含 0 写无证据', () => {
  const base = { bets: 812, roi: -0.031, ci: { lo: -0.09, hi: 0.03 } };
  const v = verdictOf(base, { seasons: 3 });
  assert.match(v, /历史 3 季、812 注、ROI −3\.1%（95% 区间 \[−9\.0%, \+3\.0%\]）/);
  assert.match(v, /无证据表明模型能赢盘口，不建议据此下注/);
  assert.doesNotMatch(v, /正收益证据/);
  const pos = verdictOf({ bets: 500, roi: 0.06, ci: { lo: 0.01, hi: 0.11 } }, { seasons: 2 });
  assert.match(pos, /有正收益证据/);
  const neg = verdictOf({ bets: 500, roi: -0.08, ci: { lo: -0.13, hi: -0.02 } }, { seasons: 2 });
  assert.match(neg, /稳定亏损/);
  assert.doesNotMatch(neg, /正收益证据/);
  assert.match(verdictOf({ bets: 0, roi: null, ci: { lo: null, hi: null } }, { seasons: 0 }), /没有/);
});

test('gamesFrom：按 gameId 接上各家价格；ESPN 主客与我们相反（中立场）时翻转钱线与概率', async () => {
  const { gamesFrom } = await import('../server/paperBetting.mjs');
  const records = [
    { season: '2022-23', gameId: 'a', date: '2023-01-01', homeId: 1, awayId: 2, p: 0.6, homeWin: true },
    { season: '2022-23', gameId: 'b', date: '2023-01-02', homeId: 3, awayId: 4, p: 0.7, homeWin: false },
    { season: '2022-23', gameId: 'c', date: '2023-01-03', homeId: 5, awayId: 6, p: 0.5, homeWin: true },
  ];
  const item = (h, a) => ({ id: '40', name: 'DraftKings', spread: -3, open: null, close: null, current: [h, a] });
  const cache = {
    a: { home: 1, items: [item(-150, 130)] },
    b: { home: 4, items: [item(-200, 170)] },     // ESPN 的主队是我们的客队
  };
  const out = gamesFrom(records, cache);
  assert.deepEqual(out.map((x) => x.gameId), ['a', 'b'], '没有价格的比赛不进来');
  assert.deepEqual(out[0].books.draftkings.ml, [-150, 130]);
  assert.deepEqual(out[1].books.draftkings.ml, [170, -200]);
  near(out[1].books.draftkings.pHome, 1 - devigHomeProb(-200, 170));
  assert.equal(out[1].pHome, 0.7);
});

test('placeBets 挑最优价 pool：只在给定博彩商之间挑（非美国站点的价不算）', () => {
  const games = [g(1, 0.70, true, { draftkings: bk(-150, 130), betfair: bk(-120, 100) })];
  assert.equal(placeBets(games, { book: 'best', threshold: 0.03 })[0].book, 'betfair');
  const [b] = placeBets(games, { book: 'best', threshold: 0.03, pool: ['draftkings'] });
  assert.equal(b.book, 'draftkings');
  assert.equal(b.ml, -150);
});

test('verdictMsg：区间整体 > 0 才 positive，含 0 为 noEvidence，整体 < 0 为 negative', () => {
  assert.equal(verdictMsg({ bets: 500, roi: 0.06, ci: { lo: 0.01, hi: 0.11 } }, { seasons: 2 }).code, 'srv.paper.verdict.positive');
  assert.equal(verdictMsg({ bets: 500, roi: -0.08, ci: { lo: -0.13, hi: -0.02 } }, { seasons: 2 }).code, 'srv.paper.verdict.negative');
  assert.equal(verdictMsg({ bets: 500, roi: -0.01, ci: { lo: -0.05, hi: 0.03 } }, { seasons: 2 }).code, 'srv.paper.verdict.noEvidence');
  assert.equal(verdictMsg({ bets: 0, roi: null, ci: { lo: null, hi: null } }, { seasons: 0 }).code, 'srv.paper.verdict.none');
  // 边界：下限恰好 0 不算正收益证据
  assert.equal(verdictMsg({ bets: 10, roi: 0, ci: { lo: 0, hi: 0.2 } }, { seasons: 1 }).code, 'srv.paper.verdict.noEvidence');
  assert.deepEqual(verdictMsg({ bets: 812, roi: -0.031, ci: { lo: -0.09, hi: 0.03 } }, { seasons: 3 }).params,
    { seasons: 3, bets: 812, roi: -0.031, lo: -0.09, hi: 0.03 });
});

test('paperHeadlineMsg：样本外前缀写 TUNING_SEASON', () => {
  const m = paperHeadlineMsg({ seasons: ['2023-24', '2025-26'], bets: 1596, roi: -0.1182, ci: { lo: -0.1926, hi: -0.0457 } });
  assert.equal(m.code, 'srv.paper.oos');
  assert.equal(m.params.after, '2022-23');
  assert.equal(m.params.after, TUNING_SEASON);
  assert.equal(m.params.verdict.code, 'srv.paper.verdict.negative');
  assert.deepEqual(m.params.verdict.params, { seasons: 2, bets: 1596, roi: -0.1182, lo: -0.1926, hi: -0.0457 });
});
