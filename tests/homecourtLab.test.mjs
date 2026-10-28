import test from 'node:test';
import assert from 'node:assert/strict';
import { computeElo } from '../server/ratings.mjs';
import { replay, expand } from '../server/lab.mjs';
import { TEAM_META } from '../server/teamMeta.mjs';
import { ARENAS, ALTITUDE, milesBetween, utcOffsetHours } from '../server/arenas.mjs';
import {
  eloStartFor, eloBase, scheduleContext, gameMinutes, teamHomeAdj, ols, fit, apply, FACTORS, buildRows,
} from '../server/homecourtLab.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('arena table covers all 30 teams with coordinates and IANA time zones', () => {
  assert.deepEqual(Object.keys(ARENAS).sort(), Object.keys(TEAM_META).sort());
  for (const a of Object.values(ARENAS)) {
    assert.ok(a.lat > 25 && a.lat < 46 && a.lon > -123 && a.lon < -71);
    assert.equal(typeof utcOffsetHours(a.tz, '2023-01-15'), 'number');
  }
  assert.deepEqual([...ALTITUDE].sort(), ['DEN', 'UTA']);
});

test('great-circle miles and DST-aware UTC offsets', () => {
  near(milesBetween(ARENAS.LAL, ARENAS.LAL), 0);
  const bosLal = milesBetween(ARENAS.BOS, ARENAS.LAL);
  assert.ok(bosLal > 2550 && bosLal < 2650, `${bosLal}`);
  assert.equal(utcOffsetHours('America/New_York', '2023-01-15'), -5);
  assert.equal(utcOffsetHours('America/New_York', '2023-04-01'), -4);
  assert.equal(utcOffsetHours('America/Phoenix', '2023-01-15'), -7);
  assert.equal(utcOffsetHours('America/Phoenix', '2023-04-01'), -7); // 亚利桑那不实行夏令时
  assert.equal(utcOffsetHours('America/Los_Angeles', '2023-04-01'), -7);
});

test('computeElo homeAdv option defaults to ELO_HOME_ADV and changes the update', () => {
  const games = [{ gameId: '1', date: '2023-01-01', neutral: false, home: { teamId: 1, pts: 100, win: true }, away: { teamId: 2, pts: 90, win: false } }];
  assert.deepEqual(computeElo(games).final, computeElo(games, { homeAdv: 100 }).final);
  assert.ok(computeElo(games, { homeAdv: 45 }).final[1] > computeElo(games).final[1]); // 预期主场优势小 → 主胜加分多
});

// ---- 合成两季：4 队双循环
const IDS = [1, 2, 3, 4];
function season(year, rating) {
  const games = []; let day = 0; let k = 0;
  for (let rep = 0; rep < 3; rep += 1) {
    for (const h of IDS) {
      for (const a of IDS) {
        if (h === a) continue;
        const m = Math.round(rating[h] - rating[a] + 2 + ((k * 7) % 5) - 2);
        const d = new Date(Date.UTC(year, 9, 1) + day * 86400000).toISOString().slice(0, 10);
        games.push({ i: `G${year}${String(k).padStart(3, '0')}`, d, s: [[h, 100 + Math.max(m, 0) + (m === 0 ? 1 : 0), 1], [a, 100 + Math.max(-m, 0), 0]] });
        k += 1; day += (k % 3 === 0 ? 1 : 0); // 有的队连续两天打：制造背靠背
      }
    }
  }
  return games;
}
const R = { 1: 6, 2: 2, 3: -2, 4: -6 };
const dataset = { seasons: { '2021-22': season(2021, R), '2022-23': season(2022, R) }, teamAdv: {} };
const ABBR = { 1: 'BOS', 2: 'LAL', 3: 'DEN', 4: 'MIA' };

test('production base rows reproduce lab.replay margins and probabilities exactly', () => {
  const lab = replay(dataset, ['2022-23']);
  const games = expand(dataset.seasons['2022-23']);
  const start = eloStartFor(expand(dataset.seasons['2021-22']), { k: 20, carryKeep: 0.75, eloHomeAdv: 100 });
  const base = eloBase(games, start, { k: 20, eloHomeAdv: 100 });
  const ctx = scheduleContext(games, { abbrOf: (id) => ABBR[id] });
  const rows = buildRows(base, ctx, { hca: 1.6, restWeight: 1.8 });
  assert.equal(rows.length, lab.length);
  rows.forEach((r, i) => {
    near(r.pred, lab[i].pred);
    assert.equal(r.teamGp, lab[i].teamGp);
    assert.equal(r.gameId, lab[i].gameId);
    assert.equal(ctx[i].home.rest, lab[i].restHome);
  });
});

// ---- 赛程上下文：湖人东部客场之旅 BOS → MIA → DEN，再回主场
const g = (gameId, date, h, a, neutral = false) => ({
  gameId, date, neutral, home: { teamId: h, pts: 100, win: true }, away: { teamId: a, pts: 90, win: false },
});
const trip = [
  g('G1', '2023-01-01', 1, 2),
  g('G2', '2023-01-02', 4, 2),
  g('G3', '2023-01-03', 3, 2),
  g('G4', '2023-01-05', 2, 3),
];

