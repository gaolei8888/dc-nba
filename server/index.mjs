/**
 * 本地服务：读取 data/*.json，提供数据 API 与预测/模拟接口，并托管前端构建产物。
 *   node server/index.mjs        (默认 http://localhost:5174)
 */
import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, DATA_DIR } from './nbaClient.mjs';
import * as db from './db.mjs';
import * as lab from './lab.mjs';
import {
  initPool, run as runInPool, poolAvailable, cached, clearCaches,
  cacheStats, pendingCount, sendCached,
} from './pool.mjs';
import {
  buildModel, predictGame, predictSchedule, simulateSeason, powerRankings, DEFAULT_PARAMS,
} from './predict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5174;

// ---------------------------------------------------------------- 数据加载

let store = null;
let modelCache = new Map();

function loadStore() {
  const teams = readJson('teams.json');
  const players = readJson('players.json');
  const schedule = readJson('schedule.json');
  const meta = readJson('meta.json');
  const injuries = readJson('injuries.json') ?? { players: [], counts: {}, fetchedAt: null };
  const gameday = readJson('gameday.json') ?? { season: null, games: [] };
  // 盘口是增强项：抓不到就退回纯模型，页面不能因此挂掉
  const odds = readJson('odds.json') ?? { source: 'ESPN', fetchedAt: null, games: {}, matched: 0 };
  // 影响力指标的模型与验证成绩，界面上要把它的弱点一并显示
  const impactModel = readJson('impact-model.json');
  if (!teams || !players || !schedule || !meta) {
    throw new Error('数据缺失，请先运行  npm run ingest');
  }
  store = { teams, players, schedule, meta, injuries, gameday, odds, impactModel };
  clearCaches();
  modelCache = new Map();
  console.log(`数据已加载: ${teams.length} 队 / ${players.length} 人 / ${schedule.games.length} 场 (${meta.priorSeason} → ${meta.targetSeason})`);
}

/** 参数不同 -> 不同模型，做个小缓存避免重复构建。 */
function getModel(overrides = {}) {
  const key = JSON.stringify(Object.entries(overrides).sort());
  if (!modelCache.has(key)) modelCache.set(key, buildModel(store, overrides));
  return modelCache.get(key);
}

// ---------------------------------------------------------------- 博彩盘口

/**
 * 把盘口贴到一场预测旁边。
 *
 * 盘口**不参与**模型计算，只做对照——一旦让它进模型，"和市场比谁更准"
 * 就没有意义了，而且模型会退化成盘口的复读机。
 * 回测结果也支持这个选择：模型相对盘口选边的让分命中率是 49.1%，
 * 低于 52.38% 的打平线，说明我们相对市场没有可利用的优势。
 */
function marketOf(gameId, prediction = null) {
  const o = store.odds?.games?.[gameId];
  if (!o || o.spread === null || o.spread === undefined) return null;
  const r1 = (v) => Math.round(v * 10) / 10;
  const mktMargin = -o.spread;               // 市场预期的主队净胜分
  return {
    spread: o.spread,
    openSpread: o.openSpread ?? null,
    total: o.total ?? null,
    homeMl: o.homeMl ?? null,
    awayMl: o.awayMl ?? null,
    homeProb: o.homeProb ?? null,
    provider: o.provider ?? null,
    // 盘口是快照，不会自己更新。把抓取时间带上，界面才能告诉用户这条线有多旧——
    // "没有盘口"和"盘口是三周前的"是两回事，后者更容易误导人。
    fetchedAt: store.odds?.fetchedAt ?? null,
    // 正数 = 模型比市场更看好主队
    edge: prediction ? r1(prediction.margin - mktMargin) : null,
    totalEdge: prediction && o.total !== null && o.total !== undefined
      ? r1(prediction.total - o.total)
      : null,
  };
}

/** 请求体里的 out: { teamId: [playerId] }，键会变成字符串，统一成数字键。 */
function normalizeOut(out) {
  const res = {};
  for (const [k, v] of Object.entries(out ?? {})) {
    if (Array.isArray(v) && v.length) res[Number(k)] = v.map(Number);
  }
  return res;
}

/** GET 请求里的缺阵名单以 JSON 字符串传递。 */
function outFromQuery(req) {
  if (!req.query.out) return {};
  try {
    return normalizeOut(JSON.parse(req.query.out));
  } catch {
    return {};
  }
}

