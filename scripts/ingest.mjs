/**
 * 数据抓取：从 stats.nba.com 拉取球队/球员/赛程/逐场结果，
 * 归一化后写入 data/*.json，供服务端直接读取。
 *
 *   node scripts/ingest.mjs
 *   PRIOR_SEASON=2025-26 TARGET_SEASON=2026-27 node scripts/ingest.mjs
 */
import fsNode from 'node:fs';
import pathNode from 'node:path';
import { nbaGet as nbaGetRaw, statsUrl, toRows, writeJson, DATA_DIR } from '../server/nbaClient.mjs';
import { TEAM_META, POS_CN } from '../server/teamMeta.mjs';
import { fetchInjuries } from '../server/espnClient.mjs';
import { fetchUpcomingOdds } from '../server/oddsClient.mjs';
import { buildBacktestDataset } from '../server/dataset.mjs';
import { impactOf, apply as spmOf, MIN_GP } from '../server/impact.mjs';
import { shrinkByMinutes, populationMean, MINUTES_SHRINK } from '../server/impactShrink.mjs';
import { decayedApm } from '../server/rapm.mjs';
import { replaySeasonPicks } from '../server/replay.mjs';
import {
  buildGames, computeElo, carryOver, rotationImpact, fitRosterImpact, totalMinutes, pickBasis,
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

/** ingest 的请求都走 data/raw/nba/ 缓存：往季接口不会变，永不重抓；本季 1 小时内重跑也不重抓 */
const nbaGet = (url, opts) => nbaGetRaw(url, { cache: true, ...opts });

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

/** 追踪类端点（leaguedashptstats / leaguedashptdefend）的必填空参数 */
const PT_BASE = {
  LeagueID: '00', SeasonType: 'Regular Season', PerMode: 'PerGame',
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
  DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '', LastNGames: 0,
  Location: '', Month: 0, OpponentTeamID: 0, Outcome: '', PORound: 0, Period: 0,
  PlayerExperience: '', PlayerPosition: '', SeasonSegment: '', StarterBench: '',
  TeamID: 0, VsConference: '', VsDivision: '', Weight: '',
};

/** 往前数 back 个赛季：'2025-26', 2 -> '2023-24' */
const seasonBefore = (season, back) => {
  const y = Number(season.slice(0, 4)) - back;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

/**
 * IMP 的 APM 那一半要用的五人组合缓存：以 PRIOR_SEASON 为最后一季、往前共 decaySpan 季。
 * 返回缺失的文件名（空数组 = 齐全）。
 */
function missingLineups(model) {
  const span = model.decaySpan ?? 3;
  const need = Array.from({ length: span }, (_, i) => seasonBefore(PRIOR_SEASON, span - 1 - i));
  const dir = pathNode.join(DATA_DIR, 'history');
  return {
    need,
    missing: need.filter((s) => !fsNode.existsSync(pathNode.join(dir, `lineups_${s}.json`))),
  };
}

/**
 * 读最近几季的五人组合数据，算出时间衰减的 APM。
 * 文件不全就返回 null——IMP 会退回纯统计栏模型，而不是把 APM 当 0。
 * 正式抓取在 main 开头就会因缺文件而停下（见 missingLineups），这里的 null 只在
 * ALLOW_NO_APM=1 时才会出现。
 */
function loadDecayedApm(model, { quiet = false } = {}) {
  const { need, missing } = missingLineups(model);
  if (missing.length) return null;
  const dir = pathNode.join(DATA_DIR, 'history');
  const bySeason = need.map((season) => ({
    season,
    rows: JSON.parse(fsNode.readFileSync(pathNode.join(dir, `lineups_${season}.json`), 'utf8')).rows,
  }));
  if (!quiet) log(`  实测 APM 取自 ${bySeason.map((b) => b.season).join('、')}（半衰期 ${model.decayHalfLife ?? 1} 季，按回合加权）`);
  return decayedApm(bySeason, {
    span: need.length,
    halfLife: model.decayHalfLife ?? 1,
    lambda: model.apmLambda ?? 6000,
  });
}

/** 读一个可选的 data 文件，不存在或坏了都当没有 */
const readJsonSafe = (f) => {
  try {
    const p = pathNode.join(DATA_DIR, f);
    return fsNode.existsSync(p) ? JSON.parse(fsNode.readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};

/**
 * 百分数 -> 小数。NBA 接口里同名字段的量纲并不一致：
 * leaguedashteamstats 的 TM_TOV_PCT 是 0.124，leaguedashplayerstats 的是 8.7。
 * 存进 data/ 之前统一成小数，显示层才敢无脑乘 100。
 */
const pctToFrac = (v) => {
  const n = v === null || v === undefined || v === '' ? null : Number(v);
  return n === null || Number.isNaN(n) ? null : n / 100;
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

/**
 * @param {boolean} opts.optional 赛季初用：追踪、拼抢、对位这些辅助接口可能还没数据，
 *   取不到就留空数组，不让整次抓取失败。基础与高阶数据仍然必须拿到。
 */
async function fetchPlayerStats(season, { optional = false } = {}) {
  const out = {};
  const extra = async (url) => {
    try {
      return toRows(await nbaGet(url));
    } catch (e) {
      if (!optional) throw e;
      console.warn(`  暂无数据，留空：${String(e.message).slice(0, 80)}`);
      return [];
    }
  };
  for (const [key, measure] of [['base', 'Base'], ['advanced', 'Advanced'], ['misc', 'Misc']]) {
    log(`球员数据 ${measure} (${season})`);
    const payload = await nbaGet(statsUrl('leaguedashplayerstats', {
      ...DASH_BASE, ...PLAYER_EXTRA, MeasureType: measure, PerMode: 'PerGame', Season: season,
    }));
    out[key] = toRows(payload);
  }

  // 官方估计效率：E_OFF/E_DEF/E_NET_RATING。
  // 和 Advanced 里的 OFF_RATING 不是一回事——那个是"在场时球队的效率"，
  // 受队友影响极大；这组是 NBA 自己按球员贡献估计的，出场少的球员稳定得多。
  log(`球员估计效率 (${season})`);
  out.estimated = await extra(statsUrl('playerestimatedmetrics', {
    LeagueID: '00', Season: season, SeasonType: 'Regular Season',
  }));

  // 拼抢：干扰投篮、抢断偏转、造进攻犯规、掩护助攻、卡位、争抢球。
  // 这些是传统 box score 完全看不到的东西，也是现代影响力指标的重要输入。
  log(`球员拼抢数据 (${season})`);
  out.hustle = await extra(statsUrl('leaguehustlestatsplayer', {
    LeagueID: '00', Season: season, SeasonType: 'Regular Season',
    PerMode: 'PerGame', PlayerOrTeam: 'Player',
  }));

  // 防守对位：被防投篮命中率 vs 对手的正常命中率。
  // 这是少数能真正衡量个人防守的公开数据——抢断盖帽只反映了防守的一小部分。
  log(`球员防守对位 (${season})`);
  out.defend = await extra(statsUrl('leaguedashptdefend', {
    ...PT_BASE, Season: season, DefenseCategory: 'Overall',
  }));

  // 追踪数据。11 组里挑 7 组：其余（肘区/低位/油漆区触球）已被 Possessions 覆盖大半，
  // 每多一组就多一次请求、多一份体积，取用得上的即可。
  for (const [key, measure] of [
    ['drives', 'Drives'], ['catchShoot', 'CatchShoot'], ['pullUp', 'PullUpShot'],
    ['passing', 'Passing'], ['possessions', 'Possessions'],
    ['rebounding', 'Rebounding'], ['speed', 'SpeedDistance'],
  ]) {
    log(`球员追踪 ${measure} (${season})`);
    out[key] = await extra(statsUrl('leaguedashptstats', {
      ...PT_BASE, Season: season, PerMode: 'PerGame',
      PlayerOrTeam: 'Player', PtMeasureType: measure,
    }));
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
  // 新增的几组都按 PLAYER_ID 建索引；某个球员在某组里没有记录是正常的
  // （比如追踪数据要求最低出场），取不到就留空对象，下游的 num() 会给 null。
  const idxOf = (rows, key = 'PLAYER_ID') => new Map((rows ?? []).map((r) => [r[key], r]));
  const estIdx = idxOf(playerStats.estimated);
  const miscIdx = idxOf(playerStats.misc);
  const hustleIdx = idxOf(playerStats.hustle);
  const defIdx = idxOf(playerStats.defend, 'CLOSE_DEF_PERSON_ID');
  const drvIdx = idxOf(playerStats.drives);
  const csIdx = idxOf(playerStats.catchShoot);
  const puIdx = idxOf(playerStats.pullUp);
  const passIdx = idxOf(playerStats.passing);
  const possIdx = idxOf(playerStats.possessions);
  const rebIdx = idxOf(playerStats.rebounding);
  const spdIdx = idxOf(playerStats.speed);

  const teamIdx = new Map(teams.map((t) => [t.teamId, t]));
  const rosterIdx = new Map();
  for (const [teamId, r] of Object.entries(rosters)) {
    for (const p of r.players) rosterIdx.set(p.PLAYER_ID, { ...p, teamId: Number(teamId) });
  }

  const players = playerStats.base.map((b) => {
    const a = advIdx.get(b.PLAYER_ID) ?? {};
    const e = estIdx.get(b.PLAYER_ID) ?? {};
    const mi = miscIdx.get(b.PLAYER_ID) ?? {};
    const hu = hustleIdx.get(b.PLAYER_ID) ?? {};
    const de = defIdx.get(b.PLAYER_ID) ?? {};
    const dr = drvIdx.get(b.PLAYER_ID) ?? {};
    const cs = csIdx.get(b.PLAYER_ID) ?? {};
    const pu = puIdx.get(b.PLAYER_ID) ?? {};
    const pa = passIdx.get(b.PLAYER_ID) ?? {};
    const po = possIdx.get(b.PLAYER_ID) ?? {};
    const rb = rebIdx.get(b.PLAYER_ID) ?? {};
    const sp = spdIdx.get(b.PLAYER_ID) ?? {};
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
        // 坑：同名字段在两个接口里量纲不同——球队的 TM_TOV_PCT 是小数（0.124），
        // 球员的却已经是百分数（8.7）。统一在这里折成小数，
        // 让 adv.* 里所有百分比字段是同一个意思，显示层只管乘 100。
        tovPct: pctToFrac(a.TM_TOV_PCT),
        pace: num(a.PACE), pie: num(a.PIE), poss: num(a.POSS),
      },
      // 官方估计效率。E_ 开头的这组是按球员贡献估计的，
      // 不像 adv.offRtg 那样几乎等于"在场时球队的效率"。
      est: {
        offRtg: num(e.E_OFF_RATING), defRtg: num(e.E_DEF_RATING), netRtg: num(e.E_NET_RATING),
        usgPct: num(e.E_USG_PCT), pace: num(e.E_PACE), tovPct: pctToFrac(e.E_TOV_PCT),
        astRatio: num(e.E_AST_RATIO), rebPct: num(e.E_REB_PCT),
      },
      // 拼抢：box score 之外的贡献
      hustle: {
        contested: num(hu.CONTESTED_SHOTS),
        contested2pt: num(hu.CONTESTED_SHOTS_2PT),
        contested3pt: num(hu.CONTESTED_SHOTS_3PT),
        deflections: num(hu.DEFLECTIONS),
        charges: num(hu.CHARGES_DRAWN),
        screenAst: num(hu.SCREEN_ASSISTS),
        screenAstPts: num(hu.SCREEN_AST_PTS),
        looseBalls: num(hu.LOOSE_BALLS_RECOVERED),
        boxOuts: num(hu.BOX_OUTS),
      },
      // 防守对位：diff 为负表示把对手压到了低于其正常水平
      defend: {
        freq: num(de.FREQ),
        dFga: num(de.D_FGA),
        dFgPct: num(de.D_FG_PCT),
        normalFgPct: num(de.NORMAL_FG_PCT),
        diffPct: num(de.PCT_PLUSMINUS),
      },
      // 得分方式与控球，来自球场追踪摄像头
      track: {
        drives: num(dr.DRIVES), drivePts: num(dr.DRIVE_PTS),
        driveFga: num(dr.DRIVE_FGA), driveFgPct: num(dr.DRIVE_FG_PCT),
        driveAst: num(dr.DRIVE_AST), driveTov: num(dr.DRIVE_TOV),
        csPts: num(cs.CATCH_SHOOT_PTS), csFga: num(cs.CATCH_SHOOT_FGA),
        csEfg: num(cs.CATCH_SHOOT_EFG_PCT),
        puPts: num(pu.PULL_UP_PTS), puFga: num(pu.PULL_UP_FGA),
        puEfg: num(pu.PULL_UP_EFG_PCT),
        passes: num(pa.PASSES_MADE), potentialAst: num(pa.POTENTIAL_AST),
        astPtsCreated: num(pa.AST_POINTS_CREATED), secondaryAst: num(pa.SECONDARY_AST),
        touches: num(po.TOUCHES), timeOfPoss: num(po.TIME_OF_POSS),
        secPerTouch: num(po.AVG_SEC_PER_TOUCH), ptsPerTouch: num(po.PTS_PER_TOUCH),
        orebChancePct: num(rb.OREB_CHANCE_PCT), drebChancePct: num(rb.DREB_CHANCE_PCT),
        distMiles: num(sp.DIST_MILES), avgSpeed: num(sp.AVG_SPEED),
      },
      // 得分构成
      misc: {
        ptsOffTov: num(mi.PTS_OFF_TOV), pts2nd: num(mi.PTS_2ND_CHANCE),
        ptsFb: num(mi.PTS_FB), ptsPaint: num(mi.PTS_PAINT),
        pfd: num(mi.PFD), blka: num(mi.BLKA),
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
      base: {}, adv: {}, est: {}, hustle: {}, defend: {}, track: {}, misc: {},
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

async function fetchGameLog(season, { optional = false } = {}) {
  log(`逐场结果 (${season})`);
  try {
    const payload = await nbaGet(statsUrl('leaguegamelog', {
      Counter: 1300, Direction: 'DESC', LeagueID: '00', PlayerOrTeam: 'T',
      Season: season, SeasonType: 'Regular Season', Sorter: 'DATE',
    }));
    return toRows(payload);
  } catch (e) {
    // 目标赛季还没开打时该接口可能直接报错，这不算失败
    if (optional) {
      console.warn(`  ${season} 暂无已完成比赛：${String(e.message).slice(0, 80)}`);
      return [];
    }
    throw e;
  }
}

// ---------------------------------------------------------------- 本赛季至今（展示用）

/** 球员 cur 里带的字段：与顶层同名同形，PlayerTable 不用改就能直接显示 */
const CUR_PLAYER_KEYS = ['gp', 'w', 'l', 'min', 'base', 'adv', 'est', 'hustle', 'defend', 'track', 'misc', 'pie', 'totalMin'];
const CUR_TEAM_KEYS = ['wins', 'losses', 'winPct', 'confRank', 'homeRecord', 'roadRecord', 'last10', 'streak',
  'base', 'adv', 'fourFactors', 'scoring'];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/**
 * 抓目标赛季至今的球队/球员数据，按 id 返回只含展示字段的对象。
 * 复用 buildTeams / buildPlayers 的字段映射，只取其中的数据部分——
 * 身份类字段（priorTeamId、onRoster）在这里没有意义，交给顶层那份。
 *
 * IMP 是例外：它要历史数据，见 currentImpact。
 */
/**
 * 本赛季 IMP = 上赛季 IMP 作先验 + 本赛季统计栏模型，按出场数加权：
 *
 *   IMP = (K × 上赛季 IMP + 本季场数 × 本季 SPM) / (K + 本季场数)，K = 20 场
 *
 * 上赛季 IMP 本身含近 3 季衰减 APM，所以历史数据完整保留。K=20 的含义是
 * 本季打满 20 场时两季各占一半——这个值**没有验证过**，是按训练门槛取的。
 * 上赛季没有 IMP 的人（新秀等）没有先验兜底，仍要本季满 20 场才给分。
 * 先验用的是**按上季分钟收缩后**的 IMP（见 main 里的 shrinkByMinutes），本季这一段未另做收缩：
 * 本季分段统计栏没有历史缓存，验证不了（docs/impact-shrink-continuity-verdict.md）。
 */
const IMP_PRIOR_GAMES = 20;
function currentImpact(model, c, prior) {
  const gp = c.gp ?? 0;
  const cur = spmOf(model, c, { minGp: prior === null ? MIN_GP : 1 });
  if (prior === null) return cur;
  if (cur === null) return prior;
  return Math.round(((IMP_PRIOR_GAMES * prior + gp * cur) / (IMP_PRIOR_GAMES + gp)) * 100) / 100;
}

async function fetchCurrentSeason(teams, rosters, tricodeById, impactModel, priorPlayers) {
  const priorImp = new Map(priorPlayers.map((p) => [p.playerId, p.impact ?? null]));
  const standings = await fetchStandings(TARGET_SEASON);
  const teamStats = await fetchTeamStats(TARGET_SEASON);
  const curTeams = new Map(buildTeams(teamStats, standings, tricodeById)
    .map((t) => [t.teamId, pick(t, CUR_TEAM_KEYS)]));

  const playerStats = await fetchPlayerStats(TARGET_SEASON, { optional: true });
  const curPlayers = new Map();
  for (const p of buildPlayers(playerStats, rosters, teams)) {
    if (!(p.gp > 0)) continue;
    const c = pick(p, CUR_PLAYER_KEYS);
    c.impact = impactModel ? currentImpact(impactModel, c, priorImp.get(p.playerId) ?? null) : null;
    curPlayers.set(p.playerId, c);
  }
  return { teams: curTeams, players: curPlayers };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`\n抓取 NBA 数据   基准赛季=${PRIOR_SEASON}   预测赛季=${TARGET_SEASON}\n`);
  const t0 = Date.now();

  // 先查本地缓存，再发任何请求：缺 lineups 时 IMP 会悄悄退化成纯统计栏模型（2026-10 线上就这样
  // 跑了一阵，406 人 IMP 全等于 SPM）。现在直接停下；只做本地试验时可设 ALLOW_NO_APM=1 放行。
  const impactModelPre = readJsonSafe('impact-model.json');
  if (impactModelPre) {
    const { need, missing } = missingLineups(impactModelPre);
    if (missing.length && process.env.ALLOW_NO_APM !== '1') {
      console.error(`缺少 data/history/${missing.map((s) => `lineups_${s}.json`).join('、')}`
        + `（IMP 需要 ${need.join('、')} ${need.length} 季的五人组合数据算 APM）。`
        + '\n从 GB10 拷：rsync -a lei@192.168.1.49:dc-nba-refresh/data/history/ data/history/'
        + '\n只做本地试验、明知 IMP 会退化为纯 SPM：ALLOW_NO_APM=1 node scripts/ingest.mjs');
      process.exit(2);
    }
  }

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

  // 综合影响力指标：系数由 npm run impact:fit 训练并验证后写进 data/impact-model.json。
  // 模型文件不存在就跳过——这一项是增强，不该让整个抓取失败。
  const impactModel = readJsonSafe('impact-model.json');
  if (impactModel) {
    // IMP 是「统计栏模型」与「场上实测 APM」的混合，两半都要现算。
    // APM 用最近几季的五人组合数据做时间衰减，缺数据时退回纯统计栏模型。
    const apm = loadDecayedApm(impactModel);
    // 按上季出场分钟向人群均值收缩（实验 1，docs/impact-shrink-continuity-verdict.md）：
    // 480 分钟的 Thybulle 不该比 2300 分钟的东契奇高。收缩前的值留在 impactUnshrunk 供核对。
    // 上季 IMP 是拿来预测本季的：SPM 特征先按逐项年龄曲线平移一岁（aged，模型里没有曲线时不变），
    // APM 用模型记的衰减（仍为 3 季、半衰期 1 季）。docs/imp-improve-verdict.md 实验 5b。
    // 10-28 之前的口径（不调年龄）另算一份放在 impactV1，供对照。
    const mu = populationMean(players.map((p) => spmOf(impactModel, p, { aged: true })));
    // v1 的系数与本版同一套 SPM，只是量纲校准不同：按 scale 之比换回 v1 的量纲
    const r1 = impactModel.v1?.scale && impactModel.scale ? impactModel.v1.scale / impactModel.scale : 1;
    const v1 = impactModel.v1 ? {
      ...impactModel, ...impactModel.v1, ageCurves: null,
      beta: impactModel.beta.map((b) => b * r1), intercept: impactModel.intercept * r1,
    } : null;
    const apmV1 = v1 ? loadDecayedApm(v1, { quiet: true }) : null;
    const muV1 = v1 ? populationMean(players.map((p) => spmOf(v1, p))) : null;
    let n = 0;
    let withApm = 0;
    for (const p of players) {
      const a = apm?.get(p.playerId)?.apm ?? null;
      const v = impactOf(impactModel, p, a, { aged: true });
      if (v !== null) {
        const mins = (p.gp ?? 0) * (p.min ?? 0);
        p.impactUnshrunk = v;
        p.impact = Math.round(shrinkByMinutes(v, mins, mu) * 100) / 100;
        if (v1) {
          const old = impactOf(v1, p, apmV1?.get(p.playerId)?.apm ?? null);
          p.impactV1 = old === null ? null : Math.round(shrinkByMinutes(old, mins, muV1) * 100) / 100;
        }
        n += 1; if (a !== null) withApm += 1;
      }
    }
    log(`综合影响力指标：${n} 名球员（其中 ${withApm} 人有实测 APM，`
      + `模型训练于 ${(impactModel.seasons ?? []).join('、')}；按分钟收缩 k=${MINUTES_SHRINK.k} 向均值 ${mu.toFixed(2)}）`);
    if (!apm) console.warn('  ALLOW_NO_APM=1：缺少 data/history/lineups_*.json，IMP 退化为纯统计栏模型');
    // 文件在但读出来几乎没人有 APM（文件坏了、球员 ID 对不上），同样不能当正常结果写出去
    else if (withApm < n * 0.5 && process.env.ALLOW_NO_APM !== '1') {
      throw new Error(`只有 ${withApm}/${n} 名球员有实测 APM，lineups 缓存可能损坏，停止（未写任何文件）`);
    }
  } else {
    console.warn('  缺少 data/impact-model.json，跳过综合影响力指标（跑 npm run impact:fit 生成）');
  }

  // 再往前一个赛季，只用来给 PRIOR_SEASON 定开赛日 Elo（人机对赌题库要用）
  const priorPriorSeason = (() => {
    const y = Number(PRIOR_SEASON.slice(0, 4));
    return `${y - 1}-${String(y % 100).padStart(2, '0')}`;
  })();
  const logRows = await fetchGameLog(PRIOR_SEASON);
  // 目标赛季已打完的比赛：赛季前为空，开赛后逐步累积
  const currentLogRows = await fetchGameLog(TARGET_SEASON, { optional: true });
  const priorPriorRows = await fetchGameLog(priorPriorSeason, { optional: true });

  // ---- 评级
  const games = buildGames(logRows);
  const { final: eloFinal } = computeElo(games);
  // 赛季间向均值回归，得到开赛日评级
  const eloPreseason = carryOver(eloFinal);
  // 再吸收本赛季已完成的比赛。回测显示这一步能把胜负准确率
  // 从 61.4% 提到 66.3%（2022-23~2025-26 共 4920 场）
  const currentGames = buildGames(currentLogRows);
  const { final: eloStart, history: eloHistory = [] } = currentGames.length
    ? computeElo(currentGames, { initial: eloPreseason })
    : { final: eloPreseason };

  // ---- 轮换影响力：先用「上赛季名单 → 上赛季净效率」拟合换算系数
  const lastSeasonRoster = new Map(teams.map((t) => [t.teamId, []]));
  for (const p of players) {
    if (p.gp > 0 && lastSeasonRoster.has(p.priorTeamId)) lastSeasonRoster.get(p.priorTeamId).push(p);
  }

  // 价值口径全联盟统一定一次：有 IMP 就用 IMP，没有（缺模型文件）退回 PIE。
  // 换算系数 b 会随口径一起变，所以这两步必须用同一个 basis。
  const basis = pickBasis(players);
  const impactFit = fitRosterImpact(teams.map((t) => ({
    raw: rotationImpact(lastSeasonRoster.get(t.teamId) ?? [], { basis }),
    net: t.adv.netRtg ?? 0,
  })));

  for (const t of teams) {
    t.eloEnd = r1(eloFinal[t.teamId]) ?? 1500;
    t.eloPreseason = r1(eloPreseason[t.teamId]) ?? 1500;
    // 未舍入的开赛日评级：scripts/espn-refresh.mjs 从它起算本季 Elo，
    // 用舍入值会和这里的结果差 0.1 分
    t.eloPreseasonExact = eloPreseason[t.teamId] ?? 1500;
    t.elo = r1(eloStart[t.teamId]) ?? 1500;
    // 上赛季名单的轮换影响力基准；新名单一侧与阵容更迭修正由预测引擎按参数实时计算
    t.rotationPrior = rotationImpact(lastSeasonRoster.get(t.teamId) ?? [], { basis });
  }

  // ---- 本赛季至今的数据：只给界面展示，挂在 t.cur / p.cur 上。
  // 上面那些顶层字段是上赛季的，预测引擎靠它们做基准，不能被覆盖——
  // 服务端在展示接口里用 cur 替换后再返回（server/index.mjs 的 showTeam / showPlayer）。
  const cur = currentGames.length ? await fetchCurrentSeason(teams, rosters, tricodeById, impactModel, players) : null;
  if (cur) {
    for (const t of teams) t.cur = cur.teams.get(t.teamId) ?? null;
    for (const p of players) p.cur = cur.players.get(p.playerId) ?? null;
    log(`  ${TARGET_SEASON} 至今：${cur.teams.size} 队、${cur.players.size} 名球员有出场数据`);
  }

  // 赛程里已结束的比赛补上比分（赛程接口本身只给 "Final"，不带分数）
  const scoreById = new Map(currentGames.map((g) => [g.gameId, g]));
  const preEloById = new Map(eloHistory.map((h) => [h.gameId, h]));
  for (const g of schedule.games) {
    const r = scoreById.get(g.gameId);
    if (!r) continue;
    const homeSide = r.home.teamId === g.homeId ? r.home : r.away;
    const awaySide = homeSide === r.home ? r.away : r.home;
    g.homeScore = homeSide.pts;
    g.awayScore = awaySide.pts;
    // 赛前 Elo，供服务端还原赛前预测（预测与实际对比）
    const h = preEloById.get(g.gameId);
    if (h) {
      const flip = r.home.teamId !== g.homeId;
      g.preElo = { home: r1(flip ? h.awayEloPre : h.homeEloPre), away: r1(flip ? h.homeEloPre : h.awayEloPre) };
    }
  }

  const meta = {
    priorSeason: PRIOR_SEASON,
    targetSeason: TARGET_SEASON,
    fetchedAt: new Date().toISOString(),
    gamesPlayedPrior: games.length,
    gamesPlayedCurrent: currentGames.length,
    lastResultDate: currentGames.length ? currentGames[currentGames.length - 1].date : null,
    // 界面上的球队/球员数据是否已换成本赛季至今（开赛前为 false，展示上赛季）
    displayCurrent: !!cur,
    impactFit,
    rotationBasis: basis.name,
    leagueAvg: {
      offRtg: teams.reduce((s, t) => s + (t.adv.offRtg ?? 0), 0) / teams.length,
      defRtg: teams.reduce((s, t) => s + (t.adv.defRtg ?? 0), 0) / teams.length,
      pace: teams.reduce((s, t) => s + (t.adv.pace ?? 0), 0) / teams.length,
    },
  };

  // 伤病名单：NBA 官方只发 PDF，改用 ESPN 的结构化接口。
  // 抓取失败时 injuries 保持 null，**保留磁盘上已有的那份**（同 scripts/espn-refresh.mjs）：
  // 之前这里写一份 fetchedAt=null 的空名单，阵容榜就会把所有人当作健康，且界面看不出来。
  let injuries = null;
  try {
    log('伤病名单 (ESPN)');
    injuries = await fetchInjuries(players);
  } catch (e) {
    console.warn(`  伤病抓取失败，保留旧数据：${String(e.message).slice(0, 90)}`);
  }

  // 博彩盘口：ESPN 的公开接口带 DraftKings 的让分与总分，不需要 api key。
  // 只有未开赛的比赛 scoreboard 才带盘口，所以这里拿到的是「还没打的比赛」；
  // 已结束比赛的收盘盘口由 scripts/odds-history.mjs 单独抓，进 backtest.json。
  //
  // 跳过或抓取失败时**保留磁盘上已有的那份**，不要写空。
  // 之前这里无论如何都会 writeJson，结果 SKIP_ODDS=1 跑一次就把好数据清成空的，
  // 抓取失败时更糟——一次网络抖动就毁掉上一次的成果。
  let odds = null;
  if (process.env.SKIP_ODDS === '1') {
    log('博彩盘口：按 SKIP_ODDS=1 跳过，保留磁盘上已有的那份');
  } else {
    try {
      log('博彩盘口 (ESPN)');
      const r = await fetchUpcomingOdds(schedule.games, {
        maxDays: Number(process.env.ODDS_DAYS) || Infinity,
        onProgress: (m) => console.log(m),
      });
      odds = {
        source: 'ESPN',
        fetchedAt: new Date().toISOString(),
        games: r.games,
        matched: r.matched,
        candidates: r.candidates,
        scannedDays: r.scanned,
        providers: r.providers,
      };
      log(`  ${r.matched}/${r.candidates} 场未开赛比赛拿到盘口`
        + `（${Object.entries(r.providers).map(([k, v]) => `${k} ${v}`).join('、') || '无'}）`);
    } catch (e) {
      console.warn(`  盘口抓取失败，保留已有数据：${String(e.message).slice(0, 90)}`);
    }
  }
  if (odds) {
    writeJson('odds.json', odds);
  } else if (!fsNode.existsSync(pathNode.join(DATA_DIR, 'odds.json'))) {
    // 从没抓过就落一份空的，免得服务端读不到文件
    writeJson('odds.json', { source: 'ESPN', fetchedAt: null, games: {}, matched: 0, providers: {} });
  }

  // 人机对赌题库：逐日重放上赛季，生成"模型当时的判断"+真实结果。
  // 新赛季开打前这是唯一能立即结算的对战素材。
  let gameday = { season: PRIOR_SEASON, days: [], games: [] };
  if (priorPriorRows.length) {
    const picks = replaySeasonPicks(games, buildGames(priorPriorRows));
    gameday = { season: PRIOR_SEASON, generatedAt: new Date().toISOString(), games: picks };
    log(`对赌题库：${PRIOR_SEASON} 共 ${picks.length} 场`);
  } else {
    console.warn(`  缺少 ${priorPriorSeason} 数据，跳过对赌题库生成`);
  }
  writeJson('gameday.json', gameday);

  // 模型实验室的数据集：把历史逐场结果压成紧凑格式随镜像走。
  // 6150 场约 480KB（brotli 后 46KB），换来服务端可以随时按需回测。
  buildBacktestDataset();

  if (injuries) writeJson('injuries.json', injuries);
  writeJson('teams.json', teams);
  writeJson('players.json', players);
  writeJson('schedule.json', schedule);
  writeJson('results.json', games);
  writeJson('meta.json', meta);

  console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  球队 ${teams.length} · 球员 ${players.length} · ${TARGET_SEASON} 赛程 ${schedule.games.length} 场`);
  console.log(`  轮换影响力回归 R²=${impactFit.r2.toFixed(3)}  b=${impactFit.b.toFixed(4)}`
    + `  口径=${basis.name.toUpperCase()}`);
  if (injuries?.matched) {
    console.log(`  伤病 ${injuries.matched} 条（确定缺阵 ${injuries.counts.out ?? 0}，每日观察 ${injuries.counts.dayToDay ?? 0}）`
      + (injuries.unmatched.length ? `，${injuries.unmatched.length} 条未匹配` : ''));
  }
  console.log(currentGames.length
    ? `  已吸收 ${TARGET_SEASON} 赛季 ${currentGames.length} 场真实结果（截至 ${currentGames[currentGames.length - 1].date}）`
    : `  ${TARGET_SEASON} 赛季尚未开打，评级为赛季前预估`);

}

main().catch((e) => {
  console.error('\n抓取失败:', e);
  process.exit(1);
});
