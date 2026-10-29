import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, pickBet, stakeFor, qualityOk } from '../server/betStrategies.mjs';

const byId = (id) => STRATEGIES.find((s) => s.id === id);
function cand({ pHome = 0.5, ml = [-110, -110], scenario = 'close', priceAt, flags = [], ...rest } = {}) {
  return { pHome, ml, scenario, priceAt: priceAt ?? scenario, flags, ...rest };
}

test('B 阈值：edge ≥ 门槛才下（浮点容差），押有正 edge 的一边', () => {
  assert.equal(pickBet(cand({ pHome: 0.42, ml: [150, -170] }), byId('B-edge3')), null);
  assert.equal(pickBet(cand({ pHome: 0.42, ml: [150, -170] }), byId('B-edge2')).side, 'home');
  assert.equal(pickBet(cand({ pHome: 0.30, ml: [150, -170] }), byId('B-edge3')).side, 'away');
  const hit = pickBet(cand({ pHome: 0.30, ml: [150, -170] }), byId('B-edge7'));
  assert.ok(Math.abs(hit.edge - (0.70 - 170 / 270)) < 1e-12);
});
test('C 正 EV：EV 恰为 0 不下；价格时点不符情景（current 冒充 close）不下', () => {
  assert.equal(pickBet(cand({ pHome: 0.6, ml: [-150, 130] }), byId('C-ev')), null);
  assert.equal(pickBet(cand({ pHome: 0.7, ml: [-150, 130], priceAt: 'current', flags: ['currentAsClose'] }), byId('C-ev')), null);
  assert.equal(pickBet(cand({ pHome: 0.7, ml: [-150, 130], priceAt: 'current', flags: ['currentAsClose'] }), byId('B-edge3')).side, 'home');
  assert.equal(pickBet(cand({ pHome: 0.7, ml: [-150, 130] }), byId('C-ev')).side, 'home');
});
test('C 与 B 等价：质量合格时，C 下注 ⇔ 该侧 edge>0（与 EV>0 同号）', () => {
  for (const [p, ml] of [[0.7, [-150, 130]], [0.3, [-150, 130]], [0.55, [-110, -110]], [0.45, [-110, -110]], [0.5, [-110, -110]]]) {
    const c = cand({ pHome: p, ml });
    const r = pickBet(c, byId('C-ev'));
    const posEdge = pickBet(c, { id: 'x', family: 'B', minEdge: 0 });
    assert.deepEqual(r, posEdge);
    if (r) assert.ok(r.edge > 0 && r.ev > 0);
  }
  assert.equal(pickBet(cand({ pHome: 0.3, ml: [-150, 130] }), byId('C-ev')).side, 'away');
  assert.equal(pickBet(cand({ pHome: 0.5, ml: [-110, -110] }), byId('C-ev')), null);
});
test('质量门槛：每个情景', () => {
  const tip = '2026-11-01T00:00:00Z';
  // open
  assert.equal(qualityOk(cand({ scenario: 'open', priceAt: 'open' })), true);
  assert.equal(qualityOk(cand({ scenario: 'open', priceAt: 'close' })), false);
  assert.equal(qualityOk(cand({ scenario: 'open', priceAt: 'current' })), false);
  // close
  assert.equal(qualityOk(cand({ scenario: 'close', priceAt: 'close' })), true);
  assert.equal(qualityOk(cand({ scenario: 'close', priceAt: 'current', flags: ['currentAsClose'] })), false);
  assert.equal(qualityOk(cand({ scenario: 'close', priceAt: 'current' })), false);
  // 标记
  for (const f of ['skippedAnomaly', 'bestPrice', 'currentAsClose']) {
    assert.equal(qualityOk(cand({ scenario: 'close', flags: [f] })), false, f);
  }
  assert.equal(qualityOk(cand({ scenario: 'open', flags: ['noCloseForClv'] })), true);
  // forward：current 且开赛前抓取
  const fw = { scenario: 'forward', priceAt: 'current', tipoff: tip };
  assert.equal(qualityOk(cand({ ...fw, capturedAt: '2026-10-31T20:00:00Z' })), true);
  assert.equal(qualityOk(cand({ ...fw, capturedAt: '2026-10-31T20:00:00Z', flags: ['currentAsClose'] })), true);
  assert.equal(qualityOk(cand({ ...fw, capturedAt: '2026-11-01T00:00:00Z' })), false);   // 恰在开赛时刻
  assert.equal(qualityOk(cand({ ...fw, capturedAt: '2026-11-01T01:00:00Z' })), false);
  assert.equal(qualityOk(cand({ ...fw })), false);   // 缺抓取时间
  assert.equal(qualityOk(cand({ ...fw, capturedAt: '2026-10-31T20:00:00Z', flags: ['skippedAnomaly'] })), false);
  assert.equal(qualityOk(cand({ ...fw, priceAt: 'close', capturedAt: '2026-10-31T20:00:00Z' })), false);
  // 未知情景
  assert.equal(qualityOk(cand({ scenario: 'weird', priceAt: 'weird' })), false);
});
test('A 基准：模型方 / 主队 / 热门，与价格无关', () => {
  const c = cand({ pHome: 0.4, ml: [-150, 130] });
  assert.deepEqual(['A-model', 'A-home', 'A-favorite'].map((id) => pickBet(c, byId(id)).side), ['away', 'home', 'home']);
  assert.equal(pickBet(cand({ pHome: 0.4, ml: [130, -150] }), byId('A-favorite')).side, 'away');
  assert.equal(pickBet(cand({ pHome: 0.4, ml: [-110, -110] }), byId('A-favorite')).side, 'home');   // 平价押主队
});
test('D Kelly：定注 = 资金 × 截后分数；负期望不下', () => {
  assert.equal(stakeFor(byId('D-kelly-quarter'), { p: 0.5, american: 150, bankroll: 100 }).toFixed(4), '4.1667');
  assert.equal(stakeFor(byId('D-kelly-full'), { p: 0.5, american: 150, bankroll: 100 }), 5);
  assert.equal(stakeFor(byId('D-kelly-full'), { p: 0.5, american: 150, bankroll: 100, cap: 0.02 }), 2);
  assert.equal(pickBet(cand({ pHome: 0.5, ml: [-110, -110] }), byId('D-kelly-half')), null);   // 两侧 edge 均为负
  assert.equal(pickBet(cand({ pHome: 0.35, ml: [150, -170] }), byId('D-kelly-half')).side, 'away');   // 客队 +2.0% edge
  assert.equal(stakeFor(byId('B-edge3'), { p: 0.6, american: -110, bankroll: 100 }), 1);
});
test('STRATEGIES 顺序与 id 固定', () => {
  assert.deepEqual(STRATEGIES.map((s) => s.id), ['A-model', 'A-home', 'A-favorite', 'B-edge2', 'B-edge3', 'B-edge5', 'B-edge7', 'B-edge10', 'C-ev', 'D-kelly-full', 'D-kelly-half', 'D-kelly-quarter']);
  assert.deepEqual(STRATEGIES.filter((s) => s.family === 'B').map((s) => s.minEdge), [0.02, 0.03, 0.05, 0.07, 0.10]);
  assert.deepEqual(STRATEGIES.filter((s) => s.family === 'D').map((s) => [s.kelly.mult, s.kelly.cap]), [[1, 0.05], [0.5, 0.05], [0.25, 0.05]]);
});
