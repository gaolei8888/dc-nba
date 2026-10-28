/**
 * 价格时点标注与博彩公司选择链。纯函数。
 *
 * 只用美国持牌博彩商（US_BOOKS；Betfair 等交易所不用于定价）。
 * 选价顺序：先按公司优先级挑一家，再在这家里取时点（close > current）。
 * 「挑最优价」只作单独标注的敏感性情景。
 */
import { cleanItems, US_BOOKS } from './books.mjs';
import { homeAwayStatus, priceAnomaly } from './dataIntegrity.mjs';

export const BOOK_PRIORITY = ['draftkings', 'espnbet', 'betmgm', 'caesars', 'betrivers', 'unibet', 'pointsbet', 'westgate'];

const swap = (ml) => (ml ? [ml[1], ml[0]] : null);

/**
 * 一场的美国公司三个时点价，钱线统一成 [我们的主队, 我们的客队]。
 * 主客判定复用 homeAwayStatus；对不上 / 没有这场返回 null。
 */
export function compactBooks(entry, homeId, awayId) {
  const status = homeAwayStatus({ homeId, awayId }, entry);
  if (status === 'unmatched' || status === 'teamMismatch') return null;
  const flipped = status === 'flipped';
  const fix = (ml) => (flipped ? swap(ml) : ml);
  const books = {};
  for (const it of cleanItems(entry.items ?? [])) {
    if (!US_BOOKS.includes(it.book)) continue;
    books[it.book] = { open: fix(it.open), close: fix(it.close), current: fix(it.current) };
  }
  return { books, flipped };
}

const decimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

/** 链：优先级里出现的在前，其余美国公司按字母序补后 */
function chainOf(books) {
  const keys = Object.keys(books).filter((k) => books[k]);
  const head = BOOK_PRIORITY.filter((k) => keys.includes(k));
  const tail = keys.filter((k) => !BOOK_PRIORITY.includes(k)).sort();
  return [...head, ...tail];
}

/** 某家在情景下的候选价：{ ml, at }，没有返回 null。收盘情景 close 优先、否则 current */
function candidate(b, scenario) {
  if (scenario === 'open') return b.open ? { ml: b.open, at: 'open' } : null;
  if (b.close) return { ml: b.close, at: 'close' };
  if (b.current) return { ml: b.current, at: 'current' };
  return null;
}

/**
 * @param {Record<string,{open,close,current}>} books  compactBooks().books
 * @param {'open'|'close'} scenario
 * @param {{book?: 'chain'|'best'|string}} opts
 * @returns {{ml:number[], books:string[], priceAt:string, closeMl:number[]|null, flags:string[]}|{missing:string}}
 */
export function selectPrice(books, scenario, { book = 'chain' } = {}) {
  let chain = chainOf(books ?? {});
  if (!chain.length) return { missing: 'noUsBook' };
  if (book !== 'chain' && book !== 'best') {
    if (!chain.includes(book)) return { missing: 'bookAbsent' };
    chain = [book];
  }

  let skipped = false;
  const valid = [];   // 通过异常检查的候选，按链顺序
  for (const name of chain) {
    const c = candidate(books[name], scenario);
    if (!c) continue;
    if (priceAnomaly(c.ml)) { skipped = true; continue; }
    valid.push({ name, ...c });
    if (book !== 'best') break;
  }
  if (!valid.length) {
    if (skipped) return { missing: 'anomaly' };
    return { missing: scenario === 'open' ? 'noOpen' : 'noPrice' };
  }

  const flags = [];
  if (book === 'best') {
    let home = valid[0]; let away = valid[0];
    for (const v of valid) {
      if (decimal(v.ml[0]) > decimal(home.ml[0])) home = v;
      if (decimal(v.ml[1]) > decimal(away.ml[1])) away = v;
    }
    flags.push('bestPrice');
    if (valid.some((v) => v.at === 'current')) flags.push('currentAsClose');
    if (skipped) flags.push('skippedAnomaly');
    return { ml: [home.ml[0], away.ml[1]], books: [home.name, away.name], priceAt: scenario, closeMl: null, flags };
  }

  const v = valid[0];
  if (v.at === 'current') flags.push('currentAsClose');
  if (skipped) flags.push('skippedAnomaly');
  let closeMl = null;
  if (scenario === 'open') {
    const cl = books[v.name].close;
    closeMl = cl && !priceAnomaly(cl) ? cl : null;
    if (!closeMl) flags.push('noCloseForClv');
  } else {
    closeMl = v.ml;
  }
  return { ml: v.ml, books: [v.name, v.name], priceAt: v.at, closeMl, flags };
}
