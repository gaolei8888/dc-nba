/**
 * 所有对外抓取共用的请求层：请求头像一个真实的 Chrome，节奏像一个人，出事就停。
 *
 * 每个站点（stats.nba.com、ESPN）各建一个客户端，各自有：
 *   - 一套和真实 macOS Chrome 一致的请求头（含 sec-ch-ua / sec-fetch-*），按站点给 Referer/Origin；
 *   - 串行队列 + 随机间隔，每 N 个请求再歇一次长的；
 *   - 本次运行内的 cookie 罐（服务器种的 cookie 下一次请求带回去，像同一个浏览器会话）；
 *   - 单次运行与单日的请求上限；
 *   - 熔断：第一次遇到 403/429、挂起超时、返回的不是 JSON，就停掉整个运行，
 *     并把「下次最早什么时候能再试」写进状态文件，跨运行指数退避。
 *     宁可今天少一份数据，也不要越抓越被封得狠。
 *
 * 诚实说明：Node 的 TLS 指纹（JA3/JA4）和 HTTP/2 设置不是 Chrome 的，请求头再像，
 * 讲究的反爬（Akamai）照样认得出来——这一层只是降低被盯上的概率，不能保证不被拦。
 * 要真正的浏览器指纹，用 stats.nba.com 的 NBA_TRANSPORT=chrome（见 chromeTransport.mjs）。
 *
 * 边界：这里只做「低频抓公开数据时别显得可疑」。**不做**代理/IP 轮换、住宅代理池、
 * 验证码破解、轮换伪造身份的 UA、指纹伪装库——那是对抗，不是礼貌，不在本项目范围内。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 和本机实际安装的 Chrome 大版本对齐；升级 Chrome 后跟着改，全站点只认这一个身份 */
export const CHROME_MAJOR = 156;
export const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

/**
 * 真实 Chrome 从 referer 所在页面发一个跨子域 fetch 时的请求头，按 Chrome 的发送顺序排。
 * Accept-Encoding 少了 zstd：Node 22 的 fetch 不一定解得开，宁可少报也别收到解不开的包。
 */
export function chromeHeaders({ referer, origin, extra = {} }) {
  return {
    'sec-ch-ua-platform': '"macOS"',
    'User-Agent': CHROME_UA,
    Accept: 'application/json, text/plain, */*',
    'sec-ch-ua': `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not)A;Brand";v="24"`,
    ...extra,
    'sec-ch-ua-mobile': '?0',
    Origin: origin,
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    Referer: referer,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    priority: 'u=1, i',
  };
}

/** [min, max] 闭区间里的随机整数 */
export const jitter = (min, max, rand = Math.random) => min + Math.floor(rand() * (max - min + 1));

/**
 * 节奏：每次返回「下一个请求前要等多少毫秒」。平时 gapMs 区间里随机，
 * 每隔 pauseEvery 个请求（也随机）再加一段 pauseMs 的长停顿——人翻页也会停下来看。
 */
export function pacer({ gapMs, pauseEvery, pauseMs, rand = Math.random }) {
  let sent = 0;
  let pauseAt = pauseEvery ? jitter(...pauseEvery, rand) : Infinity;
  return () => {
    sent += 1;
    let ms = jitter(...gapMs, rand);
    if (sent >= pauseAt) {
      ms += jitter(...pauseMs, rand);
      pauseAt += jitter(...pauseEvery, rand);
    }
    return ms;
  };
}

/** 最小 cookie 罐：只记 name=value，Max-Age=0 / 过期就删。一次运行用一个，不落盘。 */
export function cookieJar() {
  const jar = new Map();
  return {
    store(lines = []) {
      for (const line of lines) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const dead = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)
          || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < Date.now()));
        if (dead) jar.delete(name);
        else jar.set(name, pair.slice(eq + 1).trim());
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

/** 被拦 / 熔断 / 冷却中。脚本里 catch 到它应该停手，而不是换下一个继续抓 */
export class BlockedError extends Error {
  constructor(message) { super(message); this.code = 'BLOCKED'; }
}
export class CapError extends Error {
  constructor(message) { super(message); this.code = 'CAP'; }
}
const timeoutError = (ms) => Object.assign(new Error(`${ms}ms 内没有响应`), { code: 'TIMEOUT' });

/** 默认传输：Node 自带 fetch。返回 { status, text, setCookie }，超时抛 code=TIMEOUT */
export const nodeTransport = {
  async request(url, { headers, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      return { status: res.status, text: await res.text(), setCookie: res.headers.getSetCookie?.() ?? [] };
    } catch (e) {
      throw ctrl.signal.aborted ? timeoutError(timeoutMs) : e;
    } finally {
      clearTimeout(timer);
    }
  },
};

const DEFAULT_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw', 'fetch-state.json');
const DAY_MS = 86400000;

/** 状态文件是尽力而为：读坏了当空，写不了（只读容器）也不影响抓取本身 */
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeState(file, name, entry) {
  try {
    const all = readState(file);
    all[name] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
  } catch { /* 写不了就算了 */ }
}

/**
 * @param {object} cfg
 * @param {string} cfg.name 状态文件里的键，也用在报错里
 * @param {object} cfg.headers 见 chromeHeaders
 * @param {object|() => object} cfg.transport { request(url, {headers, timeoutMs}) }，可传工厂、首次请求时才建
 * @param {[number, number]} cfg.gapMs / cfg.pauseEvery / cfg.pauseMs 见 pacer
 * @param {number} cfg.maxPerRun / cfg.maxPerDay 上限，到了抛 CapError（code=CAP）
 * @param {number} cfg.backoffBaseMs 第一次熔断后冷却多久，之后每次翻倍，封顶 backoffMaxMs
 * now / sleep / rand / log / statePath 可注入，测试用
 */
