// 中文回归快照用的夹具（tests/fixtures/board-summary-zh.json 由改造前的代码对这些夹具生成）。
// 与 tests/predictionBoard.test.mjs 的夹具同形；改这里要重新生成快照。

const done = (id, date, homeId, awayId, p, hs, as, extra = {}) => ({
  gameId: id, date, homeId, awayId, homeScore: hs, awayScore: as,
  prediction: { homeWinProb: p, homeScore: 110, awayScore: 105, margin: 5, total: 215 },
  hit: (p >= 0.5) === (hs > as), ...extra,
});
const next = (id, date, homeId, awayId, p) => ({
  gameId: id, date, homeId, awayId, prediction: { homeWinProb: p, homeScore: 110, awayScore: 105, margin: 5, total: 215 },
});
const full = (id, date, p, hs, as, pred = {}, extra = {}) => ({
  ...done(id, date, 1, 2, p, hs, as, extra),
  prediction: { homeWinProb: p, homeScore: 110, awayScore: 100, margin: 10, total: 210, restHome: 1, restAway: 1, ...pred },
});

export const MIN_MARKET_FIXTURE = 20;

/** 名称 -> 比赛列表 */
export const boardFixtures = {
  basic: () => [
    done('g1', '2026-10-20', 1, 2, 0.8, 110, 100),
    done('g2', '2026-10-20', 3, 4, 0.75, 95, 101),
    done('g3', '2026-10-21', 2, 3, 0.4, 99, 108, { market: { homeProb: 0.55 } }),
    next('g4', '2026-10-22', 1, 4, 0.9),
    next('g5', '2026-10-28', 2, 4, 0.5),
    next('g6', '2026-10-29', 2, 1, 0.5),
  ],
  empty: () => [next('g1', '2026-10-20', 1, 2, 0.6)],
  market: () => Array.from({ length: MIN_MARKET_FIXTURE }, (_, i) =>
    done(`m${i}`, '2026-10-20', 1, 2, 0.6, 100, 90, { market: { homeProb: i ? 0.7 : 0.4 } })),
  stats: () => [
    full('a', '2026-10-20', 0.7, 112, 100, {}, { preElo: { home: 1600, away: 1500 } }),
    full('b', '2026-10-20', 0.66, 100, 104, { restHome: 0 }, { preElo: { home: 1500, away: 1600 } }),
    full('c', '2026-10-21', 0.4, 90, 110, {}, { preElo: { home: 1400, away: 1500 } }),
    next('u1', '2026-10-22', 1, 2, 0.52),
    next('u2', '2026-10-22', 1, 2, 0.9),
  ],
  // 客队热门、主队爆冷取胜；没有高信心比赛；没有未开打比赛
  upsetHome: () => [
    full('h1', '2026-11-02', 0.4, 101, 99),
    full('h2', '2026-11-03', 0.55, 120, 99),
  ],
};

/** verdictOf 用例：[名称, 汇总, seasons] */
export const verdictCases = [
  ['base', { bets: 812, roi: -0.031, ci: { lo: -0.09, hi: 0.03 } }, 3],
  ['positive', { bets: 500, roi: 0.06, ci: { lo: 0.01, hi: 0.11 } }, 2],
  ['negative', { bets: 500, roi: -0.08, ci: { lo: -0.13, hi: -0.02 } }, 2],
  ['noEvidence', { bets: 500, roi: -0.01, ci: { lo: -0.05, hi: 0.03 } }, 2],
  ['none', { bets: 0, roi: null, ci: { lo: null, hi: null } }, 0],
  ['zeroRoi', { bets: 10, roi: 0, ci: { lo: 0, hi: 0.2 } }, 1],
];

// ---- 阵容先验说明：覆盖四种来源（含「新秀但有样本」走新秀措辞的分支）
const N = 12;
const tinyModel = { features: ['pts'], mu: [0], sd: [1], beta: [0.1], intercept: 0 };
const box = (pts, min, gp) => ({ gp, min, base: { pts } });
function baseStore() {
  return {
    meta: { leagueAvg: { pace: 100 }, fetchedAt: '2026-10-27T15:00:00Z' },
    teams: [1, 2].map((teamId) => ({ teamId, adv: { pace: 100 } })),
    players: [1, 2].flatMap((teamId) => Array.from({ length: N }, (_, i) => ({
      playerId: teamId * 10 + i, teamId, onRoster: true, name: `Player ${teamId}-${i}`,
      gp: 60, min: 20, impact: teamId === 1 ? 1 : 0,
      cur: { gp: 3, min: 40, impact: teamId === 1 ? 1 : 0 },
    }))),
    injuries: { fetchedAt: '2026-10-27T15:00:00Z', players: [] },
  };
}
export const rosterLegacy = [1, 2].map((teamId) => ({ teamId, elo: teamId === 1 ? 1400 : 1600,
  total: teamId === 1 ? -4 : 4, rank: teamId === 1 ? 2 : 1, turnoverAdj: 0 }));

/** 返回 { store, ids }：ids = 来源名 -> playerId */
export function rosterSourceStore({ model = true } = {}) {
  const s = baseStore();
  if (model) s.impactModel = tinyModel;
  // 老将：上季 15 场（低于 IMP 门槛），本季 4 场 → 有样本，收缩到人群均值
  Object.assign(s.players[0], { impact: null, gp: 15, min: 36, base: { pts: 36 }, cur: { ...box(18, 36, 4), impact: null } });
  // 新秀：本季分钟不足，没有 SPM → 新秀先验
  Object.assign(s.players[1], { exp: 'R', impact: null, gp: 0, min: 0, cur: { ...box(10, 8, 2), impact: null } });
  // 新秀但本季已有样本：impactSource 是 estimated-shrunk-spm，措辞却是新秀均值
  Object.assign(s.players[2], { exp: 'R', impact: null, gp: 0, min: 0, cur: { ...box(20, 30, 3), impact: null } });
  // 边缘老将：两季都 <10 分钟 → 10–15 分钟段均值
  Object.assign(s.players[3], { exp: '5', impact: null, gp: 5, min: 5, base: { pts: 2 }, cur: { ...box(1, 4, 1), impact: null } });
  s.players.push({ playerId: 500, teamId: 2, onRoster: false, exp: '1', gp: 50, min: 20, base: { pts: 10 } });
  s.players.push({ playerId: 501, teamId: 2, onRoster: false, exp: '4', gp: 40, min: 12, base: { pts: 3 } });
  return { store: s, ids: [10, 11, 12, 13] };
}
