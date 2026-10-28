import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, expand } from '../server/lab.mjs';
import {
  gameMinutes, rosterTracker, continuity, rosterRaw, leagueCenter, replaySeason, eloStartFor,
  eloWeight, strength, predict, teamGamesFromStints,
} from '../server/continuityLab.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const P = { k: 20, carryKeep: 0.75, homeAdv: 1.6, restWeight: 1.8 };

/** 一场比赛的 stint：A 队 [1..5]、B 队 [11..15] 打满 48 分钟，A 的 5 号在后 12 分钟换成 6 号 */
const stintGame = (A = 100, B = 200, a = [1, 2, 3, 4, 5], b = [11, 12, 13, 14, 15], sub = 6) => [A, B, [
  [...a, ...b, 50, 50, 55, 52, 36 * 60],
  [...a.slice(0, 4), sub, ...b, 16, 16, 18, 15, 12 * 60],
]];

test('gameMinutes：按段秒数累计每人分钟，前 5 人归 A 队', () => {
  const m = gameMinutes(stintGame());
  assert.equal(m.get(100).get(1), 48);
  assert.equal(m.get(100).get(5), 36);
  assert.equal(m.get(100).get(6), 12);
  assert.equal(m.get(200).get(11), 48);
  close([...m.get(100).values()].reduce((s, v) => s + v, 0), 240);
});

test('rosterTracker：只反映已记录的比赛；为别队出场即从原队移出；teamGames 从加入时算', () => {
  const tr = rosterTracker();
  assert.deepEqual(tr.members(100), []);
  tr.record(gameMinutes(stintGame()));
  const m = new Map(tr.members(100).map((x) => [x.playerId, x]));
  assert.equal(m.size, 6);
  assert.equal(m.get(6).curMpg, 12);
  assert.equal(m.get(1).teamGames, 1);
  // 5 号被交易到 300 队
  tr.record(gameMinutes(stintGame(300, 400, [5, 31, 32, 33, 34], [41, 42, 43, 44, 45], 35)));
  assert.ok(!tr.members(100).some((x) => x.playerId === 5));
  const p5 = tr.members(300).find((x) => x.playerId === 5);
  assert.equal(p5.n, 1);
  assert.equal(p5.teamGames, 1);
  // 100 队又打一场：老成员 teamGames=2，新来的 7 号 teamGames=1
  tr.record(gameMinutes(stintGame(100, 200, [1, 2, 3, 4, 7])));
  const after = new Map(tr.members(100).map((x) => [x.playerId, x]));
  assert.equal(after.get(1).teamGames, 2);
  assert.equal(after.get(7).teamGames, 1);
  assert.equal(after.get(6).n, 2); // 6 号两场都替补出场
  // 6 号被交易走再回来：回来后重新计场次
  tr.record(gameMinutes(stintGame(300, 400, [6, 31, 32, 33, 34], [41, 42, 43, 44, 45], 35)));
  tr.record(gameMinutes(stintGame(100, 200, [1, 2, 3, 4, 7])));
  const back = tr.members(100).find((x) => x.playerId === 6);
  assert.equal(back.n, 1);
  assert.equal(back.teamGames, 1);
});

test('continuity：窗口内当前名单的分钟占比，窗口外的比赛不计', () => {
  const g1 = new Map([[1, 48], [2, 48], [3, 48], [4, 48], [9, 48]]);
  const g2 = new Map([[1, 48], [2, 48], [3, 48], [4, 48], [5, 48]]);
  close(continuity([1, 2, 3, 4, 5], [g1, g2], 82), (4 * 48 + 4 * 48 + 48) / 480);
  close(continuity(new Set([1, 2, 3, 4, 5]), [g1, g2], 1), 1);
  assert.equal(continuity([1], [], 82), null);
});

test('rosterRaw：分满 240 分钟按价值加总，没有价值的人用 fallback；不足 5 人返回 null', () => {
  const players = [1, 2, 3, 4, 5].map((id) => ({ playerId: id, n: 0, curMpg: null, teamGames: 0 }));
  const priorMpg = new Map(players.map((p) => [p.playerId, 30]));
  const value = new Map([[1, 4], [2, 2], [3, 0], [4, -1]]);
  // 5 人各 48 分钟：4+2+0−1+fallback(−0.5)
  close(rosterRaw(players, { priorMpg, value }), 4.5);
  assert.equal(rosterRaw(players.slice(0, 4), { priorMpg, value }), null);
});

