/**
 * 模拟投注：赔率换算、注单结算、盈亏统计。
 *
 * 全部使用虚拟积分，没有任何真实货币。做这个模块的目的不是"玩得爽"，
 * 而是把庄家优势演示清楚——所以赔率里的抽水是明示的，界面上会实时
 * 显示每一注的期望值，长期收益曲线会自然走向负数。
 */

/** 庄家抽水（overround）。5% 大致对应真实体育博彩的两项盘口水位。 */
export const VIG = 0.05;

export const INITIAL_BALANCE = 10000;

/**
 * 概率 -> 十进制赔率，含抽水。
 *
 * 无抽水时赔率 = 1/p，两边的隐含概率加起来正好是 1，庄家不赚不亏。
 * 加上抽水后隐含概率之和变成 1+VIG，这部分就是庄家的长期利润，
 * 也是玩家的长期亏损率。
 */
export const toOdds = (p) => {
  const q = Math.min(0.995, Math.max(0.005, p)) * (1 + VIG);
  return Math.round((1 / q) * 100) / 100;
};

/** 十进制赔率 -> 隐含概率（含抽水，所以两边相加 > 1） */
export const impliedProb = (odds) => 1 / odds;

/**
 * 一注的期望值（以模型概率为"真实"概率）。
 * 恒为负是抽水造成的——这正是要展示的东西。
 */
export const expectedValue = (stake, odds, trueProb) => stake * (odds * trueProb - 1);

/** 串关：赔率相乘，命中概率相乘 */
export function combineLegs(legs) {
  let odds = 1;
  let prob = 1;
  for (const l of legs) {
    odds *= l.odds;
    prob *= l.trueProb;
  }
  return {
    odds: Math.round(odds * 100) / 100,
    trueProb: prob,
  };
}

/**
 * 给一场比赛生成两边的盘口。
 * trueProb 用模型的赛前胜率——这是我们能拿到的最好估计。
 */
export function makeMarket(game) {
  const pHome = game.modelProb;
  const pAway = 1 - pHome;
  return {
    home: { side: 'home', trueProb: pHome, odds: toOdds(pHome) },
    away: { side: 'away', trueProb: pAway, odds: toOdds(pAway) },
  };
}

/**
 * 结算一张注单。所有腿都命中才算赢。
 * @param {object} slip { legs: [{gameId, side, odds, trueProb}], stake }
 * @param {Map} resultByGame gameId -> { homeWin }
 */
export function settleSlip(slip, resultByGame) {
  const legs = slip.legs.map((l) => {
    const r = resultByGame.get(l.gameId);
    return {
      ...l,
      settled: !!r,
      won: r ? (l.side === 'home') === r.homeWin : null,
    };
  });
  if (legs.some((l) => !l.settled)) return { ...slip, legs, status: 'pending' };

  const won = legs.every((l) => l.won);
  const combined = combineLegs(slip.legs);
  const payout = won ? Math.round(slip.stake * combined.odds) : 0;
  return {
    ...slip,
    legs,
    status: won ? 'won' : 'lost',
    odds: combined.odds,
    payout,
    profit: payout - slip.stake,
  };
}

/** 汇总所有已结算注单 */
export function summarizeSlips(slips) {
  const done = slips.filter((s) => s.status === 'won' || s.status === 'lost');
  const staked = done.reduce((a, s) => a + s.stake, 0);
  const profit = done.reduce((a, s) => a + s.profit, 0);
  const evSum = done.reduce(
    (a, s) => a + expectedValue(s.stake, s.odds ?? combineLegs(s.legs).odds, combineLegs(s.legs).trueProb),
    0,
  );
  return {
    n: done.length,
    won: done.filter((s) => s.status === 'won').length,
    staked,
    profit,
    roi: staked ? profit / staked : 0,
    /** 按模型概率算出来的理论期望，用来对照"运气"和"数学" */
    expected: evSum,
    expectedRoi: staked ? evSum / staked : 0,
  };
}