function pickParams(src = {}) {
  const p = {};
  for (const k of Object.keys(DEFAULT_PARAMS)) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') p[k] = Number(src[k]);
  }
  return p;
}

// ---------------------------------------------------------------- 路由

// 常驻采样 RSS 峰值：容器 mem_limit 是硬限制，超了是被 kill 不是变慢
let peakRssMB = 0;
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1048576);
  if (mb > peakRssMB) peakRssMB = mb;
}, 5000).unref();

const app = express();

// JSON 压缩率极高（赛程 528KB → 约 60KB）。1000 在线用户下带宽是比 CPU
// 更早触顶的资源，这一行比任何计算优化都值钱。
app.use(compression({
  threshold: 1024,
  // 大响应走 sendCached 的预压缩缓存，这里不要再压一遍
  filter: (req, res) => !res.getHeader('Content-Encoding') && compression.filter(req, res),
}));

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------- 限流
//
// 公网可写接口必须限流。用固定窗口计数，简单够用；
// 目标是挡住脚本刷分，不是抗 DDoS（那是网关的事）。
const buckets = new Map();
const rateLimit = ({ windowMs = 60_000, max = 60, key = 'ip' } = {}) => (req, res, next) => {
  const id = `${key}:${req.ip}`;
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(id, b); }
  b.count += 1;
  if (b.count > max) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  next();
};
// 定期清理过期桶，避免 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 120_000).unref();

/** 需要令牌的接口 */
function requireAuth(req, res, next) {
  if (!db.isEnabled()) {
    return res.status(503).json({ error: '服务端存储不可用', reason: db.getDisabledReason() });
  }
  const auth = req.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const player = token && db.authenticate(token);
  if (!player) return res.status(401).json({ error: '令牌无效，请重新创建玩家' });
  req.player = player;
  next();
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(400).json({ error: e.message });
  }
};

app.get('/api/meta', wrap((req, res) => {
  res.json({
    ...store.meta,
    defaultParams: DEFAULT_PARAMS,
    counts: {
      teams: store.teams.length,
      players: store.players.length,
      games: store.schedule.games.length,
    },
    features: {
      leaderboard: LEADERBOARD_ON && db.isEnabled(),
      leaderboardReason: LEADERBOARD_ON
        ? db.getDisabledReason()
        : '本部署已关闭排行榜（ENABLE_LEADERBOARD=0），进度仅保存在浏览器本地',
      lottery: process.env.ENABLE_LOTTERY === '1',
    },
    injuries: {
      fetchedAt: store.injuries?.fetchedAt ?? null,
      counts: store.injuries?.counts ?? {},
      matched: store.injuries?.matched ?? 0,
    },
    odds: {
      source: store.odds?.source ?? null,
      fetchedAt: store.odds?.fetchedAt ?? null,
      games: Object.keys(store.odds?.games ?? {}).length,
      providers: store.odds?.providers ?? {},
    },
    // 影响力指标的验证成绩。**连输的那两年一起给出去**——
    // 只报好数字的指标不值得信，这一点在「对标盘口」那页已经证明过。
    impact: store.impactModel ? {
      target: store.impactModel.target,
      seasons: store.impactModel.seasons,
      validation: store.impactModel.validation,
      distribution: store.impactModel.distribution,
    } : null,
  });
}));

app.get('/api/teams', wrap((req, res) => res.json(store.teams)));

/** 伤病名单（来自 ESPN，随 ingest 一起刷新） */
app.get('/api/injuries', wrap((req, res) => res.json(store.injuries)));

/**
 * 人机对赌题库。
 * 上赛季逐日重放的结果：每场带模型赛前判断与真实比分，可立即结算。
 * ?date=YYYY-MM-DD 取某一天；不带则返回全部比赛日索引。
 */
app.get('/api/gameday', wrap((req, res) => {
  const { date } = req.query;
  const all = store.gameday.games ?? [];
  if (date) {
    return res.json({
      season: store.gameday.season,
      date,
      games: all.filter((g) => g.date === date),
    });
  }
  // 只返回日期索引，避免一次吐 1230 场
  const byDate = new Map();
  for (const g of all) byDate.set(g.date, (byDate.get(g.date) ?? 0) + 1);
  res.json({
    season: store.gameday.season,
    total: all.length,
    days: [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, n]) => ({ date: d, games: n })),
  });
}));

