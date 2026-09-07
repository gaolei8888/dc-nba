/**
 * 预测引擎。
 *
 * 思路：把每支球队折算成一个"相对联盟平均的每场净胜分"实力值，来源有四块——
 *   1. Elo：上赛季逐场结果推出的球队强度，赛季间向均值回归 25%
 *   2. 净效率：上赛季百回合净效率，按节奏折算成每场分差
 *   3. 阵容更迭：新赛季名单与上赛季名单的轮换影响力之差（转会、签约、离队）
 *   4. 缺阵修正：把指定球员移出轮换后重算影响力
 * 再叠加主场优势与背靠背/休息天数修正，得到预期分差；
 * 用正态分布（NBA 单场分差对盘口的标准差约 12 分）转成胜率。
 * 比分则由双方进攻/防守效率与节奏推出总分后按分差拆分。
 */
import {
  ELO_BASE, ELO_PER_POINT, rotationImpact, totalMinutes, healthyMinutes,
  VALUE_IMP, VALUE_PIE,
} from './ratings.mjs';

/** 默认可调参数，前端可覆盖。 */
export const DEFAULT_PARAMS = {
  // 回测（2022-23~2025-26，4920 场）结论：Elo 能滚动吸收本赛季结果后，
  // 上赛季净效率项不再提供增量信息，纯 Elo 在赛季初/中/末三个阶段都更准。
  // 滑块保留，想混合回去随时可以。
  wElo: 1.0,            // Elo 权重
  wNet: 0.0,            // 上赛季净效率权重
  // 实测校准，不是拍脑袋。逐赛季测出来的主场优势在持续下降：
  // 2022-23 是 2.39 分，2024-25 和 2025-26 只有 1.60 / 1.62。
  // 原来写死的 2.4 是四年前的值，导致模型系统性高估主队——
  // 最近两个赛季的分差偏置是 +0.79 分，改成 1.6 之后归零。
  homeAdv: 1.6,         // 主场优势（分）
  // 同样是实测：背靠背的真实代价是 −1.98 分，我们表里写的是 −1.1，低估了 80%。
  // 1.8 的缩放让整张表贴合实测值（形状对，幅度估小了）。
  restWeight: 1.8,      // 休息/背靠背修正强度
  rosterWeight: 1.0,    // 缺阵影响强度
  // 回测结论：这一项无法证明有价值。它与实际净效率变化的相关系数只有 r=0.229，
  // 按最优线性预测理论权重应在 0.27 附近；实测 w=0.15 时 Brier 比 w=0 好 0.0003
  // （4920 场里属于噪声），而原来的 0.8 会让准确率掉 2.5 个百分点。
  // 保留一个很小的默认值，滑块可调；详见 README「回测」一节。
  turnoverWeight: 0.15, // 阵容更迭修正强度
  assumeHealthy: 0,     // 1 = 假设全员健康：按场均分钟×典型出勤估算新赛季轮换
  // 轮换影响力用哪套球员价值：auto = 有 IMP 就用 IMP，否则 PIE。
  // 写死成 'pie' 可以复现旧行为，对照用。
  rotationBasis: 'auto',
  spreadSd: 12.0,       // 单场分差标准差，用于胜率换算
  seasonNoiseSd: 2.0,   // 赛季模拟中每队的实力不确定性（分）
};

// 休息天数 -> 分数修正
const REST_ADJ = { 0: -1.1, 1: 0, 2: 0.35, 3: 0.5 };
const restAdjust = (days) => (days === null ? 0 : REST_ADJ[Math.min(days, 3)] ?? 0.5);

