/**
 * 模型实验室：可复用的回测引擎。
 *
 * scripts/backtest.mjs 是一次性的命令行工具，每次要现抓五个赛季。
 * 这里把同一套逻辑做成可按需调用的引擎，输入是一组参数、输出是**逐场记录**——
 * 有了逐场记录，误差分析、主场优势逐年测量、用户自建模型打分
 * 都只是在同一份输出上做不同的切片，不需要各写一遍重放。
 *
 * 数据来自 data/backtest.json（ingest 阶段压好，约 480KB）。
 */
import { computeElo, carryOver, ELO_BASE, ELO_HOME_ADV, ELO_PER_POINT } from './ratings.mjs';

const erf = (x) => {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
export const normalCdf = (x, sd) => 0.5 * (1 + erf(x / (sd * Math.SQRT2)));

const REST_ADJ = { 0: -1.1, 1: 0, 2: 0.35, 3: 0.5 };
export const restAdjust = (d) => (d === null ? 0 : REST_ADJ[Math.min(d, 3)] ?? 0.5);

/** 美式赔率 -> 隐含概率（含抽水） */
const mlProb = (ml) => (ml === null || ml === undefined
  ? null
  : (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100)));

/**
 * 市场对主队胜率的判断。
 *
 * 优先用两边的钱线去掉抽水：博彩公司两边的隐含概率加起来大于 1，
 * 多出来的那部分是抽水，按比例摊掉才是市场的真实判断。
 * 没有钱线时退回让分——用与模型同一个 spreadSd 把让分折成概率，
 * 这样两边是同一把尺子，比较才公平。
 */
export function marketProb(odds, spreadSd) {
  const h = mlProb(odds.homeMl);
  const a = mlProb(odds.awayMl);
  if (h !== null && a !== null && h + a > 0) return h / (h + a);
  return normalCdf(-odds.spread, spreadSd);
}

/** 紧凑格式 -> buildGames 那种结构 */
export function expand(rows) {
  return rows
    .map((g) => {
      const home = g.s.find((x) => x[2] === 1);
      const away = g.s.find((x) => x[2] === 0);
      // 中立场两边都标客场，主客顺序仅为占位；缺的一边取「另一行」，
      // 否则 away 和 H 都会落到第一行，变成「同一队对自己」
      const H = home ?? g.s.find((x) => x !== away);
      const A = away ?? g.s.find((x) => x !== H);
      if (!H || !A) return null;
      // o = [主队让分, 总分, 主队美式赔率, 客队美式赔率]，抓过盘口才有
      const [spread, total, homeMl, awayMl] = g.o ?? [];
      return {
        gameId: g.i,
        date: g.d,
        neutral: !home || !away,
        home: { teamId: H[0], pts: H[1], win: H[1] > A[1] },
        away: { teamId: A[0], pts: A[1], win: A[1] > H[1] },
        odds: g.o ? { spread, total: total ?? null, homeMl: homeMl ?? null, awayMl: awayMl ?? null } : null,
      };
    })
    .filter(Boolean)
    .sort((x, y) => (x.date === y.date ? x.gameId.localeCompare(y.gameId) : x.date.localeCompare(y.date)));
}

export const DEFAULTS = {
  wElo: 1,
  wNet: 0,
  k: 20,
  homeAdv: 1.6,
  spreadSd: 12,
  restWeight: 1.8,
  carryKeep: 0.75,
  inSeasonElo: 1,
  /**
   * 反事实：给某些球队在赛季开始时加/减实力（单位：每场净胜分）。
   * 形如 { 1610612749: 3 } 表示"假如雄鹿强 3 分"。
   * 加成是**全季持续**的，不是开局送一次。
   * 曾经把它加在开赛日 Elo 上，但赛季中的滚动更新会用真实结果把它拉回去——
   * +3 分只换来 +2.4 胜，因为加成被真实战绩冲掉了。而用户问"假如这队强 3 分"
   * 想问的是"它真的强 3 分"，所以要在每一场的实力计算里都加上。
   */
  teamBoost: null,
};