test('schedule context: travel, time zones, altitude, density, back-to-backs, road trips', () => {
  const c = scheduleContext(trip, { abbrOf: (id) => ABBR[id] });
  const la = ARENAS.LAL; const bos = ARENAS.BOS; const mia = ARENAS.MIA; const den = ARENAS.DEN;
  // G1：湖人从洛杉矶飞波士顿，波士顿本季首战在家
  near(c[0].away.miles, milesBetween(la, bos));
  assert.equal(c[0].away.tz, 3);
  assert.equal(c[0].home.miles, 0);
  assert.equal(c[0].home.rest, null);
  assert.equal(c[0].away.tripLen, 1);
  // G2：背靠背客场，波士顿 → 迈阿密
  assert.equal(c[1].away.rest, 0);
  assert.equal(c[1].away.b2b, 1);
  assert.equal(c[1].away.road, 1);
  near(c[1].away.miles, milesBetween(bos, mia));
  assert.equal(c[1].away.tz, 0);
  assert.equal(c[1].away.in4, 2);
  // G3：第三个背靠背、四天三赛、进高原、迈阿密 → 丹佛跨两个时区
  const a3 = c[2].away;
  assert.equal(a3.in4, 3);
  assert.equal(a3.tz, 2);
  assert.equal(a3.b2bAlt, 1);
  assert.equal(c[2].altitude, 1);
  assert.equal(c[2].home.b2bAlt, 0); // 掘金在自己的高原主场
  assert.equal(a3.tripLen, 3);
  near(a3.tripMiles, milesBetween(la, bos) + milesBetween(bos, mia) + milesBetween(mia, den));
  // G4：湖人回家（休 1 天），六天四赛；掘金客场之旅第 1 场、不在高原
  const h4 = c[3].home;
  assert.equal(h4.rest, 1);
  assert.equal(h4.in4, 3);
  assert.equal(h4.in6, 4);
  assert.equal(h4.tripLen, 0);
  assert.equal(h4.tripMiles, 0);
  near(h4.miles, milesBetween(den, la));
  assert.equal(c[3].altitude, 0);
  assert.equal(c[3].away.tripLen, 1);
});

test('neutral-site games carry no location features and count as road for both teams', () => {
  const c = scheduleContext([g('N1', '2023-01-01', 1, 2, true), g('N2', '2023-01-02', 2, 1)], { abbrOf: (id) => ABBR[id] });
  assert.equal(c[0].home.miles, 0);
  assert.equal(c[0].away.miles, 0);
  assert.equal(c[0].altitude, 0);
  assert.equal(c[0].home.road, 1);
  assert.equal(c[1].home.miles, 0); // 上一场地点未知：不计旅行
  assert.equal(c[1].away.tripLen, 2);
});

// ---- stints：[主5, 客5, 主回合, 客回合, 主分, 客分, 秒]
const st = (h, a, secs) => [...h, ...a, 10, 10, 20, 18, secs];
const H = [11, 12, 13, 14, 15]; const A = [21, 22, 23, 24, 25];

test('game minutes and overtime periods from stints', () => {
  const m = gameMinutes({ games: { X: [1, 2, [st(H, A, 2000), st([16, 12, 13, 14, 15], A, 880 + 300)]] } });
  const x = m.get('X');
  assert.equal(x.ot, 1);
  near(x.byTeam.get(1).get(11), 2000 / 60);
  near(x.byTeam.get(1).get(12), 3180 / 60);
  near(x.byTeam.get(2).get(21), 53);
});

test('previous-game overtime and star load (top-3 by trailing minutes, excess over their own average)', () => {
  // 球队 1 连续 5 个主场（对 2/3/4 轮换），第 4 场打了加时、主力多打
  const days = ['2023-01-01', '2023-01-03', '2023-01-05', '2023-01-07', '2023-01-08', '2023-01-10'];
  const games = days.map((d, i) => g(`S${i}`, d, 1, [2, 3, 4][i % 3]));
  const minutes = new Map();
  days.forEach((d, i) => {
    const heavy = i === 4;
    const sec = heavy ? 3180 : 2880;
    minutes.set(`S${i}`, gameMinutes({ games: { [`S${i}`]: [1, [2, 3, 4][i % 3], [st(H, A, sec)]] } }).get(`S${i}`));
  });
  // 第 3 场（S3）首发只打半场，下半场全换替补 16~20
  minutes.set('S3', gameMinutes({ games: { S3: [1, 2, [st(H, A, 1440), st([16, 17, 18, 19, 20], A, 1440)]] } }).get('S3'));
  const c = scheduleContext(games, { abbrOf: (id) => ABBR[id], minutes });
  assert.equal(c[5].home.otPrev, 1);
  assert.equal(c[4].home.otPrev, 0);
  // S5 前：窗口 S0..S4（5 场），首发五人同为 221 分钟，同分按 id 取前三 11/12/13
  // 最近两场 S4(53)+S3(24) = 77 /人；窗口均值 (48*3+24+53)/5 = 44.2 /人 → 超额 77 − 88.4 = −11.4 /人
  near(c[5].home.starLoad, 3 * (77 - 2 * 44.2), 1e-9);
  // 前两场数据不足（窗口 < 4 场）：记 0
  assert.equal(c[2].home.starLoad, 0);
});

