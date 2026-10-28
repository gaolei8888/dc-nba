/**
 * 阵容+战绩榜影子运行（2026-10-28 高磊批准）：把总览页的「阵容+战绩」榜（server/liveRosterRankings.mjs 的 total，
 * 即 r = (K·阵容先验 + Σw·对手调整净胜分)/(K + Σw)）当作一套赛前预测，与线上 Elo（影子模式的 base）逐场配对比较。
 * 只记录，页面显示的预测不变。预注册见 docs/roster-results-update-verdict.md「影子运行预注册」。
 *
 *   - rr22   ：北京 22:00 那次（与 base / r22 同一次运行）用当时的榜记；
 *   - rr0630 ：北京 06:30 那次（--late）用当时的榜记——榜的缺阵来自 store.injuries（availability = reported），
 *              06:30 的伤病更新由此反映进来。06:30 之前就开打的场在 22:00 那次就记 rr0630（与 r0630 同规则）。
 * 预注册主方案是 rr0630；rr22 只报告，不作决策。
 *
 * 胜率与回测同一个函数（rosterResults.gamePred）：Φ((r主 − r客 + 主场 1.6（中立场 0）+ 休息项) / 12)，
 * 休息项 = (restAdjust(主休息天数) − restAdjust(客)) × 1.8，与回测、线上预测同一张表；休息天数取与 base 同一份赛程推算。
 * 参数冻结在 server/roster-results-params-v1.json，影子期内不调。盘口不进任何输入。
 *
 * 赛前性：
 *   - 评级只用比赛日（美东）之前的赛果：喂给榜的赛程里，比赛日当天及之后的比分一律抹掉——
 *     与回测「每个比赛日只用更早日期的赛果」相同；06:30 那次即使同日下午场已完赛也不会进晚场的评级；
 *   - 近期加权的基准日固定为比赛日（回测同）；
 *   - 库里兜底：results_through < game_date、board_fetched_at ≤ captured_at、开赛后插不进（server/db.mjs）。
 *
 * 任何一步出问题（缺 IMP 模型、数据超过 36 小时、某队没有 total、冻结参数与代码常数不符、榜本身抛错）
 * 只跳过 rr 行，不影响 base / r22 / r0630：调用方各自 try、各自插库，每行一个保存点。
 */
import { captureDate } from './injuryShadow.mjs';
import { decisionInstant } from './injuryReport.mjs';
import { liveRosterRankings } from './liveRosterRankings.mjs';
import { gamePred } from './rosterResults.mjs';
import { restAdjust } from './lab.mjs';
import { MINUTES_SHRINK } from './impactShrink.mjs';

export const RR_VARIANTS = ['rr22', 'rr0630'];
export const RR_COLS = ['game_id', 'variant', 'params_version', 'captured_at', 'game_date', 'tipoff_utc', 'home_id', 'away_id',
  'neutral', 'rating_home', 'rating_away', 'prior_home', 'prior_away', 'hca', 'rest_pts', 'margin', 'p_home',
  'board_fetched_at', 'injuries_fetched_at', 'results_through', 'results_as_of', 'board_code', 'inputs'];

const iso = (ms) => new Date(ms).toISOString();
const isScored = (g) => Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore);

/** 喂给榜的赛程：比赛日 D（美东）当天及之后的比分抹掉，榜只能看到更早日期的赛果 */
export function pregameStore(store, D) {
  const games = (store.schedule?.games ?? []).map((g) => (g.date >= D && (g.homeScore != null || g.awayScore != null)
    ? { ...g, homeScore: null, awayScore: null } : g));
  return { ...store, schedule: { ...store.schedule, games } };
}

/** 冻结参数里的 IMP 收缩常数要与代码一致，否则榜已不是预注册的那一版 */
const shrinkMatches = (params) => params.impShrink?.minutes?.k === MINUTES_SHRINK.k
  && params.impShrink?.minutes?.pivot === MINUTES_SHRINK.pivot;

/**
 * 比赛日 D 的赛前榜。store 至少含 teams / players / schedule / meta / injuries / impactModel；
 * legacy = powerRankings(...) 的行（榜只用它的 teamId 与 legacyTotal，不影响 total）。
 * 返回 { ok: true, byTeam: Map(teamId → { total, priorTotal, games, effectiveGames, priorWeight }), fetchedAt, ... }
 * 或 { ok: false, reason }
 */
