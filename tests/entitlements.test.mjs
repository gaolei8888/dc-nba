import test from 'node:test';
import assert from 'node:assert/strict';
import { can, effectiveTier, gate, teaserBoard, teaserPaper, teaserShadow, FEATURES, TIER_FEATURES } from '../server/entitlements.mjs';
import { buildBoard } from '../server/predictionBoard.mjs';

const done = (id, date, p, hs, as) => ({
  gameId: id, date, homeId: 1, awayId: 2, homeScore: hs, awayScore: as,
  prediction: { homeWinProb: p, homeScore: 110, awayScore: 105, margin: 5 }, hit: (p >= 0.5) === (hs > as),
});
const next = (id, date, p) => ({ gameId: id, date, homeId: 1, awayId: 2, prediction: { homeWinProb: p, homeScore: 110, awayScore: 105, margin: 5 } });
const GAMES = [done('a', '2026-10-22', 0.6, 100, 90), done('b', '2026-10-23', 0.7, 90, 100), next('c', '2026-10-30', 0.55), next('d', '2026-10-31', 0.8)];

test('今天所有登录用户（free）都能看预测总表与模拟投注；未登录不能', () => {
  assert.deepEqual(FEATURES, ['board.stats', 'board.paper']);
  assert.deepEqual(TIER_FEATURES, { free: FEATURES });
  assert.equal(can({ tier: 'free' }, 'board.stats'), true);
  assert.equal(can({ tier: 'free' }, 'board.paper'), true);
  assert.equal(can(null, 'board.stats'), false);
  assert.equal(can({ tier: 'free' }, 'nope'), false);
});

test('等级到期回落 free；未知等级按 free；未到期保持', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  assert.equal(effectiveTier({ tier: 'pro', tier_expires_at: '2026-10-01T00:00:00Z' }, now), 'free');
  assert.equal(effectiveTier({ tier: 'weird' }, 0), 'free');
  assert.equal(effectiveTier({ tier: 'free' }, now), 'free');
  TIER_FEATURES.pro = ['board.stats'];
  try {
    assert.equal(effectiveTier({ tier: 'pro', tier_expires_at: '2026-12-01T00:00:00Z' }, now), 'pro');
    assert.equal(effectiveTier({ tier: 'pro', tier_expires_at: 'garbage' }, now), 'free');
    assert.equal(effectiveTier({ tier: 'pro' }, now), 'pro');
  } finally { delete TIER_FEATURES.pro; }
});

test('gate：账号功能关闭时一律放行（现状不变）；失效会话 reason = session', () => {
  assert.deepEqual(gate('board.stats', { accountsOn: false, user: null, state: 'none', now: 0 }), { allowed: true, reason: null });
  assert.deepEqual(gate('board.stats', { accountsOn: true, user: null, state: 'none', now: 0 }), { allowed: false, reason: 'anonymous' });
  assert.deepEqual(gate('board.stats', { accountsOn: true, user: null, state: 'invalid', now: 0 }), { allowed: false, reason: 'session' });
  assert.deepEqual(gate('board.paper', { accountsOn: true, user: { tier: 'free' }, state: 'valid', now: 0 }), { allowed: true, reason: null });
  assert.deepEqual(gate('nope', { accountsOn: true, user: { tier: 'free' }, state: 'valid', now: 0 }), { allowed: false, reason: 'tier' });
});

test('teaserBoard 只留预告字段，summary[0] 原样转发', () => {
  const full = { seasonYear: 2026, oddsFetchedAt: 'x', ...buildBoard(GAMES, { teamName: String }) };
  const t = teaserBoard(full);
  assert.deepEqual(Object.keys(t).sort(), ['locked', 'seasonYear', 'summary', 'summaryMsg', 'teaser']);
  assert.equal(t.locked, true);
  assert.deepEqual(t.summary, [full.summary[0]]);
  assert.deepEqual(t.summaryMsg, [full.summaryMsg[0]]);
  assert.equal(t.summaryMsg.length, 1);
  assert.deepEqual(t.teaser, { completed: full.overall.n, remaining: full.upcomingDist.n });
  assert.equal(t.teaser.completed, 2);
  assert.equal(t.teaser.remaining, 2);
  for (const k of ['overall', 'completed', 'upcoming', 'byTeam', 'misses', 'market', 'baselines', 'oddsFetchedAt']) assert.equal(k in t, false, k);
  const obj = { code: 'srv.board.overall', params: { n: 2 } };
  assert.deepEqual(teaserBoard({ ...full, summary: [obj, 'x'] }).summary, [obj]);
  assert.deepEqual(teaserBoard({ ...full, summaryMsg: undefined }).summaryMsg, []);
  assert.deepEqual(teaserBoard({ seasonYear: 2026, summary: [], overall: { n: 0 }, upcomingDist: { n: 0 } }).summary, []);
});

test('teaserPaper 不含 ROI、盈亏、注单、结论', () => {
  const t = teaserPaper({ backtest: { headline: { bets: 812, seasons: ['2023-24', '2024-25'], roi: -0.03, verdict: 'x', curve: [] }, table: [] },
    ledger: { available: true, captured: 12, rules: [{ units: 1 }], open: [{}] } });
  assert.deepEqual(t, { locked: true, teaser: { backtestBets: 812, seasons: ['2023-24', '2024-25'], ledgerCaptured: 12 } });
  assert.deepEqual(teaserPaper({ backtest: null, ledger: { available: false, reason: 'x' } }), { locked: true, teaser: { backtestBets: null, seasons: [], ledgerCaptured: null } });
});

test('teaserShadow 只说有没有', () => {
  assert.deepEqual(teaserShadow({ available: true, variants: [{}], progress: 3 }), { available: true, locked: true });
  assert.deepEqual(teaserShadow({ available: false }), { available: false, locked: true });
});
