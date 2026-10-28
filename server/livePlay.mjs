/**
 * 人机对赌「本季实战」：对本季（2026-27）还没开打的真实比赛下判断，和模型同台。
 *
 * 与上季回放的区别就是没有答案：回放题库的比分早就公开了，只能当练习；
 * 这里提交时谁都不知道结果，所以才能比出真本事。三条规矩：
 *   1. 提交时把**模型此刻的赛前预测**（胜率、所用 Elo、数据快照时间）和用户的选择一起存下。
 *      模型按它赛前说过的话计分，不按赛后更新过的评级——否则模型等于偷看了答案。
 *   2. 按赛程开赛时间锁定。开赛前可以改（选择和模型快照一起更新到改的那一刻，两边信息同时）；
 *      到点后新提交和修改一律拒绝。应用层用可注入的时钟判断，库里再用触发器按真实时钟兜底。
 *   3. 结算不写库：比分由 ESPN 刷新写进 schedule.json，读的时候现算。记录本身只有赛前的东西，
 *      结果来自唯一的比分来源，不会出现库里和赛程不一致的两份比分。
 *
 * 函数都收 node:sqlite 的库句柄（依赖注入），测试用 :memory:。表结构在 db.mjs 的 LIVE_SCHEMA。
 */

const iso = (ms) => new Date(ms).toISOString();
const conf01 = (c) => Math.min(0.95, Math.max(0.5, Number(c) || 0.5));

/** 计分与上季回放同口径：猜对 +(信心−50%)×200，猜错扣同样多；模型按自己的信心 max(p, 1−p) 计分 */
export function scorePick({ side, conf }, modelProb, homeWin) {
  const correct = (side === 'home') === homeWin;
  const pHome = side === 'home' ? conf : 1 - conf;
  const y = homeWin ? 1 : 0;
  const modelCorrect = (modelProb >= 0.5) === homeWin;
  return {
    correct,
    points: Math.round((conf - 0.5) * 200) * (correct ? 1 : -1),
    brier: (pHome - y) ** 2,
    modelCorrect,
    modelPoints: Math.round((Math.max(modelProb, 1 - modelProb) - 0.5) * 200) * (modelCorrect ? 1 : -1),
    modelBrier: (modelProb - y) ** 2,
  };
}

/** 本季能下注的比赛：季前赛不算 */
export const isLiveGame = (g) => g && g.type !== 'preseason' && g.homeId && g.awayId;
const hasScore = (g) => g.homeScore != null && g.awayScore != null;
/** 按赛程开赛时间锁定；有比分的当然也锁 */
export const isLocked = (g, now) => hasScore(g) || !(Date.parse(g.dateTimeUtc) > now);

/**
 * 可玩的比赛日（美东日期，NBA 官方口径）：从最早一个还有未开赛比赛的日子起取 n 天。
 * 当天已开赛的也算在 games 里（显示为锁定），open 是还能下的场数。
 */
export function slateDays(schedule, now, n = 3) {
  const byDate = new Map();
  for (const g of schedule) {
    if (!isLiveGame(g) || hasScore(g)) continue;
    const d = byDate.get(g.date) ?? { date: g.date, games: 0, open: 0, nextTipoff: null };
    d.games += 1;
    if (!isLocked(g, now)) {
      d.open += 1;
      if (!d.nextTipoff || g.dateTimeUtc < d.nextTipoff) d.nextTipoff = iso(Date.parse(g.dateTimeUtc));
    }
    byDate.set(g.date, d);
  }
  return [...byDate.values()].filter((d) => d.open > 0)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, n);
}

/**
 * 提交/修改一批选择。
 * games: Map gameId → 赛程行；quote(game) → { pHome, homeElo, awayElo }：此刻的生产默认预测。
 * 返回 { saved, rejected: [{ gameId, reason: unknown | locked | side }] }。
 */
