/**
 * 真浏览器传输（NBA_TRANSPORT=chrome）：请求不从 Node 发，而是让一个真的 Chrome
 * 在 www.nba.com/stats 页面里用 fetch 发——TLS 指纹、HTTP/2、cookie、sec-ch-ua 全是 Chrome 自己的，
 * 和用户平时手动打开统计页时发出的请求一模一样。
 *
 * 只用 Node 22 自带的 fetch / WebSocket 说 Chrome DevTools Protocol，不引 puppeteer/playwright。
 *
 * 这个 Chrome 要用专用 profile（~/.dc-nba-chrome）、按普通方式启动（不带 --enable-automation，
 * navigator.webdriver 保持 false），由 scripts/nba-chrome.sh 负责。为什么不用默认 profile：
 * Chrome ≥136 在默认 profile 上会忽略 --remote-debugging-port。端口默认 9223，
 * 因为本机日常用的 Chrome 已经占了 9222。
 */
import { BlockedError } from './politeFetch.mjs';

export const STATS_PAGE = 'https://www.nba.com/stats';

/**
 * 在页面里执行的那段 fetch。只带 x-nba-* 这类自定义头，其余的让浏览器自己填。
 * credentials 用默认的 same-origin，和 nba.com 自己的页面一样：stats.nba.com 的预检响应
 * 不给 Access-Control-Allow-Credentials，写 'include' 会被 CORS 直接拦掉（实测）。
 */
export function buildFetchExpression(url, headers, timeoutMs) {
  const custom = Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => /^x-/i.test(k)));
  return `fetch(${JSON.stringify(url)}, {headers: ${JSON.stringify(custom)}, `
    + `signal: AbortSignal.timeout(${Number(timeoutMs)})})`
    + '.then(async (r) => ({ status: r.status, text: await r.text() }))';
}

/**
 * Runtime.evaluate 的结果 -> { status, text, setCookie }。
 * 页面内 fetch 抛 TypeError（Failed to fetch）是被拦（拦截页不带 CORS 头）或 CORS 本身失败，
 * 从 JS 里分不出来，记成 status 0，上层按被拦熔断——原因去专用 Chrome 的控制台看；超时记成 code=TIMEOUT。
 */
export function parseEvalResult(r) {
  if (r?.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '';
    if (/TimeoutError|timed out/i.test(msg)) throw Object.assign(new Error(`页面内 fetch 超时：${msg.split('\n')[0]}`), { code: 'TIMEOUT' });
    if (/Failed to fetch|NetworkError/i.test(msg)) return { status: 0, text: msg, setCookie: [] };
    throw new Error(`页面内执行出错：${msg.split('\n')[0]}`);
  }
  const v = r?.result?.value;
  if (!v || typeof v.status !== 'number') throw new Error('页面内 fetch 没有返回预期的结果');
  return { status: v.status, text: v.text, setCookie: [] };
}

/** 最小 CDP 会话：send(method, params) -> result；waitEvent(name, ms) */
export function openCdp(wsUrl, WebSocketImpl = globalThis.WebSocket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of pending.values()) p.reject(new Error('与 Chrome 的连接断了'));
      pending.clear();
    });
    ws.addEventListener('error', () => reject(new Error(`连不上 Chrome 的调试连接 ${wsUrl}`)));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej, method }); });
      },
      waitEvent(method, ms) {
        return new Promise((res) => {
          const done = (v) => { clearTimeout(t); listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== done)); res(v); };
          const t = setTimeout(() => done(null), ms);
          listeners.set(method, [...(listeners.get(method) ?? []), done]);
        });
      },
      close: () => ws.close(),
    }));
  });
}

/**
 * @returns 和 nodeTransport 同形的 { request(url, {headers, timeoutMs}) }。
 * 第一次请求时连上 Chrome、把标签页重新加载一次统计页（预热：拿 cookie、确认没被 403），
 * 之后整次运行都复用这个标签页。
 */
export function chromeTransport({
  port = Number(process.env.NBA_CHROME_PORT ?? 9223),
  pageUrl = STATS_PAGE,
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  log = (m) => console.log(m),
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  let session = null;
  let warmed = false;
  let idle = null;
  let busy = 0;

  async function connect() {
    let tabs;
    try {
      tabs = await (await fetchImpl(`${base}/json/list`)).json();
    } catch {
      throw new Error(`NBA_TRANSPORT=chrome，但连不上专用 Chrome（${base}）。`
        + '先运行 sh scripts/nba-chrome.sh 启动它（窗口别关），再重跑。');
    }
    const tab = tabs.find((t) => t.type === 'page' && /^https:\/\/www\.nba\.com/.test(t.url))
      ?? await (await fetchImpl(`${base}/json/new?${pageUrl}`, { method: 'PUT' })).json();
    const cdp = await openCdp(tab.webSocketDebuggerUrl, WebSocketImpl);
    if (warmed) return cdp;
    await cdp.send('Page.enable');
    const loaded = cdp.waitEvent('Page.loadEventFired', 45000);
    await cdp.send('Page.navigate', { url: pageUrl });
    await loaded;
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: '({ title: document.title, url: location.href, webdriver: navigator.webdriver })', returnByValue: true,
    });
    const page = result?.value ?? {};
    if (/access denied|forbidden|403/i.test(page.title ?? '')) {
      cdp.close();
      throw new BlockedError(`专用 Chrome 打开 ${pageUrl} 也被拦了（标题「${page.title}」）——这不是请求头的问题`);
    }
    log(`· 浏览器传输：已在 ${page.url} 预热（webdriver=${page.webdriver}）`);
    warmed = true;
    return cdp;
  }

  return {
    async request(url, { headers, timeoutMs }) {
      session ??= connect().catch((e) => { session = null; throw e; });
      clearTimeout(idle);
      busy += 1;
      let cdp;
      try {
        cdp = await session;
        return parseEvalResult(await cdp.send('Runtime.evaluate', {
          expression: buildFetchExpression(url, headers, timeoutMs), awaitPromise: true, returnByValue: true,
        }));
      } finally {
        // 闲置 5 秒就断开调试连接，否则它会让脚本跑完也不退出；标签页和 cookie 留在 Chrome 里，
        // 下一个请求重连时不再预热（预热每次运行只做一次）
        busy -= 1;
        if (cdp && !busy) idle = setTimeout(() => { session = null; cdp.close(); }, 5000).unref();
      }
    },
  };
}
