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

const get = (path, params) => fetch(`/api${path}${qs(params)}`).then(json);
const post = (path, body) => fetch(`/api${path}`, {
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
  team: (id, params) => get(`/teams/${id}`, params),
  players: (params) => get('/players', params),
  schedule: (params) => get('/schedule', params),
  rankings: (params) => get('/rankings', params),
  predict: (body) => post('/predict', body),
  simulate: (body) => post('/simulate', body),
  refresh: () => post('/refresh', {}),
};
