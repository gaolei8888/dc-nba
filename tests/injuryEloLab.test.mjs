import test from 'node:test';
import assert from 'node:assert/strict';
import { computeElo } from '../server/ratings.mjs';
import { replay } from '../server/lab.mjs';
import {
  eloShift, dampOf, replayElo, seasonEloSequential, predictProb, reportStamp, reportUsable, etToMs,
  healthyRotation, preDeduction, postDeduction, strataOf,
} from '../server/injuryEloLab.mjs';
import { decisionInstant } from '../server/injuryReport.mjs';

// 小型两季数据集（紧凑格式同 data/backtest.json）：4 队，同日多场，含一场中立场
function tinyDataset() {
  const seasons = {};
  let n = 0;
  for (const [season, y] of [['2021-22', 2021], ['2022-23', 2022]]) {
    const rows = [];
    for (let d = 0; d < 30; d += 1) {
      const date = new Date(Date.UTC(y, 9, 20 + d)).toISOString().slice(0, 10);
      const pairs = d % 2 ? [[1, 2], [3, 4]] : [[2, 3], [4, 1]];
      for (const [h, a] of pairs) {
        n += 1;
        const hp = 100 + ((n * 7) % 23) + h; const ap = 100 + ((n * 11) % 19) + a;
        const neutral = n % 17 === 0;
        rows.push({ i: `g${String(n).padStart(4, '0')}`, d: date, s: [[h, hp, neutral ? 0 : 1], [a, ap === hp ? ap + 1 : ap, 0]] });
      }
    }
    seasons[season] = rows;
  }
  return { seasons, teamAdv: {} };
}

test('伤病感知更新：D = 0 时逐位等于现行 Elo（computeElo 与 lab.replay）', () => {
  const ds = tinyDataset();
  const zero = () => ({ dH: 0, dA: 0 });
  // 含上季热身：s 取多少都一样
  for (const s of [0.5, 1]) {
    const ours = replayElo(ds, ['2022-23'], { update: zero, mode: { s } });
    const prod = replay(ds, ['2022-23']);
    assert.equal(ours.length, prod.length);
    ours.forEach((r, i) => {
      assert.equal(r.gameId, prod[i].gameId);
      assert.equal(r.pred, prod[i].pred);   // 严格相等，不是近似
      assert.equal(r.teamGp, prod[i].teamGp);
    });
  }
  // 单场位移与 computeElo 相同
  const g = { gameId: 'x', date: '2022-10-20', neutral: false, home: { teamId: 1, pts: 110, win: true }, away: { teamId: 2, pts: 99, win: false } };
  const ref = computeElo([g], { initial: { 1: 1550, 2: 1480 } }).final;
  const shift = eloShift(1550, 1480, g, { dH: 0, dA: 0, s: 1 });
  assert.equal(1550 + shift, ref[1]);
  assert.equal(1480 - shift, ref[2]);
});

test('上季热身：seasonEloSequential(D=0) 与 computeElo(...).final 逐位相同', async () => {
  const ds = tinyDataset();
  const { expand } = await import('../server/lab.mjs');
  const games = expand(ds.seasons['2021-22']);
  const a = seasonEloSequential(games, { update: () => ({ dH: 0, dA: 0 }), mode: { s: 1 } });
  const b = computeElo(games).final;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const k of Object.keys(b)) assert.equal(a[k], b[k]);
});

test('伤病感知更新：缺阵方输球时少掉分，赢球时多加分', () => {
  const lose = { neutral: false, home: { teamId: 1, pts: 95, win: false }, away: { teamId: 2, pts: 105, win: true } };
  const win = { neutral: false, home: { teamId: 1, pts: 105, win: true }, away: { teamId: 2, pts: 95, win: false } };
  assert.ok(eloShift(1500, 1500, lose, { dH: 4, s: 1 }) > eloShift(1500, 1500, lose));
  assert.ok(eloShift(1500, 1500, win, { dH: 4, s: 1 }) > eloShift(1500, 1500, win));
});

test('s 的缩放：s·D 只以乘积进入更新与预测；s = 0 等于现行', () => {
  const g = { neutral: false, home: { teamId: 1, pts: 101, win: true }, away: { teamId: 2, pts: 99, win: false } };
  assert.equal(eloShift(1520, 1490, g, { dH: 2, dA: 1, s: 0.5 }), eloShift(1520, 1490, g, { dH: 1, dA: 0.5, s: 1 }));
  assert.equal(eloShift(1520, 1490, g, { dH: 3, dA: 1, s: 0 }), eloShift(1520, 1490, g));
  // 28·s·D 换成 Elo：s=1、D=1 等于把主队 Elo 直接减 28
  assert.equal(eloShift(1520, 1490, g, { dH: 1, s: 1 }), eloShift(1492, 1490, g));
  // 预测：净胜分 − s·(D主 − D客)
  assert.equal(predictProb(3, 2, 0, 0.75, 12), predictProb(3 - 1.5, 0, 0, 1, 12));
  assert.equal(predictProb(3, 2, 2, 1, 12), predictProb(3, 0, 0, 1, 12));
  // 不同 s 的重放确实不同（D ≠ 0 时）
  const ds = tinyDataset();
  const upd = (gid) => ({ dH: gid.endsWith('3') ? 3 : 0, dA: 0 });
  const r5 = replayElo(ds, ['2022-23'], { update: upd, mode: { s: 0.5 } });
  const r10 = replayElo(ds, ['2022-23'], { update: upd, mode: { s: 1 } });
  assert.ok(r5.some((r, i) => r.pred !== r10[i].pred));
});

