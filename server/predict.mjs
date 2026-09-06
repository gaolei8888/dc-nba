/**
 * 预测引擎。
 *
 * 思路：把每支球队折算成一个"相对联盟平均的每场净胜分"实力值，来源有三块——
 *   1. Elo：上赛季逐场结果推出的球队强度，赛季间向均值回归 25%
 *   2. 净效率：上赛季百回合净效率，按节奏折算成每场分差
 *   3. 阵容修正：因伤停/转会导致的阵容影响力变化（PIE×出场时间 回归到净效率）
 * 再叠加主场优势与背靠背/休息天数修正，得到预期分差；
 * 用正态分布（NBA 单场分差对盘口的标准差约 12 分）转成胜率。
 * 比分则由双方进攻/防守效率与节奏推出总分后按分差拆分。
 */
import { ELO_BASE, ELO_PER_POINT } from './ratings.mjs';

/** 默认可调参数，前端可覆盖。 */
export const DEFAULT_PARAMS = {
  wElo: 0.55,          // Elo 权重
  wNet: 0.45,          // 净效率权重
  homeAdv: 2.4,        // 主场优势（分）
  restWeight: 1.0,     // 休息/背靠背修正强度
  rosterWeight: 1.0,   // 阵容变动修正强度
  spreadSd: 12.0,      // 单场分差标准差，用于胜率换算
  seasonNoiseSd: 2.0,  // 赛季模拟中每队的实力不确定性（分）
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
 * 预计算模型：球队实力、每支球队的休息天数表、阵容基准。
 * @param {object} store { teams, players, schedule, meta }
 */
export function buildModel(store, overrides = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const { teams, players, schedule, meta } = store;
  const leagueAvg = meta.leagueAvg;
  const impactB = meta.impactFit.b;

  const rosterByTeam = new Map(teams.map((t) => [t.teamId, []]));
  for (const p of players) {
    if (p.onRoster) rosterByTeam.get(p.teamId)?.push(p);
  }

  const byId = new Map();
  for (const t of teams) {
    const roster = rosterByTeam.get(t.teamId) ?? [];
    const pace = t.adv.pace ?? leagueAvg.pace;
    byId.set(t.teamId, {
      team: t,
      roster,
      pace,
      eloPts: (t.elo - ELO_BASE) / ELO_PER_POINT,
      netPts: (t.adv.netRtg ?? 0) * (pace / 100),
    });
  }

  // 每支球队在目标赛季的"上一场比赛日期"，用于算休息天数
  const restByGame = buildRestTable(schedule.games);

  return { params, teams, players, schedule, meta, leagueAvg, impactB, byId, restByGame };
}

/** 为赛程中每场比赛算出主客队各自的休息天数。 */
function buildRestTable(games) {
  const playable = games
    .filter((g) => g.homeId && g.awayId && g.type !== 'preseason')
    .slice()
    .sort((a, b) => (a.date === b.date ? a.gameId.localeCompare(b.gameId) : a.date.localeCompare(b.date)));

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
 * 计算一支球队因伤停/缺阵产生的实力修正（每场分）。
 * @param {number[]} outIds 缺阵球员 id
 */
function rosterAdjustment(model, teamId, outIds) {
  const info = model.byId.get(teamId);
  if (!info || !outIds?.length) return { deltaPts: 0, missing: [] };
  const outSet = new Set(outIds);
  const missing = info.roster.filter((p) => outSet.has(p.playerId));
  // 顶上来的替补以"替补级"为下限：缺阵不会让球队变强，最差也就是不变
  const lost = (p) => Math.max(p.impactRaw ?? 0, 0);
  const lostRaw = missing.reduce((s, p) => s + lost(p), 0);
  // 缺阵者的出场时间由替补顶上，替补按替补级水平计算（影响力 0）
  const deltaNet = model.impactB * -lostRaw;          // 每百回合净效率变化
  const deltaPts = deltaNet * (info.pace / 100);      // 折算到每场
  return {
    deltaPts: deltaPts * model.params.rosterWeight,
    missing: missing.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      min: p.min,
      pie: p.adv?.pie ?? null,
      costPts: round(model.impactB * -lost(p) * (info.pace / 100), 2),
    })),
  };
}

/** 球队综合实力（每场净胜分，正数=强于联盟平均）。 */
export function teamStrength(model, teamId, outIds = []) {
  const info = model.byId.get(teamId);
  if (!info) throw new Error(`未知球队: ${teamId}`);
  const { wElo, wNet } = model.params;
  const wSum = wElo + wNet || 1;
  const core = (wElo * info.eloPts + wNet * info.netPts) / wSum;
  const roster = rosterAdjustment(model, teamId, outIds);
  return {
    teamId,
    core: round(core, 2),
    eloPts: round(info.eloPts, 2),
    netPts: round(info.netPts, 2),
    rosterAdj: round(roster.deltaPts, 2),
    total: round(core + roster.deltaPts, 2),
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
  // 阵容缺阵会同时压低总分
  total += (sHome.rosterAdj + sAway.rosterAdj) * 0.5;

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
      { key: 'elo', label: 'Elo 实力差', value: round((sHome.eloPts - sAway.eloPts) * (model.params.wElo / (model.params.wElo + model.params.wNet)), 2) },
      { key: 'net', label: '净效率差', value: round((sHome.netPts - sAway.netPts) * (model.params.wNet / (model.params.wElo + model.params.wNet)), 2) },
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
  const teams = model.teams;
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
      const pct = (v) => round((v / sims) * 100, 1);
      // 5% / 95% 分位数
      const gp = scheduled[i];
      let acc = 0; let p5 = 0; let p95 = gp;
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
