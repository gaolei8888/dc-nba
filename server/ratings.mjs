/**
 * 评级计算：Elo（基于上赛季逐场结果）+ 轮换影响力。
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
 * 538 风格 Elo：K=20，胜负分差放大系数抑制"垃圾时间"虚高。
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
    history.push({
      gameId: g.gameId, date: g.date,
      home: g.home.abbr, away: g.away.abbr,
      homeElo: eh + shift, awayElo: ea - shift,
    });
  }
  return { final: Object.fromEntries(elo), history };
}

/** 赛季间回归均值：新赛季开局保留 75% 上赛季实力。 */
export function carryOver(finalElo, { keep = 0.75, mean = ELO_BASE } = {}) {
  const out = {};
  for (const [id, v] of Object.entries(finalElo)) out[id] = keep * v + (1 - keep) * mean;
  return out;
}

// ---------------------------------------------------------------- 轮换影响力

/** PIE 的"替补级"基准：低于此值的球员对球队没有正面贡献。 */
export const REPLACEMENT_PIE = 0.085;

/** 一支球队整个常规赛的总上场时间：5 人 × 48 分钟 × 82 场。 */
export const TEAM_SEASON_MINUTES = 240 * 82;

/** 球员整季总出场分钟。场均分钟会被垃圾时间的临时工拉高，总分钟才反映真实轮换地位。 */
export const totalMinutes = (p) => (p.min ?? 0) * (p.gp ?? 0);

const pieOf = (p) => p.pie ?? p.adv?.pie ?? 0;

/**
 * 轮换影响力：按整季总出场分钟降序取球员，累计到球队总分钟上限为止，
 * 累加 (PIE − 替补级) × 分钟，再除以 82 折算成每场。
 *
 * 上限的意义：一支球队每场只有 240 分钟可分配。名单再长，
 * 也只有排在前面的人真正吃到轮换时间；填不满的部分视为替补级（影响力 0）。
 * 这同时让"上赛季名单"与"新赛季名单"在同一把尺子上可比。
 */
export function rotationImpact(players, { cap = TEAM_SEASON_MINUTES, exclude } = {}) {
  const list = exclude?.size ? players.filter((p) => !exclude.has(p.playerId)) : players;
  const sorted = [...list].sort((a, b) => totalMinutes(b) - totalMinutes(a));
  let remaining = cap;
  let sum = 0;
  for (const p of sorted) {
    if (remaining <= 0) break;
    const minutes = Math.min(totalMinutes(p), remaining);
    sum += (pieOf(p) - REPLACEMENT_PIE) * minutes;
    remaining -= minutes;
  }
  return sum / 82;
}

/**
 * 一元最小二乘：净效率 ≈ a + b × 轮换影响力。
 * 用 30 支球队的「上赛季名单 → 上赛季净效率」拟合，得到把影响力换算成
 * 每百回合得分的系数 b。
 */
export function fitRosterImpact(samples) {
  const n = samples.length;
  const mx = samples.reduce((s, t) => s + t.raw, 0) / n;
  const my = samples.reduce((s, t) => s + t.net, 0) / n;
  let num = 0;
  let den = 0;
  for (const t of samples) {
    num += (t.raw - mx) * (t.net - my);
    den += (t.raw - mx) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  const a = my - b * mx;
  let ssTot = 0;
  let ssRes = 0;
  for (const t of samples) {
    ssTot += (t.net - my) ** 2;
    ssRes += (t.net - (a + b * t.raw)) ** 2;
  }
  return { a, b, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, meanRaw: mx };
}
