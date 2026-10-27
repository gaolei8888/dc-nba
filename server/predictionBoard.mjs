/**
 * 预测总表：把本季常规赛的赛前预测与真实结果汇总成成绩单。
 *
 * 只做聚合，不碰模型——输入就是 predictSchedule 的输出（已结束的比赛已用赛前 Elo 重算），
 * 这样总表上的每个胜率都和赛程页同一场一模一样。
 */

/** 准确率的 Wilson 区间。几十场的样本用正态近似会冲出 [0,1]，Wilson 不会。 */
export function wilson(k, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { lo: Math.max(0, c - m), hi: Math.min(1, c + m) };
}

/** rows: [{ p: 主队胜率, y: 主队赢了 ? 1 : 0 }] */
export function score(rows) {
  const n = rows.length;
  const hits = rows.filter((r) => (r.p >= 0.5) === (r.y === 1)).length;
  const mean = (f) => (n ? rows.reduce((s, r) => s + f(r), 0) / n : null);
  return {
    n,
    hits,
    acc: n ? hits / n : null,
    ci: wilson(hits, n),
    brier: mean((r) => (r.p - r.y) ** 2),
    logLoss: mean((r) => -Math.log(Math.max(r.y ? r.p : 1 - r.p, 1e-9))),
  };
}

/** 只有命中数的基准线（全押主队之类），没有概率可打分 */
const tally = (hits, n) => ({ n, hits, acc: n ? hits / n : null, ci: wilson(hits, n) });

const BUCKETS = [[0.5, 0.6, '50–60%'], [0.6, 0.7, '60–70%'], [0.7, 0.8, '70–80%'], [0.8, 1.01, '80%+']];
const confOf = (p) => Math.max(p, 1 - p);
const inBucket = ([lo, hi]) => (p) => confOf(p) >= lo && confOf(p) < hi;

/** 校准：按信心 max(p,1-p) 分档，看「说七成」的比赛是不是真的赢了七成 */
export function buckets(rows) {
  return BUCKETS.map((b) => {
    const list = rows.filter((r) => inBucket(b)(r.p));
    const s = score(list);
    return {
      label: b[2], n: s.n, hits: s.hits, acc: s.acc,
      conf: s.n ? list.reduce((t, r) => t + confOf(r.p), 0) / s.n : null,
    };
  });
}

/** 按任意维度统计命中率；keysOf 可返回多个键（一场比赛同时属于两支球队） */
export function hitRateBy(rows, keysOf) {
  const map = new Map();
  for (const r of rows) {
    for (const key of [keysOf(r)].flat()) {
      const e = map.get(key) ?? { key, n: 0, hits: 0 };
      e.n += 1;
      if (r.hit) e.hits += 1;
      map.set(key, e);
    }
  }
  return [...map.values()].map((e) => ({ ...e, acc: e.hits / e.n }));
}

/** 分差、总分、单队得分的平均绝对误差与偏置（预测 − 实际） */
function errors(rows) {
  const n = rows.length;
  const mean = (f) => (n ? rows.reduce((s, g) => s + f(g), 0) / n : null);
  const margin = (g) => g.prediction.margin - (g.homeScore - g.awayScore);
  const total = (g) => g.prediction.total - (g.homeScore + g.awayScore);
  return {
    n,
    marginMae: mean((g) => Math.abs(margin(g))),
    marginBias: mean(margin),
    totalMae: mean((g) => Math.abs(total(g))),
    totalBias: mean(total),
    scoreMae: mean((g) => (Math.abs(g.prediction.homeScore - g.homeScore)
      + Math.abs(g.prediction.awayScore - g.awayScore)) / 2),
  };
}

