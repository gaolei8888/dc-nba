// 独赢盘回测引擎：候选生成（含缺价计数）、逐注流水、成本、资金曲线与汇总指标。
// 纯函数、无 I/O、无随机数与当前时间：同一输入 → 字节一致的流水与汇总。
//
// 规则（spec 二、三；plan Task 8；裁定 M10）：
//   - 候选按 date、gameId 排序后逐日处理；每场至多一注，故流水顺序即 (date, gameId, side)。
//   - 按日初资金定注：同一比赛日各注都用当日开始时的 bankroll。
//   - 单注先过 maxStake；再做同日敞口：当日下注总额 ≤ 日初资金，超过则按比例缩减（标 exposureScaled）。
//   - 资金 ≤ 0 后不再下注（不允许杠杆），跳过数记入 notes.skippedNoBankroll。
//   - 决策（选边、edge、EV、Kelly）用报价 quoted；结算用滑点后的 american；收益一律按实际价，去水只用于 CLV。
//   - 作废注（含非法报价）不计入 staked 与 ROI 分母；非法报价作废（invalid_price）在汇总里单列。
//   - 比分相等是数据错误（NBA 无平局）→ 作废，reason 'tie_score'；比分方向与 homeWin 矛盾 → 作废，reason 'score_mismatch'。
import { selectPrice } from './priceSelect.mjs';
import { isValidAmerican, americanToDecimal, worsenAmerican, devigPair } from './oddsMath.mjs';
import { pickBet, stakeFor } from './betStrategies.mjs';
import { settleBet, outcomeOf } from './betSettlement.mjs';

export const DEFAULT_COSTS = { feeOnWin: 0, slippagePts: 0, maxStake: null };

const BANKROLL_EPS = 1e-9;   // 资金低于此值视为耗尽（避免浮点残余继续下微注）

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDateGame = (x, y) => cmp(String(x.date), String(y.date)) || cmp(String(x.gameId), String(y.gameId));

// ---------------------------------------------------------------------------
// 候选

/**
 * 每场按情景选价，生成候选；缺价按原因计数。splitOf 返回 null 的赛季不进候选也不计缺失。
 * Candidate = Game 去掉 books 字典 + { scenario, split, ml, books: [homeBook, awayBook], priceAt, closeMl, flags }
 */
export function buildCandidates(games, { scenario, book = 'chain', splitOf }) {
  if (scenario !== 'open' && scenario !== 'close') throw new Error(`scenario 非法: ${String(scenario)}`);
  if (typeof splitOf !== 'function') throw new Error('splitOf 缺失');
  const candidates = [];
  const missing = {};
  let total = 0;
  for (const g of [...games].sort(byDateGame)) {
    const split = splitOf(g.season);
    if (split == null) continue;
    total += 1;
    const price = selectPrice(g.books, scenario, { book });
    if (price.missing) { missing[price.missing] = (missing[price.missing] ?? 0) + 1; continue; }
    const { books: _dict, ...rest } = g;
    candidates.push({
      ...rest, scenario, split,
      ml: price.ml, books: price.books, priceAt: price.priceAt, closeMl: price.closeMl, flags: [...price.flags],
    });
  }
  return { candidates, missing, priced: candidates.length, total };
}

// 策略逻辑（pickBet / stakeFor）见 betStrategies.mjs；这里只保留引擎用到的取价小工具。
const sideP = (c, side) => (side === 'home' ? c.pHome : 1 - c.pHome);
const sideMl = (c, side) => (side === 'home' ? c.ml[0] : c.ml[1]);

// ---------------------------------------------------------------------------
// 结果与 CLV

/** 比赛结果，多一层数据错误检查：比分相等或与 homeWin 矛盾 → 作废并给 reason */
function outcomeFor(c) {
  if (typeof c.actual === 'number' && c.void !== true) {
    if (c.actual === 0) return { homeWin: null, void: true, reason: 'tie_score' };
    if (typeof c.homeWin === 'boolean' && (c.actual > 0) !== c.homeWin) return { homeWin: null, void: true, reason: 'score_mismatch' };
  }
  return outcomeOf(c);
}

/** CLV = 所押一边收盘去水概率 − 下注报价去水概率；收盘情景（下注价即收盘价）或无收盘价 → null 并标注 */
function clvOf(c, side) {
  if (c.scenario === 'close') return { clv: null, flag: 'clvAtClose' };
  if (!c.closeMl) return { clv: null, flag: 'noCloseForClv' };
  const at = devigPair(c.ml[0], c.ml[1]);
  const cl = devigPair(c.closeMl[0], c.closeMl[1]);
  if (!at || !cl) return { clv: null, flag: 'noCloseForClv' };
  return { clv: cl[side] - at[side], flag: null };
}

