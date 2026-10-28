/**
 * 模拟投注（纸面交易）的纯计算：下注规则、结算、汇总、结论文字。
 * 设计见 docs/superpowers/specs/2026-10-28-paper-betting-design.md。
 *
 * 规则是**事先固定**的，不在评估季上调：
 *   edge = 模型胜率 − 该家去水胜率；edge ≥ 3% 就押那一边 1 单位，按该家真实（含水）美式赔率结算。
 *   对照一起报告、不挑最好的：门槛 0% / 3% / 6%、挑最优价、只押 DraftKings。
 * 门槛只允许在 2022-23 上看；2023-24 起只报告。
 */
import { devigHomeProb } from './oddsClient.mjs';
import { bootstrapCI } from './fusionLab.mjs';
import { gameBooks } from './books.mjs';
import { msg } from './messages.mjs';

export const PRIMARY = 0.03;
export const THRESHOLDS = [0, 0.03, 0.06];
/** 允许看门槛的赛季；之后的赛季只报告 */
export const TUNING_SEASON = '2022-23';
const EPS = 1e-12;

/** 美式钱线：赢 1 注的净利 */
export const profitOf = (ml) => (ml > 0 ? ml / 100 : 100 / -ml);
/** 美式钱线的隐含概率（含抽水） */
export const impliedOf = (ml) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));

const sideProb = (side, pHome) => (side === 'home' ? pHome : 1 - pHome);
const idx = (side) => (side === 'home' ? 0 : 1);

/** 下注决定：返回 { side, edge } 或 null。门槛 0 时 edge 也必须 > 0 */
export function decide(pModel, pBook, threshold) {
  if (pModel == null || pBook == null) return null;
  const e = pModel - pBook;
  const side = e > 0 ? 'home' : 'away';
  const edge = Math.abs(e);
  return edge > EPS && edge >= threshold - EPS ? { side, edge } : null;
}

/** 结算：ml = [主, 客] 美式赔率 */
export function settle(side, ml, homeWin) {
  const price = ml[idx(side)];
  const won = (side === 'home') === homeWin;
  return { ml: price, won, profit: won ? profitOf(price) : -1 };
}

