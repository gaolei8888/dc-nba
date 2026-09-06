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
  buildGames, computeElo, carryOver, ELO_BASE, ELO_HOME_ADV, ELO_PER_POINT,
} from '../server/ratings.mjs';

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

  for (const g of testGames) {
    const today = dayNum(g.date);
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
      return (wElo * ((getElo(id) - ELO_BASE) / ELO_PER_POINT) + wn * getNet(id)) / ws;
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
    played.set(g.home.teamId, gp(g.home.teamId) + 1);
    played.set(g.away.teamId, gp(g.away.teamId) + 1);

    lastPlayed.set(g.home.teamId, today);
    lastPlayed.set(g.away.teamId, today);

    // 赛后用真实结果更新 Elo（预测已经记下，不存在信息泄漏）
    if (inSeasonElo) {
      const eh = getElo(g.home.teamId);
      const ea = getElo(g.away.teamId);
      const diff = eh + (g.neutral ? 0 : ELO_HOME_ADV) - ea;
      const expHome = 1 / (1 + 10 ** (-diff / 400));
      const mov = Math.abs(g.home.pts - g.away.pts);
      const winnerEloDiff = g.home.win ? diff : -diff;
      const movMult = ((mov + 3) ** 0.8) / (7.5 + 0.006 * winnerEloDiff);
      const shift = k * movMult * ((g.home.win ? 1 : 0) - expHome);
      elo.set(g.home.teamId, eh + shift);
      elo.set(g.away.teamId, ea - shift);
    }
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
    { name: '滚动Elo＋固定混合', opts: { inSeasonElo: true } },
    { name: '滚动Elo＋纯Elo', opts: { inSeasonElo: true, wElo: 1, wNet: 0 } },
    { name: '滚动Elo＋先验衰减 d=10', opts: { inSeasonElo: true, priorDecay: 10 } },
    { name: '滚动Elo＋先验衰减 d=20', opts: { inSeasonElo: true, priorDecay: 20 } },
    { name: '滚动Elo＋先验衰减 d=30, K=28', opts: { inSeasonElo: true, priorDecay: 30, k: 28 } },
    // 隔离变量：冻结评级下，净效率项到底有没有用？
    { name: '冻结＋纯Elo（隔离对照）', opts: { inSeasonElo: false, wElo: 1, wNet: 0 } },
    { name: '冻结＋纯净效率（隔离对照）', opts: { inSeasonElo: false, wElo: 0, wNet: 1 } },
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
