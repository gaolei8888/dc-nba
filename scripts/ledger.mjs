/**
 * 模拟投注前向账本的记录与结算（只追加，见 server/ledger.mjs、db.mjs 的触发器）。
 *
 *   node scripts/ledger.mjs capture   # 开赛前：用 data/odds.json 里已抓的 DK 价，零额外请求
 *   node scripts/ledger.mjs settle    # 赛后：用 data/schedule.json 的比分结算；
 *                                     # 顺带每场 1 个 ESPN 请求取 DK 收盘价算 CLV
 *   node scripts/ledger.mjs show      # 打印账本汇总
 *   LEDGER_NO_FETCH=1 ...settle       # 不发请求（收盘价留空，下次再补）
 *   DB_PATH=/path/app.db ...          # 默认 data/app.db；线上容器里是 /app/data-db/app.db
 *
 * 线上由 deploy/refresh.sh 在新容器健康之后 `docker exec dc-nba node scripts/ledger.mjs …` 调用：
 * refresh 的取数在临时目录里进行、碰不到 data-db/，只有运行中的容器挂着那份持久的库。
 */
import { readJson } from '../server/nbaClient.mjs';
import { openLedger } from '../server/db.mjs';
import { buildModel, predictSchedule } from '../server/predict.mjs';
import { fetchEventOddsItems } from '../server/oddsClient.mjs';
import { trimItem, bookOf } from '../server/books.mjs';
import {
  captureRows, insertBets, settleBets, unsettled, ledgerRows, ledgerReport,
} from '../server/ledger.mjs';

const GAP_MS = 1100;
/** 赛后几天内还去补收盘价；再早的放弃，不无限重试 */
const CLOSE_DAYS = 3;

const db = openLedger();
if (!db) process.exit(1);
const cmd = process.argv[2];

function capture() {
  const store = {
    teams: readJson('teams.json'), players: readJson('players.json'),
    schedule: readJson('schedule.json'), meta: readJson('meta.json'),
  };
  const snap = readJson('odds.json');
  const odds = snap?.games ?? {};
  const elo = new Map(store.teams.map((t) => [t.teamId, t.elo]));
  const upcoming = store.schedule.games.filter((g) => g.type === 'regular' && g.homeScore == null && odds[g.gameId]);
  // 生产默认参数、不套任何缺阵勾选——账本记的是线上默认预测
  const slate = predictSchedule(buildModel(store), upcoming, {}).map((g) => ({
    gameId: g.gameId, date: g.date, tipoff: g.dateTimeUtc, homeId: g.homeId, awayId: g.awayId,
    pHome: g.prediction.homeWinProb, homeElo: elo.get(g.homeId), awayElo: elo.get(g.awayId),
    odds: odds[g.gameId],
  }));
  const rows = captureRows(slate, { oddsFetchedAt: snap?.fetchedAt ?? null });
  const n = insertBets(db, rows);
  // 窗口内却没有 DK 价的比赛（还没出线、或中立场 ESPN 主客与赛程相反没对上）记一笔，不默默漏掉
  const now = Date.now();
  const missed = store.schedule.games.filter((g) => g.type === 'regular' && g.homeScore == null
    && Date.parse(g.dateTimeUtc) > now && Date.parse(g.dateTimeUtc) - now < 14 * 3600e3
    && !rows.some((r) => r.game_id === g.gameId)).map((g) => g.gameId);
  console.log(`· 账本记录：窗口内 ${new Set(rows.map((r) => r.game_id)).size} 场，新插入 ${n} 行（已记过的忽略）`
    + `；赔率快照 ${snap?.fetchedAt ?? '—'}${missed.length ? `；窗口内无 DK 价未记 ${missed.length} 场：${missed.join(',')}` : ''}`);
}

let lastStart = 0;
/** 每次尝试（含 get 内部重试）之间至少隔 GAP_MS */
const throttle = async () => {
  const wait = lastStart + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
  lastStart = Date.now();
};

async function dkClose(eventId) {
  const dk = (await fetchEventOddsItems(eventId, { before: throttle })).map(trimItem).find((it) => it && bookOf(it) === 'draftkings');
  return dk?.close ?? null;   // 只认真正的 close，没有就留空
}

async function settleAll() {
  const sched = new Map(readJson('schedule.json').games.map((g) => [g.gameId, g]));
  const cutoff = new Date(Date.now() - CLOSE_DAYS * 86400e3).toISOString().slice(0, 10);
  const results = {};
  let fetched = 0;
  for (const u of unsettled(db)) {
    const g = sched.get(u.game_id);
    if (g?.homeScore == null || g?.awayScore == null) continue;
    let close = null;
    if (u.need_close && u.event_id && !process.env.LEDGER_NO_FETCH && u.game_date >= cutoff) {
      try { close = await dkClose(u.event_id); fetched += 1; } catch (e) {
        console.warn(`  ${u.game_id} 收盘价抓取失败，下次再补：${String(e.message).slice(0, 80)}`);
      }
    }
    results[u.game_id] = { homeScore: g.homeScore, awayScore: g.awayScore, close };
  }
  const n = settleBets(db, results);
  console.log(`· 账本结算：${Object.keys(results).length} 场有比分，结算 ${n} 行，请求收盘价 ${fetched} 次`);
}

function show() {
  const rep = ledgerReport(ledgerRows(db), { B: 1000 });
  console.log(`已记录 ${rep.captured} 场（自 ${rep.firstDate ?? '—'}）`);
  for (const r of rep.rules) {
    console.log(`  ${r.rule}: 已结算 ${r.bets} 注、待结算 ${r.pending}、盈亏 ${r.units.toFixed(2)} 注`
      + (r.roi == null ? '' : `、ROI ${(r.roi * 100).toFixed(1)}%`));
  }
}

const CMDS = { capture, settle: settleAll, show };
if (!CMDS[cmd]) {
  console.error('用法：node scripts/ledger.mjs capture|settle|show');
  process.exit(2);
}
await CMDS[cmd]();
