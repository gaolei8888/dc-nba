// 下注策略 A–D：选边（pickBet）与定注（stakeFor）。纯函数，无 I/O。
// 引擎（betBacktest.mjs）从这里导入，是策略逻辑的唯一来源。
//
// 说明：
//   - B/C/D 两侧各算 edge，取 edge 较大且满足条件的一侧（正常抽水下至多一侧为正）。
//   - C 与 B 的关系：EV/单位 = (p − 盈亏平衡)·decimal，故 EV > 0 ⇔ edge > 0（数学等价）。
//     C 的区别只有数据质量门槛（qualityOk），不是另一种阈值。
//   - 决策用报价；滑点、手续费在引擎结算时处理。
import { isValidAmerican, americanToDecimal, edgeOf, evPerUnit, kellyFraction } from './oddsMath.mjs';

const EPS = 1e-12;   // 与 paperBetting.decide 一致

export const STRATEGIES = [
  { id: 'A-model', family: 'A', pick: 'model' },
  { id: 'A-home', family: 'A', pick: 'home' },
  { id: 'A-favorite', family: 'A', pick: 'favorite' },
  { id: 'B-edge2', family: 'B', minEdge: 0.02 },
  { id: 'B-edge3', family: 'B', minEdge: 0.03 },
  { id: 'B-edge5', family: 'B', minEdge: 0.05 },
  { id: 'B-edge7', family: 'B', minEdge: 0.07 },
  { id: 'B-edge10', family: 'B', minEdge: 0.10 },
  { id: 'C-ev', family: 'C' },
  { id: 'D-kelly-full', family: 'D', kelly: { mult: 1, cap: 0.05 } },
  { id: 'D-kelly-half', family: 'D', kelly: { mult: 0.5, cap: 0.05 } },
  { id: 'D-kelly-quarter', family: 'D', kelly: { mult: 0.25, cap: 0.05 } },
];

const sideP = (c, side) => (side === 'home' ? c.pHome : 1 - c.pHome);
const sideMl = (c, side) => (side === 'home' ? c.ml[0] : c.ml[1]);

function sideStats(c, side) {
  const a = sideMl(c, side);
  if (!isValidAmerican(a)) return { side, edge: null, ev: null };
  const p = sideP(c, side);
  return { side, edge: edgeOf(p, a), ev: evPerUnit(p, a) };
}

const BAD_FLAGS = ['currentAsClose', 'skippedAnomaly', 'bestPrice'];

/**
 * C 的数据质量门槛，按情景：
 *   - open：priceAt 必须是 'open'；close：priceAt 必须是 'close'（current 冒充 close 不行）。
 *   - forward（前向账本）：priceAt 'current' 合法，但必须在开赛前抓取（capturedAt < tipoff，ISO 时间；
 *     任一缺失即不合格，宁缺勿滥）。前向价本来就是当前价，所以 currentAsClose 标记不适用。
 *   - 任何情景：不得带 skippedAnomaly / bestPrice 标记；historical 情景另不得带 currentAsClose。
 *   - 未知情景 → 不合格。
 */
export function qualityOk(c) {
  const flags = c.flags ?? [];
  const bad = c.scenario === 'forward' ? BAD_FLAGS.filter((f) => f !== 'currentAsClose') : BAD_FLAGS;
  if (flags.some((f) => bad.includes(f))) return false;
  if (c.scenario === 'open' || c.scenario === 'close') return c.priceAt === c.scenario;
  if (c.scenario === 'forward') {
    if (c.priceAt !== 'current') return false;
    const cap = Date.parse(c.capturedAt);
    const tip = Date.parse(c.tipoff);
    return Number.isFinite(cap) && Number.isFinite(tip) && cap < tip;
  }
  return false;
}

/** 选边：返回 { side, edge, ev } 或 null（不下注） */
export function pickBet(c, s) {
  const both = [sideStats(c, 'home'), sideStats(c, 'away')];
  if (s.family === 'A') {
    let side;
    if (s.pick === 'home') side = 'home';
    else if (s.pick === 'favorite') side = americanToDecimal(c.ml[1]) < americanToDecimal(c.ml[0]) ? 'away' : 'home';   // 平价押主队
    else side = c.pHome >= 0.5 ? 'home' : 'away';
    return both.find((x) => x.side === side);
  }
  // B/C/D：两侧都要有合法价，取 edge 较大的一侧
  if (both.some((x) => x.edge == null)) return null;
  const best = both[0].edge >= both[1].edge ? both[0] : both[1];
  if (s.family === 'B') return best.edge > EPS && best.edge >= s.minEdge - EPS ? best : null;
  if (s.family === 'C') return best.ev > EPS && qualityOk(c) ? best : null;
  if (s.family === 'D') {
    const f = kellyFraction(sideP(c, best.side), sideMl(c, best.side), { mult: s.kelly.mult, cap: s.kelly.cap });
    return f > 0 ? best : null;
  }
  throw new Error(`未知策略族: ${String(s.family)}`);
}

/** 定注：A/B/C 固定 flatStake；D = 资金 × 截后 Kelly 分数 */
export function stakeFor(s, { p, american, bankroll, flatStake = 1, cap }) {
  if (s.family !== 'D') return flatStake;
  return bankroll * kellyFraction(p, american, { mult: s.kelly.mult, cap: cap ?? s.kelly.cap });
}
