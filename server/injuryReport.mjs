/**
 * NBA 官方伤病报告（PDF）：文件名、决策时点、文本解析。纯函数，不发请求。
 *
 * 报告地址 https://ak-static.cms.nba.com/referee/injury/Injury-Report_<名>.pdf，<名> 两种写法：
 *   - 'hour'   旧版，每小时一份：2022-01-14_05PM（PDF 内标的时间是 05:30 PM）；
 *   - 'minute' 新版，每 15 分钟一份：2026-01-14_05_00PM。
 * 时间都是美东（ET）。不存在的文件 S3 回 403 + AccessDenied 的 XML，不是 404。
 *
 * 我们的两个决策时点（北京时间，换成 UTC 与美东日期无关）：
 *   - 22:00 北京 = 当天 14:00 UTC = 美东 09:00（冬令时）/ 10:00（夏令时）；
 *   - 06:30 北京 = 前一天 22:30 UTC = 美东 17:30 / 18:30。
 * 美东日期 D 的比赛：22:00 那次在 D 当天上午、06:30 那次在 D 当天傍晚（北京已是 D+1）。
 */

export const REPORT_BASE = 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_';
export const STATUSES = ['Out', 'Doubtful', 'Questionable', 'Probable', 'Available'];

/** 决策时点（UTC 毫秒）。gameDate 是美东比赛日 YYYY-MM-DD */
export const decisionInstant = (gameDate, slot) => Date.parse(`${gameDate}T${slot === '0630' ? '22:30' : '14:00'}:00Z`);

const etFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** UTC 毫秒 -> 美东 { date: 'YYYY-MM-DD', min: 当天第几分钟 } */
export function toEt(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

/**
 * 报告文件名（不含前缀与 .pdf）。min = 美东当天第几分钟（报告「标注」的时间）。
 * 旧版文件名只到小时，PDF 里标 HH:30：所以 'hour' 版要求 min % 60 === 30。
 */
export function reportName(date, min, style) {
  const h = Math.floor(min / 60); const m = min % 60;
  const h12 = pad(((h + 11) % 12) + 1); const ap = h < 12 ? 'AM' : 'PM';
  if (style === 'hour') {
    if (m !== 30) throw new Error(`旧版报告只在 :30：${date} ${min}`);
    return `${date}_${h12}${ap}`;
  }
  return `${date}_${h12}_${pad(m)}${ap}`;
}

/**
 * 决策时点之前（含）的候选报告，从近到远。style 决定步长：'hour' 每小时的 :30，'minute' 每 15 分钟。
 * 返回 [{ name, date, min }]，最多 n 个，可跨过美东午夜往前一天。
 */
export function candidates(atMs, style, n) {
  const { date, min } = toEt(atMs);
  const step = style === 'hour' ? 60 : 15;
  let m = min - (style === 'hour' ? (min + 30) % 60 : min % 15);   // 往回取整到 :30 / 15 分钟
  let d = date;
  const out = [];
  while (out.length < n) {
    if (m < 0) { m += 1440; d = shiftDate(d, -1); }
    out.push({ name: reportName(d, m, style), date: d, min: m });
    m -= step;
  }
  return out;
}

/** S3 对不存在的对象：403 + <Code>AccessDenied</Code> 的 XML。别的 403（Akamai 拦截页）不算 */
export const isS3Missing = (res) => res.status === 403 && /<Error>\s*<Code>AccessDenied<\/Code>/.test(res.text ?? '');

// 30 支球队的全名，用来认「这一行开头换了球队」
export const TEAM_NAMES = [
  'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls', 'Cleveland Cavaliers',
  'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors', 'Houston Rockets', 'Indiana Pacers',
  'LA Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Miami Heat', 'Milwaukee Bucks', 'Minnesota Timberwolves',
  'New Orleans Pelicans', 'New York Knicks', 'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns',
  'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors', 'Utah Jazz', 'Washington Wizards',
];
const TEAM_SET = new Set(TEAM_NAMES);
const STATUS_SET = new Set(STATUSES);

/**
 * 解析 `pdftotext -layout` 的输出。各列之间至少两个空格，所以按 /\s{2,}/ 切成格子：
 *   比赛日 / 开赛时间 / 对阵 / 球队 / 球员 / 状态 / 原因，前几格只在换了比赛/球队时出现（往下沿用）。
 * 原因太长会折行，球员行夹在中间——折出去的原因行没有状态格，直接跳过（原因我们不用）。
 * 「NOT YET SUBMITTED」= 这支球队这份报告还没交名单：记进 notSubmitted，不能当「没人伤」。
 * @returns {{ asOf: string|null, rows: object[], notSubmitted: object[] }}
 *   asOf 'MM/DD/YY hh:mm AM'；row: { gameDate:'YYYY-MM-DD', gameTime, matchup, team, player, status }
 */
export function parseReportText(text) {
  const asOf = /Injury Report:\s*(\d\d\/\d\d\/\d\d \d\d:\d\d [AP]M)/.exec(text)?.[1] ?? null;
  const rows = []; const notSubmitted = [];
  let gameDate = null; let gameTime = null; let matchup = null; let team = null;
  for (const raw of text.split('\n')) {
    if (/Injury Report:|^\s*Page \d+ of \d+|Game Date\s+Game Time/.test(raw)) continue;
    const cells = raw.trim().split(/\s{2,}/).filter(Boolean);
    if (!cells.length) continue;
    let i = 0;
    const md = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(cells[i]);
    if (md) { gameDate = `${md[3]}-${md[1]}-${md[2]}`; i++; }
    if (/^\d\d:\d\d \(ET\)$/.test(cells[i] ?? '')) { gameTime = cells[i]; i++; }
    if (/^[A-Z]{2,3}@[A-Z]{2,3}$/.test(cells[i] ?? '')) { matchup = cells[i]; team = null; i++; }
    if (TEAM_SET.has(cells[i])) { team = cells[i]; i++; }
    if (/NOT YET SUBMITTED/.test(raw)) {
      if (team) notSubmitted.push({ gameDate, gameTime, matchup, team });
      continue;
    }
    const si = cells.findIndex((c, k) => k > i && STATUS_SET.has(c));
    if (si !== i + 1 || !cells[i].includes(',') || !team) continue;   // 折行的原因、页眉页脚
    rows.push({ gameDate, gameTime, matchup, team, player: cells[i], status: cells[si] });
  }
  return { asOf, rows, notSubmitted };
}

/** 报告里的 'Last, First Jr.' -> 'First Last Jr.'（再交给 normalizeName） */
export const flipName = (s) => {
  const k = s.indexOf(',');
  return k < 0 ? s.trim() : `${s.slice(k + 1).trim()} ${s.slice(0, k).trim()}`.trim();
};
