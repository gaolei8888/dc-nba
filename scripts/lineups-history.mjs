/**
 * 抓各赛季的五人组合数据，用来算 RAPM。
 *
 *   node scripts/lineups-history.mjs
 *   SEASONS=2025-26 node scripts/lineups-history.mjs
 *
 * 为什么需要它：EPM 的方法是公开的——先用 box+追踪 拟合一个 SPM，
 * 再把 SPM 当先验喂进 RAPM 岭回归。我们的 IMP 只做了第一步，
 * 而且目标用的是**裸 on/off**，那个量被队友严重污染：
 * 一个替补中锋只要总跟主力同时上场，on/off 就会很好看。
 *
 * RAPM 的做法是把每个五人组合当一条观测，球员当自变量，
 * 让回归自己去分离"谁带来的"。这需要阵容级数据，
 * leaguedashlineups 正好给：每个组合的回合数与净效率。
 *
 * 局限要说清楚：这个接口只给进攻方的五个人，不给对手阵容，
 * 所以我们算出来的是**未做对手调整**的 APM。真正的 RAPM 需要逐回合的
 * 攻防双方阵容，那要解析 1230 场的 play-by-play。先做能做的那一步。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nbaGet, statsUrl, toRows, DATA_DIR } from '../server/nbaClient.mjs';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const log = (...a) => console.log('·', ...a);

const BASE = {
  LeagueID: '00', SeasonType: 'Regular Season', MeasureType: 'Advanced',
  PerMode: 'Totals', GroupQuantity: 5, PaceAdjust: 'N', PlusMinus: 'N', Rank: 'N',
  Outcome: '', Location: '', Month: 0, SeasonSegment: '', DateFrom: '', DateTo: '',
  OpponentTeamID: 0, VsConference: '', VsDivision: '', GameSegment: '', Period: 0,
  LastNGames: 0, Conference: '', Division: '', ShotClockRange: '', PORound: 0,
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** GROUP_ID 形如 "-201142-203507-..."，拆成球员 id 数组 */
const parseGroupId = (id) => String(id).split('-').filter(Boolean).map(Number);

async function fetchSeason(season, teamIds) {
  const rows = [];
  for (const [i, teamId] of teamIds.entries()) {
    if (i % 10 === 0) log(`${season} 阵容 ${i + 1}/${teamIds.length}`);
    // 按球队分别取，避免联盟级请求被 2000 行的上限截断
    const p = await nbaGet(statsUrl('leaguedashlineups', { ...BASE, Season: season, TeamID: teamId }));
    for (const r of toRows(p)) {
      const ids = parseGroupId(r.GROUP_ID);
      if (ids.length !== 5) continue;
      rows.push({
        teamId,
        players: ids,
        poss: num(r.POSS),
        min: num(r.MIN),
        off: num(r.OFF_RATING),
        def: num(r.DEF_RATING),
        net: num(r.NET_RATING),
      });
    }
  }
  return rows;
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

  console.log(`\n抓取五人组合数据  赛季：${seasons.join('、')}\n`);
  const t0 = Date.now();
  for (const season of seasons) {
    const out = path.join(HISTORY_DIR, `lineups_${season}.json`);
    if (fs.existsSync(out) && process.env.FORCE !== '1') {
      log(`${season} 已存在，跳过（FORCE=1 强制重抓）`);
      continue;
    }
    const rows = await fetchSeason(season, teamIds);
    const poss = rows.reduce((s, r) => s + (r.poss ?? 0), 0);
    fs.writeFileSync(out, JSON.stringify({ season, builtAt: new Date().toISOString(), rows }));
    log(`${season} 写入 ${rows.length} 个组合，合计 ${poss.toLocaleString()} 回合\n`);
  }
  console.log(`完成，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}

main().catch((e) => { console.error(e); process.exit(1); });
