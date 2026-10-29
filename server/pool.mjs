/**
 * 工作线程池 + 结果缓存。
 *
 * 两层优化，顺序有讲究：
 *  1. **先缓存**。模拟用固定随机种子，同样的参数必然得到同样的结果，
 *     所以绝大多数重复请求根本不需要计算。消除工作永远优于把工作挪走。
 *  2. **再并行**。缓存打不中的才丢给工作线程，避免卡住事件循环。
 */
import os from 'node:os';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// 压缩本身也在线程池外：zlib 的异步接口跑在 libuv 线程池，不占主线程
const gzip = promisify(zlib.gzip);
const brotli = promisify((buf, cb) => zlib.brotliCompress(buf, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
}, cb));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');

// 容器限了 512MB 内存，每个 worker 要自带一份约 1MB 的快照并解析成对象，
// 所以不按 CPU 核数无脑铺开
const SIZE = Math.max(1, Math.min(3, (os.cpus()?.length ?? 2) - 1));

const workers = [];
const idle = [];
const queue = [];
const inflight = new Map();
let seq = 0;
let broken = false;

function spawn() {
  const w = new Worker(WORKER);
  w.on('message', (msg) => {
    if (msg?.ready) { idle.push(w); drain(); return; }
    const task = inflight.get(msg.id);
    if (!task) return;
    inflight.delete(msg.id);
    if (msg.ok) task.resolve(msg.result);
    else {
      const err = new Error(msg.error);
      if (typeof msg.code === 'string') { err.code = msg.code; err.params = msg.params ?? {}; }
      task.reject(err);
    }
    idle.push(w);
    drain();
  });
  w.on('error', (e) => {
    console.error('工作线程异常，将退回主线程计算:', e.message);
    broken = true;
    // 挂掉的线程上还没回来的任务要让调用方失败，由上层回退
    for (const [id, t] of inflight) {
      if (t.worker === w) { inflight.delete(id); t.reject(e); }
    }
  });
  w.unref();
  workers.push(w);
}

function drain() {
  while (queue.length && idle.length) {
    const w = idle.pop();
    const task = queue.shift();
    task.worker = w;
    inflight.set(task.id, task);
    w.postMessage({ id: task.id, type: task.type, payload: task.payload });
  }
}

export function initPool() {
  try {
    for (let i = 0; i < SIZE; i++) spawn();
    console.log(`计算线程池已启动：${SIZE} 个工作线程`);
    return true;
  } catch (e) {
    broken = true;
    console.warn('工作线程池启动失败，将在主线程计算:', e.message);
    return false;
  }
}

export const poolAvailable = () => !broken && workers.length > 0;

/** 丢一个任务给线程池；池子不可用时抛错，由调用方回退到主线程 */
export function run(type, payload, { timeoutMs = 30_000 } = {}) {
  if (!poolAvailable()) return Promise.reject(new Error('线程池不可用'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(new Error('计算超时'));
    }, timeoutMs);
    const wrap = {
      id,
      type,
      payload,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    queue.push(wrap);
    drain();
  });
}

export const pendingCount = () => queue.length + inflight.size;

// ---------------------------------------------------------------- 结果缓存

/**
 * 带上限的 LRU。模拟结果不小（30 队 × 十几个字段），
 * 不设上限的话内存会被参数组合撑爆。
 */
class Lru {
  constructor(max = 60) { this.max = max; this.map = new Map(); }

  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  clear() { this.map.clear(); }
}

const caches = new Map();

export function cached(namespace, key, producer, { max = 60 } = {}) {
  if (!caches.has(namespace)) caches.set(namespace, new Lru(max));
  const lru = caches.get(namespace);
  const hit = lru.get(key);
  if (hit !== undefined) return hit;
  // 存的是 Promise，这样同一个 key 的并发请求只会真正算一次
  const p = Promise.resolve()
    .then(producer)
    .catch((e) => { lru.map.delete(key); throw e; });
  lru.set(key, p);
  return p;
}

/**
 * 预压缩缓存：大响应内容固定，没必要每个请求重压一遍。
 * 直接把 br / gzip 后的 Buffer 存下来，命中时零 CPU 开销。
 */
const encoded = new Lru(24);

export async function sendCached(res, req, key, produce) {
  const accept = String(req.get('accept-encoding') ?? '');
  const enc = /br/.test(accept) ? 'br' : (/gzip/.test(accept) ? 'gzip' : 'identity');
  const ck = `${key}|${enc}`;
  let buf = encoded.get(ck);
  if (buf === undefined) {
    const json = JSON.stringify(await produce());
    const raw = Buffer.from(json, 'utf8');
    buf = enc === 'br' ? await brotli(raw) : enc === 'gzip' ? await gzip(raw) : raw;
    encoded.set(ck, buf);
  }
  res.set('Content-Type', 'application/json; charset=utf-8');
  if (enc !== 'identity') res.set('Content-Encoding', enc);
  res.vary('Accept-Encoding');
  res.end(buf);
}

export function clearCaches() {
  encoded.clear();
  for (const c of caches.values()) c.clear();
}

export function cacheStats() {
  return Object.fromEntries([...caches].map(([k, v]) => [k, v.map.size]));
}
