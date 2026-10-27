import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../server/lab.mjs';
import { ridgeRatings, seasonRows, predict, strength, bootstrapCI, replaySeason } from '../server/fusionLab.mjs';
import { expand } from '../server/lab.mjs';

const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };
const IDS = [1, 2, 3, 4];

/** 4 队双循环的合成赛季：主队按固定实力差 + 小扰动赢球 */
function season(year, startDay, rating) {
  const games = [];
  let day = startDay; let k = 0;
  for (let rep = 0; rep < 3; rep += 1) {
    for (const h of IDS) {
      for (const a of IDS) {
        if (h === a) continue;
        const m = Math.round(rating[h] - rating[a] + 2 + ((k * 7) % 5) - 2);
        const d = new Date(Date.UTC(year, 9, 1) + day * 86400000).toISOString().slice(0, 10);
        games.push({ i: `G${year}${String(k).padStart(3, '0')}`, d, s: [[h, 100 + Math.max(m, 0) + (m === 0 ? 1 : 0), 1], [a, 100 + Math.max(-m, 0), 0]] });
        k += 1; day += 1;
      }
    }
  }
  return games;
}
const R = { 1: 6, 2: 2, 3: -2, 4: -6 };
const dataset = { seasons: { '2021-22': season(2021, 0, R), '2022-23': season(2022, 0, R) }, teamAdv: {} };
const SPECS = [{ toPrior: false, lambda: 1, cap: Infinity }, { toPrior: true, lambda: 5, cap: 20 }];

test('elo mode reproduces lab.replay probabilities and margins exactly', () => {
  const lab = replay(dataset, ['2022-23']);
  const rows = seasonRows(dataset, '2022-23', P, SPECS);
  assert.equal(rows.length, lab.length);
  rows.forEach((r, i) => {
    const out = predict(r, { mode: 'elo', sd: 12 });
    assert.ok(Math.abs(out.p - lab[i].p) < 1e-12);
    assert.ok(Math.abs(out.pred - lab[i].pred) < 1e-9);
    assert.equal(r.teamGp, lab[i].teamGp);
  });
});

test('ridge recovers noise-free opponent-adjusted ratings', () => {
  const games = [];
  for (const h of IDS) for (const a of IDS) if (h !== a) games.push({ h, a, y: R[h] - R[a] });
  const r = ridgeRatings(games, IDS, { lambda: 1e-6 });
  for (const id of IDS) assert.ok(Math.abs(r.get(id) - R[id]) < 1e-4);
  // 强惩罚 + 先验：结果贴近先验
  const prior = new Map(IDS.map((id) => [id, 10]));
  const rp = ridgeRatings(games, IDS, { lambda: 1e9, prior });
  for (const id of IDS) assert.ok(Math.abs(rp.get(id) - 10) < 1e-3);
});

test('features use only games strictly before the game date (no same-day or future leakage)', () => {
  const games = expand(dataset.seasons['2022-23']);
  const start = { 1: 1500, 2: 1500, 3: 1500, 4: 1500 };
  const base = replaySeason(games, start, P, SPECS).rows;
  const cut = 10;
  const changed = games.map((g, i) => (i < cut ? g : { ...g, home: { ...g.home, pts: 200, win: true } }));
  const alt = replaySeason(changed, start, P, SPECS).rows;
  // 被改动的第一场之前（含同一天）的特征完全不变
  const firstChangedDate = games[cut].date;
  base.forEach((r, i) => {
    if (r.date <= firstChangedDate) assert.deepEqual({ ...alt[i], actual: 0, homeWin: 0 }, { ...r, actual: 0, homeWin: 0 });
  });
  assert.equal(base[0].home.n, 0);
  assert.deepEqual(Object.values(base[0].home.ridge), [0, 0]);
});

test('blend weight grows with games played; n=0 falls back to the base strength', () => {
  const t = { elo: 4, prior: 2, n: 0, ridge: { '0:1:Infinity': -3 } };
  const cfg = { lambda: 1, cap: Infinity, n0: 10 };
  assert.equal(strength(t, { ...cfg, mode: 'blendElo' }), 4);
  assert.equal(strength(t, { ...cfg, mode: 'blendPrior' }), 2);
  assert.equal(strength({ ...t, n: 10 }, { ...cfg, mode: 'blendElo' }), 0.5);
  assert.equal(strength({ ...t, n: 10 }, { ...cfg, mode: 'blendPrior' }), -0.5);
});

test('paired bootstrap CI is deterministic and brackets the mean', () => {
  const diffs = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 0.1 - 0.01);
  const a = bootstrapCI(diffs, { B: 500 });
  assert.deepEqual(a, bootstrapCI(diffs, { B: 500 }));
  assert.ok(a.lo < a.mean && a.mean < a.hi);
});
