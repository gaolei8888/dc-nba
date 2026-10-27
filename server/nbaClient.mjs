/**
 * stats.nba.com 客户端。
 * 该站点对非浏览器请求非常敏感（Akamai 反爬）：请求头不像浏览器、发得太密，
 * 连接就会被挂起（curl 表现为 http=000）或直接 403。被拦的是「像机器人的请求」，不是 IP——
 * 同一台机器上用户自己的 Chrome 照常能打开统计页。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromeHeaders, createPoliteClient, nodeTransport } from './politeFetch.mjs';
import { chromeTransport } from './chromeTransport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');

/**
 * 请求头、节奏、cookie、上限、熔断都在 politeFetch.mjs，这里只给 stats.nba.com 的参数。
 * 一天一次 ingest 大约 70 个请求，上限按这个量级留余量；上万请求的 play-by-play 批量任务
 * 要自己用 NBA_MAX_REQUESTS / NBA_MAX_PER_DAY 放开，并承担被拦的风险。
 *
 * NBA_TRANSPORT=chrome：改走真浏览器（chromeTransport.mjs），先 sh scripts/nba-chrome.sh。
 */
export function selectTransport(env = process.env) {
  if (!env.NBA_TRANSPORT || env.NBA_TRANSPORT === 'node') return nodeTransport;
  if (env.NBA_TRANSPORT === 'chrome') return chromeTransport();
  throw new Error(`NBA_TRANSPORT 只能是 node 或 chrome，收到 ${env.NBA_TRANSPORT}`);
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const MIN_GAP_MS = env('NBA_MIN_GAP_MS', 900);

export const nbaHeaders = chromeHeaders({
  referer: 'https://www.nba.com/',
  origin: 'https://www.nba.com',
  extra: { 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' },
});

const nba = createPoliteClient({
  name: 'stats.nba.com',
  headers: nbaHeaders,
  transport: () => selectTransport(),
  gapMs: [MIN_GAP_MS, env('NBA_MAX_GAP_MS', MIN_GAP_MS * 2)],
  concurrency: Math.max(1, env('NBA_CONCURRENCY', 1)),
  maxPerRun: env('NBA_MAX_REQUESTS', 200),
  maxPerDay: env('NBA_MAX_PER_DAY', 500),
  tries: env('NBA_TRIES', 3),
  timeoutMs: env('NBA_TIMEOUT_MS', 40000),
});

// ---------------------------------------------------------------- 原始响应缓存（data/raw/nba/）

const CACHE_DIR = path.join(RAW_DIR, 'nba');
const CACHE_TTL_MS = env('NBA_CACHE_TTL_MIN', 60) * 60000;

/** 已经结束的赛季（开赛年早于当前赛季）数据不会再变，缓存永久有效。7 月起算新赛季，与 ingest 一致 */
export function seasonIsFinal(url, now = new Date()) {
  const m = /[?&]Season=(\d{4})-\d{2}/.exec(url);
  const cur = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return !!m && Number(m[1]) < cur;
}

/** 缓存够不够新：往季永远够；本季在 NBA_CACHE_TTL_MIN（默认 60 分钟）内够——失败重跑不必全抓一遍 */
export const cacheFresh = (entry, url, nowMs = Date.now()) => !!entry
  && (seasonIsFinal(url, new Date(nowMs)) || nowMs - entry.fetchedAt < CACHE_TTL_MS);

const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

/**
 * GET 一个 stats.nba.com 接口。cache: true 时先看 data/raw/nba/ 有没有够新的同 URL 响应。
 * 默认不缓存：play-by-play 之类批量脚本有自己的 data/history 缓存，再存一份原始响应只是占盘。
 *
 * 失败不再连着重试：挂起、403、非 JSON 都直接熔断整次运行（见 politeFetch.mjs），
 * 只有连接被重置、5xx 才缓几秒再试。
 */
export async function nbaGet(url, { cache = false, ...opts } = {}) {
  const file = cacheFile(url);
  if (cache) {
    let hit = null;
    try { hit = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有缓存 */ }
    if (cacheFresh(hit, url)) return hit.payload;
  }
  const payload = await nba.get(url, opts);
  if (cache) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url, fetchedAt: Date.now(), payload }));
  }
  return payload;
}

/** stats.nba.com 的 resultSets 是列式的，转成对象数组。 */
export function toRows(payload, setName) {
  const sets = payload.resultSets ?? payload.resultSet ?? [];
  const list = Array.isArray(sets) ? sets : [sets];
  const set = setName ? list.find((s) => s.name === setName) : list[0];
  if (!set) throw new Error(`结果集不存在: ${setName}`);
  return set.rowSet.map((row) =>
    Object.fromEntries(set.headers.map((h, i) => [h, row[i]])),
  );
}

/** 通用查询串：stats.nba.com 要求所有参数都出现，缺一个就 400。 */
export function statsUrl(endpoint, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v ?? '')}`)
    .join('&');
  return `https://stats.nba.com/stats/${endpoint}?${qs}`;
}

export function readJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJson(file, value) {
  const p = path.join(DATA_DIR, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
}

/**
 * 读 JSON，`.json` 与 `.json.gz` 都认，给绝对路径或相对 data/ 的路径都行。
 *
 * 为什么要这个：play-by-play 还原出的段数据一季 3.4MB、五季 17MB，
 * 但 gzip 后只有 2.4MB——压缩版才进得了仓库。而进了仓库，
 * 审阅者才能自己改参数重跑 `npm run rapm:lab`，而不是只能核对我给的数字。
 */
export function readJsonAuto(file) {
  const base = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  const plain = base.endsWith('.gz') ? base.slice(0, -3) : base;
  const gz = `${plain}.gz`;
  if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, 'utf8'));
  if (fs.existsSync(gz)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'));
  return null;
}

/** 写 gzip 压缩的 JSON，文件名自动补 `.gz` */
export function writeJsonGz(file, value) {
  const base = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  const out = base.endsWith('.gz') ? base : `${base}.gz`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }));
  return out;
}
