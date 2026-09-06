/**
 * 数据抓取：从 stats.nba.com 拉取球队/球员/赛程/逐场结果，
 * 归一化后写入 data/*.json，供服务端直接读取。
 *
 *   node scripts/ingest.mjs
 *   PRIOR_SEASON=2025-26 TARGET_SEASON=2026-27 node scripts/ingest.mjs
 */
import { nbaGet, statsUrl, toRows, writeJson } from '../server/nbaClient.mjs';
import { TEAM_META, POS_CN } from '../server/teamMeta.mjs';
import {
  buildGames, computeElo, carryOver, rotationImpact, fitRosterImpact, totalMinutes,
} from '../server/ratings.mjs';

/** 依据当前日期推断“最近一个已结束赛季”和“即将开始的赛季”。 */
function defaultSeasons(now = new Date()) {
  const y = now.getFullYear();
  // NBA 赛季 10 月开赛、次年 6 月结束。7 月之后指向即将开打的新赛季。
  const startYear = now.getMonth() >= 6 ? y : y - 1;
  const s = (a) => `${a}-${String((a + 1) % 100).padStart(2, '0')}`;
  return { prior: s(startYear - 1), target: s(startYear) };
}

const d = defaultSeasons();
const PRIOR_SEASON = process.env.PRIOR_SEASON || d.prior;
const TARGET_SEASON = process.env.TARGET_SEASON || d.target;

const log = (...a) => console.log('·', ...a);

