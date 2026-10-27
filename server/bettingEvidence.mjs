/**
 * 投注参考：模型和收盘盘口在历史上的正面对比 + 按分歧平注的回测。
 *
 * 只用离线数据（data/backtest.json 里的收盘钱线），用生产参数逐场重放。
 * 胜负猜得准不等于能赚钱——要赢的是**含抽水的市场价格**，所以这里只看两件事：
 *   1) 概率比市场准不准（对数损失 / Brier，同一批比赛、按场配对 bootstrap）
 *   2) 照模型与市场的分歧下注，按真实钱线结算，回报率是多少
 */
import { replay, score, DEFAULTS, BREAK_EVEN } from './lab.mjs';
import { bootstrapCI, logLoss } from './fusionLab.mjs';

/** 分歧门槛：模型胜率比去抽水市场胜率高出这么多才下注 */
export const THRESHOLDS = [0, 0.02, 0.05, 0.08];
/** 有收盘钱线的赛季（2021-22 只当 2022-23 的上赛季基准） */
export const BET_SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];

/** 美式钱线：赢 1 注的净利 */
export const profitOf = (ml) => (ml > 0 ? ml / 100 : 100 / -ml);
/** 美式钱线的隐含概率（含抽水） */
export const impliedOf = (ml) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));

/** 平注回测。rows 为 replay 记录：p、mktProb（去抽水）、homeWin、ml=[主, 客] */
export function flatStake(rows, threshold, { B = 2000 } = {}) {
  const profits = [];
  let wins = 0; let be = 0;
  for (const r of rows) {
    const edge = r.p - r.mktProb;
    if (Math.abs(edge) <= threshold) continue;
    const home = edge > 0;
    const ml = r.ml[home ? 0 : 1];
    const won = home === r.homeWin;
    if (won) wins += 1;
    be += impliedOf(ml);
    profits.push(won ? profitOf(ml) : -1);
  }
  const bets = profits.length;
  if (!bets) return { bets: 0, wins: 0, winRate: null, units: 0, roi: null, ci: { lo: null, hi: null }, breakEven: null };
  const units = profits.reduce((s, v) => s + v, 0);
  const { lo, hi } = bootstrapCI(profits, { B });
  // 打平线 = 所下各注价格的隐含概率均值；胜率要高过它才不亏
  return { bets, wins, winRate: wins / bets, units, roi: units / bets, ci: { lo, hi }, breakEven: be / bets };
}

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const sgn = (v, d = 1) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const asMarket = (r) => ({ ...r, p: r.mktProb, pred: r.mktPred });

/** 纯函数：给定重放记录，算对比、回测与结论文字 */
export function evaluate(rows, { B = 2000, thresholds = THRESHOLDS } = {}) {
  const set = rows.filter((r) => r.ml && r.ml[0] != null && r.ml[1] != null && r.mktProb != null);
  const n = set.length;
  const seasons = [...new Set(set.map((r) => r.season))].sort();
  const model = score(set);
  const market = score(set.map(asMarket));
  // 单场对数损失差（模型 − 市场），正数 = 模型更差
  const logLossDiff = n ? bootstrapCI(set.map((r) => logLoss(r) - logLoss(asMarket(r))), { B }) : null;
  const modelBeatsMarket = !!logLossDiff && logLossDiff.hi < 0;
  const overround = n ? set.reduce((s, r) => s + impliedOf(r.ml[0]) + impliedOf(r.ml[1]) - 1, 0) / n : null;
  const strategies = thresholds.map((threshold) => ({
    threshold,
    ...flatStake(set, threshold, { B }),
    bySeason: seasons.map((season) => ({ season, ...flatStake(set.filter((r) => r.season === season), threshold, { B }) })),
  }));
  const profitableThreshold = strategies.find((s) => s.ci.lo > 0)?.threshold ?? null;

  const summary = [];
  if (n) {
    const verdict = modelBeatsMarket
      ? '模型的概率比市场更准（单场差的 95% 区间整体低于 0）。'
      : logLossDiff.lo > 0
        ? '模型明显不如收盘盘口（单场对数损失差的 95% 区间整体高于 0）。'
        : '两者的差距在 95% 区间内分不出高下。';
    summary.push(`历史证据（${seasons[0]} 至 ${seasons.at(-1)} 共 ${n} 场带收盘钱线的常规赛，按生产参数逐场重放）：`
      + `模型对数损失 ${model.logloss.toFixed(3)}、Brier ${model.brier.toFixed(3)}；`
      + `去掉抽水后的收盘盘口对数损失 ${market.logloss.toFixed(3)}、Brier ${market.brier.toFixed(3)}。${verdict}`);
    summary.push('按「模型胜率 − 去抽水市场胜率」超过门槛就按收盘钱线平注 1 注：'
      + strategies.filter((s) => s.bets).map((s) => `门槛 ${pct(s.threshold, 0)} 下 ${s.bets} 注、胜率 ${pct(s.winRate)}（按所下价格打平要 ${pct(s.breakEven)}）、`
        + `回报率 ${sgn(s.roi)}（95% 区间 ${sgn(s.ci.lo)} ~ ${sgn(s.ci.hi)}）`).join('；')
      + `。收盘钱线平均抽水约 ${pct(overround)}，标准 -110 盘口要赢 ${pct(BREAK_EVEN)} 才打平。`);
    summary.push(modelBeatsMarket && profitableThreshold !== null
      ? '回测里模型胜过收盘盘口；但这仍是历史回测，下注前应以新赛季的样本外结果为准。'
      : profitableThreshold !== null
        ? `门槛 ${pct(profitableThreshold, 0)} 的回测区间为正，但这是在 ${thresholds.length} 个门槛里挑出来的，`
          + '且模型整体概率不如市场准——模型的判断不能当作投注优势，至少要等新赛季样本外验证。'
        : '结论：模型赢不了收盘盘口，它的胜负判断不能当作投注优势。');
  } else {
    summary.push('没有带收盘钱线的历史比赛，无法评估模型相对市场的表现。');
  }

  return {
    n, seasons, model, market, logLossDiff, modelBeatsMarket, overround,
    breakEven: BREAK_EVEN, strategies, profitableThreshold, summary,
    bySeason: seasons.map((season) => {
      const sub = set.filter((r) => r.season === season);
      return { season, n: sub.length, model: score(sub), market: score(sub.map(asMarket)) };
    }),
  };
}

/** 从离线数据集算全部证据。数据是静态的，调用方缓存一次即可 */
export const bettingEvidence = (dataset, { seasons = BET_SEASONS, params = DEFAULTS, B } = {}) =>
  evaluate(replay(dataset, seasons, params), { B });
