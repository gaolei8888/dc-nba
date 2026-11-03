/**
 * 让 scripts/ingest.mjs 完全离线地跑：node --import 这个文件，再跑 ingest。
 *
 * - 替换 fetch：任何请求都不出本进程。stats.nba.com 回一个合成的小联盟（或 OFFLINE_RAW_DIR 里的
 *   data/raw/nba 缓存），其他站点一律 404（伤病/盘口/五档位置走 ingest 自己「失败保留旧数据」的分支）。
 * - 请求数按站点写进 OFFLINE_COUNT_FILE，用来比较改动前后的请求量。
 * - 虚拟时钟 + 固定 Math.random：礼貌间隔不真的等，同样的输入逐字节产出同样的文件。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RealDate = Date;
const realSetTimeout = globalThis.setTimeout;
let clock = RealDate.parse(process.env.OFFLINE_NOW ?? '2026-11-04T07:30:00Z');

globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(clock); }
  static now() { return clock; }
};
globalThis.setTimeout = (fn, ms = 0, ...a) => realSetTimeout(() => { clock += ms; fn(...a); }, 0);
Math.random = () => 0.5;

// ---------------------------------------------------------------- 合成联盟

const set = (name, rows) => {
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { name, headers, rowSet: rows.map((r) => headers.map((h) => r[h] ?? null)) };
};
const rowsOf = (rows, name = 'Rows') => ({ resultSets: [set(name, rows)] });

const TEAMS = [[1610612737, 'ATL'], [1610612738, 'BOS'], [1610612741, 'CHI'], [1610612742, 'DAL']]
  .map(([id, abbr]) => ({ id, abbr }));

/**
 * 球员各带一种要覆盖的情形。prior / cur 是两季的场数与场均分钟，没有就是这一季没数据。
 * 球队取 TEAMS 下标；每人的统计栏由 id 确定性地算出来，有 cur 的人数值随季不同。
 */
const PLAYERS = [
  { id: 101, name: 'Star Prior', team: 0, prior: [70, 34], cur: [6, 33] },
  { id: 102, name: 'Mid Prior', team: 0, prior: [60, 26], cur: [7, 25] },
  { id: 103, name: 'Bench LowMin', team: 0, prior: [50, 15], cur: [5, 8] }, // 本季场均 < 10 分钟：只剩先验
  { id: 201, name: 'Rookie Enough', team: 1, cur: [25, 30] }, // 无先验、满 20 场
  { id: 202, name: 'Rookie Short', team: 1, cur: [6, 28] }, // 无先验、不满 20 场：null
  { id: 203, name: 'Vet Boston', team: 1, prior: [75, 31], cur: [7, 30] },
  { id: 301, name: 'Traded Guy', team: 2, curTeam: 3, prior: [66, 29], cur: [6, 28] }, // 本季统计行的队 ≠ 名单上的队
  { id: 302, name: 'No Hustle', team: 2, prior: [70, 28], cur: [6, 27], noHustle: true }, // 拼抢表里没有他
  { id: 303, name: 'Injured Vet', team: 2, prior: [72, 30] }, // 本季还没上场：不进快照
  { id: 401, name: 'Dal Starter', team: 3, prior: [78, 35], cur: [7, 36] },
  { id: 402, name: 'Dal Wing', team: 3, prior: [68, 24], cur: [6, 22] },
  { id: 403, name: 'Unrostered', team: null, curTeam: 3, cur: [3, 12] }, // 不在名单、上季没数据：进不了 players.json
];

const wave = (id, k, a, b) => a + ((id * 7 + k * 13) % 11) * (b - a) / 10;
const seasonOf = (url) => /Season=(\d{4}-\d{2})/.exec(url)?.[1];
const isCur = (url) => seasonOf(url) === (process.env.TARGET_SEASON ?? '2026-27');
const seasonRows = (url) => PLAYERS.filter((p) => (isCur(url) ? p.cur : p.prior));
const stat = (url, p, k, a, b) => Math.round(wave(p.id + (isCur(url) ? 5 : 0), k, a, b) * 10) / 10;
const playerTeam = (url, p) => TEAMS[isCur(url) ? (p.curTeam ?? p.team) : p.team];

