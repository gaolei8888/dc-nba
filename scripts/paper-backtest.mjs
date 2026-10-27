/**
 * 模拟投注历史回测：生产参数逐场重放 × 多家历史钱线 → data/paper-backtest.json（页面读它）。
 *
 *   node scripts/paper-backtest.mjs      # 先跑 scripts/books-history.mjs 抓好 books_<赛季>.json
 *
 * 纯离线：只读 data/backtest.json 与 data/history/books_*.json，不发任何请求。
 * 规则是预注册的（server/paperBetting.mjs），这里**只报告、不调参**：
 * 每家 × 每季 × 每个门槛全部写出，页面和文档不许只挑好看的那行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from '../server/nbaClient.mjs';
import { replay, DEFAULTS } from '../server/lab.mjs';
import { BOOK_NAMES, US_BOOKS } from '../server/books.mjs';
import {
  gamesFrom, placeBets, summarize, verdictOf, PRIMARY, THRESHOLDS, TUNING_SEASON,
} from '../server/paperBetting.mjs';

const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
/** 一家一季至少这么多场有价才单列（零星出现的博彩商不报） */
const MIN_GAMES = 200;
const B = 2000;

const bt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backtest.json'), 'utf8'));
const records = replay(bt, SEASONS, DEFAULTS);

const games = [];
const coverage = {};
for (const season of SEASONS) {
  const file = path.join(DATA_DIR, 'history', `books_${season}.json`);
  if (!fs.existsSync(file)) continue;
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = gamesFrom(records.filter((r) => r.season === season), c.games ?? {});
  const books = {};
  for (const x of g) for (const k of Object.keys(x.books)) books[k] = (books[k] ?? 0) + 1;
  coverage[season] = {
    games: records.filter((r) => r.season === season).length,
    fetched: Object.keys(c.games ?? {}).length,
    priced: g.length,
    books,
    // 每家各取了哪个时点
    at: g.reduce((m, x) => { for (const b of Object.values(x.books)) m[b.at] = (m[b.at] ?? 0) + 1; return m; }, {}),
  };
  games.push(...g);
}
const seasons = Object.keys(coverage);
const booksOf = (season) => Object.entries(coverage[season]?.books ?? {})
  .filter(([, n]) => n >= MIN_GAMES).map(([k]) => k);
const strip = ({ curve, ...s }) => s;

// ---- 博彩商 × 赛季 × 门槛（含跨季合计）
const table = [];
const allBooks = [...new Set(seasons.flatMap(booksOf))];
for (const book of [...allBooks, 'best']) {
  const sIn = book === 'best' ? seasons : seasons.filter((s) => booksOf(s).includes(book));
  if (!sIn.length) continue;
  for (const threshold of THRESHOLDS) {
    const rows = placeBets(games.filter((g) => sIn.includes(g.season)), { book, threshold, pool: book === 'best' ? US_BOOKS : null });
    for (const season of sIn) {
      table.push({ book, season, threshold, ...strip(summarize(rows.filter((r) => r.season === season), { B })) });
    }
    if (sIn.length > 1) table.push({ book, season: 'all', seasons: sIn, threshold, ...strip(summarize(rows, { B })) });
  }
}

// ---- CLV：有开盘与收盘的才算。按开盘价下注（同一条 3% 规则），看收盘往哪边走
const clv = [];
for (const season of seasons) {
  for (const book of booksOf(season)) {
    const rows = placeBets(games.filter((g) => g.season === season), { book, threshold: PRIMARY, at: 'open' });
    if (rows.length >= 30) clv.push({ book, season, threshold: PRIMARY, ...strip(summarize(rows, { B })) });
  }
}

// ---- 为什么赚/亏：模型 vs 各家去水概率的 log loss / Brier（同一批比赛）
const ll = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-9));
const br = (p, y) => ((y ? 1 : 0) - p) ** 2;
const accuracy = [];
for (const season of seasons) {
  for (const book of booksOf(season)) {
    const sub = games.filter((g) => g.season === season && g.books[book]);
    const avg = (f) => sub.reduce((s, g) => s + f(g), 0) / sub.length;
    accuracy.push({
      book, season, n: sub.length,
      model: { logloss: avg((g) => ll(g.pHome, g.homeWin)), brier: avg((g) => br(g.pHome, g.homeWin)) },
      market: { logloss: avg((g) => ll(g.books[book].pHome, g.homeWin)), brier: avg((g) => br(g.books[book].pHome, g.homeWin)) },
    });
  }
}

// ---- 页面顶部那一句：主规则 × DraftKings（前向账本也只有 DK），只用样本外赛季——
// 2022-23 是唯一允许看门槛的赛季，放进结论就等于拿调参季给自己作证。含它的合计仍在表里。
const dkSeasons = seasons.filter((s) => s > TUNING_SEASON && booksOf(s).includes('draftkings'));
const head = summarize(placeBets(games.filter((g) => dkSeasons.includes(g.season)), { book: 'draftkings', threshold: PRIMARY }), { B });
const report = {
  builtAt: new Date().toISOString(),
  params: 'lab.DEFAULTS（生产 Elo 参数），2021-22 只作 Elo 预热',
  rules: { primary: PRIMARY, thresholds: THRESHOLDS, tuningSeason: TUNING_SEASON, minGames: MIN_GAMES },
  bookNames: { ...BOOK_NAMES, best: '挑最优价' },
  coverage,
  headline: {
    book: 'draftkings', threshold: PRIMARY, seasons: dkSeasons, ...head,
    verdict: `样本外（${TUNING_SEASON} 之后）${verdictOf(head, { seasons: dkSeasons.length })}`,
  },
  table, clv, accuracy,
};
writeJson('paper-backtest.json', report);

const p = (v) => (v == null ? '   —  ' : `${(v * 100).toFixed(1).padStart(5)}%`);
console.log(`赛季：${seasons.join(', ')}  ·  有价比赛 ${games.length}`);
console.log(report.headline.verdict);
for (const r of table) {
  console.log(`${r.book.padEnd(11)} ${r.season.padEnd(8)} ≥${(r.threshold * 100).toFixed(0)}%  ${String(r.bets).padStart(5)} 注  胜率 ${p(r.winRate)}  ROI ${p(r.roi)} [${p(r.ci.lo)}, ${p(r.ci.hi)}]`);
}
for (const r of clv) console.log(`CLV ${r.book} ${r.season}: ${r.bets} 注 平均 ${p(r.clv?.mean)} [${p(r.clv?.lo)}, ${p(r.clv?.hi)}] 好于收盘 ${p(r.clv?.beatClose)}  ROI ${p(r.roi)}`);
