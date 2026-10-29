// 按语言与时区的格式化：纯函数，node 可直接导入。
// 数字沿用 lib/format.js 的 toFixed 逻辑（无千分位，中英文逐字相同）；
// Intl 只用于日期、星期、月份名和复数。
import { createT } from './core.js';

export const TIMEZONES = [
  { id: 'et', iana: 'America/New_York' },
  { id: 'bj', iana: 'Asia/Shanghai' },
];

// ---- 时区（Intl 自动处理夏令时；formatter 实例缓存）
const dtfCache = new Map();
function dtf(key, locale, opts) {
  const k = `${key}|${locale}|${opts.timeZone}`;
  let f = dtfCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat(locale, opts); dtfCache.set(k, f); }
  return f;
}
function parts(ms, tz) {
  const f = dtf('p', 'en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return o;
}
const validMs = (utc) => {
  if (!utc) return null;
  const ms = Date.parse(utc);
  return Number.isFinite(ms) ? ms : null;
};

/** 开打时刻（UTC 字符串）-> 该时区的 "YYYY-MM-DD" */
export const tzDateOf = (utc, tz) => {
  const ms = validMs(utc);
  if (ms === null) return null;
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
};

/** 开打时刻 -> 该时区 24 小时 "HH:MM" */
export const tzTimeOf = (utc, tz) => {
  const ms = validMs(utc);
  if (ms === null) return '';
  const p = parts(ms, tz);
  return `${p.hour}:${p.minute}`;
};

/** 该时区当前日期 */
export const tzToday = (tz, now = Date.now()) => {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
};

/** "YYYY-MM-DD" 加减天数 */
export const shiftDate = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

// ---- 数字（与 lib/format.js 输出逐字一致）
const isNil = (v) => v === null || v === undefined || Number.isNaN(v);
const num = (v, d = 1) => (isNil(v) ? '—' : v.toFixed(d));
const pct = (v, d = 1) => (isNil(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const pct100 = (v, d = 1) => (isNil(v) ? '—' : `${v.toFixed(d)}%`);
const signed = (v, d = 1) => (isNil(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const rate = (v, d = 1) => (isNil(v) ? '—' : (v * 100).toFixed(d));
// 服务端 verdictOf 的既有格式：负号用「−」
const pctSigned = (v, d = 1) => (isNil(v) ? '—' : `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v * 100).toFixed(d)}%`);
// 小比例：大于 0 但按 1 位小数会显示成 0.0% 时写「<0.1%」，避免「0.0% 的比赛被剔除」这种自相矛盾
const pctTiny = (v, d = 1) => (isNil(v) ? '—' : v > 0 && Number((v * 100).toFixed(d)) === 0 ? `<${(10 ** -d).toFixed(d)}%` : pct(v, d));
const roi = (v, d = 1) => (isNil(v) ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(d)}%`);

export const DIV_CODES = ['Atlantic', 'Central', 'Southeast', 'Northwest', 'Pacific', 'Southwest'];

/**
 * @param {object} o
 * @param {object} o.locale    当前语言文件
 * @param {object} [o.fallback] 回退（中文）语言文件
 * @param {string} o.tz        IANA 时区
 * @param {string} [o.intl]    覆盖 locale.meta.intl
 * @param {Map|object} [o.teamById] teamId -> 球队，供 team 格式化器
 * 不依赖外部的 t：内部只为取固定文案自建一个。
 */
export function createFormat({ locale, fallback, tz, intl, teamById } = {}) {
  const loc = intl || locale?.meta?.intl || 'en-US';
  const t = createT({ dict: locale, fallback });

  const utcParts = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (!Number.isFinite(dt.getTime())) return null;
    return {
      y, m, d, dt,
      wd: dtf('wd', loc, { timeZone: 'UTC', weekday: 'short' }).format(dt),
      mon: dtf('mon', loc, { timeZone: 'UTC', month: 'short' }).format(dt),
    };
  };
  const dateWith = (key) => (iso) => {
    if (!iso) return '';
    const p = utcParts(iso);
    if (!p) return String(iso); // 格式不对的日期原样返回，不抛 RangeError
    const { y, m, d, wd, mon } = p;
    return t(key, { y, m, d, wd, mon });
  };
  const date = dateWith('fmt.date');
  const dateFull = dateWith('fmt.dateFull');
  const dateMD = dateWith('fmt.dateMD');
  const dateShort = (iso) => {
    if (!iso) return '';
    const [, m, d] = iso.split('-').map(Number);
    return t('fmt.dateShort', { m, d });
  };
  const month = (m) => {
    const mon = dtf('mon', loc, { timeZone: 'UTC', month: 'short' }).format(new Date(Date.UTC(2026, m - 1, 1)));
    return t('fmt.month', { m, mon });
  };

  const time = (utc) => tzTimeOf(utc, tz);
  const is24h = (() => {
    const hc = new Intl.DateTimeFormat(loc, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h23' || hc === 'h24';
  })();
  const zoneId = TIMEZONES.find((z) => z.iana === tz)?.id;
  const zoneLabel = () => (zoneId ? t(`tz.${zoneId}`) : tz);
  const timeZoned = (utc) => {
    const ms = validMs(utc);
    if (ms === null) return '';
    const shown = is24h
      ? tzTimeOf(utc, tz)
      : dtf('t12', loc, { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(ms).replace(/ /g, ' ');
    return t('fmt.timeZoned', { time: shown, zone: zoneLabel() });
  };

  const field = t('fmt.teamNameField');
  const teamName = (team) => {
    if (!team) return '—';
    return team[field] || team.full || team.abbr || '—';
  };
  const collator = new Intl.Collator(loc);
  const sortTeams = (teams) => [...teams].sort((a, b) => collator.compare(teamName(a), teamName(b)));
  const lookupTeam = (id) => (teamById instanceof Map ? teamById.get(id) : teamById?.[id]);

  const code = (prefix) => (c) => {
    const key = `${prefix}.${c}`;
    const v = t(key);
    return v === key ? c : v;
  };
  const rest = (d) => {
    if (isNil(d)) return '—';
    if (d === 0) return t('fmt.rest.b2b');
    return t('fmt.rest.days', { count: d });
  };

  const snapshotAge = (iso, { staleDays = 3, now = Date.now() } = {}) => {
    if (!iso) return null;
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return null;
    const days = Math.floor((now - ts) / 86400000);
    const hours = Math.floor((now - ts) / 3600000);
    const text = hours < 1 ? t('fmt.age.now')
      : hours < 24 ? t('fmt.age.hours', { count: hours })
        : t('fmt.age.days', { count: days });
    return { days, text, stale: days >= staleDays };
  };

  const formatters = {
    int: (v) => num(v, 0),
    fix1: (v) => num(v, 1),
    fix2: (v) => num(v, 2),
    fix3: (v) => num(v, 3),
    pct0: (v) => pct(v, 0),
    pct1: (v) => pct(v, 1),
    pctTiny1: (v) => pctTiny(v, 1),
    signed1: (v) => signed(v, 1),
    pctSigned1: (v) => pctSigned(v, 1),
    roi: (v) => roi(v, 1),
    date,
    dateFull,
    dateMD,
    team: (id) => teamName(lookupTeam(id)),
  };

  return {
    intl: loc, tz,
    num, pct, pct100, signed, rate,
    date, dateFull, dateMD, dateShort, month,
    time, timeZoned, zoneLabel,
    teamName, sortTeams,
    conf: code('team.conf'), div: code('team.div'), pos: code('team.pos'),
    DIV_CODES, rest, snapshotAge, formatters,
  };
}