function dashPlayers(url) {
  const measure = /MeasureType=(\w+)/.exec(url)[1];
  return rowsOf(seasonRows(url).map((p) => {
    const [gp, min] = isCur(url) ? p.cur : p.prior;
    const common = { PLAYER_ID: p.id };
    if (measure === 'Advanced') {
      return { ...common, USG_PCT: stat(url, p, 1, 15, 32) / 100, TS_PCT: stat(url, p, 2, 50, 66) / 100, PIE: 0.1, NET_RATING: 1, TM_TOV_PCT: 10 };
    }
    if (measure === 'Misc') return { ...common, PTS_PAINT: 8 };
    const t = playerTeam(url, p);
    return {
      ...common, PLAYER_NAME: p.name, TEAM_ID: t.id, TEAM_ABBREVIATION: t.abbr, AGE: 20 + (p.id % 15),
      GP: gp, W: Math.floor(gp / 2), L: Math.ceil(gp / 2), MIN: min,
      PTS: stat(url, p, 3, 6, 30), AST: stat(url, p, 4, 1, 9), TOV: stat(url, p, 5, 0.5, 4), OREB: stat(url, p, 6, 0.3, 3),
      DREB: stat(url, p, 7, 2, 9), REB: 6, STL: stat(url, p, 8, 0.3, 2), BLK: stat(url, p, 9, 0.1, 2), PF: stat(url, p, 10, 1, 4),
      FGA: stat(url, p, 11, 4, 20), FGM: 5, FG_PCT: 0.46, FG3M: 1, FG3A: 3, FTM: 2, FTA: 3,
    };
  }));
}

function ptStats(url) {
  const measure = /PtMeasureType=(\w+)/.exec(url)[1];
  if (measure !== 'Passing') return rowsOf(seasonRows(url).map((p) => ({ PLAYER_ID: p.id, TOUCHES: 40 })));
  return rowsOf(seasonRows(url).map((p) => ({ PLAYER_ID: p.id, POTENTIAL_AST: stat(url, p, 12, 2, 15) })));
}

const hustle = (url) => rowsOf(seasonRows(url).filter((p) => !p.noHustle).map((p) => ({
  PLAYER_ID: p.id, CONTESTED_SHOTS: stat(url, p, 13, 2, 10), DEFLECTIONS: stat(url, p, 14, 0.5, 4), SCREEN_AST_PTS: stat(url, p, 15, 0, 6),
})));
const defend = (url) => rowsOf(seasonRows(url).map((p) => ({
  CLOSE_DEF_PERSON_ID: p.id, D_FGA: stat(url, p, 16, 5, 15), PCT_PLUSMINUS: Math.round(wave(p.id, 17, -0.12, 0.08) * 1000) / 1000,
})));

const standings = () => rowsOf(TEAMS.map((t, i) => ({
  TeamID: t.id, TeamCity: `City${t.abbr}`, TeamName: t.abbr, Conference: i < 3 ? 'East' : 'West', Division: 'Div',
  WINS: 4 - i, LOSSES: i, WinPCT: (4 - i) / 4, PlayoffRank: i + 1, HOME: '2-0', ROAD: '2-0', L10: '4-0', strCurrentStreak: 'W 1',
})));
const teamStats = () => rowsOf(TEAMS.map((t, i) => ({
  TEAM_ID: t.id, NET_RATING: 3 - i * 2, OFF_RATING: 112 + i, DEF_RATING: 110 - i, PACE: 99 + i, PTS: 110, TM_TOV_PCT: 0.12,
})));

