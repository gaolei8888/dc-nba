/**
 * 本地服务：读取 data/*.json，提供数据 API 与预测/模拟接口，并托管前端构建产物。
 *   node server/index.mjs        (默认 http://localhost:5174)
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, DATA_DIR } from './nbaClient.mjs';
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
  if (!teams || !players || !schedule || !meta) {
    throw new Error('数据缺失，请先运行  npm run ingest');
  }
  store = { teams, players, schedule, meta, injuries };
  modelCache = new Map();
  console.log(`数据已加载: ${teams.length} 队 / ${players.length} 人 / ${schedule.games.length} 场 (${meta.priorSeason} → ${meta.targetSeason})`);
}

/** 参数不同 -> 不同模型，做个小缓存避免重复构建。 */
function getModel(overrides = {}) {
  const key = JSON.stringify(Object.entries(overrides).sort());
  if (!modelCache.has(key)) modelCache.set(key, buildModel(store, overrides));
  return modelCache.get(key);
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

const app = express();
app.use(express.json({ limit: '2mb' }));

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
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
    injuries: {
      fetchedAt: store.injuries?.fetchedAt ?? null,
      counts: store.injuries?.counts ?? {},
      matched: store.injuries?.matched ?? 0,
    },
  });
}));

app.get('/api/teams', wrap((req, res) => res.json(store.teams)));

/** 伤病名单（来自 ESPN，随 ingest 一起刷新） */
app.get('/api/injuries', wrap((req, res) => res.json(store.injuries)));

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

app.get('/api/players', wrap((req, res) => {
  const { teamId, onRoster } = req.query;
  let list = store.players;
  if (teamId) list = list.filter((p) => p.teamId === Number(teamId));
  if (onRoster === '1') list = list.filter((p) => p.onRoster);
  res.json(withCost(getModel(pickParams(req.query)), list));
}));

app.get('/api/schedule', wrap((req, res) => {
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
  res.json({
    seasonYear: store.schedule.seasonYear,
    games: predictSchedule(model, games, outFromQuery(req)),
  });
}));

app.get('/api/rankings', wrap((req, res) => {
  res.json(powerRankings(getModel(pickParams(req.query)), outFromQuery(req)));
}));

app.post('/api/predict', wrap((req, res) => {
  const { homeId, awayId, gameId, neutral, restHome, restAway, out, params } = req.body ?? {};
  if (!homeId || !awayId) return res.status(400).json({ error: '需要 homeId 与 awayId' });
  if (Number(homeId) === Number(awayId)) return res.status(400).json({ error: '两队不能相同' });
  const model = getModel(pickParams(params));
  res.json(predictGame(model, {
    homeId: Number(homeId),
    awayId: Number(awayId),
    gameId: gameId ?? null,
    neutral: !!neutral,
    restHome: restHome === undefined || restHome === null ? undefined : Number(restHome),
    restAway: restAway === undefined || restAway === null ? undefined : Number(restAway),
    out: normalizeOut(out),
  }));
}));

app.post('/api/simulate', wrap((req, res) => {
  const { sims = 2000, out, params, seed } = req.body ?? {};
  const model = getModel(pickParams(params));
  const t0 = Date.now();
  const result = simulateSeason(model, {
    sims: Math.min(Math.max(Number(sims) || 2000, 100), 20000),
    out: normalizeOut(out),
    seed: Number(seed) || 20262027,
  });
  res.json({ ...result, ms: Date.now() - t0 });
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
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('html').send('<p>前端尚未构建。开发模式请运行 <code>npm run dev</code>，或先执行 <code>npm run build</code>。</p>');
  });
}

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
