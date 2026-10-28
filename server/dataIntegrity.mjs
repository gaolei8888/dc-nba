/**
 * 数据完整性检查：逐季审计钱线缓存（books_<季>.json）与重放记录的对应关系。
 * 纯函数、不读文件、不发请求。
 */
import { cleanItems, US_BOOKS } from './books.mjs';
import { mlToProb } from './oddsClient.mjs';

/**
 * 异常阈值：|美式| 超过 maxAbs 视为滚球价；两边隐含概率和应在 [overroundLo, overroundHi]。
 * 依据：赛前独赢盘常见抽水 4%–8%（概率和约 1.04–1.08），所以 1.0 以下（套利般的负抽水）
 * 与 1.15 以上（真实赛前价不会这么黑）都是数据错误；赛前最悬殊的价也远不到 ±5000，
 * 实测滚球价在 ±7500～±100000。三条边界均为含边界：恰好 ±5000、概率和恰好 1.0 / 1.15 判为正常。
 */
export const ANOMALY = { maxAbs: 5000, overroundLo: 1.0, overroundHi: 1.15 };

/** 单个时点钱线 [主, 客] 的异常原因，正常返回 null */
export function priceAnomaly(ml) {
  if (!ml) return 'missing';
  if (!ml.every((a) => Number.isFinite(a) && Math.abs(a) >= 100)) return 'invalidAmerican';
  if (ml.some((a) => Math.abs(a) > ANOMALY.maxAbs)) return 'liveLike';
  const sum = mlToProb(ml[0]) + mlToProb(ml[1]);
  if (sum < ANOMALY.overroundLo) return 'overroundLow';
  if (sum > ANOMALY.overroundHi) return 'overroundHigh';
  return null;
}

/**
 * 主客判定（共享：Task 3 的时点标注与选价链复用，不得另写一份）。
 * @param {{homeId:number, awayId:number}} record  重放记录
 * @param {{home:number}|undefined} cacheEntry     books 缓存里该场（home 为 ESPN 主队的 NBA 队 id）
 * @returns {'ok'|'flipped'|'teamMismatch'|'unmatched'}
 *   ok = 与记录一致；flipped = ESPN 主队是我们的客队（钱线 [主, 客] 需对调）；
 *   teamMismatch = ESPN 主队是第三支队；unmatched = 缓存里没有这场
 */
export function homeAwayStatus(record, cacheEntry) {
  if (!cacheEntry) return 'unmatched';
  if (cacheEntry.home === record.homeId) return 'ok';
  if (cacheEntry.home === record.awayId) return 'flipped';
  return 'teamMismatch';
}

const AT = ['open', 'close', 'current'];

/** 逐季审计。只统计 US_BOOKS；覆盖率与缺失只算「匹配上」的场次（重复 gameId 只算一次） */
export function auditSeason({ season, records, cache }) {
  const audit = {
    season, games: records.length, fetched: 0, matched: 0, flipped: 0,
    teamMismatch: [], duplicateGameIds: [], duplicateEventIds: [], settlementErrors: [],
    coverage: {}, missing: { open: 0, close: 0 }, anomalies: [],
  };

  const byEvent = new Map();
  for (const [gameId, c] of Object.entries(cache ?? {})) {
    if (!c?.items?.length) continue;
    audit.fetched += 1;
    if (c.eventId != null) byEvent.set(c.eventId, [...(byEvent.get(c.eventId) ?? []), gameId]);
  }
  audit.duplicateEventIds = [...byEvent].filter(([, ids]) => ids.length > 1).map(([e]) => e);

  const seen = new Set();
  const dupIds = new Set();
  for (const r of records) {
    if (seen.has(r.gameId)) { dupIds.add(r.gameId); continue; }
    seen.add(r.gameId);
    // 结算检查放在重复守卫之后：重复的 gameId 只算一次，不重复计结算错误
    if (r.actual === 0 || r.homeWin !== (r.actual > 0)) audit.settlementErrors.push(r.gameId);

    const c = cache?.[r.gameId];
    const status = c?.items?.length ? homeAwayStatus(r, c) : 'unmatched';
    if (status === 'teamMismatch') { audit.teamMismatch.push(r.gameId); continue; }
    if (status === 'unmatched') continue;
    audit.matched += 1;
    if (status === 'flipped') audit.flipped += 1;

    const items = cleanItems(c.items).filter((it) => US_BOOKS.includes(it.book));
    for (const at of AT) {
      for (const it of items) {
        if (!it[at]) continue;
        const reason = priceAnomaly(it[at]);
        if (reason) audit.anomalies.push({ gameId: r.gameId, book: it.book, at, ml: it[at], reason });
      }
    }
    for (const it of items) {
      const cov = (audit.coverage[it.book] ??= { open: 0, close: 0, current: 0 });
      for (const at of AT) if (it[at]) cov[at] += 1;
    }
    if (!items.some((it) => it.open)) audit.missing.open += 1;
    if (!items.some((it) => it.close)) audit.missing.close += 1;
  }
  audit.duplicateGameIds = [...dupIds];
  return audit;
}
