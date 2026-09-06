/**
 * stats.nba.com 客户端。
 * 该站点对非浏览器请求非常敏感：必须带完整的浏览器请求头，
 * 并且需要串行 + 限速 + 重试，否则连接会直接被挂起（curl 表现为 http=000）。
 */
import fs from 'node:fs';
import path from 'node:path';
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

// 全局串行队列 + 最小请求间隔，避免被限流。
let queue = Promise.resolve();
let lastCall = 0;
const MIN_GAP_MS = 900;

function enqueue(fn) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
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

/** 带重试的 GET。stats.nba.com 偶发挂起，重试基本都能成功。 */
export function nbaGet(url, { tries = 5, timeoutMs = 40000 } = {}) {
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
