/**
 * 博彩盘口客户端（ESPN 公开接口，无需 api key）。
 *
 * 为什么不爬博彩公司的网站：basketball-reference 的 robots.txt 明确禁止
 * GPTBot，主流博彩站点也都有反爬和地区限制。而 ESPN 自己的公开接口就带盘口，
 * 数据来自持牌博彩公司，抓取它既不越界也更稳定。
 *
 * 两个接口分工不同，这是实测出来的，不是猜的：
 *
 *   scoreboard?dates=YYYYMMDD
 *     一次拿到当天全部比赛的 eventId、两队、比分。
 *     **只有未开赛的比赛带 odds 字段**，已结束的比赛这个字段是空的。
 *     所以它只能用来取「即将进行的比赛」的实时盘口，以及取历史比赛的 eventId。
 *
 *   sports.core.api.espn.com/.../events/<id>/competitions/<id>/odds
 *     单场的盘口，历史比赛也有，且带 open/close/current 三个时点。
 *     6.8KB —— 同样内容走 site.api 的 summary 端点要 397KB，58 倍差距，
 *     抓 5000 场时这个差别决定了这件事可不可行。
 *
 * 符号约定：spread 一律是**主队**的让分，负数=主队被看好。
 * 已用客队被看好的比赛验证过（CHA @ BKN，details "CHA -4.5"，spread=+4.5）。
 * 这与我们 prediction.spread 的约定一致，可以直接相减。
 *
 * 数据源的诚实说明：ESPN 各年份的默认博彩商不一样
 * （2022-23/2023-24 是 Betfair，2024-25 起是 ESPN BET，当前是 DraftKings），
 * 不同博彩商的让分通常差 0.5 以内。我们把 provider 一起记下来，不假装是同一个源。
 */

import { espnHttp } from './espnClient.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba';

/**
 * ESPN 球队 id -> NBA 球队 id。
 * ESPN 的三字母缩写和 NBA 的不一样（GS/GSW、NY/NYK、SA/SAS、NO/NOP、UTAH/UTA、WSH/WAS），
 * 所以按 id 映射而不是按缩写。这 30 条是用两边的队名自动匹配生成后人工核对的，
 * 球队不搬家就不会变。
 */
export const ESPN_TO_NBA = new Map([
  [1, 1610612737], [2, 1610612738], [17, 1610612751], [30, 1610612766],
  [4, 1610612741], [5, 1610612739], [6, 1610612742], [7, 1610612743],
  [8, 1610612765], [9, 1610612744], [10, 1610612745], [11, 1610612754],
  [12, 1610612746], [13, 1610612747], [29, 1610612763], [14, 1610612748],
  [15, 1610612749], [16, 1610612750], [3, 1610612740], [18, 1610612752],
  [25, 1610612760], [19, 1610612753], [20, 1610612755], [21, 1610612756],
  [22, 1610612757], // POR：自动匹配漏了它（ESPN 叫 Trail Blazers，我们的队名末词是 Blazers）
  [23, 1610612758], [24, 1610612759], [28, 1610612761], [26, 1610612762],
  [27, 1610612764],
]);

const nbaId = (espnId) => ESPN_TO_NBA.get(Number(espnId)) ?? null;

// ---------------------------------------------------------------- HTTP

/**
 * 走与伤病共用的 ESPN 客户端（请求头、节奏、熔断见 politeFetch.mjs）。
 * 404 表示这场没有盘口记录，属于正常情况，返回 null。
 * before：发请求前 await 一下，给调用方叠加自己的限速/计数用。
 */
async function get(url, { before, ...opts } = {}) {
  await before?.();
  return espnHttp.get(url, { notFoundOk: true, ...opts });
}

/**
 * 宽松取数：ESPN 的盘口值有整数（-5.5）、带正号的字符串（"+4.5"）、
 * 也有带前缀的（总分写成 "o221.5"）。三种都要能吃。
 */
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

/** YYYY-MM-DD -> YYYYMMDD */
export const compactDate = (d) => String(d).replace(/-/g, '');

// ---------------------------------------------------------------- 解析

