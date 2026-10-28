/**
 * 模拟投注前向账本：开赛前记下模型的选择与 DraftKings 价格，赛后结算。
 *
 * 这是对模型最干净的检验——记录时谁都不知道结果，记下的行改不了（约束在 db.mjs 的触发器里）。
 * 只记 DraftKings：2026-27 赛季 ESPN 只给这一家。
 *
 * 函数都收一个 node:sqlite 的库句柄（依赖注入），测试用 :memory:，
 * 线上由 scripts/ledger.mjs 在运行中的容器里打开 data-db/ 卷上的那份。
 */
import { devigHomeProb } from './oddsClient.mjs';
import { decide, settle, clvOf, summarize, THRESHOLDS, PRIMARY } from './paperBetting.mjs';

/**
 * 预注册规则，每场每条各记一行；页面主看 edge3。
 * 早（默认运行）：edge0/3/6，北京 22:00 那次记，开赛前 9–12 小时的价。
 * 晚（`capture --late`，只由北京 06:30 那次 cron 带 --late 跑）：edge3-late，同样 edge ≥ 3% 平注 1 单位，
 * 记的是开赛前约 0.5–4 小时、接近收盘的价。两条规则各占一个 (game_id, rule, book)，互不覆盖。
 */
export const RULES = [
  ...THRESHOLDS.map((t) => ({ rule: `edge${Math.round(t * 100)}`, threshold: t, late: false })),
  { rule: `edge${Math.round(PRIMARY * 100)}-late`, threshold: PRIMARY, late: true },
];
export const PRIMARY_RULE = `edge${Math.round(PRIMARY * 100)}`;
export const LATE_RULE = `${PRIMARY_RULE}-late`;
/**
 * 只记开赛前这么多小时内的比赛。服务器 14:30（北京）那次刷新离开赛 16 小时以上，
 * 22:00 那次是 9–12 小时：窗口 14 小时 = 由 22:00 那次记录，见设计 §3。
 */
export const WINDOW_H = 14;
/** 晚规则：06:30（北京）= UTC 22:30，当晚最晚的西部比赛约 5 小时后开打 */
export const LATE_WINDOW_H = 8;
/**
 * 晚规则要的是「接近收盘」的价：赔率快照必须是本次刷新新抓的（2 小时内）且早于开赛。
 * 刷新失败时 refresh.sh 照样跑账本，容器里是前一晚 22:00 的旧快照——那不是临近收盘的价，宁可不记。
 */
export const LATE_MAX_ODDS_AGE_H = 2;
const DK = /draft ?kings/i;

/**
 * 由当晚比赛单生成账本行（纯函数）。
 * slate: [{ gameId, date, tipoff, homeId, awayId, pHome, homeElo, awayElo,
 *           odds: { provider, homeMl, awayMl, homeMlOpen, awayMlOpen, eventId } }]
 */
export function captureRows(slate, { now = Date.now(), run = 'early', windowH, oddsFetchedAt = null } = {}) {
  if (run !== 'early' && run !== 'late') throw new Error(`未知的 run：${run}（early | late）`);
  const late = run === 'late';
  const rules = RULES.filter((r) => r.late === late);
  const win = (windowH ?? (late ? LATE_WINDOW_H : WINDOW_H)) * 3600e3;
  const oddsAt = Date.parse(oddsFetchedAt);
  if (late && !(now - oddsAt <= LATE_MAX_ODDS_AGE_H * 3600e3 && oddsAt <= now)) return [];
  const at = new Date(now).toISOString();
  const rows = [];
  for (const g of slate) {
    const o = g.odds;
    const t = Date.parse(g.tipoff);
    // 已开赛（按赛程开赛时间）一律不记；晚规则另要求价格抓于开赛前，不是滚球价
    if (!o || !DK.test(o.provider ?? '') || !(t > now) || t - now > win || (late && !(oddsAt < t))) continue;
    const pBook = devigHomeProb(o.homeMl, o.awayMl);
    if (pBook == null || g.pHome == null) continue;
    for (const { rule, threshold } of rules) {
      const d = decide(g.pHome, pBook, threshold);
      rows.push({
        game_id: g.gameId, rule, book: 'draftkings', captured_at: at,
        event_id: o.eventId ?? null, game_date: g.date, tipoff_utc: g.tipoff,
        home_id: g.homeId, away_id: g.awayId, model_p_home: g.pHome,
        home_elo: g.homeElo ?? null, away_elo: g.awayElo ?? null,
        home_ml: o.homeMl, away_ml: o.awayMl,
        // ESPN scoreboard 把赛前当下的价放在 moneyline.*.close 里，core 端点同一个数叫 current；
        // 比赛没开打就不存在收盘价，这里如实记 current
        price_at: 'current',
        open_home_ml: o.homeMlOpen ?? null, open_away_ml: o.awayMlOpen ?? null,
        // 价格是 odds.json 抓的那一刻的，不一定是本次运行时（刷新失败时用的是上一份快照）
        odds_fetched_at: oddsFetchedAt,
        book_p_home: pBook, edge: g.pHome - pBook, threshold,
        bet: d ? 1 : 0, side: d?.side ?? null, bet_ml: d ? (d.side === 'home' ? o.homeMl : o.awayMl) : null,
      });
    }
  }
  return rows;
}

