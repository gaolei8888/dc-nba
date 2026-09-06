/**
 * 抓取历史收盘盘口，缓存到 data/history/odds_<赛季>.json。
 *
 *   node scripts/odds-history.mjs                    # 全部赛季
 *   SEASONS=2024-25,2025-26 node scripts/odds-history.mjs
 *   ODDS_CONCURRENCY=2 node scripts/odds-history.mjs # 想更客气一点
 *
 * 为什么要单独一个脚本而不是并进 ingest：这活儿要发约 7000 个请求、跑几分钟，
 * 而历史盘口一旦抓到就永远不会变。跑一次即可，之后 ingest 直接读缓存。
 * 脚本可中断可续跑——每抓 50 场落一次盘，重跑会跳过已有的比赛。
 *
 * 数据用途见 server/lab.mjs 的「对标盘口」：盘口是市场共识，
 * 拿它当一个更强的对手模型来对标，比自己拍脑袋调参数可靠得多。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchScoreboard, fetchEventOdds } from '../server/oddsClient.mjs';
import { DATA_DIR } from '../server/nbaClient.mjs';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CONCURRENCY = Math.max(1, Number(process.env.ODDS_CONCURRENCY) || 4);
const FLUSH_EVERY = 50;

const log = (...a) => console.log('·', ...a);

/** 前后各挪一天：ESPN 按美东日历分天，个别晚场会跟 NBA 的记法差一天 */
const shiftDate = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** 极简并发池：保持 n 个任务在飞，按提交顺序返回结果 */
async function mapPool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

function loadBacktest() {
  const p = path.join(DATA_DIR, 'backtest.json');
  if (!fs.existsSync(p)) {
    console.error('缺少 data/backtest.json，请先运行 npm run backtest && npm run ingest');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const cachePath = (season) => path.join(HISTORY_DIR, `odds_${season}.json`);

function loadCache(season) {
  const p = cachePath(season);
  if (!fs.existsSync(p)) return { season, games: {} };
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { season, games: c.games ?? {} };
  } catch {
    return { season, games: {} };
  }
}

function saveCache(season, cache) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const providers = {};
  for (const g of Object.values(cache.games)) {
    if (g?.provider) providers[g.provider] = (providers[g.provider] ?? 0) + 1;
  }
  fs.writeFileSync(cachePath(season), JSON.stringify({
    season,
    source: 'ESPN',
    builtAt: new Date().toISOString(),
    count: Object.keys(cache.games).length,
    providers,
    games: cache.games,
  }));
}

async function doSeason(season, games) {
  const cache = loadCache(season);

  // key = 日期|主队|客队 -> NBA gameId
  const wanted = new Map();
  const dates = new Set();
  for (const g of games) {
    const home = g.s.find((s) => s[2] === 1);
    const away = g.s.find((s) => s[2] === 0);
    if (!home || !away) continue;          // 中立场两边都不是主场，盘口对不上，跳过
    wanted.set(`${g.d}|${home[0]}|${away[0]}`, g.i);
    dates.add(g.d);
  }

  const missing = new Set(
    [...wanted.values()].filter((id) => !cache.games[id]),
  );
  if (!missing.size) {
    log(`${season} 已完整：${Object.keys(cache.games).length}/${wanted.size} 场，跳过`);
    return { season, have: Object.keys(cache.games).length, total: wanted.size, added: 0 };
  }

  const dateList = [...dates].sort();
  log(`${season} 待抓 ${missing.size} 场，扫 ${dateList.length} 个比赛日（并发 ${CONCURRENCY}）`);

  // 第一步：按日期拿 eventId。已完成的比赛 scoreboard 不带盘口，只能拿 id。
  const jobs = [];
  let scanned = 0;
  const boards = await mapPool(dateList, CONCURRENCY, async (date) => {
    try {
      const evs = await fetchScoreboard(date);
      scanned += 1;
      if (scanned % 30 === 0) process.stdout.write(`    已扫 ${scanned}/${dateList.length} 天\r`);
      return { date, evs };
    } catch (e) {
      console.warn(`\n    ${date} scoreboard 失败：${String(e.message).slice(0, 70)}`);
      return { date, evs: [] };
    }
  });
  process.stdout.write('\n');

  for (const { date, evs } of boards) {
    for (const ev of evs) {
      if (!ev.homeId || !ev.awayId) continue;
      const gameId = wanted.get(`${date}|${ev.homeId}|${ev.awayId}`)
        ?? wanted.get(`${shiftDate(date, -1)}|${ev.homeId}|${ev.awayId}`)
        ?? wanted.get(`${shiftDate(date, 1)}|${ev.homeId}|${ev.awayId}`);
      if (!gameId || !missing.has(gameId)) continue;
      jobs.push({ gameId, eventId: ev.eventId, date });
      missing.delete(gameId);              // 同一场只排一次
    }
  }

  log(`  匹配到 ${jobs.length} 场，开始抓盘口`);

  let done = 0;
  let empty = 0;
  await mapPool(jobs, CONCURRENCY, async (job) => {
    let odds = null;
    try {
      odds = await fetchEventOdds(job.eventId);
    } catch (e) {
      console.warn(`\n    ${job.gameId} 盘口失败：${String(e.message).slice(0, 70)}`);
    }
    if (odds) {
      cache.games[job.gameId] = { ...odds, eventId: job.eventId, date: job.date };
    } else {
      empty += 1;
    }
    done += 1;
    if (done % 25 === 0) process.stdout.write(`    ${done}/${jobs.length}\r`);
    if (done % FLUSH_EVERY === 0) saveCache(season, cache);
  });
  process.stdout.write('\n');

  saveCache(season, cache);
  const have = Object.keys(cache.games).length;
  log(`  ${season} 完成：${have}/${wanted.size} 场有盘口${empty ? `（${empty} 场无记录）` : ''}`);
  return { season, have, total: wanted.size, added: jobs.length - empty };
}

async function main() {
  const bt = loadBacktest();
  const all = Object.keys(bt.seasons).sort();
  const only = (process.env.SEASONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seasons = only.length ? all.filter((s) => only.includes(s)) : all;

  if (!seasons.length) {
    console.error(`没有可抓的赛季。backtest.json 里有：${all.join(', ')}`);
    process.exit(1);
  }

  console.log(`\n抓取历史盘口（ESPN）  赛季：${seasons.join(', ')}\n`);
  const t0 = Date.now();
  const summary = [];
  for (const s of seasons) summary.push(await doSeason(s, bt.seasons[s]));

  console.log(`\n完成，用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`);
  for (const r of summary) {
    const pct = r.total ? ((r.have / r.total) * 100).toFixed(1) : '0.0';
    console.log(`  ${r.season}  ${r.have}/${r.total} 场 (${pct}%)`);
  }
  console.log('\n接着跑 npm run ingest，盘口会并进 data/backtest.json 供实验室使用。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
