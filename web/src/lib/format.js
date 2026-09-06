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

/**
 * 数据项的英文缩写。NBA 的这套缩写是通用语言，看数据的人基本都认，
 * 所以界面上以缩写为主、中文为辅。集中放一份，避免各页各写一套。
 */
export const ABBR = {
  // 基础
  gp: 'GP', min: 'MIN', pts: 'PTS', reb: 'REB', ast: 'AST',
  stl: 'STL', blk: 'BLK', tov: 'TOV', pf: 'PF',
  fgPct: 'FG%', fgm: 'FGM', fga: 'FGA',
  fg3m: '3PM', fg3a: '3PA', fg3Pct: '3P%',
  ftm: 'FTM', fta: 'FTA', ftPct: 'FT%',
  oreb: 'OREB', dreb: 'DREB', plusMinus: '+/-',
  dd2: 'DD', td3: 'TD',
  // 高阶
  pie: 'PIE', usgPct: 'USG%', tsPct: 'TS%', efgPct: 'eFG%',
  offRtg: 'ORtg', defRtg: 'DRtg', netRtg: 'NetRtg',
  astPct: 'AST%', astTo: 'AST/TO', astRatio: 'AST Ratio',
  orebPct: 'OREB%', drebPct: 'DREB%', rebPct: 'REB%',
  tovPct: 'TOV%', pace: 'PACE', poss: 'POSS',
  // 四要素与得分构成
  ftaRate: 'FTr', pct3pt: '3PT%pts', pctPaint: 'PITP%', pctFastBreak: 'FB%',
  // 本项目自有
  elo: 'ELO', total: 'RTG', turnoverAdj: 'ΔROS', outCostPts: 'OUT',
};

/** 分区与赛区的中文名。球队页和总览页共用，避免各写一份走样。 */
export const CONF_CN = { East: '东部', West: '西部' };

export const DIV_CN = {
  Atlantic: '大西洋', Central: '中部', Southeast: '东南',
  Northwest: '西北', Pacific: '太平洋', Southwest: '西南',
};

/** 展示顺序：先东部三个赛区，再西部三个 */
export const DIV_ORDER = ['大西洋', '中部', '东南', '西北', '太平洋', '西南'];

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
