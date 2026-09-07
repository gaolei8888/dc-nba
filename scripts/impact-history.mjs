/**
 * 抓多赛季的「影响力指标」训练数据：box + 追踪 + 拼抢 + 防守对位 + on/off。
 *
 *   node scripts/impact-history.mjs
 *   SEASONS=2024-25,2025-26 node scripts/impact-history.mjs
 *
 * 每个赛季 43 个请求（3 个 dash + 估计效率 + 拼抢 + 防守对位 + 7 组追踪 + 30 队 on/off），
 * 5 个赛季约 5 分钟。抓完写成 data/history/impact_<赛季>.json，
 * 只存拟合要用的字段，不存原始 payload。
 *
 * 为什么要多赛季：单赛季只能给出一个相关系数，说明不了这个指标在**没见过的赛季**上
 * 还成不成立。这个项目之前就栽过——「阵容更迭」在单一口径下看着有道理，
 * 一放进 4 个赛季的回测就被否掉了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nbaGet, statsUrl, toRows, DATA_DIR } from '../server/nbaClient.mjs';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const log = (...a) => console.log('·', ...a);

const DASH_BASE = {
  Conference: '', DateFrom: '', DateTo: '', Division: '', GameScope: '', GameSegment: '',
  Height: '', LastNGames: 0, LeagueID: '00', Location: '', Month: 0, OpponentTeamID: 0,
  Outcome: '', PORound: 0, PaceAdjust: 'N', Period: 0, PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', SeasonSegment: '',
  SeasonType: 'Regular Season', ShotClockRange: '', StarterBench: '', TeamID: 0,
  TwoWay: 0, VsConference: '', VsDivision: '',
  College: '', Country: '', DraftPick: '', DraftYear: '', ISTRound: '', Weight: '',
};
const PT_BASE = {
  LeagueID: '00', SeasonType: 'Regular Season', PerMode: 'PerGame',
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
  DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '', LastNGames: 0,
  Location: '', Month: 0, OpponentTeamID: 0, Outcome: '', PORound: 0, Period: 0,
  PlayerExperience: '', PlayerPosition: '', SeasonSegment: '', StarterBench: '',
  TeamID: 0, VsConference: '', VsDivision: '', Weight: '',
};
const ONOFF_BASE = {
  LeagueID: '00', SeasonType: 'Regular Season', MeasureType: 'Advanced',
  PerMode: 'Per100Possessions', PaceAdjust: 'N', PlusMinus: 'N', Rank: 'N',
  Outcome: '', Location: '', Month: 0, SeasonSegment: '', DateFrom: '', DateTo: '',
  OpponentTeamID: 0, VsConference: '', VsDivision: '', GameSegment: '', Period: 0,
  LastNGames: 0, Conference: '', Division: '', GameScope: '', PlayerExperience: '',
  PlayerPosition: '', StarterBench: '', PORound: 0, ShotClockRange: '',
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const idxOf = (rows, key = 'PLAYER_ID') => new Map((rows ?? []).map((r) => [r[key], r]));

async function fetchSeason(season, teamIds) {
  const dash = {};
  for (const [key, measure] of [['base', 'Base'], ['advanced', 'Advanced'], ['misc', 'Misc']]) {
    log(`${season} 球员 ${measure}`);
    dash[key] = toRows(await nbaGet(statsUrl('leaguedashplayerstats', {
      ...DASH_BASE, MeasureType: measure, PerMode: 'PerGame', Season: season,
    })));
  }
  log(`${season} 估计效率`);
  const estimated = toRows(await nbaGet(statsUrl('playerestimatedmetrics', {
    LeagueID: '00', Season: season, SeasonType: 'Regular Season',
  })));
  log(`${season} 拼抢`);
  const hustle = toRows(await nbaGet(statsUrl('leaguehustlestatsplayer', {
    LeagueID: '00', Season: season, SeasonType: 'Regular Season',
    PerMode: 'PerGame', PlayerOrTeam: 'Player',
  })));
  log(`${season} 防守对位`);
  const defend = toRows(await nbaGet(statsUrl('leaguedashptdefend', {
    ...PT_BASE, Season: season, DefenseCategory: 'Overall',
  })));

  const track = {};
  for (const [key, measure] of [
    ['drives', 'Drives'], ['catchShoot', 'CatchShoot'], ['pullUp', 'PullUpShot'],
    ['passing', 'Passing'], ['possessions', 'Possessions'],
    ['rebounding', 'Rebounding'], ['speed', 'SpeedDistance'],
  ]) {
    log(`${season} 追踪 ${measure}`);
    track[key] = toRows(await nbaGet(statsUrl('leaguedashptstats', {
      ...PT_BASE, Season: season, PerMode: 'PerGame',
      PlayerOrTeam: 'Player', PtMeasureType: measure,
    })));
  }

  const onoff = [];
  for (const [i, teamId] of teamIds.entries()) {
    if (i % 10 === 0) log(`${season} on/off ${i + 1}/${teamIds.length}`);
    const p = await nbaGet(statsUrl('teamplayeronoffdetails', {
      ...ONOFF_BASE, Season: season, TeamID: teamId,
    }));
    const on = toRows(p, 'PlayersOnCourtTeamPlayerOnOffDetails');
    const off = idxOf(toRows(p, 'PlayersOffCourtTeamPlayerOnOffDetails'), 'VS_PLAYER_ID');
    for (const r of on) {
      const o = off.get(r.VS_PLAYER_ID) ?? {};
      onoff.push({
        playerId: r.VS_PLAYER_ID,
        teamId,
        onPoss: num(r.POSS), onNet: num(r.NET_RATING),
        offPoss: num(o.POSS), offNet: num(o.NET_RATING),
      });
    }
  }

  return { dash, estimated, hustle, defend, track, onoff };
}

/** 把一个赛季压成拟合要用的紧凑记录 */
function compact(season, raw) {
  const adv = idxOf(raw.dash.advanced);
  const est = idxOf(raw.estimated);
  const misc = idxOf(raw.dash.misc);
  const hus = idxOf(raw.hustle);
  const def = idxOf(raw.defend, 'CLOSE_DEF_PERSON_ID');
  const tr = Object.fromEntries(Object.entries(raw.track).map(([k, v]) => [k, idxOf(v)]));
  const oo = idxOf(raw.onoff, 'playerId');

  const rows = [];
  for (const b of raw.dash.base) {
    const id = b.PLAYER_ID;
    const a = adv.get(id) ?? {}; const e = est.get(id) ?? {}; const mi = misc.get(id) ?? {};
    const h = hus.get(id) ?? {}; const d = def.get(id) ?? {}; const o = oo.get(id) ?? {};
    const g = (k, f) => (tr[k].get(id) ?? {})[f];
    rows.push({
      playerId: id,
      name: b.PLAYER_NAME,
      teamId: b.TEAM_ID,
      gp: num(b.GP), min: num(b.MIN),
      pts: num(b.PTS), fga: num(b.FGA), ast: num(b.AST), tov: num(b.TOV),
      oreb: num(b.OREB), dreb: num(b.DREB), stl: num(b.STL), blk: num(b.BLK), pf: num(b.PF),
      tsPct: num(a.TS_PCT), usgPct: num(a.USG_PCT), pie: num(a.PIE), netRtg: num(a.NET_RATING),
      estNet: num(e.E_NET_RATING),
      deflections: num(h.DEFLECTIONS), contested: num(h.CONTESTED_SHOTS),
      screenAstPts: num(h.SCREEN_AST_PTS), boxOuts: num(h.BOX_OUTS),
      charges: num(h.CHARGES_DRAWN), looseBalls: num(h.LOOSE_BALLS_RECOVERED),
      dFga: num(d.D_FGA), diffPct: num(d.PCT_PLUSMINUS),
      potentialAst: num(g('passing', 'POTENTIAL_AST')),
      astPtsCreated: num(g('passing', 'AST_POINTS_CREATED')),
      drives: num(g('drives', 'DRIVES')),
      touches: num(g('possessions', 'TOUCHES')),
      timeOfPoss: num(g('possessions', 'TIME_OF_POSS')),
      ptsPaint: num(mi.PTS_PAINT), pfd: num(mi.PFD),
      onPoss: o.onPoss ?? null, onNet: o.onNet ?? null,
      offPoss: o.offPoss ?? null, offNet: o.offNet ?? null,
    });
  }
  return { season, builtAt: new Date().toISOString(), count: rows.length, players: rows };
}

