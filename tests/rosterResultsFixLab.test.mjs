import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resultsUpdate } from '../server/rosterResults.mjs';
import { minutesLab } from '../server/minutesLab.mjs';
import {
  lineupAdjustedUpdate, teamGameValues, blockBootstrapCI, strataOf, reportUsable,
} from '../server/rosterResultsFixLab.mjs';

const A = 1; const B = 2; const C = 3;
const priors = new Map([[A, 2.5], [B, -1.25], [C, 0.4]]);
const games = [
  { homeId: A, awayId: B, margin: 7, hca: 1.6, date: '2025-01-01' },
  { homeId: B, awayId: C, margin: -3, hca: 1.6, date: '2025-01-03' },
  { homeId: C, awayId: A, margin: 12, hca: 0, date: '2025-01-05' },
  { homeId: A, awayId: C, margin: -2, hca: 1.6, date: '2025-02-10' },
];
const REC = { recency: { ratio: 0.4, days: 60, asOf: '2025-03-01' } };

test('无缺阵（D 全 0）时 R1 与 R0（resultsUpdate）逐位相同', () => {
  for (const s of [0, 0.5, 0.75, 1]) {
    for (const K of [8, 12, 16]) {
      const r0 = resultsUpdate(priors, games, K, REC);
      const zeroPre = new Map([[A, 0], [B, 0], [C, 0]]);
      const zeroGames = games.map((g) => ({ ...g, dPostHome: 0, dPostAway: 0 }));
      for (const [pre, gs] of [[zeroPre, zeroGames], [null, games]]) {
        const r1 = lineupAdjustedUpdate(priors, pre, gs, K, { ...REC, s });
        for (const id of [A, B, C]) {
          assert.equal(r1.get(id).rating, r0.get(id).rating);
          assert.equal(r1.get(id).priorWeight, r0.get(id).priorWeight);
          assert.equal(r1.get(id).prior, r0.get(id).prior);
        }
      }
    }
  }
});

test('s 缩放：s = 0 等于 R0；一般 s 等于在满员当量空间里解原方程再减回 s·D_pre', () => {
  const dPre = new Map([[A, 3], [B, 0.5], [C, -0.4]]);
  const gs = games.map((g, i) => ({ ...g, dPostHome: [2, 0, 1, 4][i], dPostAway: [0, 1.5, 0, 0][i] }));
  const r0 = resultsUpdate(priors, games, 12, REC);
  const s0 = lineupAdjustedUpdate(priors, dPre, gs, 12, { ...REC, s: 0 });
  for (const id of [A, B, C]) assert.equal(s0.get(id).rating, r0.get(id).rating);
  for (const s of [0.5, 0.75, 1]) {
    const got = lineupAdjustedUpdate(priors, dPre, gs, 12, { ...REC, s });
    const ref = resultsUpdate(new Map([...priors].map(([id, p]) => [id, p + s * dPre.get(id)])),
      gs.map((g) => ({ ...g, margin: g.margin + s * (g.dPostHome - g.dPostAway) })), 12, REC);
    for (const id of [A, B, C]) {
      assert.equal(got.get(id).rating, ref.get(id).rating - s * dPre.get(id));
      assert.equal(got.get(id).fullRating, ref.get(id).rating);
      assert.equal(got.get(id).prior, priors.get(id));
    }
  }
  // s 越大，复出球队（过去缺阵、今天回来）被还回的分越多：评级随 s 单调上升
  const ret = [0, 0.5, 1].map((s) => lineupAdjustedUpdate(new Map([[A, 0], [B, 0]]), new Map(),
    [{ homeId: A, awayId: B, margin: -4, hca: 0, dPostHome: 4, dPostAway: 0 }], 12, { s }).get(A).rating);
  assert.ok(ret[0] < ret[1] && ret[1] < ret[2]);
});

