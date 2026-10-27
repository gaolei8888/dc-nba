/**
 * 轻量刷新：只用 ESPN，不碰 stats.nba.com。
 *
 *   node scripts/espn-refresh.mjs
 *
 * 为什么要有它：线上服务器（以及我们试过的海外机房）的 IP 被 NBA 的 CDN 封了，
 * 服务器自己跑不了 ingest；ESPN 则都能访问。所以服务器每天用它补上：
 *
 *   · 已结束比赛的比分（赛程里的 homeScore/awayScore）
 *   · 本赛季 Elo：从开赛日评级起，用全部已结束比赛重算——与 ingest 同一套 computeElo
 *   · 每场的赛前 Elo（预测 vs 实际要用）
 *   · 本赛季战绩（t.cur.wins/losses）
 *   · 伤病名单、未开赛比赛的盘口
 *
 * **不更新**球员/球队的统计数据（场均、高阶、IMP）——那些只有 stats.nba.com 有，
 * 等本机的全量刷新（npm run ingest）来补。meta.statsFetchedAt 记着它们是哪天的。
 *
 * 正确性的锚：对一份 ingest 刚写出的数据跑本脚本，Elo 必须一分不差地复现
 * （见 deploy/README.md 的验证记录）。比分来源换了，算法没换。
 */
import { readJson, writeJson } from '../server/nbaClient.mjs';
import { fetchScoreboard, fetchUpcomingOdds } from '../server/oddsClient.mjs';
import { fetchInjuries } from '../server/espnClient.mjs';
import { computeElo } from '../server/ratings.mjs';

const log = (...a) => console.log('·', ...a);
const r1 = (v) => Math.round(v * 10) / 10;

const shift = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

async function main() {
  const t0 = Date.now();
  const schedule = readJson('schedule.json');
  const teams = readJson('teams.json');
  const players = readJson('players.json');
  const meta = readJson('meta.json');
  if (!schedule || !teams || !players || !meta) throw new Error('缺少数据快照，先跑一次 npm run ingest');

  // ---- 1. 比分：扫所有「已经开打、还没有比分」的比赛日
  const now = Date.now();
  const pending = schedule.games.filter((g) => g.type !== 'preseason' && g.homeScore == null
    && g.dateTimeUtc && Date.parse(g.dateTimeUtc) < now);
  const dates = [...new Set(pending.map((g) => g.date))].sort();
  log(`待补比分 ${pending.length} 场，${dates.length} 个比赛日`);

  const byKey = new Map(pending.map((g) => [`${g.date}|${g.homeId}|${g.awayId}`, g]));
  let filled = 0;
  for (const date of dates) {
    // ESPN 的日期口径偶尔和 NBA 差一天（跨午夜的场次），前后各看一天
    for (const ev of await fetchScoreboard(date)) {
      if (!ev.completed || ev.homeScore == null || ev.awayScore == null) continue;
      const g = byKey.get(`${date}|${ev.homeId}|${ev.awayId}`)
        ?? byKey.get(`${shift(date, -1)}|${ev.homeId}|${ev.awayId}`)
        ?? byKey.get(`${shift(date, 1)}|${ev.homeId}|${ev.awayId}`);
      if (!g || g.homeScore != null) continue;
      g.homeScore = ev.homeScore;
      g.awayScore = ev.awayScore;
      filled += 1;
    }
  }
  log(`ESPN 补上 ${filled} 场比分`);

  // ---- 2. Elo：从开赛日评级起用全部已结束常规赛重算
  // 只算 type=regular，和 ingest 用的 leaguegamelog(Regular Season) 口径一致——
  // NBA 杯决赛不计入常规赛，也就不进 Elo。
  const done = schedule.games
    .filter((g) => g.type === 'regular' && g.homeScore != null)
    .map((g) => {
      const home = teams.find((t) => t.teamId === g.homeId);
      const away = teams.find((t) => t.teamId === g.awayId);
      return {
        gameId: g.gameId,
        date: g.date,
        neutral: false,
        home: { teamId: g.homeId, abbr: home?.abbr, pts: g.homeScore, win: g.homeScore > g.awayScore },
        away: { teamId: g.awayId, abbr: away?.abbr, pts: g.awayScore, win: g.awayScore > g.homeScore },
      };
    })
    // 与 ratings.buildGames 相同的顺序：日期，再按 gameId
    .sort((a, b) => (a.date === b.date ? a.gameId.localeCompare(b.gameId) : a.date.localeCompare(b.date)));

  const initial = Object.fromEntries(teams.map((t) => [t.teamId, t.eloPreseasonExact ?? t.eloPreseason]));
  const { final, history } = computeElo(done, { initial });
  const pre = new Map(history.map((h) => [h.gameId, h]));
  for (const g of schedule.games) {
    const h = pre.get(g.gameId);
    if (h) g.preElo = { home: r1(h.homeEloPre), away: r1(h.awayEloPre) };
  }
  for (const t of teams) t.elo = r1(final[t.teamId] ?? t.eloPreseason);

  // ---- 3. 本赛季战绩（统计数据不动，只有胜负场能从比分推出来）
  const rec = new Map(teams.map((t) => [t.teamId, { w: 0, l: 0 }]));
  for (const g of done) {
    rec.get(g.home.teamId)[g.home.win ? 'w' : 'l'] += 1;
    rec.get(g.away.teamId)[g.away.win ? 'w' : 'l'] += 1;
  }
  for (const t of teams) {
    if (!t.cur) continue;
    const r = rec.get(t.teamId);
    t.cur.wins = r.w;
    t.cur.losses = r.l;
    t.cur.winPct = r.w + r.l ? Math.round((r.w / (r.w + r.l)) * 1000) / 1000 : 0;
  }

  // ---- 4. 伤病与盘口：失败就保留旧的，不写空
  try {
    log('伤病名单 (ESPN)');
    writeJson('injuries.json', await fetchInjuries(players));
  } catch (e) {
    console.warn(`  伤病抓取失败，保留旧数据：${String(e.message).slice(0, 90)}`);
  }
  try {
    log('博彩盘口 (ESPN)');
    const r = await fetchUpcomingOdds(schedule.games, { maxDays: 14 });
    writeJson('odds.json', {
      source: 'ESPN', fetchedAt: new Date().toISOString(), games: r.games, matched: r.matched,
      candidates: r.candidates, scannedDays: r.scanned, providers: r.providers,
    });
  } catch (e) {
    console.warn(`  盘口抓取失败，保留旧数据：${String(e.message).slice(0, 90)}`);
  }

  // ---- 5. meta：fetchedAt 是「结果更新到什么时候」，统计数据的时间单独记
  meta.statsFetchedAt = meta.statsFetchedAt ?? meta.fetchedAt;
  meta.fetchedAt = new Date().toISOString();
  meta.resultsSource = 'espn';
  meta.gamesPlayedCurrent = done.length;
  meta.lastResultDate = done.length ? done[done.length - 1].date : meta.lastResultDate;

  writeJson('schedule.json', schedule);
  writeJson('teams.json', teams);
  writeJson('meta.json', meta);

  console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
    + `  ·  已结束 ${done.length} 场（截至 ${meta.lastResultDate}）`
    + `  ·  统计数据仍是 ${String(meta.statsFetchedAt).slice(0, 10)} 的`);
}

main().catch((e) => {
  console.error('\nESPN 刷新失败:', e);
  process.exit(1);
});