/** 切片：每组都给样本量，几场的切片别当结论 */
const SPLITS = [
  ['看好哪边', [['看好主队', (g) => g.p >= 0.5], ['看好客队', (g) => g.p < 0.5]]],
  ['实际分差', [
    ['≤5 分', (g) => Math.abs(g.homeScore - g.awayScore) <= 5],
    ['6–14 分', (g) => { const m = Math.abs(g.homeScore - g.awayScore); return m > 5 && m < 15; }],
    ['≥15 分', (g) => Math.abs(g.homeScore - g.awayScore) >= 15],
  ]],
  ['休息情况', [
    ['有一方背靠背', (g) => g.prediction.restHome === 0 || g.prediction.restAway === 0],
    ['双方都不是背靠背', (g) => g.prediction.restHome > 0 && g.prediction.restAway > 0],
    ['休息信息缺失（含揭幕战）', (g) => g.prediction.restHome == null || g.prediction.restAway == null],
  ]],
];

/** 已结束比赛里至少这么多场有盘口，才和市场对照 */
export const MIN_MARKET = 20;
/** 「爆冷」清单的门槛：赛前信心至少这么高却猜错 */
export const MISS_CONF = 0.65;

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const cnDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}月${d}日`; };
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const slim = (g) => ({
  gameId: g.gameId, date: g.date, homeId: g.homeId, awayId: g.awayId,
  homeScore: g.homeScore, awayScore: g.awayScore, p: g.p, conf: g.conf,
});

/**
 * @param games  predictSchedule 的输出（可带 market），只放常规赛
 * @param teamName  teamId -> 中文队名
 */
export function buildBoard(games, { teamName, weekDays = 7, upcomingDays = 30 } = {}) {
  const completed = games.filter((g) => g.hit !== undefined).map((g) => {
    const p = g.prediction.homeWinProb;
    const homeWin = g.homeScore > g.awayScore;
    const mp = g.market?.homeProb;
    return {
      ...g, p, y: homeWin ? 1 : 0, conf: confOf(p), homeWin,
      marketHit: mp == null ? null : (mp >= 0.5) === homeWin,
    };
  });
  const overall = score(completed);
  const hi = completed.filter((g) => g.conf >= 0.7);
  const highConf = { n: hi.length, hits: hi.filter((g) => g.hit).length };
  const withMkt = completed.filter((g) => g.marketHit !== null);
  // 盘口覆盖太少时整列都是「—」，不如不显示、在总结里说一句
  const market = {
    n: withMkt.length,
    shown: withMkt.length >= MIN_MARKET,
    model: score(withMkt),
    market: score(withMkt.map((g) => ({ p: g.market.homeProb, y: g.y }))),
  };
  const misses = completed.filter((g) => !g.hit && g.conf >= MISS_CONF).sort((a, b) => b.conf - a.conf);
  const upset = completed.filter((g) => !g.hit).sort((a, b) => b.conf - a.conf)[0] ?? null;
  const homeWins = completed.filter((g) => g.homeWin).length;
  const homeWinRate = overall.n ? homeWins / overall.n : null;
  const withElo = completed.filter((g) => g.preElo);
  const baselines = [
    { key: 'model', label: '我们的模型', ...tally(overall.hits, overall.n) },
    { key: 'home', label: '全押主队', ...tally(homeWins, overall.n) },
    { key: 'elo', label: '赛前 Elo 高的一方（不计主场）',
      ...tally(withElo.filter((g) => (g.preElo.home >= g.preElo.away) === g.homeWin).length, withElo.length) },
  ];
  const err = errors(completed);
  let cumN = 0; let cumHits = 0;
  const byDate = hitRateBy(completed, (g) => g.date).sort((a, b) => a.key.localeCompare(b.key))
    .map((d) => { cumN += d.n; cumHits += d.hits; return { ...d, cumN, cumHits, cumAcc: cumHits / cumN }; });

  const pending = games.filter((g) => g.homeScore == null);
  const d0 = pending[0]?.date;
  const upcoming = d0 ? pending.filter((g) => g.date < addDays(d0, upcomingDays)) : [];
  const week = d0 ? pending.filter((g) => g.date < addDays(d0, weekDays)) : [];
  const pp = pending.map((g) => g.prediction.homeWinProb);
  const upcomingDist = {
    n: pending.length,
    tossups: pp.filter((p) => confOf(p) < 0.55).length,
    buckets: BUCKETS.map((b) => ({ label: b[2], n: pp.filter(inBucket(b)).length })),
  };

  // ---- 文字总结：每个数字都从上面算出来，不写死
  const summary = [];
  if (!overall.n) {
    summary.push('本季常规赛还没有已结束的比赛，下面只有赛前预测。');
  } else {
    const { n, hits, acc, ci, brier, logLoss } = overall;
    summary.push(`本季常规赛已结束 ${n} 场，我们的模型赛前猜对 ${hits} 场、猜错 ${n - hits} 场，`
      + `准确率 ${pct(acc)}（95% 置信区间 ${pct(ci.lo, 0)}–${pct(ci.hi, 0)}），`
      + `Brier ${brier.toFixed(3)}、对数损失 ${logLoss.toFixed(3)}（每场都报 50% 分别是 0.250 和 0.693，越低越好）。`);
    if (n < 300) {
      summary.push(`样本只有 ${n} 场，95% 区间横跨 ${Math.round((ci.hi - ci.lo) * 100)} 个百分点：`
        + '这个准确率还说明不了模型强还是弱，要几百场才看得清。');
    }
    const [, home, elo] = baselines;
    summary.push(`同一批比赛上，全押主队能猜对 ${home.hits} 场（${pct(home.acc, 0)}）`
      + (elo.n ? `，只看赛前 Elo 高低能猜对 ${elo.hits} 场（${pct(elo.acc, 0)}）` : '')
      + `；预测分差平均差 ${err.marginMae.toFixed(1)} 分，总分平均差 ${err.totalMae.toFixed(1)} 分。`);
    summary.push(highConf.n
      ? `高信心（≥70%）的比赛 ${highConf.n} 场，猜对 ${highConf.hits} 场（${pct(highConf.hits / highConf.n, 0)}）。`
      : '还没有赛前信心达到 70% 的比赛。');
    if (upset) {
      const winH = upset.homeWin;
      const w = teamName(winH ? upset.homeId : upset.awayId);
      const l = teamName(winH ? upset.awayId : upset.homeId);
      summary.push(`最大冷门：${cnDate(upset.date)} ${w} ${winH ? '主场' : '客场'}击败 ${l}，`
        + `赛前我们只给 ${w} ${pct(1 - upset.conf, 0)} 的胜率。`);
    }
    summary.push(market.shown
      ? `仅作参考：其中 ${market.n} 场有盘口快照，这批比赛我们猜对 ${market.model.hits} 场，盘口热门胜出 ${market.market.hits} 场。`
      : market.n
        ? `已结束的比赛里只有 ${market.n} 场有盘口快照，太少，暂不和市场对照。`
        : '已结束的比赛里还没有盘口记录（目前的盘口快照只覆盖未开打的比赛），暂时无法和市场对照。');
  }
  if (week.length) {
    const best = [...week].sort((a, b) => confOf(b.prediction.homeWinProb) - confOf(a.prediction.homeWinProb))[0];
    const p = best.prediction.homeWinProb;
    const fav = p >= 0.5 ? best.homeId : best.awayId;
    summary.push(`接下来 7 天还有 ${week.length} 场常规赛，最有把握的一场是 `
      + `${teamName(best.awayId)} 客场对 ${teamName(best.homeId)}（${cnDate(best.date)}），看好 ${teamName(fav)}（${pct(confOf(p), 0)}）。`);
  } else {
    summary.push('常规赛已经没有未开打的比赛。');
  }

  return {
    summary,
    overall,
    errors: err,
    highConf,
    homeWinRate,
    baselines,
    upset: upset && slim(upset),
    misses: misses.map(slim),
    market,
    buckets: buckets(completed),
    splits: SPLITS.map(([title, defs]) => ({
      title,
      rows: defs.map(([label, f]) => ({ label, ...score(completed.filter(f)) })),
    })),
    byDate,
    byTeam: hitRateBy(completed, (g) => [g.homeId, g.awayId]).sort((a, b) => b.acc - a.acc || b.n - a.n),
    completed: completed.reverse().map(({ y, ...g }) => g),
    upcoming,
    upcomingWeek: week.length,
    upcomingDist,
  };
}
