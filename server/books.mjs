/**
 * 多家博彩商历史钱线：裁剪、清洗、取价。纯函数，网络在 scripts/books-history.mjs。
 *
 * ESPN core odds 端点每场返回多家 items，噪声是实测出来的：
 *   - in-game「Live Odds」条目（−100000 这种），不是赛前价；
 *   - 聚合源（accuscore / consensus / teamrankings），不是能下注的博彩商；
 *   - 个别博彩商的离谱线（Caesars 一次 +2.5 而其余都是 +8.5）；
 *   - Caesars 按州拆成 31/43/45/52/57 多个 id，其实是一家。
 * 时点：只认 close > current，**不用 open 冒充收盘**。
 */
import { devigHomeProb } from './oddsClient.mjs';

/** 离当场中位让分超过这么多分就当离谱线剔除 */
export const OUTLIER_PTS = 3;

/** ESPN provider id -> 博彩商（同一家多个 id 合并）。不在表里的按 id 保留 */
const BOOK_IDS = {
  40: 'draftkings', 100: 'draftkings',
  31: 'caesars', 43: 'caesars', 45: 'caesars', 52: 'caesars', 57: 'caesars',
  47: 'betmgm', 41: 'betrivers', 36: 'unibet', 58: 'espnbet', 50: 'betfair', 48: 'pointsbet',
  25: 'westgate', 53: 'titanbets', 55: 'hollandcasino',
};
/** 页面显示名 */
export const BOOK_NAMES = {
  draftkings: 'DraftKings', caesars: 'Caesars', betmgm: 'BetMGM', betrivers: 'BetRivers',
  unibet: 'Unibet', espnbet: 'ESPN BET', betfair: 'Betfair', pointsbet: 'PointsBet',
  westgate: 'Westgate', titanbets: 'Titanbets', hollandcasino: 'Holland Casino',
};
/**
 * 「挑最优价」只在美国持牌博彩商之间挑：Betfair 是英国交易所，Titanbets / Holland Casino
 * 不是美国站点，用户在美国下不了，拿它们的价算最优价会虚高。逐家结果仍全部报告。
 */
export const US_BOOKS = ['draftkings', 'caesars', 'betmgm', 'betrivers', 'unibet', 'espnbet', 'pointsbet', 'westgate'];
const AGGREGATOR = /accuscore|consensus|teamrankings|numberfire/i;

/** 博彩商 key；Live Odds 与聚合源返回 null（剔除） */
export function bookOf({ id, name = '' }) {
  if (/live odds/i.test(name) || AGGREGATOR.test(name) || Number(id) >= 1000) return null;
  return BOOK_IDS[id] ?? `p${id}`;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};

/** 原始 item -> { id, name, spread, open, close, current }，时点为 [主队钱线, 客队钱线] 或 null */
export function trimItem(item) {
  if (!item?.provider) return null;
  const h = item.homeTeamOdds ?? {};
  const a = item.awayTeamOdds ?? {};
  const at = (when) => {
    const hm = num(h[when]?.moneyLine?.american);
    const am = num(a[when]?.moneyLine?.american);
    return hm !== null && am !== null ? [hm, am] : null;
  };
  return {
    id: String(item.provider.id),
    name: item.provider.name ?? '',
    spread: num(item.spread),
    open: at('open'),
    close: at('close'),
    current: at('current'),
  };
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 剔除 Live / 聚合源 / 离谱线，同一家只留第一条正常的。返回 [{ book, ...trimmed }] */
export function cleanItems(items) {
  const real = items.map((it) => ({ ...it, book: bookOf(it) })).filter((it) => it.book);
  const spreads = real.map((it) => it.spread).filter((v) => v !== null);
  const mid = spreads.length ? median(spreads) : null;
  const seen = new Set();
  return real.filter((it) => {
    if (mid !== null && it.spread !== null && Math.abs(it.spread - mid) > OUTLIER_PTS) return false;
    if (seen.has(it.book)) return false;
    seen.add(it.book);
    return true;
  });
}

/** 最接近收盘的价：close > current，没有就不算（不用 open） */
export function priceOf(it) {
  if (it.close) return { ml: it.close, at: 'close' };
  if (it.current) return { ml: it.current, at: 'current' };
  return null;
}

/** 一场的各家价格：{ book: { ml, at, open, pHome } }，pHome 为该家去水后的主队胜率 */
export function gameBooks(items) {
  const out = {};
  for (const it of cleanItems(items)) {
    const px = priceOf(it);
    const pHome = px && devigHomeProb(px.ml[0], px.ml[1]);
    if (!px || pHome === null) continue;
    out[it.book] = { ...px, open: it.open, pHome };
  }
  return out;
}
