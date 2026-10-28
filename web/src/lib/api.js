const json = async (res) => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${res.status})`);
  }
  return res.json();
};

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

// 部署在子路径下时，API 也要带上同一个前缀（Traefik 那边再 stripPrefix 掉）。
// BASE_URL 由 vite 注入，根路径部署时就是 "/"，等价于原来的写法。
const API = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, '/');

const get = (path, params, headers) =>
  fetch(`${API}${path}${qs(params)}`, headers ? { headers } : undefined).then(json);
const post = (path, body) => fetch(`${API}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(json);

/** 把全局缺阵名单编码进 GET 查询串 */
export const withOut = (params, out) => ({
  ...params,
  out: out && Object.keys(out).length ? JSON.stringify(out) : undefined,
});

export const api = {
  meta: () => get('/meta'),
  teams: () => get('/teams'),
  injuries: () => get('/injuries'),
  gamedays: () => get('/gameday'),
  gameday: (date) => get('/gameday', { date }),
  team: (id, params) => get(`/teams/${id}`, params),
  players: (params) => get('/players', params),
  schedule: (params) => get('/schedule', params),
  predictionBoard: (params) => get('/predictions/summary', params),
  paper: () => get('/paper'),
  rankings: (params) => get('/rankings', params),
  predict: (body) => post('/predict', body),
  simulate: (body) => post('/simulate', body),
  refresh: () => post('/refresh', {}),

  // ---- 排行榜（服务端可能未启用，调用方需容错）
  createPlayer: (name) => post('/players', { name }),
  me: (token) => get('/me', null, { Authorization: `Bearer ${token}` }),
  renameMe: (token, name) => fetch(`${API}/me/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  }).then(json),
  pushPicks: (token, picks) => fetch(`${API}/picks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ picks }),
  }).then(json),
  leaderboard: (params) => get('/leaderboard', params),
  // ---- 本季实战：两种身份头都带上，服务端按部署模式认其中一个
  live: (params, headers) => get('/live', params, headers),
  livePicks: (picks, headers) => fetch(`${API}/live/picks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ picks }),
  }).then(json),

  // ---- 模型实验室
  labMeta: () => get('/lab/meta'),
  labBacktest: (body) => post('/lab/backtest', body),
  labMeasure: (body) => post('/lab/measure', body),
  labCounterfactual: (body) => post('/lab/counterfactual', body),
  labMarket: (body) => post('/lab/market', body),
};