// ---------------------------------------------------------------------------
// 引擎

export function runBacktest(candidates, strategy, { costs = DEFAULT_COSTS, bankroll0 = 100 } = {}) {
  const { feeOnWin = 0, slippagePts = 0, maxStake = null } = { ...DEFAULT_COSTS, ...costs };
  const sorted = [...candidates].sort(byDateGame);

  // 按比赛日分组
  const days = [];
  for (const c of sorted) {
    const last = days[days.length - 1];
    if (last && last.date === c.date) last.items.push(c);
    else days.push({ date: c.date, items: [c] });
  }

  const ledger = [];
  const notes = { scaledDays: 0, skippedNoBankroll: 0 };
  let bankroll = bankroll0;

  for (const day of days) {
    const start = bankroll;   // 日初资金
    // 先定当日全部注（只看日初资金），再统一结算
    const planned = [];
    for (const c of day.items) {
      const pick = pickBet(c, strategy);
      if (!pick) continue;
      if (!(start > BANKROLL_EPS)) { notes.skippedNoBankroll += 1; continue; }
      const quoted = sideMl(c, pick.side);
      const pModel = sideP(c, pick.side);
      let stake = isValidAmerican(quoted) ? stakeFor(strategy, { p: pModel, american: quoted, bankroll: start }) : 1;
      if (maxStake != null) stake = Math.min(stake, maxStake);
      if (!(stake > 0)) continue;
      planned.push({ c, pick, quoted, pModel, stake });
    }
    const total = planned.reduce((s, x) => s + x.stake, 0);
    const scale = total > start ? start / total : 1;
    if (scale < 1) notes.scaledDays += 1;

    for (const { c, pick, quoted, pModel, stake: raw } of planned) {
      const stake = scale < 1 ? raw * scale : raw;
      const valid = isValidAmerican(quoted);
      const american = valid ? worsenAmerican(quoted, slippagePts) : quoted;
      const outcome = outcomeFor(c);
      const settled = settleBet({ market: 'moneyline', side: pick.side, american, stake, outcome, feeOnWin });
      const reason = settled.reason ?? (settled.result === 'void' ? outcome.reason : undefined);
      bankroll += settled.profit;
      const { clv, flag } = clvOf(c, pick.side);
      const flags = [...(c.flags ?? [])];
      if (flag && !flags.includes(flag)) flags.push(flag);
      if (scale < 1) flags.push('exposureScaled');
      const bet = {
        gameId: c.gameId, date: c.date, season: c.season, homeId: c.homeId, awayId: c.awayId,
        modelVersion: c.modelVersion, paramsVersion: c.paramsVersion,
        scenario: c.scenario, split: c.split, priceAt: c.priceAt,
        book: c.books?.[pick.side === 'home' ? 0 : 1] ?? null,
        strategy: strategy.id, market: 'moneyline', side: pick.side, pModel,
        quoted, american, decimal: valid ? americanToDecimal(american) : null,
        edge: pick.edge, ev: pick.ev,
        stake, result: settled.result, profit: settled.profit, bankrollAfter: bankroll,
        clv, flags,
        b2bSide: pick.side === 'home' ? c.b2bHome : c.b2bAway,
        b2bOpp: pick.side === 'home' ? c.b2bAway : c.b2bHome,
        teamGp: c.teamGp,
      };
      if (reason) bet.reason = reason;
      ledger.push(bet);
    }
  }

  return { ledger, summary: summarizeLedger(ledger, { bankroll0 }), notes };
}

// ---------------------------------------------------------------------------
// 汇总

const dayNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;

/**
 * 汇总指标。bets = 已结算（胜/负）注数，作废不计；voids = 普通作废，invalidPriceVoids 单列；
 * roi = profit / staked（staked 只含胜负注）；avgDecimal = 胜负注实际（滑点后）十进制赔率的简单平均；
 * curve 每个下注日一点：当日 profit 与日终 bankroll；最大回撤在 bankroll 曲线上算（含初始资金作为起点峰值）。
 * maxDrawdown.pctOfPeak 取自 units 最大的那一次回撤（不是各次回撤百分比的最大值）；
 * profitableMonthShare 只统计有胜负注的月份（只有作废注的月份不计入分母）。
 */