const erf = (x) => {
  // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
const normalCdf = (x, sd) => 0.5 * (1 + erf(x / (sd * Math.SQRT2)));

const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

/**
 * 预计算模型：球队实力、轮换基准、每位球员的边际价值、休息天数表。
 * @param {object} store { teams, players, schedule, meta }
 */
export function buildModel(store, overrides = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const { teams, players, schedule, meta } = store;
  const leagueAvg = meta.leagueAvg;
  const impactB = meta.impactFit.b;

  const rosterByTeam = new Map(teams.map((t) => [t.teamId, []]));
  const priorRosterByTeam = new Map(teams.map((t) => [t.teamId, []]));
  for (const p of players) {
    if (p.onRoster) rosterByTeam.get(p.teamId)?.push(p);
    if (p.gp > 0 && p.priorTeamId) priorRosterByTeam.get(p.priorTeamId)?.push(p);
  }

  const byId = new Map();
  /** playerId -> 该球员缺阵时现属球队每场净胜分的变化（负数） */
  const marginalCost = new Map();
  /** playerId -> 该球员上赛季对原属球队的边际贡献，用于展示转出损失 */
  const priorMarginalCost = new Map();

  // 新赛季名单的分钟口径：默认沿用上赛季实际出勤，
  // 开启"假设全员健康"后按场均分钟 × 典型出勤估算（伤停整季的球星才不会被埋没）。
  const minutesOf = params.assumeHealthy ? healthyMinutes : totalMinutes;

  // 价值口径（IMP 还是 PIE）在**全联盟层面**定一次，绝不能逐队各判各的——
  // 一支队用 IMP、另一支用 PIE，两边的数根本不在同一把尺子上。
  //
  // 更要紧的是**必须跟数据文件对齐**：teams.json 里的 rotationPrior 和
  // meta.impactFit 的换算系数 b 都是 ingest 按某个口径算好写进去的。
  // 这里要是自作主张换一个，就会拿 IMP 量纲的新名单去减 PIE 量纲的旧基准，
  // 实测湖人的阵容更迭会算成 +206 分/场。所以口径以 meta 里记的为准，
  // meta 没记（老数据文件）就按当时的行为退回 PIE。
  const BASES = { imp: VALUE_IMP, pie: VALUE_PIE };
  const basis = BASES[params.rotationBasis]     // 显式指定最优先（对照实验用）
    ?? BASES[meta.rotationBasis]                // 其次跟数据文件对齐
    ?? VALUE_PIE;                               // 老数据文件没记，当时用的就是 PIE

  // 先算各队新名单的轮换影响力，再做联盟零和归一得到阵容更迭修正
  const rotationNow = new Map();
  for (const t of teams) {
    rotationNow.set(t.teamId, rotationImpact(rosterByTeam.get(t.teamId) ?? [], { minutesOf, basis }));
  }
  const deltas = teams.map((t) => rotationNow.get(t.teamId) - (t.rotationPrior ?? 0));
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / teams.length;

  for (const [i, t] of teams.entries()) {
    const roster = rosterByTeam.get(t.teamId) ?? [];
    const pace = t.adv.pace ?? leagueAvg.pace;
    const toPts = (raw) => impactB * raw * (pace / 100);
    const baseRotation = rotationNow.get(t.teamId);

    // 逐个球员算边际价值：把他移出轮换，空出的时间由排在后面的人顶上
    for (const p of roster) {
      const without = rotationImpact(roster, { exclude: new Set([p.playerId]), minutesOf, basis });
      marginalCost.set(p.playerId, round(Math.min(0, toPts(without - baseRotation)), 2));
    }

    // 同样的算法用在上赛季名单上（始终用实际出勤），得到"这名球员当时值多少"
    const priorRoster = priorRosterByTeam.get(t.teamId) ?? [];
    const priorBase = rotationImpact(priorRoster, { basis });
    for (const p of priorRoster) {
      const without = rotationImpact(priorRoster, { exclude: new Set([p.playerId]), basis });
      priorMarginalCost.set(p.playerId, round(Math.min(0, toPts(without - priorBase)), 2));
    }

    byId.set(t.teamId, {
      team: t,
      roster,
      pace,
      minutesOf,
      baseRotation,
      eloPts: (t.elo - ELO_BASE) / ELO_PER_POINT,
      netPts: (t.adv.netRtg ?? 0) * (pace / 100),
      turnoverPts: toPts(deltas[i] - meanDelta),
    });
  }

  // 每支球队在目标赛季的"上一场比赛日期"，用于算休息天数
  const restByGame = buildRestTable(schedule.games);

  return {
    params, teams, players, schedule, meta, leagueAvg, impactB, basis,
    byId, marginalCost, priorMarginalCost, restByGame,
    // 总经理模式要能对任意阵容重算，所以需要一个全联盟球员索引，
    // 以及联盟平均更迭量（阵容更迭是零和归一的，换人后要用同一个基准）
    playerById: new Map(players.map((p) => [p.playerId, p])),
    meanTurnoverDelta: meanDelta,
    minutesOf,
  };
}

/** 为赛程中每场比赛算出主客队各自的休息天数。 */
function buildRestTable(games) {
  const playable = games
    .filter((g) => g.homeId && g.awayId && g.type !== 'preseason')
    .slice()
    .sort((a, b) => (a.date === b.date
      ? a.gameId.localeCompare(b.gameId)
      : a.date.localeCompare(b.date)));

  const lastPlayed = new Map();
  const table = new Map();
  const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

  for (const g of playable) {
    const today = dayNum(g.date);
    const rest = (teamId) => {
      const prev = lastPlayed.get(teamId);
      return prev === undefined ? null : today - prev - 1;
    };
    table.set(g.gameId, { home: rest(g.homeId), away: rest(g.awayId) });
    lastPlayed.set(g.homeId, today);
    lastPlayed.set(g.awayId, today);
  }
  return table;
}

/**
 * 缺阵修正：把缺阵球员移出轮换后重算影响力。
 * 空出的时间由名单里排在后面的球员顶上，因此损失会小于球员本身的全部价值。
 */
function rosterAdjustment(model, teamId, outIds, overrideRoster = null) {
  const info = model.byId.get(teamId);
  if (!info) return { deltaPts: 0, missing: [] };
  const roster = overrideRoster ?? info.roster;
  if (!outIds?.length) return { deltaPts: 0, missing: [] };

  const exclude = new Set(outIds);
  const base = overrideRoster
    ? rotationImpact(roster, { minutesOf: info.minutesOf, basis: model.basis })
    : info.baseRotation;
  const without = rotationImpact(roster, { exclude, minutesOf: info.minutesOf, basis: model.basis });
  const raw = model.impactB * (without - base) * (info.pace / 100);
  // 顶替者最差也是替补级：缺人不会让球队变强
  const deltaPts = Math.min(0, raw) * model.params.rosterWeight;

  return {
    deltaPts,
    missing: roster
      .filter((p) => exclude.has(p.playerId))
      .map((p) => ({
        playerId: p.playerId,
        name: p.name,
        min: p.min,
        gp: p.gp,
        pie: p.pie ?? p.adv?.pie ?? null,
        costPts: model.marginalCost.get(p.playerId) ?? 0,
      }))
      .sort((a, b) => a.costPts - b.costPts),
  };
}

/**
 * 球队综合实力（每场净胜分，正数=强于联盟平均）。
 *
 * @param {Array} outIds  缺阵球员
 * @param {Array} rosterIds 可选：用这份阵容代替真实名单（总经理模式用）。
 *   给了它就连阵容更迭项一起重算——换了人，"相对上赛季变化了多少"当然也变了。
 */
export function teamStrength(model, teamId, outIds = [], rosterIds = null) {
  const info = model.byId.get(teamId);
  if (!info) throw new Error(`未知球队: ${teamId}`);
  const { wElo, wNet, turnoverWeight } = model.params;
  const wSum = wElo + wNet || 1;

  const core = (wElo * info.eloPts + wNet * info.netPts) / wSum;

  let turnoverPts = info.turnoverPts;
  let roster;
  if (rosterIds) {
    const list = rosterIds.map((id) => model.playerById.get(id)).filter(Boolean);
    const rot = rotationImpact(list, { minutesOf: model.minutesOf, basis: model.basis });
    const delta = rot - (info.team.rotationPrior ?? 0) - model.meanTurnoverDelta;
    turnoverPts = model.impactB * delta * (info.pace / 100);
    roster = rosterAdjustment(model, teamId, outIds, list);
  } else {
    roster = rosterAdjustment(model, teamId, outIds);
  }

  const turnoverAdj = turnoverPts * turnoverWeight;
  return {
    teamId,
    core: round(core, 2),
    eloPts: round(info.eloPts, 2),
    netPts: round(info.netPts, 2),
    turnoverAdj: round(turnoverAdj, 2),
    rosterAdj: round(roster.deltaPts, 2),
    total: round(core + turnoverAdj + roster.deltaPts, 2),
    missing: roster.missing,
  };
}

/**
 * 单场比赛预测。
 * @param {object} opts { homeId, awayId, gameId?, restHome?, restAway?, out?, neutral? }
 */
export function predictGame(model, opts) {
  const { homeId, awayId, gameId, neutral = false, out = {} } = opts;
  const sHome = teamStrength(model, homeId, out[homeId]);
  const sAway = teamStrength(model, awayId, out[awayId]);

  const restRow = gameId ? model.restByGame.get(gameId) : null;
  const restHome = opts.restHome ?? restRow?.home ?? null;
  const restAway = opts.restAway ?? restRow?.away ?? null;
  const restPts = (restAdjust(restHome) - restAdjust(restAway)) * model.params.restWeight;

  const hca = neutral ? 0 : model.params.homeAdv;
  const margin = sHome.total - sAway.total + hca + restPts;
  const homeWinProb = normalCdf(margin, model.params.spreadSd);

  // ---- 比分预测
  const hi = model.byId.get(homeId);
  const ai = model.byId.get(awayId);
  const { offRtg: avgOff, pace: avgPace } = model.leagueAvg;
  const pace = hi.pace + ai.pace - avgPace;
  // 对位效率：己方进攻 + 对手防守 - 联盟平均
  const homeRtg = (hi.team.adv.offRtg ?? avgOff) + (ai.team.adv.defRtg ?? avgOff) - avgOff;
  const awayRtg = (ai.team.adv.offRtg ?? avgOff) + (hi.team.adv.defRtg ?? avgOff) - avgOff;
  let total = ((homeRtg + awayRtg) * pace) / 100;
  // 缺阵主要压低进攻端，因此也会压低总分
  total += (sHome.rosterAdj + sAway.rosterAdj) * 0.5;

  const wNorm = model.params.wElo / (model.params.wElo + model.params.wNet);

  return {
    homeId,
    awayId,
    gameId: gameId ?? null,
    margin: round(margin, 1),
    homeWinProb: round(homeWinProb, 4),
    awayWinProb: round(1 - homeWinProb, 4),
    spread: round(-margin, 1), // 主队让分（负数=主队让分）
    total: round(total, 1),
    homeScore: round(total / 2 + margin / 2, 1),
    awayScore: round(total / 2 - margin / 2, 1),
    pace: round(pace, 1),
    restHome,
    restAway,
    strength: { home: sHome, away: sAway },
    factors: [
      { key: 'elo', label: 'Elo 实力差', value: round((sHome.eloPts - sAway.eloPts) * wNorm, 2) },
      { key: 'net', label: '净效率差', value: round((sHome.netPts - sAway.netPts) * (1 - wNorm), 2) },
      { key: 'turnover', label: '阵容更迭', value: round(sHome.turnoverAdj - sAway.turnoverAdj, 2) },
      { key: 'hca', label: '主场优势', value: round(hca, 2) },
      { key: 'rest', label: '休息/背靠背', value: round(restPts, 2) },
      { key: 'roster', label: '阵容缺阵', value: round(sHome.rosterAdj - sAway.rosterAdj, 2) },
    ],
  };
}

/**
 * 给整个赛程批量算胜率。列表页只需要精简结果，
 * 完整分解（实力分项、缺阵明细）走单场 predictGame。
 */
export function predictSchedule(model, games, out = {}) {
  return games
    .filter((g) => g.homeId && g.awayId)
    .map((g) => {
      const p = predictGame(model, {
        homeId: g.homeId, awayId: g.awayId, gameId: g.gameId, neutral: g.neutral, out,
      });
      return {
        ...g,
        prediction: {
          margin: p.margin,
          homeWinProb: p.homeWinProb,
          total: p.total,
          homeScore: p.homeScore,
          awayScore: p.awayScore,
          restHome: p.restHome,
          restAway: p.restAway,
        },
      };
    });
}

// ---------------------------------------------------------------- 赛季模拟

/** Box–Muller 正态随机数 */
function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 可复现的伪随机数发生器 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 蒙特卡洛赛季模拟：逐场按胜率抽样，输出预计战绩、季后赛/附加赛概率。
 * 每次模拟给每队叠加一个正态实力扰动，反映赛季前预测本身的不确定性。
 */
export function simulateSeason(model, { sims = 2000, out = {}, seed = 20262027 } = {}) {
  const rand = mulberry32(seed);
  const { teams } = model;
  const idx = new Map(teams.map((t, i) => [t.teamId, i]));
  const n = teams.length;

  const strengths = teams.map((t) => teamStrength(model, t.teamId, out[t.teamId]).total);
  const games = model.schedule.games.filter((g) => g.type === 'regular' && g.homeId && g.awayId);

  // 每队实际排定的常规赛场次（NBA 杯淘汰赛为待定对阵，未计入）
  const scheduled = new Float64Array(n);
  for (const g of games) {
    scheduled[idx.get(g.homeId)] += 1;
    scheduled[idx.get(g.awayId)] += 1;
  }

  const base = games.map((g) => {
    const rest = model.restByGame.get(g.gameId) ?? { home: null, away: null };
    const restPts = (restAdjust(rest.home) - restAdjust(rest.away)) * model.params.restWeight;
    return {
      h: idx.get(g.homeId),
      a: idx.get(g.awayId),
      bias: (g.neutral ? 0 : model.params.homeAdv) + restPts,
    };
  });

  const sd = model.params.spreadSd;
  const winTotals = Array.from({ length: n }, () => new Float64Array(90));
  const sumWins = new Float64Array(n);
  const playoffs = new Float64Array(n);   // 前 6
  const playin = new Float64Array(n);     // 7-10
  const topSeed = new Float64Array(n);    // 分区第 1
  const bestRecord = new Float64Array(n); // 全联盟第 1

  const wins = new Float64Array(n);
  const noise = new Float64Array(n);
  const confOf = teams.map((t) => t.conference);

  for (let s = 0; s < sims; s++) {
    wins.fill(0);
    for (let i = 0; i < n; i++) noise[i] = gauss(rand) * model.params.seasonNoiseSd;

    for (const g of base) {
      const margin = strengths[g.h] + noise[g.h] - strengths[g.a] - noise[g.a] + g.bias;
      const p = normalCdf(margin, sd);
      if (rand() < p) wins[g.h] += 1;
      else wins[g.a] += 1;
    }

    for (let i = 0; i < n; i++) {
      sumWins[i] += wins[i];
      winTotals[i][Math.round(wins[i])] += 1;
    }

    // 分区排名（同战绩用随机数打破平局）
    for (const conf of ['East', 'West']) {
      const order = [];
      for (let i = 0; i < n; i++) if (confOf[i] === conf) order.push(i);
      order.sort((x, y) => (wins[y] - wins[x]) || (rand() - 0.5));
      order.slice(0, 6).forEach((i) => { playoffs[i] += 1; });
      order.slice(6, 10).forEach((i) => { playin[i] += 1; });
      topSeed[order[0]] += 1;
    }
    let best = 0;
    for (let i = 1; i < n; i++) if (wins[i] > wins[best]) best = i;
    bestRecord[best] += 1;
  }

  return {
    sims,
    teams: teams.map((t, i) => {
      const dist = winTotals[i];
      const gp = scheduled[i];
      const pct = (v) => round((v / sims) * 100, 1);
      // 5% / 95% 分位数
      let acc = 0;
      let p5 = 0;
      let p95 = gp;
      for (let w = 0; w <= gp; w++) {
        acc += dist[w];
        if (acc >= sims * 0.05 && p5 === 0) p5 = w;
        if (acc >= sims * 0.95) { p95 = w; break; }
      }
      return {
        teamId: t.teamId,
        abbr: t.abbr,
        cn: t.cn,
        conference: t.conference,
        strength: round(strengths[i], 2),
        gamesScheduled: gp,
        projWins: round(sumWins[i] / sims, 1),
        projLosses: round(gp - sumWins[i] / sims, 1),
        winsLo: p5,
        winsHi: p95,
        playoffPct: pct(playoffs[i]),
        playinPct: pct(playin[i]),
        postseasonPct: pct(playoffs[i] + playin[i]),
        topSeedPct: pct(topSeed[i]),
        bestRecordPct: pct(bestRecord[i]),
      };
    }).sort((a, b) => b.projWins - a.projWins),
  };
}

/** 力量榜：按综合实力排序，附带各分项。 */
export function powerRankings(model, out = {}) {
  return model.teams
    .map((t) => {
      const s = teamStrength(model, t.teamId, out[t.teamId]);
      return {
        teamId: t.teamId, abbr: t.abbr, cn: t.cn, full: t.full,
        color: t.color, colorAlt: t.colorAlt,
        conference: t.conference, division: t.division,
        priorRecord: `${t.wins}-${t.losses}`,
        elo: t.elo, eloEnd: t.eloEnd,
        netRtg: t.adv.netRtg, offRtg: t.adv.offRtg, defRtg: t.adv.defRtg, pace: t.adv.pace,
        ...s,
      };
    })
    .sort((a, b) => b.total - a.total)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}
