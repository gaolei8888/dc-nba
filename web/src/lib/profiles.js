/**
 * 玩家档案管理。
 *
 * 身份模型：账号是可选的，不登录也能完整地玩。
 *  - 不登录：身份只是"这台浏览器上的一个本地档案"，多人各玩各的靠多档案切换，
 *    跨设备靠导出/导入存档码。
 *  - 登录（手机号 + 短信验证码，无密码）：服务端账号对应一个排行榜玩家档案，
 *    登录时由 attachAccount 把它对应到本地档案（规则见该函数）；
 *    账号档案的 cloud.account === true，cloud.token 是账号会话令牌，
 *    退出登录时 detachAccount 去掉这些 cloud，本地档案与游戏存档保留。
 *  会话令牌本身的存取见 session.js；这里只在账号档案的 cloud 里留一份，
 *  让排行榜接口沿用原有的 cloud.token 取身份（服务端认会话令牌兼作玩家身份）。
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

/**
 * 本地错误：带机器可读的 code（界面按 code 翻译），message 保留中文原文仅供排查。
 * errorText 见到以 err. 开头的 code 就按当前语言渲染。
 */
const codedError = (code, message, params = {}) => Object.assign(new Error(message), { code, params });

/** 首次进入时自动建一个默认档案，避免空状态；defaultName 由调用方按当前语言给（t('profiles.defaultName')） */
export function ensureProfile(state, defaultName) {
  if (state.profiles.length) {
    if (state.activeId && state.profiles.some((p) => p.id === state.activeId)) return state;
    return saveProfiles({ ...state, activeId: state.profiles[0].id });
  }
  const p = { id: newId(), name: defaultName, createdAt: new Date().toISOString() };
  migrateLegacy(p.id);
  return saveProfiles({ ...state, activeId: p.id, profiles: [p] });
}

/** name 为空时用 defaultName（调用方按当前语言给）；已有档案名是用户内容，永不翻译 */
export function createProfile(state, name, defaultName) {
  const p = {
    id: newId(),
    name: (name || '').trim() || defaultName,
    createdAt: new Date().toISOString(),
  };
  return saveProfiles({ ...state, activeId: p.id, profiles: [...state.profiles, p] });
}

/** 把服务端下发的身份绑到某个本地档案上 */
export function linkCloud(state, id, cloud) {
  return saveProfiles({
    ...state,
    profiles: state.profiles.map((p) => (p.id === id ? { ...p, cloud } : p)),
  });
}

/**
 * 登录成功后把服务端账号的玩家档案对应到本地档案：
 *  1. 本机已有 cloud.playerId 相同的档案 → 换上会话令牌、标 account，并切过去；
 *  2. 否则当前档案没有 cloud（或绑的就是该玩家）→ 绑到当前档案；
 *  3. 否则（当前档案绑着别的玩家）→ 新建本地档案（名取账号档案名）绑上并切过去，
 *     本机原有的匿名档案原样保留，不并入。
 * player 为 null（账号还没有玩家档案）→ 原样返回。
 */
export function attachAccount(state, { player, token }) {
  if (!player) return state;
  const cloud = { playerId: player.id, token, name: player.name, account: true };
  const same = state.profiles.find((p) => p.cloud?.playerId === player.id);
  if (same) return switchProfile(linkCloud(state, same.id, cloud), same.id);
  const cur = state.profiles.find((p) => p.id === state.activeId);
  if (cur && !cur.cloud) return linkCloud(state, cur.id, cloud);
  const made = createProfile(state, player.name, player.name);
  return linkCloud(made, made.activeId, cloud);
}

/** 退出登录：去掉所有账号档案的 cloud（本地档案与存档保留，下次登录可重新对应） */
export function detachAccount(state) {
  return saveProfiles({
    ...state,
    profiles: state.profiles.map((p) => {
      if (p.cloud?.account !== true) return p;
      const { cloud, ...rest } = p;
      return rest;
    }),
  });
}

export function unlinkCloud(state, id) {
  return saveProfiles({
    ...state,
    profiles: state.profiles.map((p) => {
      if (p.id !== id) return p;
      const { cloud, ...rest } = p;
      return rest;
    }),
  });
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
    name: meta?.name ?? '', // 档案必存在；空名导入时会落到默认名
    // 刻意不导出 cloud 令牌：存档码可能被随手贴到聊天里，
    // 带着令牌等于把身份也交出去了
    games: Object.fromEntries(GAMES.map((g) => [g, read(gameKey(g, profileId), null)])),
  };
  const json = JSON.stringify(payload);
  // 先编码成 UTF-8 字节再 base64，否则中文昵称会抛异常
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

/**
 * 导入存档码，作为一个新档案落地；存档码里名字为空时用 defaultName（调用方按当前语言给）。
 * importedName(name) 给出带「导入」后缀的档案名（后缀随语言，由调用方给）；缺省只用原名。
 */
export function importProfile(state, code, importedName = (n) => n, defaultName = '') {
  let payload;
  try {
    const bin = atob(code.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw codedError('err.profileCode', 'invalid save code');
  }
  if (payload?.v !== 1 || !payload.games) throw codedError('err.profileVersion', 'unsupported save code version');

  const next = createProfile(state, importedName(payload.name || defaultName), defaultName);
  const id = next.activeId;
  for (const g of GAMES) {
    if (payload.games[g]) write(gameKey(g, id), payload.games[g]);
  }
  return next;
}