test('leagueCenter：上季分钟加权的每队每场平均阵容分', () => {
  const minutes = new Map([[1, 48 * 82], [2, 48 * 82]]);
  close(leagueCenter(minutes, new Map([[1, 3], [2, -1]]), { teams: 1 }), 2);
  close(leagueCenter(minutes, new Map([[1, 3]]), { teams: 1, fallback: -0.5 }), 2.5);
});

test('eloWeight / strength：各模式的权重；没有阵容分或延续度时退回 Elo', () => {
  assert.equal(eloWeight(0.5, { mode: 'elo' }), 1);
  assert.equal(eloWeight(0.5, { mode: 'roster' }), 0);
  assert.equal(eloWeight(0.5, { mode: 'const', w: 0.3 }), 0.3);
  close(eloWeight(0.5, { mode: 'pow', gamma: 2 }), 0.25);
  close(eloWeight(0.5, { mode: 'lin', beta: 0.5 }), 0.75);
  assert.equal(eloWeight(0.1, { mode: 'lin', beta: 3 }), 0);
  assert.equal(eloWeight(null, { mode: 'pow', gamma: 2 }), 1);
  const t = { elo: 2, c: 0.5, roster: { imp: 6, shrunk: null } };
  close(strength(t, { mode: 'pow', gamma: 1, a: 1, value: 'imp' }), 0.5 * 2 + 0.5 * 6);
  close(strength(t, { mode: 'pow', gamma: 1, a: 0.5, value: 'imp' }), 0.5 * 2 + 0.5 * 3);
  assert.equal(strength(t, { mode: 'roster', a: 1, value: 'shrunk' }), 2);
});

/** 4 队双循环的合成赛季（与 fusionLab 测试同构） */
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
        k += 1; day += 1;
      }
    }
  }
  return games;
}
const R = { 1: 6, 2: 2, 3: -2, 4: -6 };
const dataset = { seasons: { '2021-22': season(2021, R), '2022-23': season(2022, R) }, teamAdv: {} };
const roster = (t) => [1, 2, 3, 4, 5, 6].map((j) => t * 10 + j);

test('replaySeason：elo 模式与 lab.replay 逐场一致；阵容分与延续度只用此前比赛', () => {
  const games = expand(dataset.seasons['2022-23']);
  const stints = new Map(games.map((g) => [g.gameId, [g.home.teamId, g.away.teamId, [
    [...roster(g.home.teamId).slice(0, 5), ...roster(g.away.teamId).slice(0, 5), 100, 100, 100, 100, 2880],
  ]]]));
  const prevGames = new Map(IDS.map((t) => [t, [new Map(roster(t).slice(1).map((p) => [p, 48]))]]));
  const value = new Map(IDS.flatMap((t) => roster(t).map((p) => [p, R[t] / 5])));
  const { rows } = replaySeason(games, eloStartFor(dataset, '2022-23', P), P, {
    stints, prevGames, priorMpg: new Map(), values: new Map([['imp', value]]), center: new Map([['imp', 0]]),
  });
  const lab = replay(dataset, ['2022-23']);
  assert.equal(rows.length, lab.length);
  rows.forEach((r, i) => {
    const out = predict(r, { mode: 'elo', sd: 12 });
    close(out.p, lab[i].p, 1e-12);
    close(out.pred, lab[i].pred);
    assert.equal(r.teamGp, lab[i].teamGp);
  });
  // 第一场：用当场出场的 5 人近似名单；延续度 = 上季窗口里这 5 人打的分钟（上季 6 号缺、1 号不在）
  const first = rows[0].home;
  assert.equal(first.opening, true);
  close(first.c, 4 / 5);
  // 5 人各 48 分钟，价值 R/5：阵容分 = R
  close(first.roster.imp, R[rows[0].homeId]);
  // 之后的比赛不再是 opening，且延续度只会上升（本季分钟都是现名单打的）
  const later = rows.filter((r) => r.homeId === rows[0].homeId).at(-1).home;
  assert.equal(later.opening, false);
  assert.ok(later.c > first.c);
});

test('teamGamesFromStints：按 gameId 排序、逐队列出每场分钟', () => {
  const file = { games: { G2: stintGame(100, 200), G1: stintGame(100, 300, [1, 2, 3, 4, 9]) } };
  const m = teamGamesFromStints(file);
  assert.equal(m.get(100).length, 2);
  assert.equal(m.get(100)[0].get(9), 36); // G1 在前
  assert.equal(m.get(300).length, 1);
});