export function rrBoard({ store, legacy, D, params, now }) {
  try {
    if (!shrinkMatches(params)) return { ok: false, reason: `IMP 收缩常数与冻结参数不符（代码 ${JSON.stringify(MINUTES_SHRINK)}）` };
    if (!store.impactModel) return { ok: false, reason: '缺 impact-model.json' };
    const fetchedAt = store.meta?.fetchedAt;
    if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return { ok: false, reason: '数据快照没有 fetchedAt' };
    if (Date.parse(fetchedAt) > now) return { ok: false, reason: `数据快照时间在未来：${fetchedAt}` };
    const ageH = (now - Date.parse(fetchedAt)) / 3600e3;
    if (ageH > params.maxDataAgeH) return { ok: false, reason: `数据快照已 ${ageH.toFixed(1)} 小时（> ${params.maxDataAgeH}）` };
    const pre = pregameStore(store, D);
    // 榜的近期加权基准 = (now − 4h) 的 UTC 日期；取 D 美东中午（UTC 16/17 点），基准恰为 D，与回测 asOf = 比赛日相同
    const noonEt = new Date(`${D}T17:00:00Z`);
    const rows = liveRosterRankings(pre, legacy, {
      availability: params.availability, results: { K: params.K, recency: params.recency }, homeAdv: params.homeAdv, now: noonEt,
    });
    const used = pre.schedule.games.filter((g) => g.type === 'regular' && isScored(g)).map((g) => g.date).sort();
    const byTeam = new Map();
    let asOf = null;
    for (const r of rows) {
      const res = r.rosterProjection?.results;
      if (res?.asOf) asOf = res.asOf;
      byTeam.set(r.teamId, {
        total: Number.isFinite(r.total) ? r.total : null,
        priorTotal: Number.isFinite(r.priorTotal) ? r.priorTotal : null,
        games: res?.games ?? null, effectiveGames: res?.effectiveGames ?? null, priorWeight: res?.priorWeight ?? null,
        error: r.rosterProjection?.error ?? null,
      });
    }
    if (asOf && asOf !== D) return { ok: false, reason: `近期加权基准 ${asOf} ≠ 比赛日 ${D}` };
    return {
      ok: true, byTeam, fetchedAt, asOf: asOf ?? D,
      injuryFetchedAt: store.injuries?.fetchedAt ?? null, statsFetchedAt: store.meta?.statsFetchedAt ?? null,
      resultsThrough: used.at(-1) ?? null, resultsN: used.length,
    };
  } catch (e) {
    return { ok: false, reason: `榜计算失败：${String(e.message).slice(0, 200)}` };
  }
}

/**
 * 本次运行要记的 rr 行。slate: [{ gameId, date, tipoff, homeId, awayId, neutral, restHome, restAway }]；
 * board = rrBoard(...) 的结果。返回 { rows, skipped: [{ game_id, variant, why }] }
 */
export function rrRows({ slate, slot, now, params, board, code = null }) {
  const D = captureDate(now, slot);
  const rows = []; const skipped = [];
  if (!D) return { rows, skipped };
  const at = iso(now);
  for (const g of slate) {
    const tip = Date.parse(g.tipoff);
    if (g.date !== D || !(tip > now)) continue;
    const variants = slot === '22' ? ['rr22', ...(tip <= decisionInstant(D, '0630') ? ['rr0630'] : [])] : ['rr0630'];
    const skip = (why) => variants.forEach((variant) => skipped.push({ game_id: g.gameId, variant, why }));
    if (!board?.ok) { skip(board?.reason ?? '没有榜'); continue; }
    const h = board.byTeam.get(g.homeId); const a = board.byTeam.get(g.awayId);
    if (!Number.isFinite(h?.total) || !Number.isFinite(a?.total)) {
      skip(`榜上没有 total：${[h, a].map((x) => x?.error ?? (x ? '空' : '缺队')).join(' / ')}`);
      continue;
    }
    const hca = g.neutral ? 0 : params.homeAdv;
    const restPts = (restAdjust(g.restHome ?? null) - restAdjust(g.restAway ?? null)) * params.restWeight;
    const { margin, p } = gamePred(h.total, a.total, hca, restPts, params.spreadSd);
    const side = (x) => ({ games: x.games, effectiveGames: x.effectiveGames, priorWeight: x.priorWeight });
    for (const variant of variants) {
      rows.push({
        game_id: g.gameId, variant, params_version: params.version, captured_at: at, game_date: D, tipoff_utc: iso(tip),
        home_id: g.homeId, away_id: g.awayId, neutral: g.neutral ? 1 : 0,
        rating_home: h.total, rating_away: a.total, prior_home: h.priorTotal, prior_away: a.priorTotal,
        hca, rest_pts: restPts, margin, p_home: p,
        board_fetched_at: board.fetchedAt, injuries_fetched_at: board.injuryFetchedAt,
        results_through: board.resultsThrough, results_as_of: board.asOf, board_code: code,
        inputs: JSON.stringify({
          home: side(h), away: side(a), restHome: g.restHome ?? null, restAway: g.restAway ?? null,
          resultsN: board.resultsN, statsFetchedAt: board.statsFetchedAt, paramsName: params.name,
        }),
      });
    }
  }
  return { rows, skipped };
}

export const rrAll = (db) => db.prepare('SELECT * FROM shadow_rr_predictions ORDER BY game_date, game_id, variant').all();
