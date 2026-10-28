/**
 * 重放快照：把 lab.replay 的关键输出压成一份 JSON，用来对比改动前后是否逐位一致。
 *
 *   node scripts/replay-snapshot.mjs > snapshot.json
 *
 * 纯离线：只读 data/backtest.json 与 data/history/books_*.json，不发任何请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { replay, DEFAULTS, score, market } from '../server/lab.mjs';
import { gamesFrom, placeBets, summarize, PRIMARY } from '../server/paperBetting.mjs';

const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const TUNING = '2022-23';

const bt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backtest.json'), 'utf8'));
const records = replay(bt, SEASONS, DEFAULTS);

const recordsSha256 = crypto.createHash('sha256')
  .update(JSON.stringify(records.map((r) => [r.gameId, r.p.toFixed(12), r.pred.toFixed(9)])))
  .digest('hex');

const scoreBySeason = {};
for (const s of SEASONS) scoreBySeason[s] = score(records.filter((r) => r.season === s));

const m = market(records);

// 与 scripts/paper-backtest.mjs 同口径：DraftKings、主规则、调参季之后
const games = [];
for (const season of SEASONS) {
  const file = path.join(DATA_DIR, 'history', `books_${season}.json`);
  if (!fs.existsSync(file)) continue;
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  games.push(...gamesFrom(records.filter((r) => r.season === season), c.games ?? {}));
}
const dkSeasons = SEASONS.filter((s) => s > TUNING
  && games.some((g) => g.season === s && g.books.draftkings));
const head = summarize(
  placeBets(games.filter((g) => dkSeasons.includes(g.season)), { book: 'draftkings', threshold: PRIMARY }),
  { B: 2000 },
);

console.log(JSON.stringify({
  recordsSha256,
  score: scoreBySeason,
  market: { n: m.n, model: m.model, marketModel: m.marketModel, mcnemar: m.mcnemar, ats: m.ats?.all, byEdge: m.ats?.byEdge },
  paperHeadline: { bets: head.bets, roi: head.roi, ci: head.ci },
}, null, 2));
