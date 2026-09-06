/**
 * 玩家档案管理。
 *
 * 为什么不做服务端账号：
 *  1. 作品部署在 /works/ 路径下，Traefik 中间件双向剥离 Cookie，
 *     传统会话用不了，只能把 token 放 localStorage，安全性反而更差。
 *  2. 服务端目前无状态、数据快照只读、容器不挂卷。加账号就要加卷，
 *     随之而来的是备份、迁移、权限一整套负担。
 *  3. 存密码是要负安全责任的，一个展示作品不值得。
 *
 * 所以身份只是"这台浏览器上的一个本地档案"。多人各玩各的靠多档案切换，
 * 跨设备靠导出/导入存档码。真需要跨用户排行榜再上服务端，
 * 届时这里的 id + name 结构可以直接复用。
 */

// 与主站及其它 /works/* 作品同源，键名必须带作品前缀
const KEY = 'dc-nba:profiles.v1';

const read = (k, fallback) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch { /* 隐私模式或存储已满：本次不落盘，功能仍可用 */ }
  return v;
};

const newId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const EMPTY = { version: 1, activeId: null, profiles: [] };

/** 游戏存档按档案分键存放 */
export const gameKey = (game, profileId) => `dc-nba:${game}.v1:${profileId}`;

const GAMES = ['play', 'lottery'];
const gameKeys = (profileId) => GAMES.map((g) => gameKey(g, profileId));

export function loadProfiles() {
  const s = read(KEY, null);
  if (!s || s.version !== 1 || !Array.isArray(s.profiles)) return { ...EMPTY };
  return s;
}

export const saveProfiles = (s) => write(KEY, s);

/**
 * 一次性迁移：多档案功能之前的存档存在不带档案后缀的旧键上。
 * 把它认领给首个档案，避免升级后玩家的进度凭空消失。
 */
function migrateLegacy(profileId) {
  for (const g of GAMES) {
    const legacy = `dc-nba:${g}.v1`;
    try {
      const old = localStorage.getItem(legacy);
      if (!old) continue;
      if (!localStorage.getItem(gameKey(g, profileId))) {
        localStorage.setItem(gameKey(g, profileId), old);
      }
      localStorage.removeItem(legacy);
    } catch { /* 忽略 */ }
  }
}

/** 首次进入时自动建一个默认档案，避免空状态 */
export function ensureProfile(state) {
  if (state.profiles.length) {
    if (state.activeId && state.profiles.some((p) => p.id === state.activeId)) return state;
    return saveProfiles({ ...state, activeId: state.profiles[0].id });
  }
  const p = { id: newId(), name: '玩家 1', createdAt: new Date().toISOString() };
  migrateLegacy(p.id);
  return saveProfiles({ ...state, activeId: p.id, profiles: [p] });
}

export function createProfile(state, name) {
  const p = {
    id: newId(),
    name: (name || '').trim() || `玩家 ${state.profiles.length + 1}`,
    createdAt: new Date().toISOString(),
  };
  return saveProfiles({ ...state, activeId: p.id, profiles: [...state.profiles, p] });
}

export function renameProfile(state, id, name) {
  return saveProfiles({
    ...state,
    profiles: state.profiles.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
  });
}

export function switchProfile(state, id) {
  if (!state.profiles.some((p) => p.id === id)) return state;
  return saveProfiles({ ...state, activeId: id });
}

/** 删除档案，同时清掉它名下的所有游戏存档 */
export function deleteProfile(state, id) {
  for (const k of gameKeys(id)) {
    try { localStorage.removeItem(k); } catch { /* 忽略 */ }
  }
  const profiles = state.profiles.filter((p) => p.id !== id);
  const activeId = state.activeId === id ? (profiles[0]?.id ?? null) : state.activeId;
  return saveProfiles({ ...state, activeId, profiles });
}

// ---------------------------------------------------------------- 每档案的游戏存档

export const loadGame = (game, profileId, fallback) =>
  (profileId ? read(gameKey(game, profileId), fallback) : fallback);

export const saveGame = (game, profileId, value) =>
  (profileId ? write(gameKey(game, profileId), value) : value);

// ---------------------------------------------------------------- 存档码

/**
 * 导出为一段可复制的字符串，用来把进度带到别的设备。
 * 用 base64 只是为了避免用户手滑改坏 JSON，不是加密。
 */
export function exportProfile(profileId, profiles) {
  const meta = profiles.find((p) => p.id === profileId);
  const payload = {
    v: 1,
    name: meta?.name ?? '玩家',
    games: Object.fromEntries(GAMES.map((g) => [g, read(gameKey(g, profileId), null)])),
  };
  const json = JSON.stringify(payload);
  // 先编码成 UTF-8 字节再 base64，否则中文昵称会抛异常
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

/** 导入存档码，作为一个新档案落地 */
export function importProfile(state, code) {
  let payload;
  try {
    const bin = atob(code.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('存档码无法识别，请确认复制完整');
  }
  if (payload?.v !== 1 || !payload.games) throw new Error('存档码版本不支持');

  const next = createProfile(state, `${payload.name}（导入）`);
  const id = next.activeId;
  for (const g of GAMES) {
    if (payload.games[g]) write(gameKey(g, id), payload.games[g]);
  }
  return next;
}