export function submitLivePicks(db, playerId, picks, { games, quote, dataAt = null, now = Date.now() }) {
  const at = iso(now);
  // 先改后插：插入那条路上有防重复触发器（INSERT OR REPLACE 也绕不过），修改那条路有开赛锁触发器
  const upd = db.prepare(`UPDATE live_picks SET side = ?, conf = ?, model_p_home = ?, home_elo = ?, away_elo = ?,
    data_at = ?, updated_at = ?, edits = edits + 1 WHERE player_id = ? AND game_id = ?`);
  const ins = db.prepare(`INSERT INTO live_picks (player_id, game_id, game_date, tipoff_utc, home_id, away_id, side, conf,
    model_p_home, home_elo, away_elo, data_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rejected = [];
  let saved = 0;
  db.exec('BEGIN');
  try {
    for (const p of picks) {
      const gameId = String(p?.gameId ?? '');
      const g = games.get(gameId);
      if (!isLiveGame(g)) { rejected.push({ gameId, reason: 'unknown' }); continue; }
      if (isLocked(g, now)) { rejected.push({ gameId, reason: 'locked' }); continue; }
      if (p.side !== 'home' && p.side !== 'away') { rejected.push({ gameId, reason: 'side' }); continue; }
      const q = quote(g);
      const c = conf01(p.conf);
      const vals = [p.side, c, q.pHome, q.homeElo ?? null, q.awayElo ?? null, dataAt, at];
      if (!Number(upd.run(...vals, playerId, gameId).changes)) {
        ins.run(playerId, gameId, g.date, iso(Date.parse(g.dateTimeUtc)), g.homeId, g.awayId,
          p.side, c, q.pHome, q.homeElo ?? null, q.awayElo ?? null, dataAt, at, at);
      }
      saved += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { saved, rejected };
}

/** 某玩家（或全部，排行榜用）的记录，按开赛时间排 */
export const livePickRows = (db, playerId = null) => (playerId
  ? db.prepare('SELECT * FROM live_picks WHERE player_id = ? ORDER BY tipoff_utc, game_id').all(playerId)
  : db.prepare('SELECT * FROM live_picks ORDER BY tipoff_utc, game_id').all());

/**
 * 翻牌：把库里的赛前记录和赛程比分对上。没比分的只回选择，不透露模型快照。
 * 输出行的计分字段与前端 summarize() 同名。
 */
export function settleLive(rows, games) {
  return rows.map((r) => {
    const g = games.get(r.game_id);
    const base = {
      playerId: r.player_id, name: r.name ?? null, gameId: r.game_id, date: r.game_date, tipoff: r.tipoff_utc, homeId: r.home_id, awayId: r.away_id,
      side: r.side, conf: r.conf, createdAt: r.created_at, updatedAt: r.updated_at, result: null,
    };
    if (!g || !hasScore(g) || g.homeScore === g.awayScore) return base;
    const homeWin = g.homeScore > g.awayScore;
    return {
      ...base,
      result: { homeScore: g.homeScore, awayScore: g.awayScore, homeWin },
      modelProb: r.model_p_home, homeElo: r.home_elo, awayElo: r.away_elo, dataAt: r.data_at,
      ...scorePick(r, r.model_p_home, homeWin),
    };
  });
}

/** 本季实战排行：rows 需带 name（调用方 join players）。字段与上季回放的排行榜一致，前端表格可复用 */
export function liveBoard(rows, games, { min = 1, limit = 50 } = {}) {
  const by = new Map();
  for (const s of settleLive(rows, games)) {
    if (!s.result) continue;
    const id = s.playerId;
    const a = by.get(id) ?? { id, name: s.name, n: 0, correct: 0, points: 0, brier: 0, model_points: 0, model_brier: 0, last_at: null };
    a.n += 1; a.correct += Number(s.correct); a.points += s.points; a.brier += s.brier;
    a.model_points += s.modelPoints; a.model_brier += s.modelBrier;
    if (!a.last_at || s.updatedAt > a.last_at) a.last_at = s.updatedAt;
    by.set(id, a);
  }
  return [...by.values()].filter((a) => a.n >= min)
    .map((a) => ({ ...a, brier: a.brier / a.n, model_brier: a.model_brier / a.n }))
    .sort((x, y) => y.points - x.points).slice(0, limit);
}
