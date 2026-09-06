/**
 * 本地存档。
 *
 * 刻意只用 localStorage：服务端保持无状态、数据快照保持只读，
 * 容器不需要挂卷也不需要数据库。代价是存档跟着浏览器走，
 * 换设备或清缓存就没了——对一个单人小游戏这个取舍是划算的。
 *
 * 所有读写都包在 try/catch 里：隐私模式下 localStorage 会直接抛异常。
 */

import { loadGame, saveGame } from './profiles.js';

const EMPTY = {
  version: 1,
  /** gameId -> { side: 'home'|'away', conf: 0.5~0.95, at: ISO } */
  picks: {},
  /** 已经翻牌结算过的 gameId，避免重复计分 */
  settled: {},
  /** 玩家推进到哪一天了（历史赛季模式） */
  cursor: null,
};

export function loadPlay(profileId) {
  const parsed = loadGame('play', profileId, null);
  if (!parsed || parsed.version !== 1) return { ...EMPTY };
  return { ...EMPTY, ...parsed };
}

export function savePlay(profileId, state) {
  saveGame('play', profileId, state);
  return state;
}

export function resetPlay(profileId) {
  return savePlay(profileId, { ...EMPTY });
}

// ---------------------------------------------------------------- 计分

/**
 * 单场结算。
 *
 * 积分同时奖励"选对"和"敢下重注"，但下重注押错要付出对称的代价，
 * 否则最优策略永远是把信心拉满。这里用的是对数记分的线性变体：
 *   猜对 → +round((conf - 0.5) * 200)      信心 50% 得 0 分，95% 得 90 分
 *   猜错 → -round((conf - 0.5) * 200)
 * 也就是说只有当你的判断确实优于抛硬币时，加信心才划算。
 */
export function scorePick(pick, game) {
  const correct = (pick.side === 'home') === game.homeWin;
  const points = Math.round((pick.conf - 0.5) * 200) * (correct ? 1 : -1);
  // Brier 用来跟模型做同口径对比：预测的是"主队获胜概率"
  const pHome = pick.side === 'home' ? pick.conf : 1 - pick.conf;
  const y = game.homeWin ? 1 : 0;
  return {
    correct,
    points,
    brier: (pHome - y) ** 2,
    modelCorrect: (game.modelProb >= 0.5) === game.homeWin,
    modelBrier: (game.modelProb - y) ** 2,
    // 模型也押同样的信心时能拿多少分，用来比较"敢不敢下注"
    modelPoints: Math.round((Math.max(game.modelProb, 1 - game.modelProb) - 0.5) * 200)
      * (((game.modelProb >= 0.5) === game.homeWin) ? 1 : -1),
  };
}

/** 把一批已结算的比赛汇总成战绩 */
export function summarize(rows) {
  const n = rows.length;
  if (!n) {
    return {
      n: 0, correct: 0, accuracy: 0, points: 0, brier: 0,
      modelCorrect: 0, modelAccuracy: 0, modelPoints: 0, modelBrier: 0,
      streak: 0, bestStreak: 0,
    };
  }
  let correct = 0; let points = 0; let brier = 0;
  let modelCorrect = 0; let modelPoints = 0; let modelBrier = 0;
  let streak = 0; let bestStreak = 0;

  for (const r of rows) {
    if (r.correct) { correct += 1; streak += 1; bestStreak = Math.max(bestStreak, streak); }
    else streak = 0;
    points += r.points;
    brier += r.brier;
    if (r.modelCorrect) modelCorrect += 1;
    modelPoints += r.modelPoints;
    modelBrier += r.modelBrier;
  }
  return {
    n,
    correct,
    accuracy: correct / n,
    points,
    brier: brier / n,
    modelCorrect,
    modelAccuracy: modelCorrect / n,
    modelPoints,
    modelBrier: modelBrier / n,
    streak,
    bestStreak,
  };
}