/** 每队两两打一场主客：每季都有比赛，current 才不为 null */
function games(url) {
  const year = seasonOf(url).slice(0, 4);
  const rows = [];
  let n = 0;
  for (const home of TEAMS) {
    for (const away of TEAMS) {
      if (home === away) continue;
      n += 1;
      const GAME_ID = `002${year.slice(2)}${String(n).padStart(5, '0')}`;
      const GAME_DATE = `${year}-11-${String(n).padStart(2, '0')}`;
      const homeWin = (home.id + away.id + n) % 2 === 0;
      rows.push(
        { GAME_ID, GAME_DATE, TEAM_ID: home.id, TEAM_ABBREVIATION: home.abbr, PTS: homeWin ? 112 : 104, WL: homeWin ? 'W' : 'L', MATCHUP: `${home.abbr} vs. ${away.abbr}` },
        { GAME_ID, GAME_DATE, TEAM_ID: away.id, TEAM_ABBREVIATION: away.abbr, PTS: homeWin ? 104 : 112, WL: homeWin ? 'L' : 'W', MATCHUP: `${away.abbr} @ ${home.abbr}` },
      );
    }
  }
  return rowsOf(rows);
}

const schedule = () => ({
  leagueSchedule: {
    seasonYear: '2026-27',
    gameDates: [{
      gameDate: '11/20/2026 00:00:00',
      games: [[0, 1], [2, 3]].map(([h, a], i) => ({
        gameId: `00226${String(i + 1).padStart(5, '0')}`, gameStatusText: '7:30 pm ET', gameDateTimeUTC: '2026-11-21T00:30:00Z',
        weekNumber: 5, day: 'Fri', arenaName: 'Arena', arenaCity: 'City', isNeutral: false, gameLabel: '', gameSubLabel: '',
        homeTeam: { teamId: TEAMS[h].id, teamTricode: TEAMS[h].abbr }, awayTeam: { teamId: TEAMS[a].id, teamTricode: TEAMS[a].abbr },
      })),
    }],
  },
});

function roster(url) {
  const id = Number(/TeamID=(\d+)/.exec(url)[1]);
  const team = TEAMS.findIndex((t) => t.id === id);
  return {
    resultSets: [
      set('CommonTeamRoster', PLAYERS.filter((p) => p.team === team).map((p) => ({ PLAYER_ID: p.id, PLAYER: p.name, POSITION: 'G', NUM: '1', AGE: 25 }))),
      set('Coaches', []),
    ],
  };
}

const ROUTES = {
  scheduleleaguev2: schedule,
  leaguestandingsv3: standings,
  leaguedashteamstats: teamStats,
  leaguedashplayerstats: dashPlayers,
  playerestimatedmetrics: () => rowsOf([{ PLAYER_ID: 101, E_NET_RATING: 1 }]),
  leaguehustlestatsplayer: hustle,
  leaguedashptdefend: defend,
  leaguedashptstats: ptStats,
  commonteamroster: roster,
  leaguegamelog: games,
};

function nbaPayload(url) {
  if (process.env.OFFLINE_RAW_DIR) {
    const f = path.join(process.env.OFFLINE_RAW_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).payload : null;
  }
  return ROUTES[/stats\/(\w+)\?/.exec(url)[1]](url);
}

// ---------------------------------------------------------------- 假 fetch

const counts = {};
const respond = (status, body) => ({
  status,
  headers: { getSetCookie: () => [] },
  arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
});

globalThis.fetch = async (input) => {
  const url = String(input);
  const { host } = new URL(url);
  counts[host] = (counts[host] ?? 0) + 1;
  const payload = host === 'stats.nba.com' ? nbaPayload(url) : null;
  return payload ? respond(200, payload) : respond(404, {});
};

process.on('exit', () => {
  if (process.env.OFFLINE_COUNT_FILE) fs.writeFileSync(process.env.OFFLINE_COUNT_FILE, JSON.stringify(counts));
});
