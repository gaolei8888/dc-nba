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
  // 自制综合影响力指标（server/impact.mjs）
  impact: 'IMP',
  // 官方估计效率（playerestimatedmetrics，按球员贡献估计，不是在场时球队表现）
  estNetRtg: 'E-NET',
  // 防守对位与拼抢
  diffPct: 'DIFF%', dFgPct: 'D-FG%', dFga: 'D-FGA', contested: 'CONT',
  deflections: 'DEFL', charges: 'CHG', looseBalls: 'LOOSE', boxOuts: 'BOX',
  drebChancePct: 'DREB-CH%', screenAstPts: 'SC-PTS',
  // 得分方式（球场追踪摄像头）
  drives: 'DRV', drivePts: 'DRV-PTS', driveFgPct: 'DRV-FG%',
  csPts: 'C&S-PTS', csEfg: 'C&S-eFG%', puPts: 'PU-PTS', puEfg: 'PU-eFG%',
  ptsPaint: 'PITP', ptsFb: 'FBPS', pts2nd: '2ND-PTS', ptsOffTov: 'PTS-OFF-TO', pfd: 'PFD',
  // 传球控球
  potentialAst: 'POT-AST', astPtsCreated: 'AST-PTS', secondaryAst: '2ND-AST',
  touches: 'TCH', timeOfPoss: 'POSS-MIN', secPerTouch: 'SEC/TCH',
  ptsPerTouch: 'PTS/TCH', passes: 'PASS', distMiles: 'DIST',
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

/** "2025-10-27" -> "2025年10月27日 周一"：人机对赌两种模式都带年份，免得把上季回放当成今晚 */
export const fmtDateFull = (iso) => (iso ? `${iso.slice(0, 4)}年${fmtDate(iso)}` : '');

// ---- 北京时间
// 赛程的 date 是美东日期（NBA 官方口径），但这个站的读者在国内：
// 美东 10 月 27 日晚上的比赛，北京时间是 10 月 28 日上午。「今日比赛」按北京时间算。
const BJ_OFFSET_MS = 8 * 3600e3;

/** 当前北京日期 "YYYY-MM-DD" */
export const bjToday = () => new Date(Date.now() + BJ_OFFSET_MS).toISOString().slice(0, 10);

/** 比赛开打时刻（UTC 字符串）-> 北京日期 */
export const bjDateOf = (utc) => (utc ? new Date(Date.parse(utc) + BJ_OFFSET_MS).toISOString().slice(0, 10) : null);

/** 比赛开打时刻 -> 北京时间 "09:30" */
export const bjTimeOf = (utc) => (utc ? new Date(Date.parse(utc) + BJ_OFFSET_MS).toISOString().slice(11, 16) : '');

/** "YYYY-MM-DD" 加减天数 */
export const shiftDate = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
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

/**
 * 快照有多旧。
 *
 * 用于盘口这类"抓下来就不会自己更新"的数据：
 * "没有盘口"和"盘口是三周前的"是两回事，后者更危险——
 * 用户看到一条过期的线却以为是当前的。所以时间要显式写出来。
 *
 * @returns {{days:number, text:string, stale:boolean}|null}
 */
export const snapshotAge = (iso, { staleDays = 3 } = {}) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / 86400000);
  const hours = Math.floor((Date.now() - t) / 3600000);
  let text;
  if (hours < 1) text = '刚刚抓取';
  else if (hours < 24) text = `${hours} 小时前抓取`;
  else text = `${days} 天前抓取`;
  return { days, text, stale: days >= staleDays };
};
