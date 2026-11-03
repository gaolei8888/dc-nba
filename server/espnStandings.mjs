/**
 * 本赛季联盟排名（ESPN standings，一个请求）。轻量刷新用它让 cur.confRank 跟上战绩。
 *
 * 并列怎么办：不自己判。名次就是 ESPN 的 playoffSeed，每个分区 1..n 不重复，胜率相同时的先后由 ESPN 决定
 * （看起来用了某种打破平局规则，具体规则未公开，不保证与 NBA 官方 PlayoffRank 逐位相同）。
 *
 * 只认整份：conferenceRanks 校验不过就抛错，调用方保留旧名次，不会只改一部分。
 * 校验里最要紧的是战绩必须与本次刷新算出的完全相同——名次和页面上并排显示的胜负场不能来自两份不同的战绩。
 */
import { espnHttp } from './espnClient.mjs';
import { ESPN_TO_NBA } from './oddsClient.mjs';

const STANDINGS_URL = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?level=2';
const CONFERENCE = { 'Eastern Conference': 'East', 'Western Conference': 'West' };

/** ESPN 响应 → [{ teamId, conference, seed, wins, losses }]；认不出的字段留空，由 conferenceRanks 拒绝 */
export function parseStandings(payload) {
  return (payload?.children ?? []).flatMap((c) => (c.standings?.entries ?? []).map((e) => {
    const stat = (name) => e.stats?.find((s) => s.name === name)?.value;
    return {
      teamId: ESPN_TO_NBA.get(Number(e.team?.id)) ?? null,
      conference: CONFERENCE[c.name] ?? null,
      seed: stat('playoffSeed'),
      wins: stat('wins'),
      losses: stat('losses'),
    };
  }));
}

/** 校验 standings 与球队快照一致 → Map(teamId → 名次)；任何一处不对都抛错 */
export function conferenceRanks(teams, standings) {
  const byTeam = new Map(standings.map((s) => [s.teamId, s]));
  if (standings.length !== teams.length || byTeam.size !== teams.length) {
    throw new Error(`standings ${standings.length} 行、${byTeam.size} 队，快照 ${teams.length} 队`);
  }
  for (const t of teams) {
    const s = byTeam.get(t.teamId);
    if (!s) throw new Error(`standings 缺 ${t.abbr ?? t.teamId}`);
    if (s.conference !== t.conference) throw new Error(`${t.abbr ?? t.teamId} 分区不符：${s.conference}`);
    if (s.wins !== t.cur?.wins || s.losses !== t.cur?.losses) {
      throw new Error(`${t.abbr ?? t.teamId} 战绩不符：ESPN ${s.wins}-${s.losses}，本次 ${t.cur?.wins}-${t.cur?.losses}`);
    }
  }
  for (const conference of new Set(teams.map((t) => t.conference))) {
    const rows = standings.filter((s) => s.conference === conference).sort((a, b) => a.seed - b.seed);
    rows.forEach((s, i) => {
      if (s.seed !== i + 1) throw new Error(`${conference} 种子不是 1..${rows.length}：第 ${i + 1} 行是 ${s.seed}`);
      // 交叉相乘比较准确的胜率；0 胜 0 负按 0 算
      const prev = rows[i - 1];
      if (prev && prev.wins * (s.wins + s.losses) < s.wins * (prev.wins + prev.losses)) {
        throw new Error(`${conference} 种子 ${s.seed}（${s.wins}-${s.losses}）胜率高于种子 ${prev.seed}（${prev.wins}-${prev.losses}）`);
      }
    });
  }
  return new Map(standings.map((s) => [s.teamId, s.seed]));
}

export const fetchStandings = async () => parseStandings(await espnHttp.get(STANDINGS_URL));
