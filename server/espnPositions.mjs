/**
 * 五档位置（控卫 / 得分后卫 / 小前锋 / 大前锋 / 中锋）。
 *
 * NBA 官方数据和 ESPN 的球队阵容接口都只给三类（G / F / C），
 * ESPN fantasy 的球员列表有 defaultPositionId（1–5），一次请求就是全联盟。
 * 用 ESPN 的球员 id 不通用，和伤病一样按姓名匹配；同名的一律不匹配，宁缺勿错。
 */
import { chromeHeaders, createPoliteClient } from './politeFetch.mjs';
import { normalizeName } from './espnClient.mjs';

/** ESPN defaultPositionId → 位置代码 */
export const POS5 = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' };

/** 只有这一个请求，每天至多跑几次；单独一个客户端，不占伤病 / 比分的队列 */
const fantasyHttp = createPoliteClient({
  name: 'espn-fantasy',
  headers: {
    ...chromeHeaders({ referer: 'https://fantasy.espn.com/', origin: 'https://fantasy.espn.com' }),
    // 不带这个头只返回前 50 人；只要现役（filterActive）
    'x-fantasy-filter': JSON.stringify({ players: { filterActive: { value: true }, limit: 2000 } }),
  },
  gapMs: [300, 800],
  maxPerRun: 3,
  maxPerDay: 10,
  timeoutMs: 20000,
  backoffBaseMs: 10 * 60000,
});

/** '2026-27' → 2027（ESPN 用赛季结束的年份） */
export function fantasySeason(season) {
  const m = /^(\d{4})-\d{2}$/.exec(String(season ?? ''));
  return m ? Number(m[1]) + 1 : null;
}

/**
 * 按姓名把 ESPN 的五档位置对到我们的球员（纯函数）。
 * 两边任一方同名多人 → 该名字整体不匹配，记进 ambiguous。
 * @returns {{ byPlayerId: Record<string,string>, matched: number, unmatched: string[], ambiguous: string[] }}
 */
export function matchPositions(espnPlayers, players) {
  const espnByName = new Map();
  for (const e of espnPlayers ?? []) {
    const pos = POS5[e?.defaultPositionId];
    const key = normalizeName(e?.fullName);
    if (!pos || !key) continue;
    if (!espnByName.has(key)) espnByName.set(key, []);
    espnByName.get(key).push({ pos, team: e.proTeamId ?? 0 });
  }
  const oursByName = new Map();
  for (const p of players ?? []) {
    const key = normalizeName(p?.name);
    if (!key) continue;
    if (!oursByName.has(key)) oursByName.set(key, []);
    oursByName.get(key).push(p);
  }

  const byPlayerId = {};
  const unmatched = [];
  const ambiguous = [];
  for (const [key, ours] of oursByName) {
    const cands = espnByName.get(key);
    if (!cands) { for (const p of ours) unmatched.push(p.name); continue; }
    // 同名时只看在队的（proTeamId > 0）；还多于一个就放弃
    const pool = cands.length > 1 ? cands.filter((c) => c.team > 0) : cands;
    if (ours.length > 1 || pool.length !== 1) { for (const p of ours) ambiguous.push(p.name); continue; }
    byPlayerId[ours[0].playerId] = pool[0].pos;
  }
  return { byPlayerId, matched: Object.keys(byPlayerId).length, unmatched, ambiguous };
}

/** 抓一次全联盟五档位置并匹配。失败抛错，由调用方决定是否保留旧数据 */
export async function fetchPositions(players, season) {
  const year = fantasySeason(season);
  if (!year) throw new Error(`赛季格式不对：${season}`);
  const list = await fantasyHttp.get(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${year}/players?view=players_wl`);
  if (!Array.isArray(list)) throw new Error('ESPN fantasy 返回的不是球员列表');
  return { source: 'ESPN fantasy', season, fetchedAt: new Date().toISOString(), ...matchPositions(list, players) };
}
