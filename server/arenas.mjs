/**
 * 30 座主场的静态公开信息：球馆经纬度（公开地图资料，约 0.01° 精度）与 IANA 时区。
 * 只供旅行距离 / 时差 / 高原实验使用（scripts/homecourt-fatigue-experiment.mjs），不进线上预测。
 *
 * 海拔：丹佛 Ball Arena 约 1609 米、盐湖城 Delta Center 约 1288 米，其余主场都在约 400 米以下。
 * 快船 2024-25 起迁到英格尔伍德 Intuit Dome，距原 Crypto.com Arena 约 15 公里，这里不区分。
 */
export const ARENAS = {
  ATL: { lat: 33.757, lon: -84.396, tz: 'America/New_York' },      // State Farm Arena
  BOS: { lat: 42.366, lon: -71.062, tz: 'America/New_York' },      // TD Garden
  BKN: { lat: 40.683, lon: -73.976, tz: 'America/New_York' },      // Barclays Center
  CHA: { lat: 35.225, lon: -80.839, tz: 'America/New_York' },      // Spectrum Center
  CHI: { lat: 41.881, lon: -87.674, tz: 'America/Chicago' },       // United Center
  CLE: { lat: 41.497, lon: -81.688, tz: 'America/New_York' },      // Rocket Arena
  DAL: { lat: 32.790, lon: -96.810, tz: 'America/Chicago' },       // American Airlines Center
  DEN: { lat: 39.749, lon: -105.008, tz: 'America/Denver' },       // Ball Arena
  DET: { lat: 42.341, lon: -83.055, tz: 'America/Detroit' },       // Little Caesars Arena
  GSW: { lat: 37.768, lon: -122.388, tz: 'America/Los_Angeles' },  // Chase Center
  HOU: { lat: 29.751, lon: -95.362, tz: 'America/Chicago' },       // Toyota Center
  IND: { lat: 39.764, lon: -86.156, tz: 'America/Indiana/Indianapolis' }, // Gainbridge Fieldhouse
  LAC: { lat: 34.043, lon: -118.267, tz: 'America/Los_Angeles' },  // Crypto.com Arena（见上）
  LAL: { lat: 34.043, lon: -118.267, tz: 'America/Los_Angeles' },  // Crypto.com Arena
  MEM: { lat: 35.138, lon: -90.051, tz: 'America/Chicago' },       // FedExForum
  MIA: { lat: 25.781, lon: -80.188, tz: 'America/New_York' },      // Kaseya Center
  MIL: { lat: 43.045, lon: -87.917, tz: 'America/Chicago' },       // Fiserv Forum
  MIN: { lat: 44.979, lon: -93.276, tz: 'America/Chicago' },       // Target Center
  NOP: { lat: 29.949, lon: -90.082, tz: 'America/Chicago' },       // Smoothie King Center
  NYK: { lat: 40.751, lon: -73.993, tz: 'America/New_York' },      // Madison Square Garden
  OKC: { lat: 35.463, lon: -97.515, tz: 'America/Chicago' },       // Paycom Center
  ORL: { lat: 28.539, lon: -81.384, tz: 'America/New_York' },      // Kia Center
  PHI: { lat: 39.901, lon: -75.172, tz: 'America/New_York' },      // Wells Fargo Center
  PHX: { lat: 33.446, lon: -112.071, tz: 'America/Phoenix' },      // Footprint Center（不实行夏令时）
  POR: { lat: 45.532, lon: -122.667, tz: 'America/Los_Angeles' },  // Moda Center
  SAC: { lat: 38.580, lon: -121.500, tz: 'America/Los_Angeles' },  // Golden 1 Center
  SAS: { lat: 29.427, lon: -98.438, tz: 'America/Chicago' },       // Frost Bank Center
  TOR: { lat: 43.643, lon: -79.379, tz: 'America/Toronto' },       // Scotiabank Arena
  UTA: { lat: 40.768, lon: -111.901, tz: 'America/Denver' },       // Delta Center
  WAS: { lat: 38.898, lon: -77.021, tz: 'America/New_York' },      // Capital One Arena
};

/** 高原主场 */
export const ALTITUDE = new Set(['DEN', 'UTA']);

const RAD = Math.PI / 180;
/** 大圆距离（英里） */
export function milesBetween(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

const fmts = new Map();
const offsets = new Map();
/** 某时区在某天（当地正午）的 UTC 偏移小时数，自动处理夏令时 */
export function utcOffsetHours(tz, date) {
  const key = `${tz}|${date}`;
  if (!offsets.has(key)) {
    if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }));
    const name = fmts.get(tz).formatToParts(new Date(`${date}T18:00:00Z`)).find((p) => p.type === 'timeZoneName').value;
    const m = name.match(/GMT([+-]\d+)(?::(\d+))?/);
    offsets.set(key, m ? Number(m[1]) + Math.sign(Number(m[1])) * (Number(m[2] ?? 0) / 60) : 0);
  }
  return offsets.get(key);
}