/**
 * 从一条 odds 记录里取出我们需要的字段。
 *
 * 两个端点的字段结构不一样，这里一并吃掉：
 *   core 端点：homeTeamOdds.close.pointSpread.american、homeTeamOdds.moneyLine
 *   site 端点：pointSpread.home.close.line、moneyline.home.close.odds
 * open/close/current 也不是每个年份都有（2022-23 只有顶层 spread），
 * 所以逐级回退：close -> current -> 顶层。
 */
function parseOddsItem(item) {
  if (!item) return null;
  const h = item.homeTeamOdds ?? {};
  const a = item.awayTeamOdds ?? {};

  // side='home'|'away'，when='open'|'close'|'current'
  const spreadOf = (side, when) => {
    const core = side === 'home' ? h : a;
    return numOrNull(core?.[when]?.pointSpread?.american)
      ?? numOrNull(item.pointSpread?.[side]?.[when]?.line);
  };
  const mlOf = (side, when) => {
    const core = side === 'home' ? h : a;
    return numOrNull(core?.[when]?.moneyLine?.american)
      ?? numOrNull(item.moneyline?.[side]?.[when]?.odds);
  };

  const spread = spreadOf('home', 'close') ?? spreadOf('home', 'current')
    ?? numOrNull(item.spread);
  if (spread === null) return null;

  return {
    provider: item.provider?.name ?? null,
    spread,                                        // 主队让分，负数=主队被看好
    openSpread: spreadOf('home', 'open'),
    total: numOrNull(item.overUnder)
      ?? numOrNull(item.total?.over?.close?.line),
    homeMl: numOrNull(h.moneyLine) ?? mlOf('home', 'close') ?? mlOf('home', 'current'),
    awayMl: numOrNull(a.moneyLine) ?? mlOf('away', 'close') ?? mlOf('away', 'current'),
    // 开盘价：前向账本记下来备查（不参与下注决定）
    homeMlOpen: mlOf('home', 'open'),
    awayMlOpen: mlOf('away', 'open'),
    overOdds: numOrNull(item.overOdds),
    underOdds: numOrNull(item.underOdds),
  };
}

/**
 * 多个博彩商时优先取 DraftKings，其次按 ESPN 给的 priority（跳过 in-game Live Odds）。
 * DraftKings 在 ESPN 有新旧两个 id：2025-26 起是 '100'，之前是 '40'。
 * 以前只认 '100'，旧赛季全部回退到 priority 都为 0 的第一条，结果记成了 Betfair。
 */
export function pickBook(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const pre = items.filter((i) => !/live odds/i.test(i.provider?.name ?? ''));
  return pre.find((i) => i.provider?.id === '100' || i.provider?.id === '40')
    ?? [...(pre.length ? pre : items)]
      .sort((x, y) => (x.provider?.priority ?? 99) - (y.provider?.priority ?? 99))[0];
}

// ---------------------------------------------------------------- 接口

/**
 * 抓某一天的赛程（含未开赛比赛的盘口）。
 * @param {string} date YYYY-MM-DD 或 YYYYMMDD
 */
export async function fetchScoreboard(date, httpOpts) {
  const payload = await get(`${SITE}/scoreboard?dates=${compactDate(date)}&limit=100`, httpOpts);
  const out = [];
  for (const e of payload?.events ?? []) {
    const c = e.competitions?.[0];
    if (!c) continue;
    const home = c.competitors?.find((x) => x.homeAway === 'home');
    const away = c.competitors?.find((x) => x.homeAway === 'away');
    if (!home || !away) continue;
    out.push({
      eventId: e.id,
      dateUtc: e.date,
      homeId: nbaId(home.team?.id),
      awayId: nbaId(away.team?.id),
      homeScore: numOrNull(home.score),
      awayScore: numOrNull(away.score),
      completed: !!c.status?.type?.completed,
      neutral: !!c.neutralSite,
      odds: parseOddsItem(pickBook(c.odds)),
    });
  }
  return out;
}

/**
 * 抓单场比赛的盘口（历史比赛也有）。找不到返回 null。
 */
