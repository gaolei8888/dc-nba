export const pct = (v, digits = 1) =>
  (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);

export const pct100 = (v, digits = 1) =>
  (v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`);

export const num = (v, digits = 1) =>
  (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits));

/** 带正负号，用于净效率/正负值一类指标 */
export const signed = (v, digits = 1) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
};

/** 命中率类：.478 -> 47.8 */
export const rate = (v, digits = 1) =>
  (v === null || v === undefined ? '—' : (v * 100).toFixed(digits));

export const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "2026-10-20" -> "10月20日 周二" */
export const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日 ${wd}`;
};

export const fmtDateShort = (iso) => {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
};

export const monthOf = (iso) => (iso ? Number(iso.split('-')[1]) : 0);

export const MONTH_CN = {
  1: '1月', 2: '2月', 3: '3月', 4: '4月', 5: '5月',
  9: '9月', 10: '10月', 11: '11月', 12: '12月',
};

/** 休息天数描述 */
export const restLabel = (d) => {
  if (d === null || d === undefined) return '—';
  if (d === 0) return '背靠背';
  return `休${d}天`;
};

/** 胜率 -> 颜色（绿=大概率赢，红=大概率输） */
export const probColor = (p) => {
  const t = Math.max(0, Math.min(1, p));
  if (t >= 0.5) {
    const k = (t - 0.5) * 2;
    return `rgb(${Math.round(150 - 87 * k)}, ${Math.round(163 + 22 * k)}, ${Math.round(179 - 99 * k)})`;
  }
  const k = (0.5 - t) * 2;
  return `rgb(${Math.round(150 + 98 * k)}, ${Math.round(163 - 82 * k)}, ${Math.round(179 - 106 * k)})`;
};