export function createPoliteClient(cfg) {
  const {
    name, headers, gapMs = [900, 1800], pauseEvery = [10, 20], pauseMs = [5000, 15000],
    maxPerRun = Infinity, maxPerDay = Infinity, concurrency = 1, tries = 3, timeoutMs = 30000,
    backoffBaseMs = 30 * 60000, backoffMaxMs = DAY_MS, statePath = process.env.FETCH_STATE_FILE ?? DEFAULT_STATE,
    now = Date.now, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), rand = Math.random,
    log = (m) => console.warn(m),
  } = cfg;
  let transport = null;
  let state = null;
  let runCount = 0;
  let tripped = null;
  const jar = cookieJar();
  const nextGap = pacer({ gapMs, pauseEvery, pauseMs, rand });

  const save = () => writeState(statePath, name, state);
  const loadState = () => {
    if (state) return state;
    const s = readState(statePath)[name] ?? {};
    state = { failures: 0, nextAllowedAt: 0, day: '', dayCount: 0, ...s };
    return state;
  };

  function trip(reason) {
    const s = loadState();
    s.failures += 1;
    const wait = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (s.failures - 1));
    s.nextAllowedAt = now() + wait;
    s.lastReason = reason;
    save();
    const until = new Date(s.nextAllowedAt).toISOString();
    tripped = new BlockedError(`[${name}] 熔断：${reason}。本次运行不再请求，${Math.round(wait / 60000)} 分钟内（到 ${until}）也不再试`);
    log(`!! ${tripped.message}`);
    throw tripped;
  }

  /** 发一次请求前的关卡：熔断、冷却、上限 */
  function admit() {
    if (tripped) throw tripped;
    const s = loadState();
    if (s.nextAllowedAt > now()) {
      tripped = new BlockedError(`[${name}] 冷却中（上次：${s.lastReason ?? '?'}），到 ${new Date(s.nextAllowedAt).toISOString()} 之前不请求。`
        + `确认已解封可删 ${statePath} 里的 "${name}"`);
      throw tripped;
    }
    const day = new Date(now()).toISOString().slice(0, 10);
    if (s.day !== day) { s.day = day; s.dayCount = 0; }
    if (runCount >= maxPerRun) throw new CapError(`[${name}] 本次运行已发 ${runCount} 个请求，到上限了`);
    if (s.dayCount >= maxPerDay) throw new CapError(`[${name}] 今天已发 ${s.dayCount} 个请求，到单日上限了`);
    runCount += 1;
    s.dayCount += 1;
    save();
  }

  async function once(url, { notFoundOk, timeout }) {
    admit();
    transport ??= typeof cfg.transport === 'function' ? cfg.transport() : (cfg.transport ?? nodeTransport);
    const cookie = jar.header();
    let res;
    try {
      res = await transport.request(url, { headers: cookie ? { ...headers, Cookie: cookie } : headers, timeoutMs: timeout });
    } catch (e) {
      if (e.code === 'TIMEOUT') trip(`挂起超时（${e.message}）`);
      if (e.code === 'BLOCKED') { tripped = e; throw e; }
      throw Object.assign(e, { retry: true });   // 连接被重置之类，可以缓一缓再试
    }
    jar.store(res.setCookie);
    if (res.status === 404 && notFoundOk) return null;
    if ([0, 401, 403, 429].includes(res.status)) trip(res.status ? `HTTP ${res.status}` : '浏览器里请求失败（被拦或 CORS 不通过，详见专用 Chrome 的控制台）');
    if (res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    let json;
    try { json = JSON.parse(res.text); } catch { trip(`返回的不是 JSON（${String(res.text).slice(0, 60).replace(/\s+/g, ' ')}…）`); }
    const s = loadState();
    if (s.failures) { s.failures = 0; s.lastReason = null; save(); }
    return json;
  }

  async function withRetry(url, o) {
    let lastErr;
    for (let i = 0; i < o.tries; i++) {
      try {
        return await once(url, o);
      } catch (e) {
        lastErr = e;
        if (!e.retry || i === o.tries - 1) break;
        await sleep(jitter(3000, 8000, rand) * (i + 1));   // 冷却后再试，不连珠炮
      }
    }
    if (lastErr.code) throw lastErr;
    throw new Error(`[${name}] 请求失败 ${url}\n  ${lastErr?.message ?? lastErr}`);
  }

  // 队列：最多 concurrency 个在飞，相邻两次发起之间隔 nextGap()
  let inflight = 0;
  let nextAt = 0;
  let timer = null;
  const waiting = [];
  function pump() {
    if (!waiting.length || inflight >= concurrency) return;
    const wait = nextAt - now();
    if (wait > 0) { timer ??= setTimeout(() => { timer = null; pump(); }, wait); return; }
    const task = waiting.shift();
    inflight += 1;
    nextAt = now() + nextGap();
    task.fn().then(task.resolve, task.reject).finally(() => { inflight -= 1; pump(); });
    pump();
  }

  return {
    /** GET 一个 JSON。notFoundOk：404 返回 null 而不是报错 */
    get(url, { tries: t = tries, timeoutMs: timeout = timeoutMs, notFoundOk = false } = {}) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn: () => withRetry(url, { tries: t, timeout, notFoundOk }), resolve, reject });
        pump();
      });
    },
  };
}