/** 给球员补上模型算出的缺阵边际价值（每场净胜分，负数）。 */
const withCost = (model, list) => {
  const injById = new Map((store.injuries?.players ?? []).map((i) => [i.playerId, i]));
  return list.map((p) => ({
    ...p,
    outCostPts: model.marginalCost.get(p.playerId) ?? null,
    injury: injById.get(p.playerId) ?? null,
  }));
};

app.get('/api/teams/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const team = store.teams.find((t) => t.teamId === id);
  if (!team) return res.status(404).json({ error: '球队不存在' });

  const model = getModel(pickParams(req.query));
  const out = outFromQuery(req);
  const roster = withCost(model, store.players
    .filter((p) => p.teamId === id && p.onRoster)
    .sort((a, b) => (b.min ?? 0) - (a.min ?? 0)));

  // 阵容更迭明细：新加盟的人 / 上赛季在队但已不在名单的人
  const arrivals = roster
    .filter((p) => p.priorTeamId !== id)
    .sort((a, b) => (b.totalMin ?? 0) - (a.totalMin ?? 0));
  // 转出球员按他上赛季在本队的边际贡献估值，而不是在新东家的
  const departures = store.players
    .filter((p) => p.priorTeamId === id && p.teamId !== id && p.gp > 0)
    .sort((a, b) => (b.totalMin ?? 0) - (a.totalMin ?? 0))
    .map((p) => ({ ...p, outCostPts: model.priorMarginalCost.get(p.playerId) ?? null }));
  const games = store.schedule.games.filter(
    (g) => (g.homeId === id || g.awayId === id) && g.type !== 'preseason',
  );
  res.json({
    team,
    roster,
    arrivals,
    departures,
    schedule: predictSchedule(model, games, out),
    ranking: powerRankings(model, out).find((r) => r.teamId === id),
  });
}));

app.get('/api/players', wrap(async (req, res) => {
  const { teamId, onRoster } = req.query;
  const key = `players|${teamId ?? ''}|${onRoster ?? ''}|${JSON.stringify(pickParams(req.query))}`;
  await sendCached(res, req, key, () => {
    let list = store.players;
    if (teamId) list = list.filter((p) => p.teamId === Number(teamId));
    if (onRoster === '1') list = list.filter((p) => p.onRoster);
    return withCost(getModel(pickParams(req.query)), list);
  });
}));

app.get('/api/schedule', wrap(async (req, res) => {
  const { teamId, type = 'regular', from, to, predict, limit } = req.query;
  let games = store.schedule.games;
  if (type && type !== 'all') games = games.filter((g) => g.type === type);
  if (teamId) {
    const id = Number(teamId);
    games = games.filter((g) => g.homeId === id || g.awayId === id);
  }
  if (from) games = games.filter((g) => g.date >= from);
  if (to) games = games.filter((g) => g.date <= to);
  if (limit) games = games.slice(0, Number(limit));

  if (predict === '0') return res.json({ seasonYear: store.schedule.seasonYear, games });
  const model = getModel(pickParams(req.query));
  const out = outFromQuery(req);
  // 同样的筛选 + 参数 + 缺阵名单必然产出同样的结果，缓存掉
  const key = JSON.stringify([type, teamId ?? '', from ?? '', to ?? '', limit ?? '',
    pickParams(req.query), out]);
  await sendCached(res, req, `schedule|${key}`, () => ({
    seasonYear: store.schedule.seasonYear,
    games: predictSchedule(model, games, out).map((g) => {
      const market = marketOf(g.gameId, g.prediction);
      return market ? { ...g, market } : g;
    }),
  }));
}));

// ---------------------------------------------------------------- 排行榜

/** 排行榜结果缓存：1000 在线用户下不能每次请求都跑一次全表聚合 */
let lbCache = { at: 0, key: '', data: null };
const LB_TTL = 10_000;

app.get('/api/leaderboard', wrap((req, res) => {
  if (!db.isEnabled()) {
    return res.status(503).json({ error: '服务端存储不可用', reason: db.getDisabledReason() });
  }
  const mode = req.query.mode === 'live' ? 'live' : 'practice';
  const min = Math.max(1, Math.min(200, Number(req.query.min) || 10));
  const key = `${mode}:${min}`;
  const now = Date.now();
  if (lbCache.data && lbCache.key === key && now - lbCache.at < LB_TTL) {
    return res.json({ ...lbCache.data, cached: true });
  }
  const data = {
    mode,
    min,
    counts: db.counts(),
    rows: db.leaderboard({ mode, min }),
    generatedAt: new Date().toISOString(),
  };
  lbCache = { at: now, key, data };
  res.json(data);
}));