test('team home advantage: rolling, centered on league mean, empirical-Bayes shrunk', () => {
  // 球队 1 主场残差 +6、客场 0；其余为 0。每天一场。
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    const d = new Date(Date.UTC(2022, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const home1 = i % 2 === 0;
    rows.push({ date: d, homeId: home1 ? 1 : 2, awayId: home1 ? 2 : 1, neutral: false, resid: home1 ? 6 : 0 });
  }
  const adj = teamHomeAdj(rows, [1e-9, 10, 1e9]);
  assert.equal(adj[0][10], 0); // 第一场之前没有任何历史
  assert.equal(adj[1][10], 0); // 球队 2 只有客场样本、球队 1 只有主场样本：不估
  // 最后一场（2 主 1 客）之前 39 场：球队 1 主场 20 场残差 +6、客场 19 场 0；
  // 球队 2 主场 19 场 0、客场 20 场（站在 2 的角度）−6。两队原始 (主−客)/2 都是 3，
  // 联盟均值 = 全部残差均值 120/39，偏离各为 3 − 120/39。
  const last = rows.length - 1;
  const dev = 3 - 120 / 39;
  const neff = 1 / (1 / 20 + 1 / 19);
  near(adj[last][1e-9], 2 * dev, 1e-6);                        // 不收缩：主队偏离 + 客队偏离
  near(adj[last][10], 2 * dev * (neff / (neff + 10)), 1e-9);   // K 场先验
  near(adj[last][1e9], 0, 1e-6);                               // 完全收缩到联盟均值
  // 无泄漏：改动最后一场的残差不影响任何一场的调整
  const rows2 = rows.map((r, i) => (i === last ? { ...r, resid: 99 } : r));
  assert.deepEqual(teamHomeAdj(rows2, [10]).map((x) => x[10]), adj.map((x) => x[10]));
});

test('ols recovers exact linear coefficients', () => {
  const X = []; const y = [];
  for (let i = 0; i < 50; i += 1) { const a = (i % 7) - 3; const b = (i % 5) * 0.5; X.push([a, b]); y.push(2 * a - b); }
  const beta = ols(X, y);
  near(beta[0], 2, 1e-9);
  near(beta[1], -1, 1e-9);
});

test('fit picks offsets/features by training log loss and apply predicts with them', () => {
  const rows = [];
  for (let i = 0; i < 399; i += 1) {
    const x = (i % 3) - 1;
    // 每组三场 x = −1/0/+1 共用同一个扰动：扰动与 x 正交，最小二乘应精确得到 3
    const actual = 3 * x + ((Math.floor(i / 3) * 37) % 21) - 10;
    rows.push({
      actual, homeWin: actual > 0, base: { a: 0, b: 50 }, adj: { a: { 5: 0 }, b: { 5: 0 } }, x: { T: [x] },
    });
  }
  const m = fit(rows, { ehas: ['a', 'b'], Ks: [null], factors: ['T'] });
  assert.equal(m.eha, 'a');
  near(m.beta[0], 3, 1e-6);
  const out = apply(m, rows[0]);
  near(out.pred, m.beta[0] * rows[0].x.T[0]);
  assert.ok(out.p > 0 && out.p < 1);
});

test('factor features are home-minus-away and zero when both sides are identical', () => {
  const side = { miles: 500, tz: 1, in4: 3, in6: 4, b2b: 1, road: 0, b2bAlt: 0, otPrev: 1, starLoad: 20, tripLen: 0, tripMiles: 0 };
  for (const [name, f] of Object.entries(FACTORS)) {
    const v = f({ home: side, away: side, altitude: 0 });
    assert.ok(v.every((x) => x === 0), name);
  }
  assert.deepEqual(FACTORS.H3({ home: side, away: { ...side, miles: 1500, tz: 3 }, altitude: 1 }), [-1, -2, 1]);
});

test('factor features are centered on the training mean: a constant feature cannot re-tune home advantage', () => {
  // 残差恒为 +2 ± 5（好比真实主场比 1.6 高）、特征恒为 1：不中心化的话系数会是 2，偷偷把主场调高
  const rows = Array.from({ length: 100 }, (_, i) => ({
    actual: 2 + (i % 2 ? 5 : -5), homeWin: i % 2 === 1, base: { prod: 0 }, adj: { prod: {} }, x: { T: [1] },
  }));
  const m = fit(rows, { factors: ['T'] });
  near(apply(m, rows[0]).pred, 0, 1e-6);
  near(apply(m, rows[1]).pred, 0, 1e-6);
});
