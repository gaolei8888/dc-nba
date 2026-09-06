/**
 * 逐日重放：为一个已结束的赛季生成"模型当时会怎么预测"的记录。
 *
 * 这是人机对赌的题库。关键在于**不能有信息泄漏**——模型对某场比赛的
 * 预测，只能用该场开打之前已经发生的结果算出来。做法与 backtest.mjs
 * 一致：按日期顺序走，先记录预测，再用真实结果更新 Elo。
 *
 * 生成的记录同时带着真实比分，所以对赌可以立即结算。
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
const normalCdf = (x, sd) => 0.5 * (1 + erf(x / (sd * Math.SQRT2)));
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

const REST_ADJ = { 0: -1.1, 1: 0, 2: 0.35, 3: 0.5 };
const restAdjust = (d) => (d === null ? 0 : REST_ADJ[Math.min(d, 3)] ?? 0.5);

/**
 * @param {Array}  games        buildGames() 的输出，按日期排好序
 * @param {Array}  priorGames   上上赛季的比赛，用来定开赛日 Elo
 * @param {object} opts         k / homeAdv / spreadSd
 * @returns {Array} 每场一条：模型预测 + 真实结果
 */
export function replaySeasonPicks(games, priorGames, opts = {}) {
  const { k = 20, homeAdv = 2.4, spreadSd = 12 } = opts;

  const elo = new Map(
    Object.entries(carryOver(computeElo(priorGames, { k }).final))
      .map(([id, v]) => [Number(id), v]),
  );
  const getElo = (id) => elo.get(id) ?? ELO_BASE;

  const lastPlayed = new Map();
  const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

  const out = [];
  for (const g of games) {
    const today = dayNum(g.date);
    const restOf = (id) => {
      const prev = lastPlayed.get(id);
      return prev === undefined ? null : today - prev - 1;
    };
    const restHome = restOf(g.home.teamId);
    const restAway = restOf(g.away.teamId);
    const restPts = restAdjust(restHome) - restAdjust(restAway);

    const strength = (id) => (getElo(id) - ELO_BASE) / ELO_PER_POINT;
    const margin = strength(g.home.teamId) - strength(g.away.teamId)
      + (g.neutral ? 0 : homeAdv) + restPts;
    const p = normalCdf(margin, spreadSd);

    out.push({
      gameId: g.gameId,
      date: g.date,
      homeId: g.home.teamId,
      awayId: g.away.teamId,
      homeAbbr: g.home.abbr,
      awayAbbr: g.away.abbr,
      neutral: g.neutral,
      // 模型在开打前的判断
      modelProb: round(p, 4),
      modelMargin: round(margin, 1),
      restHome,
      restAway,
      // 真实结果
      homeScore: g.home.pts,
      awayScore: g.away.pts,
      homeWin: g.home.win,
    });

    lastPlayed.set(g.home.teamId, today);
    lastPlayed.set(g.away.teamId, today);

    // 记录完预测才更新评级
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
  return out;
}

/** 按日期分组，方便前端一天一天地玩 */
export function groupByDate(picks) {
  const map = new Map();
  for (const p of picks) {
    if (!map.has(p.date)) map.set(p.date, []);
    map.get(p.date).push(p);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, games]) => ({ date, games }));
}