/** 某一边各家最高赔率（同样赢一注、赔得最多的那家） */
export function bestPrice(books, side) {
  let best = null;
  for (const [book, b] of Object.entries(books)) {
    const ml = b.ml[idx(side)];
    if (!best || profitOf(ml) > profitOf(best.ml)) best = { ml, book };
  }
  return best;
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 收盘线价值：所押一边，收盘去水概率 − 下注价去水概率。正数 = 买到了比收盘更好的价 */
export function clvOf(side, betMl, closeMl) {
  if (!betMl || !closeMl) return null;
  const a = devigHomeProb(...betMl);
  const b = devigHomeProb(...closeMl);
  return a == null || b == null ? null : sideProb(side, b) - sideProb(side, a);
}

/**
 * 按一条规则模拟下注。
 * games: [{ gameId, date, season, pHome, homeWin, books: { book: { ml, at, open, pHome } } }]
 * book: 博彩商 key，或 'best'（用各家去水中位数判断，按每方最高赔率结算；pool 限定在哪些家里挑）
 * at: 'close'（默认，最接近收盘的价）或 'open'（按开盘价下、对收盘算 CLV）
 */
export function placeBets(games, { book, threshold, at = 'close', pool = null }) {
  const out = [];
  for (const g0 of games) {
    // pool：挑最优价时只在这些博彩商之间挑
    const g = pool ? { ...g0, books: Object.fromEntries(Object.entries(g0.books).filter(([k]) => pool.includes(k))) } : g0;
    let pBook; let ml; let used = book; let close = null;
    if (book === 'best') {
      const all = Object.values(g.books);
      if (!all.length) continue;
      pBook = median(all.map((b) => b.pHome));
    } else {
      const b = g.books[book];
      if (!b) continue;
      if (at === 'open') {
        if (!b.open || b.at !== 'close') continue;
        pBook = devigHomeProb(...b.open);
        ml = b.open;
        close = b.ml;
      } else {
        pBook = b.pHome;
        ml = b.ml;
      }
    }
    const d = decide(g.pHome, pBook, threshold);
    if (!d) continue;
    if (book === 'best') {
      const bp = bestPrice(g.books, d.side);
      used = bp.book;
      ml = d.side === 'home' ? [bp.ml, null] : [null, bp.ml];
    }
    const s = settle(d.side, ml, g.homeWin);
    out.push({
      gameId: g.gameId, date: g.date, season: g.season, side: d.side, edge: d.edge, book: used, ...s,
      clv: close ? clvOf(d.side, ml, close) : null,
    });
  }
  return out;
}

const flip = (pair) => (pair ? [pair[1], pair[0]] : null);

/**
 * 重放记录（lab.replay，带 gameId）× 多家价格缓存（books_<赛季>.json 的 games）→ placeBets 的输入。
 * ESPN 的主队与我们的不一致时（中立场）把各家钱线和去水概率翻过来。没有任何价格的比赛不要。
 */
export function gamesFrom(records, cache) {
  const out = [];
  for (const r of records) {
    const c = cache[r.gameId];
    if (!c?.items?.length || (c.home !== r.homeId && c.home !== r.awayId)) continue;
    let books = gameBooks(c.items);
    if (c.home !== r.homeId) {
      books = Object.fromEntries(Object.entries(books).map(([k, b]) => [k, {
        ...b, ml: flip(b.ml), open: flip(b.open), pHome: 1 - b.pHome,
      }]));
    }
    if (!Object.keys(books).length) continue;
    out.push({ gameId: r.gameId, date: r.date, season: r.season, pHome: r.p, homeWin: r.homeWin, books });
  }
  return out;
}

/** 累计盈亏从历史高点（含起点 0）回落的最大幅度，单位：注 */
export function maxDrawdown(profits) {
  let cum = 0; let peak = 0; let dd = 0;
  for (const p of profits) {
    cum += p;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

const EMPTY = {
  bets: 0, wins: 0, winRate: null, units: 0, roi: null, ci: { lo: null, hi: null },
  breakEven: null, maxDrawdown: 0, curve: [], clv: null,
};

/** 一组注单的指标。按场 bootstrap（每条规则每场至多一注，按注即按场） */
export function summarize(bets, { B = 2000 } = {}) {
  if (!bets.length) return { ...EMPTY, ci: { ...EMPTY.ci }, curve: [] };
  const sorted = [...bets].sort((x, y) => x.date.localeCompare(y.date));
  const profits = sorted.map((b) => b.profit);
  const units = profits.reduce((s, v) => s + v, 0);
  const wins = sorted.filter((b) => b.won).length;
  const { lo, hi } = bootstrapCI(profits, { B });
  const curve = [];
  let cum = 0;
  for (const b of sorted) {
    cum += b.profit;
    if (curve.at(-1)?.date === b.date) curve.at(-1).units = cum;
    else curve.push({ date: b.date, units: cum });
  }
  const clvs = sorted.map((b) => b.clv).filter((v) => v != null);
  return {
    bets: sorted.length,
    wins,
    winRate: wins / sorted.length,
    units,
    roi: units / sorted.length,
    ci: { lo, hi },
    // 保本胜率：所下各注价格的含水隐含概率均值，胜率要高过它才不亏
    breakEven: sorted.reduce((s, b) => s + impliedOf(b.ml), 0) / sorted.length,
    maxDrawdown: maxDrawdown(profits),
    curve,
    clv: clvs.length ? {
      n: clvs.length, ...bootstrapCI(clvs, { B }), beatClose: clvs.filter((v) => v > 0).length / clvs.length,
    } : null,
  };
}

const pctS = (v) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v * 100).toFixed(1)}%`;
const roiS = (v) => `${v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(1)}%`;

/**
 * 一句话结论。区间整体 > 0 才允许出现「有正收益证据」；含 0 一律「无证据」。
 */
export function verdictOf(s, { seasons }) {
  if (!s.bets) return '没有可回测的下注，无法评估。';
  const head = `历史 ${seasons} 季、${s.bets} 注、ROI ${roiS(s.roi)}（95% 区间 [${pctS(s.ci.lo)}, ${pctS(s.ci.hi)}]）：`;
  if (s.ci.lo > 0) return `${head}有正收益证据，但这是历史回测，下注前应以本季前向账本为准。`;
  if (s.ci.hi < 0) return `${head}稳定亏损，无证据表明模型能赢盘口，不建议据此下注。`;
  return `${head}无证据表明模型能赢盘口，不建议据此下注。`;
}

/**
 * verdictOf 的消息码版本：判断分支与 verdictOf 完全相同，数字原样放 params，由前端按语言渲染。
 * verdictOf 保留给脚本（scripts/paper-backtest.mjs 写进 data/paper-backtest.json 的中文 verdict）。
 */
export function verdictMsg(s, { seasons }) {
  if (!s.bets) return msg('srv.paper.verdict.none');
  const params = { seasons, bets: s.bets, roi: s.roi, lo: s.ci.lo, hi: s.ci.hi };
  if (s.ci.lo > 0) return msg('srv.paper.verdict.positive', params);
  if (s.ci.hi < 0) return msg('srv.paper.verdict.negative', params);
  return msg('srv.paper.verdict.noEvidence', params);
}

/** 回测头条（data/paper-backtest.json 的 headline）→ 带「样本外」前缀的消息；与脚本里的中文 verdict 逐字对应 */
export function paperHeadlineMsg(headline) {
  return msg('srv.paper.oos', { after: TUNING_SEASON, verdict: verdictMsg(headline, { seasons: headline.seasons.length }) });
}

/** 预测总表总结的最后一句：「模拟投注（DraftKings、edge ≥ 3% 平注）」+ 头条结论（params.verdict 是嵌套消息） */
export const PAPER_LINE_CODE = 'srv.board.paperLine';
