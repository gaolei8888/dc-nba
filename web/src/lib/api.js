import { ApiError, toApiError } from './apiError.js';
import { authHeaders, clearSession, shouldDropSession } from './session.js';

// fetch 自身失败（断网、DNS、CORS）统一成 status 0 的网络错误；其它 TypeError 不在此列
const request = (url, init) => fetch(url, init).catch(() => {
  throw new ApiError({ status: 0, code: 'err.network' });
});

const json = async (res) => {
  if (!res.ok) {
    throw await toApiError(res);
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
  request(`${API}${path}${qs(params)}`, headers ? { headers } : undefined).then(json);
const post = (path, body, headers) => request(`${API}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
}).then(json);

// 被锁接口：只带账号会话令牌（绝不带排行榜玩家令牌——服务端会把玩家令牌当匿名）。
// 会话失效（401 auth.sessionInvalid，或预告里 reason 为 session）→ 清掉本地会话，
// 让界面回到未登录；本函数不改界面，调用方通过再次读 loadSession 得知。
const locked = (path, params, token) => get(path, params, authHeaders({ token }))
  .then((d) => { if (shouldDropSession(d)) clearSession(); return d; })
  .catch((e) => { if (shouldDropSession(e)) clearSession(); throw e; });
const sessionHeaders = (token) => authHeaders({ token });

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
  predictionBoard: (params, token) => locked('/predictions/summary', params, token),
  paper: (token) => locked('/paper', null, token),
  shadow: (token) => locked('/shadow', null, token),
  rankings: (params) => get('/rankings', params),
  predict: (body) => post('/predict', body),
  simulate: (body) => post('/simulate', body),
  refresh: () => post('/refresh', {}),

  // ---- 账号（手机号 + 短信验证码）。authCode 需要图形验证时抛 ApiError(428/400)，body.captcha = { id, image }
  authCaptcha: () => post('/auth/captcha', {}),
  authCode: (body) => post('/auth/code', body),
  authVerify: (body) => post('/auth/verify', body),
  authMe: (token) => get('/auth/me', null, sessionHeaders(token)),
  authLogout: (token) => post('/auth/logout', {}, sessionHeaders(token)),
  authPrefs: (token, prefs) => post('/auth/prefs', prefs, sessionHeaders(token)),

  // ---- 排行榜（服务端可能未启用，调用方需容错）
  createPlayer: (name) => post('/players', { name }),
  me: (token) => get('/me', null, { Authorization: `Bearer ${token}` }),
  renameMe: (token, name) => request(`${API}/me/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  }).then(json),
  pushPicks: (token, picks) => request(`${API}/picks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ picks }),
  }).then(json),
  leaderboard: (params) => get('/leaderboard', params),
  // ---- 本季实战：两种身份头都带上，服务端按部署模式认其中一个
  live: (params, headers) => get('/live', params, headers),
  livePicks: (picks, headers) => request(`${API}/live/picks`, {
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
  labMoneylineMeta: () => get('/lab/moneyline/meta'),
  labMoneyline: (body) => post('/lab/moneyline', body),
};