/**
 * 重放若干赛季，返回逐场记录。
 * 每条记录都带着做误差分析所需的上下文（休息、Elo 差、是否冷门等）。
 */
export function replay(dataset, seasons, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const records = [];

  for (const season of seasons) {
    const rows = dataset.seasons[season];
    const prior = priorOf(season);
    const priorRows = dataset.seasons[prior];
    if (!rows || !priorRows) continue;

    const games = expand(rows);
    const priorGames = expand(priorRows);

    const eloStart = carryOver(computeElo(priorGames, { k: p.k }).final, { keep: p.carryKeep });
    const elo = new Map(Object.entries(eloStart).map(([id, v]) => [Number(id), v]));
    const boost = p.teamBoost
      ? new Map(Object.entries(p.teamBoost).map(([k, v]) => [Number(k), Number(v)]))
      : null;
    const getElo = (id) => elo.get(id) ?? ELO_BASE;

    const adv = dataset.teamAdv[prior] ?? [];
    const netPts = new Map(adv.map((r) => [r.t, (Number(r.n) || 0) * ((Number(r.p) || 100) / 100)]));

    const lastPlayed = new Map();
    const played = new Map();
    const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);
    const wSum = p.wElo + p.wNet || 1;

    for (const g of games) {
      const today = dayNum(g.date);
      const restOf = (id) => {
        const prev = lastPlayed.get(id);
        return prev === undefined ? null : today - prev - 1;
      };
      const restHome = restOf(g.home.teamId);
      const restAway = restOf(g.away.teamId);
      const restPts = (restAdjust(restHome) - restAdjust(restAway)) * p.restWeight;

      const strength = (id) => (p.wElo * ((getElo(id) - ELO_BASE) / ELO_PER_POINT)
        + p.wNet * (netPts.get(id) ?? 0)) / wSum
        + (boost?.get(id) ?? 0);

      const eloDiff = getElo(g.home.teamId) - getElo(g.away.teamId);
      const hca = g.neutral ? 0 : p.homeAdv;
      const margin = strength(g.home.teamId) - strength(g.away.teamId) + hca + restPts;
      const prob = normalCdf(margin, p.spreadSd);
      const actual = g.home.pts - g.away.pts;

      records.push({
        season,
        date: g.date,
        homeId: g.home.teamId,
        awayId: g.away.teamId,
        p: prob,
        homeWin: g.home.win,
        pred: margin,
        actual,
        // 误差分析用的上下文
        restHome,
        restAway,
        b2bHome: restHome === 0,
        b2bAway: restAway === 0,
        eloDiff,
        teamGp: Math.min(played.get(g.home.teamId) ?? 0, played.get(g.away.teamId) ?? 0),
        neutral: g.neutral,
        // 冷门 = 模型看好的一方输了
        upset: (prob >= 0.5) !== g.home.win,
        // 盘口：mktPred 与我们的 pred 同向（主队预期净胜分），方便直接相减
        mktPred: g.odds ? -g.odds.spread : null,
        mktTotal: g.odds?.total ?? null,
        mktProb: g.odds ? marketProb(g.odds, p.spreadSd) : null,
        // 原始钱线 [主, 客]：平注回测要按真实（含抽水）价格结算
        ml: g.odds ? [g.odds.homeMl, g.odds.awayMl] : null,
      });

      played.set(g.home.teamId, (played.get(g.home.teamId) ?? 0) + 1);
      played.set(g.away.teamId, (played.get(g.away.teamId) ?? 0) + 1);
      lastPlayed.set(g.home.teamId, today);
      lastPlayed.set(g.away.teamId, today);

      if (p.inSeasonElo) {
        const eh = getElo(g.home.teamId);
        const ea = getElo(g.away.teamId);
        const diff = eh + (g.neutral ? 0 : ELO_HOME_ADV) - ea;
        const expHome = 1 / (1 + 10 ** (-diff / 400));
        const mov = Math.abs(actual);
        const winnerEloDiff = g.home.win ? diff : -diff;
        const movMult = ((mov + 3) ** 0.8) / (7.5 + 0.006 * winnerEloDiff);
        const shift = p.k * movMult * ((g.home.win ? 1 : 0) - expHome);
        elo.set(g.home.teamId, eh + shift);
        elo.set(g.away.teamId, ea - shift);
      }
    }
  }
  return records;
}

