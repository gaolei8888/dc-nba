/**
 * 影子运行的球员价值与常规轮换（server/injuryShadow.mjs 用）：本季 play-by-play 增量抓取 →
 * 每 7 天重拟合一次段级 RAPM → 写 data/history/shadow/player-values.json，由 deploy/player-values.sh 推到服务器。
 *
 *   node scripts/player-values.mjs          # 只抓新结束的比赛；距上次拟合不满 7 天就只更新轮换分钟
 *   FORCE_REFIT=1 node scripts/player-values.mjs
 *
 * 只能在能访问 stats.nba.com 的机器上跑（服务器 IP 被封）。口径与实验完全一致（server/injury-params-v1.json）：
 *   RAPM = computeRapm(λ=2000, minPoss 0.25)，本季到昨天（权重 1）+ 上季 0.5 + 上上季 0.25；
 *   常规轮换 = 每队最近 10 场的场均分钟（服务器按比赛日之前取，这里给最近 12 场）。
 * 请求（全走 nbaClient → politeFetch）：leaguegamelog 1 个 + commonallplayers 1 个 + 每场新比赛 2 个。
 * 一周约 50 场 ≈ 100 个，每天跑就是每天约 15–30 个；单次最多 SHADOW_MAX_GAMES 场（默认 80 场 = 160 个，
 * 低于 nbaClient 默认每次 200 / 每天 500 的上限），剩下的下次续。被拦/到上限就停手，已抓的照样落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nbaGet, statsUrl, toRows, DATA_DIR, readJsonAuto, writeJsonGz } from '../server/nbaClient.mjs';
import { fetchGameStints } from '../server/pbp.mjs';
import { computeRapm } from '../server/stintRapm.mjs';
import { stintMinutes, weightedStints } from '../server/injuryLab.mjs';
import { toEt } from '../server/injuryReport.mjs';

const PARAMS = JSON.parse(fs.readFileSync(new URL('../server/injury-params-v1.json', import.meta.url), 'utf8'));
const OUT_DIR = path.join(DATA_DIR, 'history', 'shadow');
const OUT = path.join(OUT_DIR, 'player-values.json');
const MAX_GAMES = Number(process.env.SHADOW_MAX_GAMES ?? 80);
const KEEP = PARAMS.window + 2;
const log = (...a) => console.log('·', ...a);

const now = Date.now();
const today = toEt(now).date;   // 美东今天：今天的比赛还没打，RAPM 只用今天之前的
const y0 = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 7 ? 0 : 1);
const seasonOf = (y) => `${y}-${String(y + 1).slice(2)}`;
const SEASON = seasonOf(y0);

// ---------------------------------------------------------------- 1. 本季已结束的比赛
const gamelog = toRows(await nbaGet(statsUrl('leaguegamelog', {
  Counter: 1300, Direction: 'DESC', LeagueID: '00', PlayerOrTeam: 'T',
  Season: SEASON, SeasonType: 'Regular Season', Sorter: 'DATE',
})));
const dateOf = new Map(gamelog.map((r) => [r.GAME_ID, String(r.GAME_DATE).slice(0, 10)]));

// ---------------------------------------------------------------- 2. 增量抓 PBP
fs.mkdirSync(OUT_DIR, { recursive: true });
const stintFile = path.join(OUT_DIR, `stints_${SEASON}.json.gz`);
const data = readJsonAuto(stintFile) ?? { season: SEASON, games: {}, failed: {}, dates: {} };
const todo = [...dateOf.keys()].filter((id) => !data.games[id] && !data.failed[id]).sort().slice(0, MAX_GAMES);
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
let fetched = 0; let stopped = null;
for (const id of todo) {
  let r;
  try {
    r = await fetchGameStints(id, (e, p) => nbaGet(statsUrl(e, p)));
  } catch (e) {
    // 被拦 / 到上限 / 挂起（politeFetch 的 code）：停手，下次续。其余（如刚打完 PBP 还是空的）只跳过这一场
    if (e.code) { stopped = String(e.message).slice(0, 120); break; }
    r = { ok: false, why: String(e.message).slice(0, 120) };
  }
  fetched += 1;
  data.dates[id] = dateOf.get(id);
  if (r.ok) data.games[id] = [r.homeId, r.awayId, r.stints];
  // 刚打完的比赛 NBA 有时还没整理好 PBP：两天内的对不上不记失败，下次再试
  else if (dateOf.get(id) < yesterday) data.failed[id] = r.why;
}
writeJsonGz(stintFile, data);
log(`${SEASON}：已结束 ${dateOf.size} 场，本次抓 ${fetched} 场，可用 ${Object.keys(data.games).length}、丢弃 ${Object.keys(data.failed).length}`
  + `${stopped ? `；中途停止：${stopped}` : ''}${todo.length === MAX_GAMES ? `；到单次 ${MAX_GAMES} 场上限，剩下的下次续` : ''}`);

const cur = Object.entries(data.games).map(([gid, [home, away, st]]) => ({ gid, date: data.dates[gid] ?? dateOf.get(gid), home, away, st }))
  .filter((g) => g.date).sort((a, b) => a.date.localeCompare(b.date) || a.gid.localeCompare(b.gid));

// ---------------------------------------------------------------- 3. RAPM：每 7 天重拟合
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
let { rapm, fittedAt, fitThrough } = prev?.season === SEASON ? prev : {};
if (process.env.FORCE_REFIT || !rapm || now - Date.parse(fittedAt) >= PARAMS.refitDays * 86400e3) {
  const parts = PARAMS.seasonWeights.map((w, a) => {
    if (a === 0) return { w, games: cur };
    const f = readJsonAuto(`history/stints_${seasonOf(y0 - a)}.json.gz`);
    if (!f) throw new Error(`缺少 data/history/stints_${seasonOf(y0 - a)}.json.gz`);
    return { w, games: Object.values(f.games).map(([, , st]) => ({ date: '', st })) };
  });
  const t0 = Date.now();
  rapm = {};
  for (const [k, o] of computeRapm(weightedStints(parts, today), { lambda: PARAMS.lambda, minPoss: PARAMS.minPoss })) if (k !== '__hca') rapm[k] = o.rapm;
  fittedAt = new Date(now).toISOString();
  fitThrough = cur.at(-1)?.date ?? null;
  log(`RAPM 重拟合：${Object.keys(rapm).length} 人，本季段截至 ${fitThrough ?? '—'}，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
} else log(`RAPM 沿用 ${fittedAt} 的拟合（每 ${PARAMS.refitDays} 天一次）`);

// ---------------------------------------------------------------- 4. 轮换分钟、本季名单、姓名表
const recent = {}; const firstSeen = {};
for (const g of cur) {
  const m = stintMinutes(g.st);
  for (const [t, mins] of [[g.home, m.home], [g.away, m.away]]) {
    (recent[t] ??= []).push({ date: g.date, gameId: g.gid, mins: Object.fromEntries([...mins].map(([id, v]) => [id, Math.round(v * 100) / 100])) });
    firstSeen[t] ??= {};
    for (const id of mins.keys()) firstSeen[t][id] ??= g.date;
  }
}
for (const t of Object.keys(recent)) recent[t] = recent[t].slice(-KEEP);
const people = toRows(await nbaGet(statsUrl('commonallplayers', { LeagueID: '00', Season: SEASON, IsOnlyCurrentSeason: 0 }), { cache: true }))
  .filter((p) => Number(p.TO_YEAR) >= 2020)   // 与实验同：去掉同名的父辈
  .map((p) => [p.PERSON_ID, p.DISPLAY_FIRST_LAST]);

const out = {
  version: 1, paramsVersion: PARAMS.version, season: SEASON, builtAt: new Date(now).toISOString(),
  fittedAt, fitThrough, gamesThrough: cur.at(-1)?.date ?? null, games: cur.length,
  rapm, recent, firstSeen, people,
};
fs.writeFileSync(`${OUT}.tmp`, JSON.stringify(out));
fs.renameSync(`${OUT}.tmp`, OUT);
log(`写出 ${path.relative(process.cwd(), OUT)}：${cur.length} 场、${Object.keys(recent).length} 队、姓名 ${people.length} 人`);
if (stopped) process.exitCode = 3;   // 让外层知道这次没抓全（文件照样推，服务器按时间判断能不能用）