/** 创建玩家，返回一次性令牌 */
app.post('/api/players', rateLimit({ max: 5, windowMs: 600_000 }), wrap((req, res) => {
  if (!db.isEnabled()) {
    return res.status(503).json({ error: '服务端存储不可用', reason: db.getDisabledReason() });
  }
  res.json(db.createPlayer(req.body?.name));
}));

/** 用令牌确认身份 */
app.get('/api/me', requireAuth, wrap((req, res) => {
  res.json({ ...req.player, stats: db.playerStats(req.player.id) });
}));

app.post('/api/me/name', requireAuth, rateLimit({ max: 10 }), wrap((req, res) => {
  const ok = db.renamePlayer(req.player.id, req.body?.name);
  res.json({ ok });
}));

/**
 * 同步预测。
 * 客户端只报"押哪边、多少信心"，**得分一律由服务端查真实结果自己算**——
 * 否则谁都能 POST 一个 999999 分。
 */
app.post('/api/picks', requireAuth, rateLimit({ max: 30 }), wrap((req, res) => {
  const list = Array.isArray(req.body?.picks) ? req.body.picks.slice(0, 400) : [];
  const byId = new Map((store.gameday.games ?? []).map((g) => [g.gameId, g]));

  const rows = [];
  for (const p of list) {
    const g = byId.get(String(p.gameId));
    if (!g) continue;
    const side = p.side === 'home' ? 'home' : 'away';
    const conf = Math.min(0.95, Math.max(0.5, Number(p.conf) || 0.5));
    const correct = (side === 'home') === g.homeWin;
    const pHome = side === 'home' ? conf : 1 - conf;
    const y = g.homeWin ? 1 : 0;
    rows.push({
      gameId: g.gameId,
      mode: 'practice',
      side,
      conf,
      correct,
      points: Math.round((conf - 0.5) * 200) * (correct ? 1 : -1),
      brier: (pHome - y) ** 2,
      modelCorrect: (g.modelProb >= 0.5) === g.homeWin,
      modelPoints: Math.round((Math.max(g.modelProb, 1 - g.modelProb) - 0.5) * 200)
        * (((g.modelProb >= 0.5) === g.homeWin) ? 1 : -1),
      modelBrier: (g.modelProb - y) ** 2,
    });
  }
  const inserted = rows.length ? db.savePicks(req.player.id, rows) : 0;
  lbCache = { at: 0, key: '', data: null };
  res.json({ received: list.length, inserted, stats: db.playerStats(req.player.id) });
}));

app.get('/api/rankings', wrap(async (req, res) => {
  const params = pickParams(req.query);
  const out = outFromQuery(req);
  const key = JSON.stringify([params, out]);
  res.json(await cached('rankings', key, () => powerRankings(getModel(params), out), { max: 40 }));
}));

app.post('/api/predict', wrap((req, res) => {
  const { homeId, awayId, gameId, neutral, restHome, restAway, out, params } = req.body ?? {};
  if (!homeId || !awayId) return res.status(400).json({ error: '需要 homeId 与 awayId' });
  if (Number(homeId) === Number(awayId)) return res.status(400).json({ error: '两队不能相同' });
  const model = getModel(pickParams(params));
  const prediction = predictGame(model, {
    homeId: Number(homeId),
    awayId: Number(awayId),
    gameId: gameId ?? null,
    neutral: !!neutral,
    restHome: restHome === undefined || restHome === null ? undefined : Number(restHome),
    restAway: restAway === undefined || restAway === null ? undefined : Number(restAway),
    out: normalizeOut(out),
  });
  res.json({ ...prediction, market: marketOf(gameId ?? null, prediction) });
}));

app.post('/api/simulate', wrap(async (req, res) => {
  const { sims = 2000, out, params, seed } = req.body ?? {};
  const payload = {
    params: pickParams(params),
    out: normalizeOut(out),
    sims: Math.min(Math.max(Number(sims) || 2000, 100), 20000),
    seed: Number(seed) || 20262027,
  };
  // 模拟用固定种子，同参数必然同结果——先查缓存，消除工作优于挪走工作
  const key = JSON.stringify(payload);
  const result = await cached('simulate', key, async () => {
    if (poolAvailable()) {
      try {
        return await runInPool('simulate', payload);
      } catch (e) {
        // 线程池出问题就退回主线程，功能不能因为优化而挂掉
        console.warn('线程池计算失败，退回主线程:', e.message);
      }
    }
    const t0 = Date.now();
    const r = simulateSeason(getModel(payload.params), payload);
    return { ...r, ms: Date.now() - t0, inline: true };
  }, { max: 40 });
  res.json(result);
}));

