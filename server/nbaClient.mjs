/**
 * stats.nba.com 客户端。
 * 该站点对非浏览器请求非常敏感：必须带完整的浏览器请求头，
 * 并且需要串行 + 限速 + 重试，否则连接会直接被挂起（curl 表现为 http=000）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  Connection: 'keep-alive',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局限流：最多 N 个请求在飞，且两次发起至少隔 MIN_GAP_MS，避免被限流。
//
// 默认仍是「串行 + 900ms」，跟以前完全一样——日常 ingest 只有几百个请求，
// 慢一点无所谓，稳定更重要。只有 play-by-play 那种上万请求的批量任务才
// 用 NBA_CONCURRENCY / NBA_MIN_GAP_MS 放宽，脚本里自己承担被限流的风险。
const MIN_GAP_MS = Number(process.env.NBA_MIN_GAP_MS ?? 900);
const MAX_INFLIGHT = Math.max(1, Number(process.env.NBA_CONCURRENCY ?? 1));

let inflight = 0;
let lastStart = 0;
const waiting = [];

function pump() {
  if (!waiting.length || inflight >= MAX_INFLIGHT) return;
  const gap = MIN_GAP_MS - (Date.now() - lastStart);
  if (gap > 0) { setTimeout(pump, gap); return; }
  const task = waiting.shift();
  inflight++;
  lastStart = Date.now();
  task.fn().then(task.resolve, task.reject).finally(() => {
    inflight--;
    pump();
  });
  pump();
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    pump();
  });
}

async function rawFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_TRIES = Number(process.env.NBA_TRIES ?? 5);
const DEFAULT_TIMEOUT_MS = Number(process.env.NBA_TIMEOUT_MS ?? 40000);

/**
 * 带重试的 GET。stats.nba.com 偶发挂起，重试基本都能成功。
 *
 * 但**被限流时重试是有害的**：那时每个请求都会一直挂到超时，
 * 5 次重试 × 40 秒 = 一场卡三分钟。批量任务应该用 NBA_TRIES / NBA_TIMEOUT_MS
 * 调小，让它快点失败、快点熔断。
 */
export function nbaGet(url, { tries = DEFAULT_TRIES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return enqueue(async () => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        return await rawFetch(url, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (i < tries - 1) await sleep(1500 * (i + 1));
      }
    }
    throw new Error(`请求失败 ${url}\n  ${lastErr?.message ?? lastErr}`);
  });
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
