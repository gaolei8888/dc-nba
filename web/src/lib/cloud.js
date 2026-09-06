/**
 * 排行榜同步。
 *
 * 服务端可能根本没开（ENABLE_LEADERBOARD=0）或者卷没挂上，
 * 所以这里所有操作都必须能安静地失败——本地游戏不能因为云端不可用而玩不了。
 *
 * 身份是一个随机令牌，创建时由服务端下发、只返回一次，存在本地档案里。
 * 没有密码，也就没有找回流程：令牌丢了就是一个新玩家。
 * 这是刻意的取舍，理由见 profiles.js 顶部。
 */
import { api } from './api.js';

/** 云端不可用时统一走这个，调用方不需要到处 try/catch */
const quiet = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

export const createCloudPlayer = (name) => api.createPlayer(name);

export const fetchMe = (token) => quiet(() => api.me(token));

export const renameCloud = (token, name) => quiet(() => api.renameMe(token, name), null);

/**
 * 上传预测。服务端只认 gameId / side / conf 三个字段——
 * 得分它自己查真实结果算，客户端报什么都没用。
 */
export const pushPicks = (token, settled) => quiet(async () => {
  const picks = Object.values(settled ?? {})
    .map((s) => ({ gameId: s.gameId, side: s.side, conf: s.conf }))
    .filter((p) => p.gameId && p.side);
  if (!picks.length) return null;
  return api.pushPicks(token, picks);
}, null);

export const fetchLeaderboard = (params) => quiet(() => api.leaderboard(params), null);