// ---------------------------------------------------------------- 模型实验室
//
// 一次重放 4920 场是 CPU 密集的（约 300ms），必须走工作线程，
// 否则并发几个请求就把事件循环卡死。结果按参数缓存。

const LAB_SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];

/** 只接受白名单参数，避免用户塞进奇怪的东西 */
const LAB_KEYS = ['wElo', 'wNet', 'k', 'homeAdv', 'spreadSd', 'restWeight', 'carryKeep', 'inSeasonElo'];
const pickLabParams = (src = {}) => {
  const p = {};
  for (const k of LAB_KEYS) {
    const v = Number(src[k]);
    if (Number.isFinite(v)) p[k] = v;
  }
  return p;
};

const runLab = async (type, payload) => {
  if (poolAvailable()) {
    try {
      return await runInPool(type, payload, { timeoutMs: 60_000 });
    } catch (e) {
      console.warn('实验室计算走线程池失败，退回主线程:', e.message);
    }
  }
  // 兜底：主线程直接算。会卡事件循环，但功能不能因优化失效
  const labData = readJson('backtest.json');
  if (!labData) throw new Error('缺少 data/backtest.json，请先运行 npm run ingest');
  const { seasons, params } = payload;
  if (type === 'labBacktest') {
    const rows = lab.replay(labData, seasons, params);
    return {
      seasons,
      summary: lab.score(rows),
      calibration: lab.calibration(rows),
      slices: lab.slices(rows),
      bySeason: seasons.map((s) => ({ season: s, ...lab.score(rows.filter((r) => r.season === s)) })),
    };
  }
  if (type === 'labMarket') {
    return lab.market(lab.replay(labData, seasons, params));
  }
  if (type === 'labMeasure') {
    return {
      homeAdvantage: lab.homeAdvantageBySeason(labData, seasons, params),
      rest: lab.restEffect(labData, seasons, params),
    };
  }
  return lab.counterfactual(labData, seasons, payload.teamId, payload.deltaPts, params);
};

app.get('/api/lab/meta', wrap((req, res) => {
  const ds = readJson('backtest.json');
  res.json({
    available: !!ds,
    seasons: LAB_SEASONS,
    allSeasons: ds ? Object.keys(ds.seasons).sort() : [],
    games: ds ? LAB_SEASONS.reduce((n, s) => n + (ds.seasons[s]?.length ?? 0), 0) : 0,
    defaults: lab.DEFAULTS,
    keys: LAB_KEYS,
    odds: {
      // 有多少场带收盘盘口，决定「对标盘口」这一页能不能用
      games: ds ? LAB_SEASONS.reduce(
        (n, s) => n + (ds.seasons[s] ?? []).filter((g) => g.o).length, 0,
      ) : 0,
      providers: ds?.odds?.providers ?? {},
      breakEven: lab.BREAK_EVEN,
    },
  });
}));

app.post('/api/lab/backtest', rateLimit({ max: 60 }), wrap(async (req, res) => {
  const seasons = (Array.isArray(req.body?.seasons) ? req.body.seasons : LAB_SEASONS)
    .filter((s) => LAB_SEASONS.includes(s));
  const params = pickLabParams(req.body?.params);
  const key = JSON.stringify([seasons, params]);
  res.json(await cached('labBacktest', key, () => runLab('labBacktest', { seasons, params }), { max: 60 }));
}));

app.post('/api/lab/measure', rateLimit({ max: 30 }), wrap(async (req, res) => {
  const seasons = (Array.isArray(req.body?.seasons) ? req.body.seasons : LAB_SEASONS)
    .filter((s) => LAB_SEASONS.includes(s));
  const params = pickLabParams(req.body?.params);
  const key = JSON.stringify([seasons, params]);
  res.json(await cached('labMeasure', key, () => runLab('labMeasure', { seasons, params }), { max: 20 }));
}));

app.post('/api/lab/market', rateLimit({ max: 30 }), wrap(async (req, res) => {
  const seasons = (Array.isArray(req.body?.seasons) ? req.body.seasons : LAB_SEASONS)
    .filter((s) => LAB_SEASONS.includes(s));
  const params = pickLabParams(req.body?.params);
  const key = JSON.stringify([seasons, params]);
  res.json(await cached('labMarket', key, () => runLab('labMarket', { seasons, params }), { max: 20 }));
}));