const DASH_BASE = {
  Conference: '', DateFrom: '', DateTo: '', Division: '', GameScope: '', GameSegment: '',
  Height: '', LastNGames: 0, LeagueID: '00', Location: '', Month: 0, OpponentTeamID: 0,
  Outcome: '', PORound: 0, PaceAdjust: 'N', Period: 0, PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', SeasonSegment: '',
  SeasonType: 'Regular Season', ShotClockRange: '', StarterBench: '', TeamID: 0,
  TwoWay: 0, VsConference: '', VsDivision: '',
};
const PLAYER_EXTRA = {
  College: '', Country: '', DraftPick: '', DraftYear: '', ISTRound: '', Weight: '',
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------- 球队

async function fetchTeamStats(season) {
  const measures = [
    ['base', 'Base'], ['advanced', 'Advanced'],
    ['fourFactors', 'Four Factors'], ['scoring', 'Scoring'],
  ];
  const out = {};
  for (const [key, measure] of measures) {
    log(`球队数据 ${measure} (${season})`);
    const payload = await nbaGet(statsUrl('leaguedashteamstats', {
      ...DASH_BASE, MeasureType: measure, PerMode: 'PerGame', Season: season,
    }));
    out[key] = toRows(payload);
  }
  return out;
}

async function fetchStandings(season) {
  log(`积分榜 (${season})`);
  const payload = await nbaGet(statsUrl('leaguestandingsv3', {
    LeagueID: '00', Season: season, SeasonType: 'Regular Season',
  }));
  return toRows(payload);
}

function buildTeams(stats, standings, tricodeById) {
  const idx = (rows) => new Map(rows.map((r) => [r.TEAM_ID, r]));
  const base = idx(stats.base);
  const adv = idx(stats.advanced);
  const ff = idx(stats.fourFactors);
  const sc = idx(stats.scoring);

  return standings.map((s) => {
    const id = s.TeamID;
    const b = base.get(id) ?? {};
    const a = adv.get(id) ?? {};
    const f = ff.get(id) ?? {};
    const c = sc.get(id) ?? {};
    const abbr = tricodeById.get(id) ?? '';
    const meta = TEAM_META[abbr] ?? {};
    return {
      teamId: id,
      abbr,
      city: s.TeamCity,
      name: s.TeamName,
      full: `${s.TeamCity} ${s.TeamName}`,
      cn: meta.cn ?? `${s.TeamCity} ${s.TeamName}`,
      color: meta.color ?? '#5b6472',
      colorAlt: meta.alt ?? '#9aa3b0',
      conference: s.Conference,
      division: s.Division,
      wins: s.WINS,
      losses: s.LOSSES,
      winPct: num(s.WinPCT),
      confRank: s.PlayoffRank,
      homeRecord: s.HOME,
      roadRecord: s.ROAD,
      last10: s.L10,
      streak: s.strCurrentStreak,
      base: {
        pts: num(b.PTS), reb: num(b.REB), ast: num(b.AST), stl: num(b.STL), blk: num(b.BLK),
        tov: num(b.TOV), pf: num(b.PF), fgPct: num(b.FG_PCT), fg3Pct: num(b.FG3_PCT),
        ftPct: num(b.FT_PCT), fgm: num(b.FGM), fga: num(b.FGA),
        fg3m: num(b.FG3M), fg3a: num(b.FG3A),
        oreb: num(b.OREB), dreb: num(b.DREB), plusMinus: num(b.PLUS_MINUS),
      },
      adv: {
        offRtg: num(a.OFF_RATING), defRtg: num(a.DEF_RATING), netRtg: num(a.NET_RATING),
        pace: num(a.PACE), astPct: num(a.AST_PCT), astRatio: num(a.AST_RATIO),
        orebPct: num(a.OREB_PCT), drebPct: num(a.DREB_PCT), rebPct: num(a.REB_PCT),
        tovPct: num(a.TM_TOV_PCT), efgPct: num(a.EFG_PCT), tsPct: num(a.TS_PCT),
        pie: num(a.PIE),
      },
      fourFactors: {
        efgPct: num(f.EFG_PCT), ftaRate: num(f.FTA_RATE),
        tovPct: num(f.TM_TOV_PCT), orebPct: num(f.OREB_PCT),
        oppEfgPct: num(f.OPP_EFG_PCT), oppFtaRate: num(f.OPP_FTA_RATE),
        oppTovPct: num(f.OPP_TOV_PCT), oppOrebPct: num(f.OPP_OREB_PCT),
      },
      scoring: {
        pct2pt: num(c.PCT_PTS_2PT), pct3pt: num(c.PCT_PTS_3PT), pctPaint: num(c.PCT_PTS_PAINT),
        pctFastBreak: num(c.PCT_PTS_FB), pctFt: num(c.PCT_PTS_FT), pctAssisted: num(c.PCT_AST_FGM),
      },
    };
  });
}

// ---------------------------------------------------------------- 球员

async function fetchPlayerStats(season) {
  const out = {};
  for (const [key, measure] of [['base', 'Base'], ['advanced', 'Advanced']]) {
    log(`球员数据 ${measure} (${season})`);
    const payload = await nbaGet(statsUrl('leaguedashplayerstats', {
      ...DASH_BASE, ...PLAYER_EXTRA, MeasureType: measure, PerMode: 'PerGame', Season: season,
    }));
    out[key] = toRows(payload);
  }
  return out;
}

async function fetchRosters(teams, season) {
  const rosters = {};
  for (const [i, t] of teams.entries()) {
    log(`阵容 ${i + 1}/${teams.length} ${t.abbr} (${season})`);
    const payload = await nbaGet(statsUrl('commonteamroster', {
      LeagueID: '00', Season: season, TeamID: t.teamId,
    }));
    rosters[t.teamId] = {
      players: toRows(payload, 'CommonTeamRoster'),
      coaches: toRows(payload, 'Coaches'),
    };
  }
  return rosters;
}

function buildPlayers(playerStats, rosters, teams) {
  const advIdx = new Map(playerStats.advanced.map((r) => [r.PLAYER_ID, r]));
  const teamIdx = new Map(teams.map((t) => [t.teamId, t]));
  const rosterIdx = new Map();
  for (const [teamId, r] of Object.entries(rosters)) {
    for (const p of r.players) rosterIdx.set(p.PLAYER_ID, { ...p, teamId: Number(teamId) });
  }

  const players = playerStats.base.map((b) => {
    const a = advIdx.get(b.PLAYER_ID) ?? {};
    const ros = rosterIdx.get(b.PLAYER_ID);
    // 若球员已转队，以最新名单的球队为准
    const teamId = ros ? ros.teamId : b.TEAM_ID;
    const team = teamIdx.get(teamId);
    const pos = ros?.POSITION ?? '';
    return {
      playerId: b.PLAYER_ID,
      name: b.PLAYER_NAME,
      teamId,
      teamAbbr: team?.abbr ?? b.TEAM_ABBREVIATION,
      teamCn: team?.cn ?? b.TEAM_ABBREVIATION,
      priorTeamAbbr: b.TEAM_ABBREVIATION,
      priorTeamId: b.TEAM_ID,
      age: num(b.AGE),
      pos,
      posCn: POS_CN[pos] ?? pos,
      number: ros?.NUM ?? '',
      height: ros?.HEIGHT ?? '',
      weight: ros?.WEIGHT ?? '',
      exp: ros?.EXP ?? '',
      school: ros?.SCHOOL ?? '',
      gp: num(b.GP), w: num(b.W), l: num(b.L), min: num(b.MIN),
      base: {
        pts: num(b.PTS), reb: num(b.REB), ast: num(b.AST), stl: num(b.STL), blk: num(b.BLK),
        tov: num(b.TOV), pf: num(b.PF),
        fgm: num(b.FGM), fga: num(b.FGA), fgPct: num(b.FG_PCT),
        fg3m: num(b.FG3M), fg3a: num(b.FG3A), fg3Pct: num(b.FG3_PCT),
        ftm: num(b.FTM), fta: num(b.FTA), ftPct: num(b.FT_PCT),
        oreb: num(b.OREB), dreb: num(b.DREB), plusMinus: num(b.PLUS_MINUS),
        dd2: num(b.DD2), td3: num(b.TD3),
      },
      adv: {
        offRtg: num(a.OFF_RATING), defRtg: num(a.DEF_RATING), netRtg: num(a.NET_RATING),
        usgPct: num(a.USG_PCT), tsPct: num(a.TS_PCT), efgPct: num(a.EFG_PCT),
        astPct: num(a.AST_PCT), astTo: num(a.AST_TO), astRatio: num(a.AST_RATIO),
        orebPct: num(a.OREB_PCT), drebPct: num(a.DREB_PCT), rebPct: num(a.REB_PCT),
        tovPct: num(a.TM_TOV_PCT), pace: num(a.PACE), pie: num(a.PIE), poss: num(a.POSS),
      },
      // 轮换影响力的两个输入，扁平存放便于 ratings.mjs 直接使用
      pie: num(a.PIE) ?? 0,
      totalMin: (num(b.MIN) ?? 0) * (num(b.GP) ?? 0),
      onRoster: !!ros,
    };
  });

  // 新赛季名单里但上赛季无数据的球员（新秀 / 整季伤停 / 海外回归）
  const known = new Set(players.map((p) => p.playerId));
  for (const [playerId, ros] of rosterIdx) {
    if (known.has(playerId)) continue;
    const team = teamIdx.get(ros.teamId);
    players.push({
      playerId,
      name: ros.PLAYER,
      teamId: ros.teamId,
      teamAbbr: team?.abbr ?? '',
      teamCn: team?.cn ?? '',
      priorTeamAbbr: '',
      priorTeamId: null,
      age: num(ros.AGE),
      pos: ros.POSITION ?? '',
      posCn: POS_CN[ros.POSITION] ?? ros.POSITION ?? '',
      number: ros.NUM ?? '', height: ros.HEIGHT ?? '', weight: ros.WEIGHT ?? '',
      exp: ros.EXP ?? '', school: ros.SCHOOL ?? '',
      gp: 0, w: 0, l: 0, min: 0,
      base: {}, adv: {},
      pie: 0, totalMin: 0, onRoster: true, noPriorData: true,
    });
  }
  return players;
}

// ---------------------------------------------------------------- 赛程

/** "10/03/2026 00:00:00" -> "2026-10-03" */
function parseScheduleDate(s) {
  const [mm, dd, yyyy] = s.split(' ')[0].split('/');
  return `${yyyy}-${mm}-${dd}`;
}

const GAME_TYPE = {
  '001': 'preseason', '002': 'regular', '003': 'allstar',
  '004': 'playoffs', '005': 'playin', '006': 'cupFinal',
};

async function fetchSchedule(season) {
  log(`赛程 (${season})`);
  const payload = await nbaGet(statsUrl('scheduleleaguev2', { LeagueID: '00', Season: season }));
  const ls = payload.leagueSchedule;
  const games = [];
  for (const day of ls.gameDates) {
    const date = parseScheduleDate(day.gameDate);
    for (const g of day.games) {
      const natl = (g.broadcasters?.nationalBroadcasters ?? [])
        .filter((b) => b.broadcasterMedia === 'tv')
        .map((b) => b.broadcasterAbbreviation);
      games.push({
        gameId: g.gameId,
        type: GAME_TYPE[g.gameId.slice(0, 3)] ?? 'other',
        date,
        timeEt: g.gameStatusText,
        dateTimeUtc: g.gameDateTimeUTC,
        weekNumber: g.weekNumber,
        day: g.day,
        homeId: g.homeTeam.teamId,
        homeAbbr: g.homeTeam.teamTricode,
        awayId: g.awayTeam.teamId,
        awayAbbr: g.awayTeam.teamTricode,
        arena: g.arenaName,
        city: g.arenaCity,
        neutral: !!g.isNeutral,
        label: g.gameLabel || '',
        subLabel: g.gameSubLabel || '',
        national: natl,
      });
    }
  }
  games.sort((a, b) => (a.date === b.date
    ? a.gameId.localeCompare(b.gameId)
    : a.date.localeCompare(b.date)));
  return { seasonYear: ls.seasonYear, games };
}

async function fetchGameLog(season) {
  log(`逐场结果 (${season})`);
  const payload = await nbaGet(statsUrl('leaguegamelog', {
    Counter: 1000, Direction: 'DESC', LeagueID: '00', PlayerOrTeam: 'T',
    Season: season, SeasonType: 'Regular Season', Sorter: 'DATE',
  }));
  return toRows(payload);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`\n抓取 NBA 数据   基准赛季=${PRIOR_SEASON}   预测赛季=${TARGET_SEASON}\n`);
  const t0 = Date.now();

  // 先取赛程：它是 teamId -> 三字母缩写 的权威来源
  const schedule = await fetchSchedule(TARGET_SEASON);
  const tricodeById = new Map();
  for (const g of schedule.games) {
    tricodeById.set(g.homeId, g.homeAbbr);
    tricodeById.set(g.awayId, g.awayAbbr);
  }

  const standings = await fetchStandings(PRIOR_SEASON);
  const teamStats = await fetchTeamStats(PRIOR_SEASON);
  const teams = buildTeams(teamStats, standings, tricodeById);

  const playerStats = await fetchPlayerStats(PRIOR_SEASON);
  let rosters;
  try {
    rosters = await fetchRosters(teams, TARGET_SEASON);
  } catch (e) {
    console.warn(`  ${TARGET_SEASON} 名单不可用，回退到 ${PRIOR_SEASON}：${e.message}`);
    rosters = await fetchRosters(teams, PRIOR_SEASON);
  }
  const players = buildPlayers(playerStats, rosters, teams);

  const logRows = await fetchGameLog(PRIOR_SEASON);

  // ---- 评级
  const games = buildGames(logRows);
  const { final: eloFinal } = computeElo(games);
  const eloStart = carryOver(eloFinal);

  // ---- 轮换影响力：先用「上赛季名单 → 上赛季净效率」拟合换算系数
  const lastSeasonRoster = new Map(teams.map((t) => [t.teamId, []]));
  for (const p of players) {
    if (p.gp > 0 && lastSeasonRoster.has(p.priorTeamId)) lastSeasonRoster.get(p.priorTeamId).push(p);
  }

  const impactFit = fitRosterImpact(teams.map((t) => ({
    raw: rotationImpact(lastSeasonRoster.get(t.teamId) ?? []),
    net: t.adv.netRtg ?? 0,
  })));

  for (const t of teams) {
    t.eloEnd = r1(eloFinal[t.teamId]) ?? 1500;
    t.elo = r1(eloStart[t.teamId]) ?? 1500;
    // 上赛季名单的轮换影响力基准；新名单一侧与阵容更迭修正由预测引擎按参数实时计算
    t.rotationPrior = rotationImpact(lastSeasonRoster.get(t.teamId) ?? []);
  }

  const meta = {
    priorSeason: PRIOR_SEASON,
    targetSeason: TARGET_SEASON,
    fetchedAt: new Date().toISOString(),
    gamesPlayedPrior: games.length,
    impactFit,
    leagueAvg: {
      offRtg: teams.reduce((s, t) => s + (t.adv.offRtg ?? 0), 0) / teams.length,
      defRtg: teams.reduce((s, t) => s + (t.adv.defRtg ?? 0), 0) / teams.length,
      pace: teams.reduce((s, t) => s + (t.adv.pace ?? 0), 0) / teams.length,
    },
  };

  writeJson('teams.json', teams);
  writeJson('players.json', players);
  writeJson('schedule.json', schedule);
  writeJson('results.json', games);
  writeJson('meta.json', meta);

  console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  球队 ${teams.length} · 球员 ${players.length} · ${TARGET_SEASON} 赛程 ${schedule.games.length} 场`);
  console.log(`  轮换影响力回归 R²=${impactFit.r2.toFixed(3)}  b=${impactFit.b.toFixed(4)}`);

}

main().catch((e) => {
  console.error('\n抓取失败:', e);
  process.exit(1);
});
