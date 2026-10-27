/**
 * 抓历史多家博彩商钱线，缓存到 data/history/books_<赛季>.json（gitignore）。
 *
 *   node scripts/books-history.mjs                          # 默认赛季顺序见 ORDER
 *   SEASONS=2022-23 node scripts/books-history.mjs
 *   MAX_REQUESTS=1500 node scripts/books-history.mjs        # 分批：发够这么多请求就停
 *
 * 只访问 ESPN（不碰 stats.nba.com / nba.com），**全局每秒最多 1 个请求**（含重试）。
 * 可中断续跑：先按日期扫 scoreboard 拿 eventId（已扫的日期记下来不再扫），
 * 再逐场抓 odds；每 25 场落一次盘，已有的比赛跳过。五季约 7000 次请求、两小时。
 *
 * 存的是裁剪后的每家条目（server/books.mjs 的 trimItem），清洗留到分析时做，
 * 这样清洗规则改了不用重抓。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchScoreboard, fetchEventOddsItems } from '../server/oddsClient.mjs';
import { trimItem } from '../server/books.mjs';
import { DATA_DIR } from '../server/nbaClient.mjs';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
// 2022-23 先抓（只有它允许看门槛），2021-22 只作 Elo 预热、放最后
const ORDER = ['2022-23', '2023-24', '2025-26', '2024-25', '2021-22'];
const GAP_MS = 1100;
const FLUSH_EVERY = 25;
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS) || Infinity;

let lastStart = 0;
let sent = 0;
/** 全局限速：两次请求开始时间至少隔 GAP_MS */
const throttle = async () => {
  const wait = lastStart + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
  lastStart = Date.now();
  sent += 1;
};
const http = { before: throttle };
const budgetLeft = () => sent < MAX_REQUESTS;

const shiftDate = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const pairKey = (date, a, b) => `${date}|${Math.min(a, b)}|${Math.max(a, b)}`;

export const cachePath = (season) => path.join(HISTORY_DIR, `books_${season}.json`);

function loadCache(season) {
  // 只有「文件不存在」才从空开始；读坏了要停下，否则下一次落盘会覆盖掉已抓的进度
  if (!fs.existsSync(cachePath(season))) return { season, scanned: [], events: {}, games: {} };
  const c = JSON.parse(fs.readFileSync(cachePath(season), 'utf8'));
  return { season, scanned: c.scanned ?? [], events: c.events ?? {}, games: c.games ?? {} };
}

function saveCache(c) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const tmp = `${cachePath(c.season)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...c, source: 'ESPN core odds', builtAt: new Date().toISOString() }));
  fs.renameSync(tmp, cachePath(c.season));   // 原子替换，中途被杀也不留半个文件
}

async function doSeason(season, games) {
  const c = loadCache(season);
  const wanted = new Map();
  for (const g of games) {
    if (g.s.length !== 2) continue;
    wanted.set(pairKey(g.d, g.s[0][0], g.s[1][0]), g.i);
  }
  const dates = [...new Set(games.map((g) => g.d))].sort();
  const scanned = new Set(c.scanned);

  // 第一步：scoreboard 拿 eventId
  for (const date of dates) {
    if (scanned.has(date) || !budgetLeft()) continue;
    try {
      for (const ev of await fetchScoreboard(date, http)) {
        if (!ev.homeId || !ev.awayId) continue;
        const gameId = [0, -1, 1].map((d) => wanted.get(pairKey(shiftDate(date, d), ev.homeId, ev.awayId))).find(Boolean);
        if (gameId && !c.events[gameId]) c.events[gameId] = { eventId: ev.eventId, date, home: ev.homeId };
      }
      scanned.add(date);
      c.scanned = [...scanned];
      if (scanned.size % 20 === 0) { saveCache(c); console.log(`  ${season} scoreboard ${scanned.size}/${dates.length}`); }
    } catch (e) {
      console.warn(`  ${date} scoreboard 失败：${String(e.message).slice(0, 80)}`);
    }
  }
  saveCache(c);

  // 第二步：逐场 odds
  const todo = Object.entries(c.events).filter(([id]) => !c.games[id]);
  let done = 0;
  for (const [gameId, ev] of todo) {
    if (!budgetLeft()) break;
    try {
      const items = (await fetchEventOddsItems(ev.eventId, http)).map(trimItem).filter(Boolean);
      c.games[gameId] = { ...ev, items };
    } catch (e) {
      console.warn(`  ${gameId} odds 失败：${String(e.message).slice(0, 80)}`);
    }
    done += 1;
    if (done % FLUSH_EVERY === 0) {
      saveCache(c);
      console.log(`  ${season} odds ${Object.keys(c.games).length}/${Object.keys(c.events).length}（本批已发 ${sent} 请求）`);
    }
  }
  saveCache(c);
  const r = {
    season, dates: `${scanned.size}/${dates.length}`, events: Object.keys(c.events).length,
    games: Object.keys(c.games).length, total: wanted.size,
  };
  console.log(`· ${season}：日期 ${r.dates}，eventId ${r.events}，已抓 ${r.games}/${r.total}`);
  return r;
}

/** 同时只跑一份：两份并行会互相覆盖缓存、请求速率也翻倍。锁里记 pid，进程不在了就当失效 */
function lock() {
  const p = path.join(HISTORY_DIR, '.books-history.lock');
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(p, 'utf8'));
    process.kill(pid, 0);
    console.error(`已有一份在跑（pid ${pid}），退出`);
    process.exit(1);
  } catch { /* 没有锁或持锁进程已不在 */ }
  fs.writeFileSync(p, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(p); } catch { /* 已删 */ } });
}

async function main() {
  lock();
  const bt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backtest.json'), 'utf8'));
  const only = (process.env.SEASONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seasons = (only.length ? only : ORDER).filter((s) => bt.seasons[s]);
  console.log(`抓多家历史钱线（ESPN，≤1 请求/秒）赛季：${seasons.join(', ')}`);
  const t0 = Date.now();
  for (const s of seasons) {
    if (!budgetLeft()) break;
    await doSeason(s, bt.seasons[s]);
  }
  console.log(`本批 ${sent} 请求，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟${budgetLeft() ? '' : '（达到 MAX_REQUESTS，重跑同一命令续抓）'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