export function summarizeLedger(ledger, { bankroll0 = 100 } = {}) {
  let wins = 0; let losses = 0; let voids = 0; let invalidPriceVoids = 0;
  let staked = 0; let profit = 0; let decSum = 0;
  const voidReasons = {};
  let streak = 0; let longestLosingStreak = 0;
  const monthMap = new Map();
  const curve = [];
  const clvs = [];

  for (const b of ledger) {
    if (b.result === 'void') {
      if (b.reason === 'invalid_price') invalidPriceVoids += 1;
      else {
        voids += 1;
        if (b.reason) voidReasons[b.reason] = (voidReasons[b.reason] ?? 0) + 1;
      }
    } else {
      if (b.result === 'win') { wins += 1; streak = 0; } else { losses += 1; streak += 1; }
      longestLosingStreak = Math.max(longestLosingStreak, streak);
      staked += b.stake;
      profit += b.profit;
      decSum += b.decimal;
      if (b.clv != null) clvs.push(b.clv);
      const month = String(b.date).slice(0, 7);
      const m = monthMap.get(month) ?? { month, bets: 0, staked: 0, profit: 0 };
      m.bets += 1; m.staked += b.stake; m.profit += b.profit;
      monthMap.set(month, m);
    }
    const last = curve[curve.length - 1];
    if (last && last.date === b.date) { last.profit += b.profit; last.bankroll += b.profit; } else {
      const prev = last ? last.bankroll : bankroll0;
      curve.push({ date: b.date, profit: b.profit, bankroll: prev + b.profit });
    }
  }

  const bets = wins + losses;
  const months = [...monthMap.values()].sort((x, y) => cmp(x.month, y.month));
  return {
    bets, staked, profit,
    roi: staked > 0 ? profit / staked : null,
    wins, losses, voids, invalidPriceVoids, voidReasons,
    hitRate: bets ? wins / bets : null,
    avgDecimal: bets ? decSum / bets : null,
    maxDrawdown: drawdownOf(curve, ledger, bankroll0),
    longestLosingStreak,
    months,
    profitableMonthShare: months.length ? months.filter((m) => m.profit > 0).length / months.length : null,
    curve,
    clv: clvs.length ? {
      n: clvs.length,
      mean: clvs.reduce((s, x) => s + x, 0) / clvs.length,
      beatClose: clvs.filter((x) => x > 0).length / clvs.length,
    } : null,
  };
}

/**
 * 最大回撤：units = 峰值 − 谷值（取最大的一次，并列取最早）；pctOfPeak = units / 峰值；
 * 回到与峰值相等（v ≥ peak）即视为新峰值，之后再跌从这一点重新计回撤；收复从谷值之后开始找；
 * days = 峰值日到收复日（首个 bankroll ≥ 峰值的日子；未收复则到最后一日）的日历天数；
 * bets = 峰值日之后到收复（或最后）日期间的胜负注数。峰值为初始资金时，以首个下注日为峰值日且计入该日注数。
 */
function drawdownOf(curve, ledger, bankroll0) {
  const none = { units: 0, pctOfPeak: 0, days: 0, bets: 0, recovered: true };
  if (!curve.length) return none;
  let peak = bankroll0; let peakIdx = -1;
  let best = null;   // { units, peak, peakIdx, troughIdx }
  for (let i = 0; i < curve.length; i += 1) {
    const v = curve[i].bankroll;
    if (v >= peak) { peak = v; peakIdx = i; continue; }
    const units = peak - v;
    if (!best || units > best.units) best = { units, peak, peakIdx, troughIdx: i };
  }
  if (!best) return none;
  let endIdx = curve.length - 1; let recovered = false;
  for (let i = best.troughIdx + 1; i < curve.length; i += 1) {
    if (curve[i].bankroll >= best.peak) { endIdx = i; recovered = true; break; }
  }
  const startDate = curve[Math.max(best.peakIdx, 0)].date;
  const endDate = curve[endIdx].date;
  const inside = (d) => (best.peakIdx < 0 ? d >= startDate : d > startDate) && d <= endDate;
  return {
    units: best.units,
    pctOfPeak: best.units / best.peak,
    days: dayNum(endDate) - dayNum(startDate),
    bets: ledger.filter((b) => b.result !== 'void' && inside(String(b.date))).length,
    recovered,
  };
}