test('复出：缺人输掉的比赛在 s=1 时完全还分；持续缺阵：R1 与 R0 一致（不重复扣）', () => {
  const p = new Map([[A, 0], [B, 0]]);
  const lost = Array.from({ length: 10 }, (_, i) => ({ homeId: A, awayId: B, margin: -4, hca: 0, date: `2025-01-${String(i + 1).padStart(2, '0')}`, dPostHome: 4, dPostAway: 0 }));
  // 球星回来了：今天的先验 = 满员 0，D_pre = 0
  const r0 = resultsUpdate(p, lost, 12);
  const r1 = lineupAdjustedUpdate(p, new Map([[A, 0], [B, 0]]), lost, 12, { s: 1 });
  assert.ok(r0.get(A).rating < -1);
  assert.ok(Math.abs(r1.get(A).rating) < 1e-6);
  // 今天还缺他：先验已扣 4（p = −4，D_pre = 4），过去也缺他 → 调整为 0，与 R0 相同
  const pOut = new Map([[A, -4], [B, 0]]);
  const q0 = resultsUpdate(pOut, lost, 12);
  const q1 = lineupAdjustedUpdate(pOut, new Map([[A, 4], [B, 0]]), lost, 12, { s: 1 });
  assert.ok(Math.abs(q1.get(A).rating - q0.get(A).rating) < 1e-6);
  assert.ok(Math.abs(q1.get(A).rating + 4) < 1e-6);
});

// ---------------------------------------------------------------- minutesLab strict：先验不泄漏

/** 两队的小赛季：stints 每场两段各 24 分钟，每段每队 5 人 */
function fixture({ alterFrom = Infinity } = {}) {
  const tA = [101, 102, 103, 104, 105, 106, 107, 108];
  const tB = [201, 202, 203, 204, 205, 206, 207, 208];
  const stint = (a, b) => [...a, ...b, 0, 0, 0, 0, 1440];
  const mk = (season, n, debutAt) => {
    const rows = []; const g = {};
    for (let k = 0; k < n; k += 1) {
      const id = `${season}-${String(k).padStart(3, '0')}`;
      const d = new Date(Date.UTC(2024 + (season === 'S1' ? 1 : 0), 0, 1 + 2 * k)).toISOString().slice(0, 10);
      rows.push({ i: id, d, s: [[A, 100 + (k % 7), 1], [B, 98 + (k % 5), 0]] });
      let a1 = tA.slice(0, 5); let a2 = tA.slice(3, 8);
      if (season === 'S1' && k >= 6 && k < 12) { a1 = a1.map((x) => (x === 101 ? 106 : x)); a2 = a2.map((x) => x); }   // 101 缺阵 6 场
      if (season === 'S1' && k >= debutAt) a2 = [109, ...a2.slice(1)];   // 109 本季中途首秀
      if (season === 'S1' && k >= alterFrom) { a1 = [108, 107, 106, 105, 104]; a2 = [103, 102, 108, 107, 106]; }   // 「未来」改写
      g[id] = [A, B, [stint(a1, tB.slice(0, 5)), stint(a2, tB.slice(3, 8))]];
    }
    return { rows, games: g };
  };
  const s0 = mk('S0', 20, Infinity); const s1 = mk('S1', 20, 8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrfix-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ picks_lag15: {} }));
  const people = [...tA, 109, ...tB].map((id) => ({ playerId: id, name: `P ${id}` }));
  return {
    dataset: { seasons: { S0: s0.rows, S1: s1.rows } },
    teams: [{ teamId: A, full: 'Team A', abbr: 'AAA' }, { teamId: B, full: 'Team B', abbr: 'BBB' }],
    players: { S0: people, S1: people },
    stints: { S0: { games: s0.games }, S1: { games: s1.games } },
    injDir: dir, allSeasons: ['S0', 'S1'],
  };
}
const values = new Map([...[101, 102, 103, 104, 105, 106, 107, 108, 109, 201, 202, 203, 204, 205, 206, 207, 208]
  .map((id) => [id, id === 101 ? 4 : (id % 7) / 3 - 1])]);
const sideOf = (ctxs, k, team) => { const g = ctxs[k]; return g.home.teamId === team ? g.home : g.away; };
const pre = (side) => side.rows.map((r) => ({ pid: r.pid, priorMpg: r.priorMpg, n: r.n, curMpg: r.curMpg, status: r.status })).sort((x, y) => x.pid - y.pid);

