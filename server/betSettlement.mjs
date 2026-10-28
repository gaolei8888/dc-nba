// 结算：胜 / 负 / 作废，按市场分派。本期只实现独赢盘（moneyline）；
// 让分 / 大小分只留分派口，未实现的市场直接抛错，绝不静默当独赢盘。
// NBA 无平局，故不实现 push；延期 / 取消 / 比分缺失一律作废（本金退回，盈亏 0）。
// 纯函数，无 I/O。
import { isValidAmerican, americanToDecimal } from './oddsMath.mjs';

export const MARKETS = ['moneyline'];

/** 比赛结果：homeWin 非布尔（缺比分）或 void 标记 → 作废，homeWin 归一为 null */
export function outcomeOf(game = {}) {
  const isVoid = game.void === true || typeof game.homeWin !== 'boolean';
  return { homeWin: isVoid ? null : game.homeWin, void: isVoid };
}

function settleMoneyline({ side, american, stake, outcome, feeOnWin }) {
  if (side !== 'home' && side !== 'away') throw new Error(`side 非法: ${String(side)}`);
  if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) throw new Error(`stake 非法: ${String(stake)}`);
  if (typeof feeOnWin !== 'number' || !Number.isFinite(feeOnWin) || feeOnWin < 0 || feeOnWin > 1) throw new Error(`feeOnWin 非法: ${String(feeOnWin)}`);
  if (!outcome || typeof outcome !== 'object') throw new Error('outcome 缺失');
  // 报价非法：作废并带 reason 标记，由调用方统计，不当作正常的 0 盈亏单
  if (!isValidAmerican(american)) return { result: 'void', profit: 0, reason: 'invalid_price' };
  if (outcome.void || typeof outcome.homeWin !== 'boolean') return { result: 'void', profit: 0 };
  const won = side === 'home' ? outcome.homeWin : !outcome.homeWin;
  if (!won) return { result: 'loss', profit: -stake };
  // 赢：按实际报价的净利，手续费只扣净利
  return { result: 'win', profit: stake * (americanToDecimal(american) - 1) * (1 - feeOnWin) };
}

const SETTLERS = { moneyline: settleMoneyline };

export function settleBet({ market, side, american, stake, outcome, feeOnWin = 0 }) {
  if (!MARKETS.includes(market)) throw new Error(`未实现的市场：${market}`);
  return SETTLERS[market]({ side, american, stake, outcome, feeOnWin });
}