async function main() {
  const only = (process.env.SEASONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seasons = only.length ? only : ['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'];
  const teamsFile = path.join(DATA_DIR, 'teams.json');
  if (!fs.existsSync(teamsFile)) {
    console.error('缺少 data/teams.json，请先运行 npm run ingest');
    process.exit(1);
  }
  const teamIds = JSON.parse(fs.readFileSync(teamsFile, 'utf8')).map((t) => t.teamId);

  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  console.log(`\n抓取影响力指标训练数据  赛季：${seasons.join(', ')}\n`);
  const t0 = Date.now();

  for (const season of seasons) {
    const out = path.join(HISTORY_DIR, `impact_${season}.json`);
    if (fs.existsSync(out) && process.env.FORCE !== '1') {
      log(`${season} 已存在，跳过（FORCE=1 可强制重抓）`);
      continue;
    }
    const raw = await fetchSeason(season, teamIds);
    const c = compact(season, raw);
    fs.writeFileSync(out, JSON.stringify(c));
    const withOnoff = c.players.filter((p) => p.onPoss && p.offPoss).length;
    log(`${season} 写入 ${c.count} 人，其中 ${withOnoff} 人有 on/off\n`);
  }

  console.log(`完成，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}

main().catch((e) => { console.error(e); process.exit(1); });