test('E 方案的降权：(1 − min(1, D合计/c))，c = ∞ 不降权', () => {
  assert.equal(dampOf(2, 3, 10), 0.5);
  assert.equal(dampOf(8, 8, 10), 0);
  assert.equal(dampOf(5, 5, Infinity), 1);
  const g = { neutral: false, home: { teamId: 1, pts: 101, win: true }, away: { teamId: 2, pts: 99, win: false } };
  assert.equal(eloShift(1500, 1500, g, { damp: 0.5 }), 0.5 * eloShift(1500, 1500, g));
});

test('无未来泄漏：只用标注时间 + 15 分钟 ≤ 决策时点、且决策时点早于开赛的报告', () => {
  assert.deepEqual(reportStamp('2023-01-10_05PM'), { date: '2023-01-10', min: 17 * 60 + 30 });
  assert.deepEqual(reportStamp('2026-01-14_05_00PM'), { date: '2026-01-14', min: 17 * 60 });
  assert.deepEqual(reportStamp('2026-01-14_12_15AM'), { date: '2026-01-14', min: 15 });
  // 冬令时：06:30 北京 = 美东 17:30
  const dec = decisionInstant('2023-01-10', '0630');
  const tip = etToMs('2023-01-10', 19 * 60);   // 7 点开赛
  assert.equal(reportUsable('2023-01-10_04PM', dec, tip), true);    // 16:30 + 15 ≤ 17:30
  assert.equal(reportUsable('2023-01-10_05PM', dec, tip), false);   // 17:30 + 15 > 17:30
  assert.equal(reportUsable('2023-01-10_06PM', dec, tip), false);   // 决策之后的报告
  assert.equal(reportUsable('2023-01-10_04PM', dec, etToMs('2023-01-10', 17 * 60)), false);   // 17:00 已开打
  // 新版 15 分钟一份：17:15 正好在 17:30 前 15 分钟，可用；17:30 那份不可用
  const dec26 = decisionInstant('2026-01-14', '0630');
  const tip26 = etToMs('2026-01-14', 19 * 60 + 30);
  assert.equal(reportUsable('2026-01-14_05_15PM', dec26, tip26), true);
  assert.equal(reportUsable('2026-01-14_05_30PM', dec26, tip26), false);
  // 夏令时：06:30 北京 = 美东 18:30
  const decDst = decisionInstant('2025-04-01', '0630');
  assert.equal(reportUsable('2025-04-01_06_15PM', decDst, etToMs('2025-04-01', 19 * 60)), true);
  assert.equal(reportUsable('2025-04-01_06_30PM', decDst, etToMs('2025-04-01', 19 * 60)), false);
});

test('无未来泄漏：赛前扣分只读赛前状态，与当场实际谁上场无关', () => {
  const H = [{ id: 1, m: 34 }, { id: 2, m: 30 }, { id: 3, m: 28 }, { id: 4, m: 26 }, { id: 5, m: 24 }, { id: 6, m: 20 }, { id: 7, m: 18 }, { id: 8, m: 16 }, { id: 9, m: 12 }];
  const val = new Map([[1, 6], [2, 2], [3, 1], [4, 0], [5, 0], [6, -1], [7, -1], [8, -1], [9, -1]]);
  const status = new Map([[1, 'Out']]);
  const pre = preDeduction(H, (id) => status.get(id), { Out: 0 }, val);
  assert.ok(pre > 0);
  // 赛前扣分不接受「谁上了场」；赛后扣分才看 playedSet
  const played = new Set(H.map((p) => p.id));
  assert.equal(postDeduction(H, played, val), 0);
  played.delete(1);
  assert.equal(postDeduction(H, played, val), pre);   // 赛前确定 Out 且真没上：两者一致
  // 不在报告上 = 按 1；空基线 = 0
  assert.equal(preDeduction(H, () => undefined, { Out: 0 }, val), 0);
  assert.equal(preDeduction([], (id) => status.get(id), { Out: 0 }, val), 0);
});

test('健康基线：分钟是最近 W 次出场时的场均（缺席不算 0）', () => {
  const H = healthyRotation([{ id: 1, mins: [30, 30, 36, 36] }, { id: 2, mins: [] }], 2);
  assert.deepEqual(H, [{ id: 1, m: 36 }]);
});

test('分层：≥5 场的连续缺阵为 (i)，复出那场起 10 场为 (ii)，(i) 优先', () => {
  const seq = [];
  for (let k = 0; k < 20; k += 1) {
    const out = k >= 2 && k < 8;   // 第 2–7 场缺 6 场
    seq.push({ gameId: `t${k}`, absent: new Set(out ? [9] : []), playedSet: new Set(out ? [] : [9]) });
  }
  const short = [];
  for (let k = 0; k < 6; k += 1) short.push({ gameId: `u${k}`, absent: new Set(k === 1 ? [5] : []), playedSet: new Set(k === 1 ? [] : [5]) });
  // 另一队在 t3（已是 (i)）和 t9（(ii)）上也有比赛：同一 gameId 共用
  const other = [{ gameId: 't9', absent: new Set(), playedSet: new Set() }];
  const tag = strataOf(new Map([[1, seq], [2, short], [3, other]]));
  for (let k = 2; k < 8; k += 1) assert.equal(tag.get(`t${k}`), 'i');
  for (let k = 8; k < 18; k += 1) assert.equal(tag.get(`t${k}`), 'ii');
  assert.equal(tag.get('t18'), undefined);
  assert.equal(tag.get('u1'), undefined);   // 1 场的缺阵不算长期
});