export function priorOf(season) {
  const y = Number(season.slice(0, 4));
  return `${y - 1}-${String(y % 100).padStart(2, '0')}`;
}

const r4 = (v) => Math.round(v * 10000) / 10000;

/** 一组记录的标准指标 */
export function score(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  let correct = 0; let brier = 0; let logloss = 0; let mae = 0; let bias = 0;
  for (const r of rows) {
    if ((r.p >= 0.5) === r.homeWin) correct += 1;
    const y = r.homeWin ? 1 : 0;
    brier += (r.p - y) ** 2;
    logloss += -(y * Math.log(Math.max(r.p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - r.p, 1e-9)));
    mae += Math.abs(r.pred - r.actual);
    bias += r.pred - r.actual;
  }
  return {
    n,
    accuracy: r4(correct / n),
    brier: r4(brier / n),
    logloss: r4(logloss / n),
    marginMae: r4(mae / n),
    marginBias: r4(bias / n),
  };
}

/** 概率校准：10 档，看"模型说 70%"的那些比赛实际赢了多少 */
export function calibration(rows) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pred: 0, actual: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r.p * 10))];
    b.n += 1; b.pred += r.p; b.actual += r.homeWin ? 1 : 0;
  }
  return bins
    .map((b, i) => ({
      lo: i * 10,
      hi: i * 10 + 10,
      n: b.n,
      predicted: b.n ? r4(b.pred / b.n) : null,
      actual: b.n ? r4(b.actual / b.n) : null,
    }))
    .filter((b) => b.n > 0);
}

/** 从逐场记录累计出战绩表，反事实重放靠它看"结果变了多少" */
export function standings(rows) {
  const t = new Map();
  const get = (id) => {
    if (!t.has(id)) t.set(id, { teamId: id, w: 0, l: 0, pf: 0, pa: 0 });
    return t.get(id);
  };
  for (const r of rows) {
    const h = get(r.homeId);
    const a = get(r.awayId);
    if (r.homeWin) { h.w += 1; a.l += 1; } else { h.l += 1; a.w += 1; }
    h.pf += 0; a.pf += 0;
  }
  return [...t.values()].sort((x, y) => y.w - x.w);
}

/**
 * 反事实重放：给某队加减实力，看整个赛季重跑后会怎样。
 *
 * 注意这里改的是**模型对该队的评级**，不是真实结果——所以得到的是
 * "模型认为会怎样"，而不是"历史真的会怎样"。真实结果无法反事实，
 * 这一点在界面上要说清楚。
 */
export function counterfactual(dataset, seasons, teamId, deltaPts, opts = {}) {
  const base = replay(dataset, seasons, opts);
  const alt = replay(dataset, seasons, { ...opts, teamBoost: { [teamId]: deltaPts } });

  const games = base.filter((r) => r.homeId === teamId || r.awayId === teamId);
  const altGames = alt.filter((r) => r.homeId === teamId || r.awayId === teamId);

  // 用模型胜率的期望胜场来比较，比"抽样结果"稳定
  const expWins = (rows) => rows.reduce(
    (s, r) => s + (r.homeId === teamId ? r.p : 1 - r.p), 0,
  );
  const flipped = games.filter((r, i) => {
    const b = r.homeId === teamId ? r.p >= 0.5 : r.p < 0.5;
    const a2 = altGames[i];
    const a = a2 && (a2.homeId === teamId ? a2.p >= 0.5 : a2.p < 0.5);
    return b !== a;
  }).length;

  return {
    teamId,
    deltaPts,
    n: games.length,
    baseExpectedWins: Math.round(expWins(games) * 10) / 10,
    altExpectedWins: Math.round(expWins(altGames) * 10) / 10,
    winsDelta: Math.round((expWins(altGames) - expWins(games)) * 10) / 10,
    flippedGames: flipped,
  };
}

