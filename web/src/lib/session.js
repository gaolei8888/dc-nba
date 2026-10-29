/**
 * 账号会话（手机号登录后的 Bearer 令牌）。
 *
 * 令牌只在这里读写：不进日志、不进 URL；手机号只以服务端脱敏后的形式出现在 user 里。
 * 存 localStorage（与其它 /works/* 作品同源，键名带作品前缀）；读写都 try/catch，
 * 存不下（隐私模式、存储已满）时刷新后丢失，功能降级为未登录。
 */
import { ApiError } from './apiError.js';

export const SESSION_KEY = 'dc-nba:session.v1';

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* 忽略 */ }
}

/** 读出会话；格式不对或已过期（expiresAt 为 ISO 时间）即清除并返回 null */
export function loadSession(now = Date.now()) {
  let s = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    s = raw ? JSON.parse(raw) : null;
  } catch {
    s = null;
  }
  const exp = Date.parse(s?.expiresAt);
  if (!s || typeof s.token !== 'string' || !s.token || !Number.isFinite(exp) || exp <= now) {
    clearSession();
    return null;
  }
  return { token: s.token, expiresAt: s.expiresAt, user: s.user ?? null };
}

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* 存不下：本次不落盘 */ }
  return s;
}

export const authHeaders = (session) => (session?.token ? { Authorization: `Bearer ${session.token}` } : undefined);

/** 服务端已不认这个会话：401 auth.sessionInvalid，或被锁接口预告里 reason 为 session */
export function shouldDropSession(x) {
  if (x instanceof ApiError) return x.status === 401 && x.code === 'auth.sessionInvalid';
  return x?.locked === true && x.reason === 'session';
}