test('strict 先验不泄漏：改写本场及以后的 stints 不改变本场的候选、赛前特征、先验与 D_pre；本场才首秀的人不进候选', () => {
  const base = minutesLab({ ...fixture(), roster: 'strict' }).buildContexts('S1');
  const alt = minutesLab({ ...fixture({ alterFrom: 10 }), roster: 'strict' }).buildContexts('S1');
  for (let k = 0; k <= 10; k += 1) {
    const a = sideOf(base, k, A); const b = sideOf(alt, k, A);
    assert.deepEqual(pre(a), pre(b), `第 ${k} 场的赛前输入不应随本场及以后的 stints 变化`);
    const va = teamGameValues(a, values, 0); const vb = teamGameValues(b, values, 0);
    assert.equal(va.prior, vb.prior); assert.equal(va.dPre, vb.dPre); assert.equal(va.healthy, vb.healthy);
  }
  // 对照：改写确实生效——第 11 场的赛前特征（含第 10 场的出场）就不同了
  assert.notDeepEqual(pre(sideOf(base, 11, A)), pre(sideOf(alt, 11, A)));
  // 109 在第 8 场首秀：strict 第 8 场不在候选，第 9 场起才在；legacy 第 8 场就在（含赛后信息）
  assert.ok(!sideOf(base, 8, A).rows.some((r) => r.pid === 109));
  assert.ok(sideOf(base, 9, A).rows.some((r) => r.pid === 109));
  const legacy = minutesLab({ ...fixture(), roster: 'legacy' }).buildContexts('S1');
  assert.ok(sideOf(legacy, 8, A).rows.some((r) => r.pid === 109));
  // legacy 默认行为不变：不传 roster 与传 'legacy' 相同
  const dflt = minutesLab(fixture()).buildContexts('S1');
  assert.deepEqual(dflt.map((g) => pre(g.home)), legacy.map((g) => pre(g.home)));
});

test('teamGameValues：全员上场且无报告时 D_pre = D_post = 0；缺了高价值的人 D_post > 0', () => {
  const ctx = minutesLab({ ...fixture(), roster: 'strict' }).buildContexts('S1');
  const allPlayed = { ...sideOf(ctx, 3, A), rows: sideOf(ctx, 3, A).rows.map((r) => ({ ...r, played: true })) };
  const v = teamGameValues(allPlayed, values, 0.3);
  assert.equal(v.dPre, 0); assert.equal(v.dPost, 0); assert.equal(v.prior, v.healthy); assert.equal(v.actual, v.healthy);
  const out = sideOf(ctx, 7, A);   // 101（价值 4）缺阵
  assert.ok(!out.rows.find((r) => r.pid === 101).played);
  assert.ok(teamGameValues(out, values, 0).dPost > 0);
});

test('按比赛日分块 bootstrap：均值同按场；整日常数时区间退化；块数正确', () => {
  const diffs = [1, 1, 1, -1, -1, 2];
  const blocks = ['d1', 'd1', 'd1', 'd2', 'd2', 'd3'];
  const c = blockBootstrapCI(diffs, blocks, { B: 500 });
  assert.equal(c.blocks, 3);
  assert.ok(Math.abs(c.mean - 0.5) < 1e-12);
  assert.ok(c.lo <= c.mean && c.mean <= c.hi);
  const flat = blockBootstrapCI([0.2, 0.2, 0.2], ['a', 'b', 'b'], { B: 200 });
  assert.ok(Math.abs(flat.lo - 0.2) < 1e-12 && Math.abs(flat.hi - 0.2) < 1e-12);
});

test('分层：≥5 场连续缺阵为 (i)，复出起 10 场为 (ii)', () => {
  const seq = [];
  for (let k = 0; k < 20; k += 1) seq.push({ gameId: `g${k}`, absent: new Set(k >= 2 && k < 8 ? [9] : []), playedSet: new Set(k >= 2 && k < 8 ? [] : [9]) });
  const tag = strataOf(new Map([['t', seq]]));
  assert.equal(tag.get('g1'), undefined);
  for (let k = 2; k < 8; k += 1) assert.equal(tag.get(`g${k}`), 'i');
  for (let k = 8; k < 18; k += 1) assert.equal(tag.get(`g${k}`), 'ii');
  assert.equal(tag.get('g18'), undefined);
});

test('报告时间核对：标注 + 15 分钟必须 ≤ 决策时点，且决策时点早于开赛', () => {
  const decision = Date.parse('2025-01-10T14:00:00Z');   // 北京 22:00 = 美东 09:00
  assert.equal(reportUsable('2025-01-10_08_30AM', decision, Date.parse('2025-01-11T00:00:00Z')), true);
  assert.equal(reportUsable('2025-01-10_08_50AM', decision, null), false);
  assert.equal(reportUsable('2025-01-10_08_30AM', decision, decision), false);
});