app.post('/api/lab/counterfactual', rateLimit({ max: 60 }), wrap(async (req, res) => {
  const seasons = (Array.isArray(req.body?.seasons) ? req.body.seasons : ['2025-26'])
    .filter((s) => LAB_SEASONS.includes(s));
  const teamId = Number(req.body?.teamId);
  const deltaPts = Math.max(-10, Math.min(10, Number(req.body?.deltaPts) || 0));
  if (!store.teams.some((t) => t.teamId === teamId)) {
    return res.status(400).json({ error: '未知球队' });
  }
  const params = pickLabParams(req.body?.params);
  const key = JSON.stringify([seasons, teamId, deltaPts, params]);
  res.json(await cached('labCf', key, () => runLab('labCounterfactual', { seasons, teamId, deltaPts, params }), { max: 80 }));
}));

/** 运行状态，方便压测和线上排查 */
app.get('/api/health', wrap((req, res) => {
  res.json({
    ok: true,
    pool: { available: poolAvailable(), pending: pendingCount() },
    caches: cacheStats(),
    db: {
      enabled: LEADERBOARD_ON && db.isEnabled(),
      writable: LEADERBOARD_ON && db.isEnabled(),
      reason: LEADERBOARD_ON ? db.getDisabledReason() : 'ENABLE_LEADERBOARD=0',
      path: process.env.DB_PATH ?? '(默认 data/app.db)',
    },
    // mem_limit 是硬限制，超了容器直接被 OOM kill 而不是变慢，
    // 所以峰值比当前值更值得盯
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    memoryPeakMB: peakRssMB,
    uptimeSec: Math.round(process.uptime()),
  });
}));

/** 触发重新抓取（会阻塞约 1 分钟）。 */
let refreshing = false;
app.post('/api/refresh', (req, res) => {
  // 这个接口无鉴权，且每次会 spawn 一个抓取进程跑约 40 秒、对外请求 stats.nba.com。
  // 本地跑无所谓，公网暴露就是三件坏事：白送的 DoS 放大器、服务器 IP 会被 NBA 限流，
  // 以及把「个人学习」变成「持续抓取并公开分发」。所以生产镜像里默认关掉
  // （ALLOW_REFRESH=0），本地不设这个变量则照常可用。
  if (process.env.ALLOW_REFRESH === '0') {
    return res.status(403).json({ error: '该部署为只读数据快照，不支持在线抓取' });
  }
  if (refreshing) return res.status(409).json({ error: '正在抓取中' });
  refreshing = true;
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'ingest.mjs')], {
    cwd: ROOT, env: process.env,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  child.on('close', (code) => {
    refreshing = false;
    if (code === 0) {
      try { loadStore(); } catch (e) { return res.status(500).json({ error: e.message }); }
      return res.json({ ok: true, log: out.slice(-2000) });
    }
    res.status(500).json({ error: '抓取失败', log: out.slice(-2000) });
  });
});

// ---------------------------------------------------------------- 静态资源

const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  /*
   * 两级缓存策略。搞错这个的后果很隐蔽：
   * index.html 里引用的是带内容哈希的资源名，一旦浏览器缓存住旧的 index.html，
   * 它就会一直去加载旧的 JS——发了新版也看不到，而且用户没有任何提示。
   *
   *  - assets/ 下的文件名本身带哈希，内容变了文件名就变，可以永久缓存
   *  - index.html 绝不能缓存，必须每次回源校验
   */
  app.use('/assets', express.static(path.join(dist, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }));
  app.use(express.static(dist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('html').send('<p>前端尚未构建。开发模式请运行 <code>npm run dev</code>，或先执行 <code>npm run build</code>。</p>');
  });
}

// 排行榜会在公网收集并存储用户数据，做成显式开关，
// 让"要不要上线"变成一条 compose 配置而不是一次代码改动
const LEADERBOARD_ON = process.env.ENABLE_LEADERBOARD !== '0';
if (LEADERBOARD_ON) db.initDb();
else console.log('排行榜已通过 ENABLE_LEADERBOARD=0 关闭，服务端不写任何用户数据');
initPool();

try {
  loadStore();
} catch (e) {
  console.error(`\n${e.message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`NBA 预测应用 API: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
