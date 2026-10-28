// 比赛分日：按所选时区把开打时刻归到某一天。纯函数，node 可直接导入。
// 时区只影响显示与分日，从不进入请求参数，也不改任何预测。
import { tzDateOf, tzToday, shiftDate } from '../i18n/fmt.js';

/** 一场比赛在所选时区的日期；没有（或无效的）dateTimeUtc 回退服务端的美东日期 g.date */
export const gameDay = (g, tz) => tzDateOf(g.dateTimeUtc, tz) ?? g.date;

const byTip = (a, b) => (a.dateTimeUtc ?? '').localeCompare(b.dateTimeUtc ?? '');

/** 有正式比赛的日期：去重、升序，跳过季前赛 */
export const gameDates = (games, tz) => [
  ...new Set(games.filter((g) => g.type !== 'preseason').map((g) => gameDay(g, tz))),
].sort();

/** 所选时区某天的比赛（不含季前赛），按开打时间升序 */
export const gamesOn = (games, date, tz) => games
  .filter((g) => g.type !== 'preseason' && gameDay(g, tz) === date)
  .sort(byTip);

/**
 * 取数范围。服务端 from/to 是美东日期；任一时区的某一天对应的美东日期
 * 都在 [date-1, date+1] 内，所以前后各多取一天再用 gamesOn 精确过滤。
 */
export const fetchRangeFor = (date) => ({ from: shiftDate(date, -1), to: shiftDate(date, 1) });

/** 按所选时区的日期分组（赛程页要能看季前赛，所以不过滤类型）：[[日期, 比赛[]], ...]，日期升序，组内按开打时间升序 */
export function groupByDay(games, tz) {
  const map = new Map();
  for (const g of games) {
    const d = gameDay(g, tz);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(g);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([d, list]) => [d, list.sort(byTip)]);
}

/**
 * 下一个比赛日：还没出比分、非季前赛、日期不早于所选时区「今天」的最早一天。
 * （与原来的「今天已开打但比分未到」口径一致：当天不会提前翻页。）
 */
export function nextGameDay(games, tz, now = Date.now()) {
  const today = tzToday(tz, now);
  let best = null;
  for (const g of games) {
    if (g.type === 'preseason' || g.homeScore != null) continue;
    const d = gameDay(g, tz);
    if (d >= today && (best === null || d < best)) best = d;
  }
  return best;
}
