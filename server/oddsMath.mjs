// 赔率数学：纯函数，无 I/O、不依赖其他模块（故未复用 oddsClient.mjs 的 mlToProb / devigHomeProb，
// 因为那两个函数不校验输入，且该模块带网络依赖；公式与之一致）。
// 非法输入约定：数值函数抛 RangeError；devigPair 返回 null（与 devigHomeProb 的 null 语义一致）。

const bad = (what, v) => new RangeError(`${what} 非法: ${String(v)}`);

/** 有效美式赔率：有限数且 |a| ≥ 100 */
export function isValidAmerican(a) {
  return typeof a === 'number' && Number.isFinite(a) && Math.abs(a) >= 100;
}
const needAmerican = (a) => { if (!isValidAmerican(a)) throw bad('美式赔率', a); };
const needProb = (p) => { if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw bad('概率', p); };

/** 美式 → 十进制赔率（含本金） */
export function americanToDecimal(a) {
  needAmerican(a);
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

/** 十进制 → 美式（取整；d=2 → +100） */
export function decimalToAmerican(d) {
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 1) throw bad('十进制赔率', d);
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** 盈亏平衡概率：+A → 100/(A+100)，−A → A/(A+100) */
export function breakEven(a) {
  needAmerican(a);
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

/**
 * 同一家、同一时点两侧赔率按比例去水。仅用于模型 vs 市场比较，绝不用于结算。
 * 任一侧非法 → null。overround = 两侧隐含概率之和。
 */
export function devigPair(homeMl, awayMl) {
  if (!isValidAmerican(homeMl) || !isValidAmerican(awayMl)) return null;
  const h = breakEven(homeMl);
  const a = breakEven(awayMl);
  const overround = h + a;
  return { home: h / overround, away: a / overround, overround };
}

/** edge = p_model − p_break_even（按实际下注价） */
export function edgeOf(p, a) {
  needProb(p);
  return p - breakEven(a);
}

/** 每 1 单位本金的期望收益：p·(decimal−1) − (1−p) */
export function evPerUnit(p, a) {
  needProb(p);
  return p * (americanToDecimal(a) - 1) - (1 - p);
}

/** 分数 Kelly：f* = (b·p − q)/b，乘 mult 后截到 [0, cap]；负期望返回 0（不做空、无杠杆） */
export function kellyFraction(p, a, { mult = 1, cap = 0.05 } = {}) {
  needProb(p);
  if (typeof mult !== 'number' || !Number.isFinite(mult) || mult < 0) throw bad('Kelly 乘数', mult);
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) throw bad('单注上限', cap);
  const b = americanToDecimal(a) - 1;
  const f = (b * p - (1 - p)) / b;
  if (!(f > 0)) return 0;
  return Math.min(f * mult, cap);
}

/**
 * 滑点：赔率按美式点数变差，越过 ±100 时连续。
 * 把美式价映射到以 ±100 为原点的一维轴（正价 a → a−100，负价 a → a+100，±100 均为原点 0），减去 pts 后映回。
 */
export function worsenAmerican(a, pts) {
  needAmerican(a);
  if (typeof pts !== 'number' || !Number.isFinite(pts) || pts < 0) throw bad('滑点点数', pts);
  const x = (a > 0 ? a - 100 : a + 100) - pts;
  return x >= 0 ? x + 100 : x - 100;
}