const COLS = ['game_id', 'rule', 'book', 'captured_at', 'event_id', 'game_date', 'tipoff_utc',
  'home_id', 'away_id', 'model_p_home', 'home_elo', 'away_elo', 'home_ml', 'away_ml', 'price_at',
  'open_home_ml', 'open_away_ml', 'odds_fetched_at', 'book_p_home', 'edge', 'threshold', 'bet', 'side', 'bet_ml'];

/** 插入；已存在的 (game_id, rule, book) 由触发器忽略。返回新插入的行数 */
export function insertBets(db, rows) {
  const stmt = db.prepare(`INSERT INTO paper_bets (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) n += Number(stmt.run(...COLS.map((c) => r[c] ?? null)).changes ?? 0);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

/** 还没结算、或还缺收盘价的比赛（每场一条） */
export const unsettled = (db) => db.prepare(`
  SELECT game_id, MIN(event_id) AS event_id, MIN(game_date) AS game_date,
         MAX(settled_at IS NULL) AS need_score, MAX(close_home_ml IS NULL) AS need_close
  FROM paper_bets GROUP BY game_id
  HAVING need_score = 1 OR need_close = 1
`).all();

/**
 * 结算。results: { gameId: { homeScore, awayScore, close: [主, 客] | null } }。
 * 只写结算字段：比分/盈亏在 settled_at 为空时写一次；收盘价/CLV 在为空时写一次。
 * 返回写了比分的行数。
 */
export function settleBets(db, results, at = new Date().toISOString()) {
  const rows = db.prepare('SELECT * FROM paper_bets WHERE settled_at IS NULL OR close_home_ml IS NULL').all();
  const score = db.prepare(`UPDATE paper_bets SET home_score = ?, away_score = ?, won = ?, profit = ?, settled_at = ?
    WHERE game_id = ? AND rule = ? AND book = ? AND settled_at IS NULL`);
  const close = db.prepare(`UPDATE paper_bets SET close_home_ml = ?, close_away_ml = ?, clv = ?
    WHERE game_id = ? AND rule = ? AND book = ? AND close_home_ml IS NULL`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const res = results[r.game_id];
      if (!res) continue;
      const key = [r.game_id, r.rule, r.book];
      if (r.settled_at == null && res.homeScore != null && res.awayScore != null) {
        const s = r.bet ? settle(r.side, [r.home_ml, r.away_ml], res.homeScore > res.awayScore) : null;
        n += Number(score.run(res.homeScore, res.awayScore, s ? Number(s.won) : null, s?.profit ?? null, at, ...key).changes ?? 0);
      }
      if (r.close_home_ml == null && res.close) {
        const clv = r.bet ? clvOf(r.side, [r.home_ml, r.away_ml], res.close) : null;
        close.run(res.close[0], res.close[1], clv, ...key);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export const ledgerRows = (db) => db.prepare('SELECT * FROM paper_bets ORDER BY game_date, game_id, rule').all();

/** 页面用的账本汇总：每条规则已结算注单的指标 + 还没结算的已下注行 */
export function ledgerReport(rows, { B, now = Date.now() } = {}) {
  const asBet = (r) => ({ date: r.game_date, ml: r.bet_ml, won: !!r.won, profit: r.profit, clv: r.clv });
  return {
    captured: new Set(rows.map((r) => r.game_id)).size,
    firstDate: rows[0]?.game_date ?? null,
    rules: RULES.map(({ rule, threshold, late }) => {
      const mine = rows.filter((r) => r.rule === rule && r.bet);
      return {
        rule, threshold, late,
        pending: mine.filter((r) => r.settled_at == null).length,
        ...summarize(mine.filter((r) => r.settled_at != null).map(asBet), { B }),
      };
    }),
    // 今晚：早、晚两条主规则里未结算、且开赛不早于 12 小时前的（延期或漏结算的旧单不混进来）
    open: rows.filter((r) => (r.rule === PRIMARY_RULE || r.rule === LATE_RULE) && r.bet && r.settled_at == null
      && !(Date.parse(r.tipoff_utc) < now - 12 * 3600e3)),
  };
}
