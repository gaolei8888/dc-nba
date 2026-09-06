/**
 * 评级计算：Elo（基于上赛季逐场结果）+ 阵容影响力回归。
 * 这两项是预测引擎的输入，在 ingest 阶段预先算好写入 data/。
 */

export const ELO_BASE = 1500;
export const ELO_HOME_ADV = 100; // 主场优势，约合 3.5 分
export const ELO_PER_POINT = 28; // 28 Elo ≈ 1 分净胜分

/**
 * 把 leaguegamelog 的两行/场记录合并为一场比赛。
 * 中立场比赛（海外赛、杯赛决赛）两行都标 "@"，此时按中立场处理、不给主场优势。
 */
export function buildGames(logRows) {
  const byGame = new Map();
  for (const r of logRows) {
    const g = byGame.get(r.GAME_ID) ?? { gameId: r.GAME_ID, date: r.GAME_DATE, sides: [] };
    g.sides.push({
      teamId: r.TEAM_ID,
      abbr: r.TEAM_ABBREVIATION,
      pts: r.PTS,
      win: r.WL === 'W',
      // MATCHUP 形如 "LAL vs. UTA"(主) 或 "LAL @ UTA"(客)
      isHome: r.MATCHUP.includes('vs.'),
    });
    byGame.set(r.GAME_ID, g);
  }

  const games = [];
  for (const g of byGame.values()) {
    if (g.sides.length !== 2) continue;
    const home = g.sides.find((s) => s.isHome);
    const away = g.sides.find((s) => !s.isHome);
    if (home && away) {
      games.push({ gameId: g.gameId, date: g.date, home, away, neutral: false });
    } else {
      // 双方都没有主场标记：中立场，主客顺序仅为占位
      const [a, b] = g.sides;
      games.push({ gameId: g.gameId, date: g.date, home: a, away: b, neutral: true });
    }
  }
  return games.sort((a, b) => (a.date === b.date
    ? a.gameId.localeCompare(b.gameId)
    : a.date.localeCompare(b.date)));
}

/**
 * 538 风格 Elo：K=20，胜负分差放大系数抑制“垃圾时间”虚高。
 * 返回 { 赛季末 Elo, 逐场轨迹 }。
 */
export function computeElo(games, { k = 20 } = {}) {
  const elo = new Map();
  const history = [];
  const get = (id) => elo.get(id) ?? ELO_BASE;

  for (const g of games) {
    const eh = get(g.home.teamId);
    const ea = get(g.away.teamId);
    const diff = eh + (g.neutral ? 0 : ELO_HOME_ADV) - ea;
    const expHome = 1 / (1 + 10 ** (-diff / 400));
    const mov = Math.abs(g.home.pts - g.away.pts);
    const winnerEloDiff = g.home.win ? diff : -diff;
    const movMult = ((mov + 3) ** 0.8) / (7.5 + 0.006 * winnerEloDiff);
    const shift = k * movMult * ((g.home.win ? 1 : 0) - expHome);
    elo.set(g.home.teamId, eh + shift);
    elo.set(g.away.teamId, ea - shift);
    history.push({ gameId: g.gameId, date: g.date, home: g.home.abbr, away: g.away.abbr, homeElo: eh + shift, awayElo: ea - shift });
  }
  return { final: Object.fromEntries(elo), history };
}

/** 赛季间回归均值：新赛季开局保留 75% 上赛季实力。 */
export function carryOver(finalElo, { keep = 0.75, mean = ELO_BASE } = {}) {
  const out = {};
  for (const [id, v] of Object.entries(finalElo)) out[id] = keep * v + (1 - keep) * mean;
  return out;
}

/**
 * 球员影响力：以 PIE（球员影响估值）超出替补级基准的部分，按出场时间加权。
 * 单位是“原始分”，再通过对球队净效率的最小二乘回归换算成每百回合得分。
 */
export const REPLACEMENT_PIE = 0.085;

export function playerRawImpact(p) {
  const min = Number(p.MIN) || 0;
  const pie = Number(p.PIE) || 0;
  const gp = Number(p.GP) || 0;
  // 样本太小的球员向替补级收缩，避免 3 场高 PIE 的噪声
  const shrink = gp / (gp + 12);
  return (pie - REPLACEMENT_PIE) * min * shrink;
}

/** 用 30 队做 netRating ≈ a + b·Σimpact 的一元回归，得到换算系数。 */
export function fitRosterImpact(teamStrengths) {
  const n = teamStrengths.length;
  const mx = teamStrengths.reduce((s, t) => s + t.raw, 0) / n;
  const my = teamStrengths.reduce((s, t) => s + t.net, 0) / n;
  let num = 0, den = 0;
  for (const t of teamStrengths) {
    num += (t.raw - mx) * (t.net - my);
    den += (t.raw - mx) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  const a = my - b * mx;
  // 拟合优度，用于在界面上说明模型可信度
  let ssTot = 0, ssRes = 0;
  for (const t of teamStrengths) {
    ssTot += (t.net - my) ** 2;
    ssRes += (t.net - (a + b * t.raw)) ** 2;
  }
  return { a, b, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, meanRaw: mx };
}
