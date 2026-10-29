/**
 * 已排好序的一列值 → 每行的名次（与输入一一对应）。
 *
 * 数值按「并列同名次、后面跳号」（1, 2, 2, 4）；缺值（null / undefined）不参与排名，名次为 null。
 * 非数值（例如按姓名排序）没有「并列」可言，名次就是位置。
 * 只看传进来的这些行，所以筛选、排序一变，名次跟着变。
 */
export function competitionRanks(values) {
  const out = new Array(values.length).fill(null);
  let pos = 0;
  let prev;
  let prevRank = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    pos += 1;
    if (typeof v === 'number' && prevRank !== null && v === prev) {
      out[i] = prevRank;
    } else {
      out[i] = pos;
      prevRank = pos;
    }
    prev = v;
  }
  return out;
}