export async function fetchEventOdds(eventId) {
  return parseOddsItem(pickBook(await fetchEventOddsItems(eventId)));
}

/** 单场全部博彩商的原始 items（多家回测与账本结算用）。没有记录返回 [] */
export async function fetchEventOddsItems(eventId, httpOpts) {
  const payload = await get(`${CORE}/events/${eventId}/competitions/${eventId}/odds`, httpOpts);
  return payload?.items ?? [];
}

/** 极简并发池：保持 n 个任务在飞 */
async function mapPool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

/** 前后挪一天：ESPN 按美东日历分天，个别晚场会与 NBA 的记法差一天 */
const shiftDate = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * 抓「还没打的比赛」的实时盘口，按我们的 gameId 归档。
 *
 * 只有未开赛的比赛 scoreboard 才带 odds，所以这里天然只覆盖未来的比赛；
 * 已结束比赛的收盘盘口走 scripts/odds-history.mjs。
 *
 * @param {Array} games data/schedule.json 的 games（会自行过滤常规赛与日期）
 * @param {object} [opts]
 * @param {string} [opts.from] 起始日期 YYYY-MM-DD，默认今天
 * @param {number} [opts.maxDays] 最多扫多少个比赛日，默认全季
 * @param {number} [opts.concurrency] 默认 4
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function fetchUpcomingOdds(games, opts = {}) {
  const {
    from = new Date().toISOString().slice(0, 10),
    maxDays = Infinity,
    concurrency = 4,
    onProgress,
  } = opts;

  const wanted = new Map();   // 日期|主队|客队 -> gameId
  const dates = new Set();
  for (const g of games) {
    if (g.type !== 'regular' || !g.homeId || !g.awayId) continue;
    if (g.date < from) continue;
    wanted.set(`${g.date}|${g.homeId}|${g.awayId}`, g.gameId);
    dates.add(g.date);
  }
  const dateList = [...dates].sort().slice(0, maxDays);
  if (!dateList.length) return { games: {}, scanned: 0, matched: 0, providers: {} };

  let scanned = 0;
  const boards = await mapPool(dateList, concurrency, async (date) => {
    try {
      const evs = await fetchScoreboard(date);
      scanned += 1;
      if (scanned % 25 === 0) onProgress?.(`  已扫 ${scanned}/${dateList.length} 个比赛日`);
      return { date, evs };
    } catch (e) {
      onProgress?.(`  ${date} 抓取失败：${String(e.message).slice(0, 70)}`);
      return { date, evs: [] };
    }
  });

  const out = {};
  const providers = {};
  for (const { date, evs } of boards) {
    for (const ev of evs) {
      if (!ev.homeId || !ev.awayId || !ev.odds) continue;
      const gameId = wanted.get(`${date}|${ev.homeId}|${ev.awayId}`)
        ?? wanted.get(`${shiftDate(date, -1)}|${ev.homeId}|${ev.awayId}`)
        ?? wanted.get(`${shiftDate(date, 1)}|${ev.homeId}|${ev.awayId}`);
      if (!gameId || out[gameId]) continue;
      out[gameId] = {
        ...ev.odds,
        homeProb: devigHomeProb(ev.odds.homeMl, ev.odds.awayMl),
        eventId: ev.eventId,
      };
      if (ev.odds.provider) providers[ev.odds.provider] = (providers[ev.odds.provider] ?? 0) + 1;
    }
  }

  return {
    games: out,
    scanned,
    matched: Object.keys(out).length,
    candidates: wanted.size,
    providers,
  };
}

/** 美式赔率 -> 隐含概率（含抽水） */
export const mlToProb = (ml) => {
  if (ml === null || ml === undefined) return null;
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
};

/**
 * 两侧美式赔率 -> 去抽水后的主队胜率。
 * 博彩公司两边的隐含概率加起来大于 1，多出来的就是抽水（vig），
 * 按比例摊掉才是市场对胜负的真实判断。
 */
export function devigHomeProb(homeMl, awayMl) {
  const h = mlToProb(homeMl);
  const a = mlToProb(awayMl);
  if (h === null || a === null || h + a <= 0) return null;
  return h / (h + a);
}
