/**
 * 逐场抓 play-by-play，还原每一段的场上十人，写成 RAPM 的训练数据。
 *
 *   node scripts/pbp-history.mjs
 *   SEASONS=2025-26 node scripts/pbp-history.mjs
 *   FORCE=1 node scripts/pbp-history.mjs     # 重抓已有赛季
 *
 * 为什么要它：`leaguedashlineups` 只给进攻方五人，算出来的 APM
 * 没有对手调整，总在一起上场的球员分不开。要做真正的 RAPM，
 * 必须知道每一段攻守双方各是谁——只有 PBP 有这个信息。
 *
 * 一场要两个请求：PBP（阵容变动）+ box score（首发名单、姓名→ID、分钟数）。
 * box score 不是可有可无的：v3 的换人事件只给下场球员的 ID，
 * 上场的人只有一个姓氏，必须靠名册才能还原成 ID。
 *
 * **每场都对账**：把还原出的出场时间和 box score 的分钟数逐人比，
 * 对不上的整场丢掉。宁可少几场也不要脏数据——RAPM 对阵容错误很敏感，
 * 一段错位会把两边十个人的系数一起带偏。
 *
 * 断点续抓：已经处理过的比赛不会重来，中途 Ctrl-C 可以直接再跑。
 *
 * **速率**：实测 7.6 请求/秒能跑几十个请求不出错，但持续几分钟之后
 * stats.nba.com 会把这个 IP 上的所有请求挂起（不是返回 429，是直接不响应，
 * 连退回串行也照样挂）。所以默认压到 2 请求/秒，一万两千个请求约 1.7 小时。
 * 被封了就等十几分钟，续抓不会丢已有进度。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nbaGet, statsUrl, DATA_DIR, readJsonAuto, writeJsonGz } from '../server/nbaClient.mjs';
import { fetchGameStints } from '../server/pbp.mjs';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const FLUSH_EVERY = 20;
// 连续这么多场都是请求失败，就认定被限流了，直接停——继续跑只会把
// 一千多场都记成 failed，下次续抓反而会跳过它们。
const GIVE_UP_AFTER = 12;

const log = (...a) => console.log('·', ...a);

class Throttled extends Error {}

const fetchGame = (gameId) => fetchGameStints(gameId, (e, p) => nbaGet(statsUrl(e, p)));

/** 固定并发的任务池；比 chunk 分批快，因为不用等最慢的那个 */
async function pool(items, worker, { concurrency, onDone }) {
  let next = 0;
  let done = 0;
  let stop = false;
  const run = async () => {
    while (next < items.length && !stop) {
      const i = next++;
      const r = await worker(items[i]);
      done++;
      try {
        onDone?.(r, done, items.length);
      } catch (e) {
        if (e instanceof Throttled) { stop = true; throw e; }
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function doSeason(season) {
  const gamelog = path.join(HISTORY_DIR, `gamelog_${season}.json`);
  if (!fs.existsSync(gamelog)) { log(`${season} 缺少 gamelog，跳过`); return; }
  const gameIds = [...new Set(JSON.parse(fs.readFileSync(gamelog, 'utf8')).map((r) => r.GAME_ID))].sort();

  // 存 gzip：一季 3.4MB、五季 17MB，压完只有 2.4MB，压缩版才进得了仓库。
  // 进了仓库审阅者才能自己改参数重跑，而不是只能核对我给的数字。
  const out = path.join(HISTORY_DIR, `stints_${season}.json.gz`);
  let data = { season, games: {}, failed: {} };
  if (process.env.FORCE !== '1') {
    const prev = readJsonAuto(out);   // .json 与 .json.gz 都认，老文件能续上
    if (prev) { data = prev; data.failed ??= {}; }
  }
  const todo = gameIds.filter((id) => !data.games[id] && !data.failed[id]);
  log(`${season}：共 ${gameIds.length} 场，已有 ${Object.keys(data.games).length} 场，本次要抓 ${todo.length} 场`);
  if (!todo.length) return;

  const save = () => writeJsonGz(out, data);
  let sinceFlush = 0;
  let netFailStreak = 0;
  const t0 = Date.now();

  try {
    await pool(todo, async (gameId) => {
      try {
        return await fetchGame(gameId);
      } catch (e) {
        return { gameId, ok: false, net: true, why: e.message };
      }
    }, {
      concurrency: CONCURRENCY,
      onDone: (r, done, total) => {
        if (r.ok) data.games[r.gameId] = [r.homeId, r.awayId, r.stints];
        // 网络失败不写进 failed：那是我们的问题不是数据的问题，下次要重试
        else if (!r.net) data.failed[r.gameId] = r.why;

        netFailStreak = r.net ? netFailStreak + 1 : 0;
        if (++sinceFlush >= FLUSH_EVERY) { save(); sinceFlush = 0; }
        if (done % 50 === 0 || done === total) {
          const rate = done / ((Date.now() - t0) / 1000);
          const eta = Math.round((total - done) / rate / 60);
          log(`${season} ${done}/${total}  可用 ${Object.keys(data.games).length}  `
            + `${rate.toFixed(2)} 场/秒  剩约 ${eta} 分`);
        }
        if (netFailStreak >= GIVE_UP_AFTER) {
          throw new Throttled(`连续 ${netFailStreak} 场请求失败，多半被限流了`);
        }
      },
    });
  } catch (e) {
    save();
    if (e instanceof Throttled) {
      log(`${season} 中止：${e.message}。已保存 ${Object.keys(data.games).length} 场，`
        + '等十几分钟再跑同一条命令即可续抓。');
      throw e;
    }
    throw e;
  }
  save();

  const okN = Object.keys(data.games).length;
  const stintN = Object.values(data.games).reduce((a, g) => a + g[2].length, 0);
  const failN = Object.keys(data.failed).length;
  log(`${season} 完成：${okN} 场可用（${(100 * okN / gameIds.length).toFixed(1)}%），`
    + `${stintN.toLocaleString()} 段，丢弃 ${failN} 场，`
    + `文件 ${(fs.statSync(out).size / 1e6).toFixed(1)} MB（gzip）`);
  if (failN) {
    const why = Object.values(data.failed);
    const top = [...new Set(why.map((w) => w.split('：')[0]))].slice(0, 3);
    log(`  丢弃原因样例：${top.join(' / ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 被限流就等一会儿再续。封禁是有时限的，而这本来就是个以小时计的任务，
 * 与其让人守着重跑，不如自己等——进度已经落盘，等多久都不会丢。
 */
async function withRetry(season) {
  const waits = [10, 15, 20, 30, 45, 60];
  for (let i = 0; ; i++) {
    try {
      await doSeason(season);
      return;
    } catch (e) {
      if (!(e instanceof Throttled) || i >= waits.length) throw e;
      log(`等 ${waits[i]} 分钟后继续 ${season}…`);
      await sleep(waits[i] * 60000);
    }
  }
}

async function main() {
  const only = (process.env.SEASONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seasons = only.length ? only : ['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'];
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  console.log(`\n抓取 play-by-play 并还原阵容  赛季：${seasons.join('、')}\n`);
  const t0 = Date.now();
  for (const s of seasons) await withRetry(s);
  console.log(`\n用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
