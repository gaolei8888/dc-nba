/**
 * 回测框架。
 *
 * 在历史赛季上逐场重放预测，量化模型准确性。没有这个东西，
 * 任何"加数据源提升准确率"的说法都无法验证。
 *
 * 做法：对每个被测赛季 S，只用 S 开赛前能拿到的信息（S-1 赛季的
 * Elo 与净效率）建立初始评级，然后按日期顺序逐场预测；可选地在
 * 比赛结束后用真实结果更新 Elo（模拟赛季中的滚动学习）。
 *
 *   node scripts/backtest.mjs                       # 默认最近 4 个赛季
 *   node scripts/backtest.mjs 2021-22 2022-23       # 指定赛季
 *
 * 数据会缓存在 data/history/，重跑不用再抓。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nbaGet, statsUrl, toRows, DATA_DIR } from '../server/nbaClient.mjs';
import {
  buildGames, computeElo, carryOver, rotationImpact, fitRosterImpact,
  ELO_BASE, ELO_HOME_ADV, ELO_PER_POINT, VALUE_IMP, VALUE_PIE,
} from '../server/ratings.mjs';
import { decayedApm } from '../server/rapm.mjs';
import { impactOf, DECAY_SPAN, DECAY_HALFLIFE } from '../server/impact.mjs';

const HIST_DIR = path.join(DATA_DIR, 'history');

const DASH_BASE = {
  Conference: '', DateFrom: '', DateTo: '', Division: '', GameScope: '', GameSegment: '',
  Height: '', LastNGames: 0, LeagueID: '00', Location: '', Month: 0, OpponentTeamID: 0,
  Outcome: '', PORound: 0, PaceAdjust: 'N', Period: 0, PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', SeasonSegment: '',
  SeasonType: 'Regular Season', ShotClockRange: '', StarterBench: '', TeamID: 0,
  TwoWay: 0, VsConference: '', VsDivision: '',
};

/** 带磁盘缓存的抓取：回测要反复跑，不该反复打 stats.nba.com */
async function cached(name, fetcher) {
  fs.mkdirSync(HIST_DIR, { recursive: true });
  const file = path.join(HIST_DIR, `${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  // 离线护栏：BACKTEST_OFFLINE=1 时缺缓存直接报错，绝不联网
  if (process.env.BACKTEST_OFFLINE === '1') throw new Error(`离线模式缺缓存 ${name}，不联网`);
  process.stdout.write(`  抓取 ${name} … `);
  const data = await fetcher();
  fs.writeFileSync(file, JSON.stringify(data));
  console.log('完成');
  return data;
}

const seasonGames = (season) => cached(`gamelog_${season}`, async () => {
  const j = await nbaGet(statsUrl('leaguegamelog', {
    Counter: 1200, Direction: 'DESC', LeagueID: '00', PlayerOrTeam: 'T',
    Season: season, SeasonType: 'Regular Season', Sorter: 'DATE',
  }));
  return toRows(j);
});

const seasonTeamAdv = (season) => cached(`teamadv_${season}`, async () => {
  const j = await nbaGet(statsUrl('leaguedashteamstats', {
    ...DASH_BASE, MeasureType: 'Advanced', PerMode: 'PerGame', Season: season,
  }));
  return toRows(j);
});

const PLAYER_EXTRA = {
  College: '', Country: '', DraftPick: '', DraftYear: '', ISTRound: '', Weight: '',
};

const seasonPlayers = (season) => cached(`players_${season}`, async () => {
  const base = toRows(await nbaGet(statsUrl('leaguedashplayerstats', {
    ...DASH_BASE, ...PLAYER_EXTRA, MeasureType: 'Base', PerMode: 'PerGame', Season: season,
  })));
  const adv = toRows(await nbaGet(statsUrl('leaguedashplayerstats', {
    ...DASH_BASE, ...PLAYER_EXTRA, MeasureType: 'Advanced', PerMode: 'PerGame', Season: season,
  })));
  const pieById = new Map(adv.map((r) => [r.PLAYER_ID, Number(r.PIE) || 0]));
  return base.map((b) => ({
    playerId: b.PLAYER_ID,
    teamId: b.TEAM_ID,
    min: Number(b.MIN) || 0,
    gp: Number(b.GP) || 0,
    totalMin: (Number(b.MIN) || 0) * (Number(b.GP) || 0),
    pie: pieById.get(b.PLAYER_ID) ?? 0,
  }));
});

/** 某赛季 30 队的名单（球员 id 集合）。30 次请求，缓存后不再抓。 */
const seasonRosters = (season, teamIds) => cached(`rosters_${season}`, async () => {
  const out = {};
  for (const id of teamIds) {
    const rows = toRows(await nbaGet(statsUrl('commonteamroster', {
      LeagueID: '00', Season: season, TeamID: id,
    })), 'CommonTeamRoster');
    out[id] = rows.map((r) => r.PLAYER_ID);
  }
  return out;
});

/**
 * 算出某赛季各队的阵容更迭修正（每场分）。
 *
 * 注意：历史赛季的名单接口返回的是该赛季全程名单，含交易截止日加盟的球员，
 * 用来预测赛季初的比赛存在轻微信息泄漏。因此这里测出的收益是乐观上界。
 */
/**
 * 某赛季每名球员的 IMP。
 *
 * 回测里的球员行来自 leaguedashplayerstats，只有 PIE，没有 IMP 需要的
 * 追踪字段。IMP 的原料在 data/history/impact_<season>.json 里，
 * 按 playerId 贴回去即可——两边都是同一批 stats.nba.com 的球员 id。
 * 缺 impact_/lineups_ 文件时返回 null，调用方自动退回 PIE 口径。
 */
const impactCache = new Map();
function impactFor(season) {
  if (impactCache.has(season)) return impactCache.get(season);
  const model = readIfExists(path.join(DATA_DIR, 'impact-model.json'));
  const seasonsAll = [];
  for (let y = Number(season.slice(0, 4)) - DECAY_SPAN + 1; y <= Number(season.slice(0, 4)); y++) {
    const s = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    const rows = readIfExists(path.join(HIST_DIR, `lineups_${s}.json`))?.rows;
    if (rows) seasonsAll.push({ season: s, rows });
  }
  const own = readIfExists(path.join(HIST_DIR, `impact_${season}.json`))?.players;
  if (!model || !own || !seasonsAll.length) { impactCache.set(season, null); return null; }
  const dec = decayedApm(seasonsAll, {
    span: DECAY_SPAN, halfLife: DECAY_HALFLIFE, lambda: model.apmLambda ?? 6000,
  });
  const out = new Map();
  for (const p of own) {
    const v = impactOf(model, p, dec.get(p.playerId)?.apm ?? null);
    if (v !== null) out.set(p.playerId, v);
  }
  impactCache.set(season, out);
  return out;
}

const readIfExists = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

async function turnoverForSeason(season, priorSeason, useImpact = true) {
  const priorPlayers = await seasonPlayers(priorSeason);
  const priorAdv = await seasonTeamAdv(priorSeason);
  const teamIds = priorAdv.map((r) => r.TEAM_ID);
  const rosters = await seasonRosters(season, teamIds);

  // 把 IMP 贴到球员行上。贴不上（缺模型或历史文件）就退回 PIE 口径，
  // 于是这条支路测出来的就是旧行为，两者可以直接对比。
  const impMap = useImpact ? impactFor(priorSeason) : null;
  if (impMap) for (const p of priorPlayers) p.impact = impMap.get(p.playerId) ?? null;
  else for (const p of priorPlayers) delete p.impact;
  const basis = impMap ? VALUE_IMP : VALUE_PIE;

  // 上赛季各队实际阵容 -> 上赛季净效率，拟合换算系数
  const priorByTeam = new Map(teamIds.map((id) => [id, []]));
  for (const p of priorPlayers) {
    if (p.gp > 0) priorByTeam.get(p.teamId)?.push(p);
  }
  const fit = fitRosterImpact(priorAdv.map((r) => ({
    raw: rotationImpact(priorByTeam.get(r.TEAM_ID) ?? [], { basis }),
    net: Number(r.NET_RATING) || 0,
  })));

  // 新赛季名单（用上赛季的产出数据衡量）
  const statById = new Map(priorPlayers.map((p) => [p.playerId, p]));
  const deltas = new Map();
  for (const id of teamIds) {
    const now = (rosters[id] ?? []).map((pid) => statById.get(pid)).filter(Boolean);
    deltas.set(id, rotationImpact(now, { basis })
      - rotationImpact(priorByTeam.get(id) ?? [], { basis }));
  }
  const mean = [...deltas.values()].reduce((a, b) => a + b, 0) / deltas.size;

  const paceById = new Map(priorAdv.map((r) => [r.TEAM_ID, Number(r.PACE) || 100]));
  const pts = new Map();
  for (const [id, d] of deltas) {
    pts.set(id, fit.b * (d - mean) * (paceById.get(id) / 100));
  }
  return { pts, r2: fit.r2, basis: basis.name };
}

// ---------------------------------------------------------------- 指标

const erf = (x) => {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
const normalCdf = (x, sd) => 0.5 * (1 + erf(x / (sd * Math.SQRT2)));

/** 收集逐场预测，算出一组标准评估指标 */
function score(records) {
  const n = records.length;
  let correct = 0;
  let brier = 0;
  let logloss = 0;
  let marginAbs = 0;
  let marginErr = 0;
  // 10 个概率区间的校准统计
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pred: 0, actual: 0 }));

  for (const r of records) {
    const hit = (r.p >= 0.5) === r.homeWin;
    if (hit) correct += 1;
    const y = r.homeWin ? 1 : 0;
    brier += (r.p - y) ** 2;
    logloss += -(y * Math.log(Math.max(r.p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - r.p, 1e-9)));
    marginAbs += Math.abs(r.pred - r.actual);
    marginErr += r.pred - r.actual;
    const b = bins[Math.min(9, Math.floor(r.p * 10))];
    b.n += 1; b.pred += r.p; b.actual += y;
  }

  return {
    n,
    accuracy: correct / n,
    brier: brier / n,
    logloss: logloss / n,
    marginMae: marginAbs / n,
    marginBias: marginErr / n,
    calibration: bins.filter((b) => b.n > 0).map((b) => ({
      n: b.n,
      predicted: b.pred / b.n,
      actual: b.actual / b.n,
    })),
  };
}

// ---------------------------------------------------------------- 回测

/**
 * 重放一个赛季。
 * @param {object} opts
 *   inSeasonElo  是否在赛季中用真实结果滚动更新 Elo
 *   k            Elo 更新步长
 *   wElo/wNet    两个评级来源的权重
 *   spreadSd     分差标准差
 *   homeAdv      主场优势（分）
 */
async function replaySeason(season, priorSeason, opts) {
  const {
    inSeasonElo = false, k = 20, wElo = 0.55, wNet = 0.45,
    spreadSd = 12, homeAdv = 2.4, restWeight = 1, priorDecay = 0,
    turnoverWeight = 0, rotationBasis = 'imp',
  } = opts;

  const priorGames = buildGames(await seasonGames(priorSeason));
  const priorAdv = await seasonTeamAdv(priorSeason);
  const testGames = buildGames(await seasonGames(season));

  // 赛季前评级：只用 S-1 赛季的信息
  const eloStart = carryOver(computeElo(priorGames, { k }).final);
  const advById = new Map(priorAdv.map((r) => [r.TEAM_ID, r]));
  const leaguePace = priorAdv.reduce((s, r) => s + Number(r.PACE), 0) / priorAdv.length;

  const netPts = new Map();
  for (const r of priorAdv) {
    netPts.set(r.TEAM_ID, Number(r.NET_RATING) * (Number(r.PACE) / 100));
  }

  // 阵容更迭修正（turnoverWeight = 0 时完全不参与）
  const turnover = turnoverWeight
    ? (await turnoverForSeason(season, priorSeason, rotationBasis === 'imp')).pts
    : new Map();
  const getTurnover = (id) => (turnover.get(id) ?? 0) * turnoverWeight;

  const elo = new Map(Object.entries(eloStart).map(([id, v]) => [Number(id), v]));
  const getElo = (id) => elo.get(id) ?? ELO_BASE;
  const getNet = (id) => netPts.get(id) ?? 0;

  // 休息天数
  const REST_ADJ = { 0: -1.1, 1: 0, 2: 0.35, 3: 0.5 };
  const restAdjust = (d) => (d === null ? 0 : REST_ADJ[Math.min(d, 3)] ?? 0.5);
  const lastPlayed = new Map();
  const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

  const wSum = wElo + wNet || 1;
  const records = [];
  const played = new Map();          // teamId -> 已打场次
  const gp = (id) => played.get(id) ?? 0;

  // 按比赛日分组（testGames 已按日期排序）：同一天的预测都用当日开始时的评级 / 休息 / 场次，
  // 先全部记下，再统一更新，避免同日赛果泄漏给同日其他预测
  for (let i = 0; i < testGames.length;) {
    let j = i;
    while (j < testGames.length && testGames[j].date === testGames[i].date) j += 1;
    const day = testGames.slice(i, j);
    i = j;
    const today = dayNum(day[0].date);

    for (const g of day) {
      const restOf = (id) => {
        const prev = lastPlayed.get(id);
        return prev === undefined ? null : today - prev - 1;
      };
      const restPts = (restAdjust(restOf(g.home.teamId)) - restAdjust(restOf(g.away.teamId))) * restWeight;

      // priorDecay > 0 时，上赛季净效率的权重随本赛季场次累积而衰减：
      // 赛季初它是唯一可信的信息，打满一定场次后 Elo 已自带本赛季信息，再用就是拖累
      const strength = (id) => {
        const n = gp(id);
        const wn = priorDecay > 0 ? wNet * (priorDecay / (priorDecay + n)) : wNet;
        const ws = wElo + wn || 1;
        return (wElo * ((getElo(id) - ELO_BASE) / ELO_PER_POINT) + wn * getNet(id)) / ws
          + getTurnover(id);
      };
      const hca = g.neutral ? 0 : homeAdv;
      const margin = strength(g.home.teamId) - strength(g.away.teamId) + hca + restPts;
      const p = normalCdf(margin, spreadSd);

      records.push({
        p,
        homeWin: g.home.win,
        pred: margin,
        actual: g.home.pts - g.away.pts,
        date: g.date,
        teamGp: Math.min(gp(g.home.teamId), gp(g.away.teamId)),
      });
    }

    // 赛后用真实结果更新（当日预测都已记下，不存在信息泄漏；Elo 增量按当日开始时的评级算）
    const shifts = new Map();
    for (const g of day) {
      played.set(g.home.teamId, gp(g.home.teamId) + 1);
      played.set(g.away.teamId, gp(g.away.teamId) + 1);
      lastPlayed.set(g.home.teamId, today);
      lastPlayed.set(g.away.teamId, today);

      if (inSeasonElo) {
        const eh = getElo(g.home.teamId);
        const ea = getElo(g.away.teamId);
        const diff = eh + (g.neutral ? 0 : ELO_HOME_ADV) - ea;
        const expHome = 1 / (1 + 10 ** (-diff / 400));
        const mov = Math.abs(g.home.pts - g.away.pts);
        const winnerEloDiff = g.home.win ? diff : -diff;
        const movMult = ((mov + 3) ** 0.8) / (7.5 + 0.006 * winnerEloDiff);
        const shift = k * movMult * ((g.home.win ? 1 : 0) - expHome);
        shifts.set(g.home.teamId, (shifts.get(g.home.teamId) ?? 0) + shift);
        shifts.set(g.away.teamId, (shifts.get(g.away.teamId) ?? 0) - shift);
      }
    }
    for (const [id, d] of shifts) elo.set(id, getElo(id) + d);
  }
  return records;
}

const priorOf = (season) => {
  const y = Number(season.slice(0, 4));
  return `${y - 1}-${String(y % 100).padStart(2, '0')}`;
};

const pct = (v) => `${(v * 100).toFixed(2)}%`;

async function main() {
  const argv = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}$/.test(a));
  const seasons = argv.length ? argv : ['2022-23', '2023-24', '2024-25', '2025-26'];

  console.log(`\n回测赛季: ${seasons.join(', ')}\n`);

  const variants = [
    { name: '当前模型（评级冻结）', opts: { inSeasonElo: false } },
    { name: '滚动Elo＋纯Elo（基线）', opts: { inSeasonElo: true, wElo: 1, wNet: 0 } },
    // 阵容更迭修正到底有没有用？基线是当前默认配置（滚动Elo＋纯Elo）
    // 阵容更迭的球员价值口径：PIE 还是 IMP？两条支路同权重对比。
    { name: '＋阵容更迭 PIE w=0.15', opts: { inSeasonElo: true, wElo: 1, wNet: 0, turnoverWeight: 0.15, rotationBasis: 'pie' } },
    { name: '＋阵容更迭 IMP w=0.15', opts: { inSeasonElo: true, wElo: 1, wNet: 0, turnoverWeight: 0.15 } },
    { name: '＋阵容更迭 PIE w=0.4', opts: { inSeasonElo: true, wElo: 1, wNet: 0, turnoverWeight: 0.4, rotationBasis: 'pie' } },
    { name: '＋阵容更迭 IMP w=0.4', opts: { inSeasonElo: true, wElo: 1, wNet: 0, turnoverWeight: 0.4 } },
    { name: '＋阵容更迭 IMP w=0.8', opts: { inSeasonElo: true, wElo: 1, wNet: 0, turnoverWeight: 0.8 } },
  ];

  // 按赛季阶段分段：双方都还没打满 N 场时算"赛季初"
  const PHASES = [
    ['赛季初 (双方<10场)', (r) => r.teamGp < 10],
    ['赛季中 (10-40场)', (r) => r.teamGp >= 10 && r.teamGp < 40],
    ['赛季末 (≥40场)', (r) => r.teamGp >= 40],
  ];

  const results = [];
  for (const v of variants) {
    const all = [];
    for (const s of seasons) {
      all.push(...await replaySeason(s, priorOf(s), v.opts));
    }
    results.push({ name: v.name, records: all, ...score(all) });
  }

  console.log('\n' + '─'.repeat(96));
  console.log(
    '模型变体'.padEnd(30)
    + '场次'.padStart(8) + '胜负准确率'.padStart(12) + 'Brier'.padStart(10)
    + 'LogLoss'.padStart(10) + '分差MAE'.padStart(10) + '分差偏置'.padStart(10),
  );
  console.log('─'.repeat(96));
  for (const r of results) {
    console.log(
      r.name.padEnd(30)
      + String(r.n).padStart(8)
      + pct(r.accuracy).padStart(12)
      + r.brier.toFixed(4).padStart(10)
      + r.logloss.toFixed(4).padStart(10)
      + r.marginMae.toFixed(2).padStart(10)
      + (r.marginBias >= 0 ? '+' : '') + r.marginBias.toFixed(2).padStart(9),
    );
  }
  console.log('─'.repeat(96));
  console.log('Brier / LogLoss 越低越好；分差偏置接近 0 说明没有系统性高估或低估。\n');

  // 分阶段：赛季初可用信息最少，而应用当下正处在这个阶段
  const counts = PHASES.map(([, f]) => results[0].records.filter(f).length);
  console.log('按赛季阶段拆分  准确率 / Brier');
  console.log('  ' + '模型变体'.padEnd(28)
    + PHASES.map(([n], i) => `${n} n=${counts[i]}`.padStart(26)).join(''));
  for (const r of results) {
    const cells = PHASES.map(([, f]) => {
      const sub = score(r.records.filter(f));
      return `${pct(sub.accuracy)} / ${sub.brier.toFixed(4)}`.padStart(26);
    });
    console.log('  ' + r.name.padEnd(28) + cells.join(''));
  }
  console.log('');

  // 最好的那个变体看一下概率校准
  const best = results.filter((r) => !r.name.startsWith('基准线'))
    .sort((a, b) => a.brier - b.brier)[0];
  console.log(`概率校准（${best.name}）：`);
  console.log('  预测胜率区间     场次    模型说    实际是');
  for (const b of best.calibration) {
    const lo = Math.floor(b.predicted * 10) * 10;
    console.log(
      `  ${String(lo).padStart(3)}-${String(lo + 10).padStart(3)}%`.padEnd(18)
      + String(b.n).padStart(7)
      + pct(b.predicted).padStart(10)
      + pct(b.actual).padStart(10),
    );
  }
  console.log('');
}

main().catch((e) => { console.error('\n回测失败:', e); process.exit(1); });
