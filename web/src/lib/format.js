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

// shiftDate 已移到 i18n/fmt.js，这里保留导出给 Dashboard
export { shiftDate } from '../i18n/fmt.js';

export const fmtDateShort = (iso) => {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
};

export const monthOf = (iso) => (iso ? Number(iso.split('-')[1]) : 0);

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