// ---------------------------------------------------------------- 误差分析

/** 把记录按若干条件切片，逐片算指标——用来找模型在哪类比赛上系统性犯错 */
export function slices(rows) {
  const defs = [
    ['背靠背 · 主队', (r) => r.b2bHome && !r.b2bAway],
    ['背靠背 · 客队', (r) => r.b2bAway && !r.b2bHome],
    ['双方都背靠背', (r) => r.b2bHome && r.b2bAway],
    ['双方都休息充分', (r) => (r.restHome ?? 9) >= 2 && (r.restAway ?? 9) >= 2],
    ['实力接近 (Elo 差<50)', (r) => Math.abs(r.eloDiff) < 50],
    ['实力悬殊 (Elo 差>200)', (r) => Math.abs(r.eloDiff) > 200],
    ['模型很有把握 (>75%)', (r) => Math.max(r.p, 1 - r.p) > 0.75],
    ['模型没把握 (<60%)', (r) => Math.max(r.p, 1 - r.p) < 0.6],
    ['赛季初 (<10场)', (r) => r.teamGp < 10],
    ['赛季末 (≥60场)', (r) => r.teamGp >= 60],
    ['中立场', (r) => r.neutral],
  ];
  const all = score(rows);
  return defs
    .map(([label, f]) => {
      const sub = rows.filter(f);
      if (!sub.length) return null;
      const s = score(sub);
      return {
        label,
        ...s,
        // 相对整体的偏离：正数表示这一片比平均更准
        accuracyDelta: r4(s.accuracy - all.accuracy),
        brierDelta: r4(s.brier - all.brier),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.brierDelta - a.brierDelta);
}

// ---------------------------------------------------------------- 逐年测量

/**
 * 逐赛季拟合"最优主场优势"：在给定其它参数下，让分差偏置归零的那个值。
 *
 * 做法很直接——模型的预测分差里已经含了一个假定的主场优势，
 * 把实际分差与预测分差的平均差异加回去，就是这个赛季真实的主场优势。
 */
export function homeAdvantageBySeason(dataset, seasons, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  return seasons.map((season) => {
    const rows = replay(dataset, [season], { ...p, homeAdv: 0 });
    const real = rows.filter((r) => !r.neutral);
    if (!real.length) return null;
    // 预测里不含主场优势时，实际分差减预测分差的均值就是主场优势
    const fitted = real.reduce((s, r) => s + (r.actual - r.pred), 0) / real.length;
    const homeWinPct = real.filter((r) => r.homeWin).length / real.length;
    return {
      season,
      n: real.length,
      homeAdvantage: r4(fitted),
      homeWinPct: r4(homeWinPct),
    };
  }).filter(Boolean);
}

/** 逐个休息天数档位测量真实收益，用来检验我们写死的那张表对不对 */
export function restEffect(dataset, seasons, opts = {}) {
  const rows = replay(dataset, seasons, { ...opts, restWeight: 0, homeAdv: 0 });
  const buckets = new Map();
  for (const r of rows) {
    if (r.neutral) continue;
    for (const [days, sign] of [[r.restHome, 1], [r.restAway, -1]]) {
      if (days === null) continue;
      const k = Math.min(days, 4);
      if (!buckets.has(k)) buckets.set(k, { n: 0, sum: 0 });
      const b = buckets.get(k);
      b.n += 1;
      // 残差里剩下的就是休息带来的影响
      b.sum += sign * (r.actual - r.pred);
    }
  }
  const all = [...buckets.values()].reduce((s, b) => s + b.sum, 0)
    / [...buckets.values()].reduce((s, b) => s + b.n, 0);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([days, b]) => ({
      days,
      n: b.n,
      // 相对全体平均的偏离，才是"休息这么多天"的净效应
      effect: r4(b.sum / b.n - all),
    }));
}

// ---------------------------------------------------------------- 对标盘口

/** -110 的抽水下，长期打平需要的胜率 */
export const BREAK_EVEN = 110 / 210;   // 0.5238

/**
 * McNemar 检验：两个预测器在**同一批**比赛上比高下，只看它们判断不同的那些场次。
 *
 * 为什么不能直接比命中率：66.3% 和 68.4% 看着差 2 个百分点，
 * 但两边共享绝大多数容易的比赛，那部分对比较毫无信息量。
 * 只有"一个对一个错"的场次才是证据。chi2 > 3.84 相当于 p < 0.05。
 */
export function mcnemar(rows) {
  let onlyModel = 0; let onlyMarket = 0;
  for (const r of rows) {
    const m = (r.p >= 0.5) === r.homeWin;
    const k = (r.mktProb >= 0.5) === r.homeWin;
    if (m && !k) onlyModel += 1;
    else if (!m && k) onlyMarket += 1;
  }
  const n = onlyModel + onlyMarket;
  // 带连续性校正
  const chi2 = n ? ((Math.abs(onlyModel - onlyMarket) - 1) ** 2) / n : 0;
  return {
    onlyModel, onlyMarket, chi2: r4(chi2), significant: chi2 > 3.84,
  };
}

const EDGE_BUCKETS = [
  ['0 ~ 1 分', 0, 1],
  ['1 ~ 2 分', 1, 2],
  ['2 ~ 3 分', 2, 3],
  ['3 ~ 5 分', 3, 5],
  ['5 分以上', 5, Infinity],
];

/**
 * 拿模型和博彩收盘盘口正面比较。
 *
 * 为什么值得做：盘口是市场共识，是公开可得的最强对手之一。
 * 拿它当标尺，比我自己拍脑袋调参数可靠得多——之前"阵容更迭权重"
 * 就是靠回测才发现调错了方向。
 *
 * 三件事分开看，别混：
 *   1) 胜负预测谁更准（同一批比赛上直接对比）
 *   2) 分差预测谁更接近（MAE 与偏置）
 *   3) 模型跟盘口分歧时，谁对得更多——这是唯一能变成"下注建议"的部分，
 *      而且必须跟 52.38% 的打平线比，不能跟 50% 比。
 */
export function market(rows) {
  const withMkt = rows.filter((r) => r.mktPred !== null && r.mktPred !== undefined);
  if (!withMkt.length) {
    return { available: false, n: 0, coverage: 0 };
  }

  const modelScore = score(withMkt);
  // 把市场概率当成"另一个模型"的预测，用同一套指标打分
  const marketRows = withMkt.map((r) => ({
    ...r, p: r.mktProb, pred: r.mktPred,
  }));
  const marketScore = score(marketRows);

  // ---- 一致 / 分歧
  let agree = 0; let agreeRight = 0;
  let disagree = 0; let modelRight = 0; let marketRight = 0;
  for (const r of withMkt) {
    const mSide = r.p >= 0.5;
    const kSide = r.mktProb >= 0.5;
    if (mSide === kSide) {
      agree += 1;
      if (mSide === r.homeWin) agreeRight += 1;
    } else {
      disagree += 1;
      if (mSide === r.homeWin) modelRight += 1;
      if (kSide === r.homeWin) marketRight += 1;
    }
  }

  // ---- 让分盘（ATS）：模型相对盘口选边，结果按实际分差有没有过盘算
  const atsOf = (subset) => {
    let win = 0; let lose = 0; let push = 0;
    for (const r of subset) {
      const edge = r.pred - r.mktPred;
      if (edge === 0) { push += 1; continue; }
      const cover = r.actual - r.mktPred;
      if (cover === 0) { push += 1; continue; }
      if ((edge > 0) === (cover > 0)) win += 1; else lose += 1;
    }
    const decided = win + lose;
    return {
      n: subset.length,
      win,
      lose,
      push,
      rate: decided ? r4(win / decided) : null,
      // 相对打平线的净胜率，正数才是真的有优势
      edgeOverBreakEven: decided ? r4(win / decided - BREAK_EVEN) : null,
    };
  };

  const byEdge = EDGE_BUCKETS.map(([label, lo, hi]) => {
    const sub = withMkt.filter((r) => {
      const e = Math.abs(r.pred - r.mktPred);
      return e >= lo && e < hi;
    });
    return sub.length ? { label, ...atsOf(sub) } : null;
  }).filter(Boolean);

  const seasons = [...new Set(withMkt.map((r) => r.season))].sort();
  const bySeason = seasons.map((s) => {
    const sub = withMkt.filter((r) => r.season === s);
    const mk = sub.map((r) => ({ ...r, p: r.mktProb, pred: r.mktPred }));
    const m = score(sub); const k = score(mk);
    return {
      season: s,
      n: sub.length,
      modelAccuracy: m.accuracy,
      marketAccuracy: k.accuracy,
      accuracyGap: r4(m.accuracy - k.accuracy),
      modelMae: m.marginMae,
      marketMae: k.marginMae,
      ats: atsOf(sub).rate,
      significant: mcnemar(sub).significant,
    };
  });

  // ---- 模型在哪类比赛上被盘口拉开差距
  const gapSlices = [
    ['背靠背相关', (r) => r.b2bHome || r.b2bAway],
    ['实力接近 (Elo 差<50)', (r) => Math.abs(r.eloDiff) < 50],
    ['实力悬殊 (Elo 差>200)', (r) => Math.abs(r.eloDiff) > 200],
    ['赛季初 (<10场)', (r) => r.teamGp < 10],
    ['赛季末 (≥60场)', (r) => r.teamGp >= 60],
  ].map(([label, f]) => {
    const sub = withMkt.filter(f);
    if (sub.length < 30) return null;
    const mk = sub.map((r) => ({ ...r, p: r.mktProb, pred: r.mktPred }));
    const m = score(sub); const k = score(mk);
    return {
      label,
      n: sub.length,
      modelAccuracy: m.accuracy,
      marketAccuracy: k.accuracy,
      accuracyGap: r4(m.accuracy - k.accuracy),
      modelMae: m.marginMae,
      marketMae: k.marginMae,
      maeGap: r4(m.marginMae - k.marginMae),
    };
  }).filter(Boolean).sort((a, b) => a.accuracyGap - b.accuracyGap);

  return {
    available: true,
    n: withMkt.length,
    coverage: r4(withMkt.length / rows.length),
    model: modelScore,
    marketModel: marketScore,
    accuracyGap: r4(modelScore.accuracy - marketScore.accuracy),
    maeGap: r4(modelScore.marginMae - marketScore.marginMae),
    mcnemar: mcnemar(withMkt),
    agreement: {
      agree,
      agreeAccuracy: agree ? r4(agreeRight / agree) : null,
      disagree,
      disagreeRate: r4(disagree / withMkt.length),
      modelRight,
      marketRight,
      modelWinsWhenDisagree: disagree ? r4(modelRight / disagree) : null,
    },
    ats: { all: atsOf(withMkt), byEdge, breakEven: r4(BREAK_EVEN) },
    bySeason,
    gapSlices,
  };
}
