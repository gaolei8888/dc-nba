/**
 * 实验 2：球队强度 = 按「延续度」加权的 Elo 与阵容估计的混合。
 *
 * 问题：旧 Elo 榜高估休赛期大换血的球队（CHA、ATL），因为 Elo 带着上赛季。
 * FiveThirtyEight 的做法是把球队 Elo 与「天赋评分」（RAPTOR 加总）混合，
 * Elo 的权重取决于它有多少是**现在这批人**打出来的。这里照这个思路：
 *
 *   强度 = w·Elo 分 + (1−w)·a·阵容分，w = f(延续度 c)
 *   c = 该队最近 WINDOW 场（不够就往上季补）的上场分钟里，由**当前名单**球员打的比例
 *
 * 赛季中 c 会自然上升：本季打得越多，窗口里本季的场次越多，而本季分钟都是现名单打的。
 *
 * 全部特征只用当场之前的信息：
 *   · 球员价值 = 第 N−1 季的 IMP（SPM 只在 ≤N−1 季上训练，APM 只用 ≤N−1 季的五人组合）
 *   · 当前名单 = 本季在当场之前为该队出过场的人（之后为别队出场即移出）；
 *     该队本季第一场用当场出场名单近似开赛日的可上场名单（赛前公布的现役名单，非伤停后的实际分钟）
 *   · 预计分钟 = rosterProjection 同一套 projectMinutes（上季场均 + 本季此前场均与出场率）
 *   · 延续度只看此前的比赛
 * 本模块只做实验，不改动线上 DEFAULT_PARAMS / ratings。
 */
import { computeElo, carryOver, ELO_BASE, ELO_HOME_ADV, ELO_PER_POINT, REPLACEMENT_IMP } from './ratings.mjs';
import { expand, normalCdf, restAdjust, marketProb, priorOf } from './lab.mjs';
import { projectMinutes } from './liveRosterRankings.mjs';
import { projectRotation, rosterRating } from './rosterProjection.mjs';

const toPts = (elo) => (elo - ELO_BASE) / ELO_PER_POINT;
const dayNum = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);

/** 一场 stint 记录 [队A, 队B, 段[]] → Map(teamId → Map(playerId → 分钟)) */
export function gameMinutes(stintGame) {
  const [A, B, stints] = stintGame;
  const out = new Map([[A, new Map()], [B, new Map()]]);
  for (const st of stints) {
    const min = st[14] / 60;
    for (let i = 0; i < 10; i += 1) {
      const m = out.get(i < 5 ? A : B);
      m.set(st[i], (m.get(st[i]) ?? 0) + min);
    }
  }
  return out;
}

/**
 * 本季名单追踪。只在比赛**之后**调用 record，查询只反映此前的比赛。
 * 没有 stint 数据的比赛（还原失败，约 3%）不计入：不知道谁上了场。
 */
export function rosterTracker() {
  const lastTeam = new Map(); // playerId → 最近一次出场的球队
  const teamGames = new Map(); // teamId → 本季已记录（有 stint）的场数
  const stay = new Map(); // `${team}:${player}` → { joinedAt, n, min }
  const history = new Map(); // teamId → [Map(playerId → 分钟)]，本季按时间
  return {
    games: (teamId) => teamGames.get(teamId) ?? 0,
    history: (teamId) => history.get(teamId) ?? [],
    /** 当前名单：最近一次出场是为这支队的人 */
    members(teamId) {
      const T = teamGames.get(teamId) ?? 0;
      const out = [];
      for (const [pid, t] of lastTeam) {
        if (t !== teamId) continue;
        const s = stay.get(`${teamId}:${pid}`);
        out.push({ playerId: pid, n: s.n, curMpg: s.n ? s.min / s.n : null, teamGames: T - s.joinedAt });
      }
      return out;
    },
    record(minutesByTeam) {
      for (const [teamId, mins] of minutesByTeam) {
        const T = teamGames.get(teamId) ?? 0;
        for (const [pid, m] of mins) {
          const key = `${teamId}:${pid}`;
          if (lastTeam.get(pid) !== teamId || !stay.has(key)) stay.set(key, { joinedAt: T, n: 0, min: 0 });
          const s = stay.get(key);
          s.n += 1; s.min += m;
          lastTeam.set(pid, teamId);
        }
        teamGames.set(teamId, T + 1);
        if (!history.has(teamId)) history.set(teamId, []);
        history.get(teamId).push(mins);
      }
    },
  };
}

/**
 * 延续度：最近 window 场（本季在前、不够用上季补）的分钟里，由 members 打的比例。
 * games 按时间升序；返回 null 表示窗口里一场都没有。
 */
export function continuity(memberIds, games, window = 82) {
  const ids = memberIds instanceof Set ? memberIds : new Set(memberIds);
  let tot = 0; let kept = 0;
  for (const g of games.slice(-window)) {
    for (const [pid, m] of g) { tot += m; if (ids.has(pid)) kept += m; }
  }
  return tot > 0 ? kept / tot : null;
}

/**
 * 一支队的阵容分（每百回合，未去联盟均值）：预计分钟分 240、乘球员价值。
 * players: [{ playerId, n, curMpg, teamGames }]；priorMpg / value: Map；没有价值的人用 fallback。
 */
export function rosterRaw(players, { priorMpg, value, fallback = REPLACEMENT_IMP }) {
  const rows = players.map((p) => {
    const pm = priorMpg.get(p.playerId);
    const v = value.get(p.playerId);
    return {
      playerId: p.playerId,
      projectedMinutes: projectMinutes(Number.isFinite(pm) ? pm : null, p.curMpg, p.n, p.teamGames),
      impact: Number.isFinite(v) ? v : null,
      impactPrior: { value: fallback, source: '上季无 IMP：替补级先验' },
      availability: 1,
    };
  });
  // 预计分钟全为 0（例如只剩没有先验、本季也没出场的人）时 projectRotation 会平均分；人数不够 5 人分不满 240 就放弃
  if (rows.length < 5) return null;
  return rosterRating(projectRotation(rows));
}

/**
 * 重放一个赛季，产出逐场特征行（Elo 与 lab.replay 逐场一致，有测试锁定）。
 *
 * @param {Array} games expand 之后的比赛，时间升序
 * @param {object} eloStart 开赛日 Elo
 * @param {object} p { k, homeAdv, restWeight, inSeasonElo? }
 * @param {object} ctx
 * @param {Map} ctx.stints gameId → [队A, 队B, 段[]]（本季）
 * @param {Map} ctx.prevGames teamId → [Map(playerId → 分钟)]（上季，时间升序），供延续度窗口
 * @param {Map} ctx.priorMpg playerId → 上季场均（≥10 场者）
 * @param {Map<string,Map>} ctx.values 版本名 → (playerId → 上季价值)
 * @param {Map<string,number>} ctx.center 版本名 → 联盟平均阵容分（见 leagueCenter，赛前即可知）
 * @param {number} [ctx.window] 延续度窗口（场）
 */
export function replaySeason(games, eloStart, p, ctx) {
  const elo = new Map(Object.entries(eloStart).map(([id, v]) => [Number(id), v]));
  const getElo = (id) => elo.get(id) ?? ELO_BASE;
  const tracker = rosterTracker();
  const lastPlayed = new Map();
  const played = new Map();
  const window = ctx.window ?? 82;
  const rows = [];

  const teamFeatures = (teamId, gameMins) => {
    let members = tracker.members(teamId);
    let opening = false;
    if (!tracker.games(teamId)) {
      // 本季第一场：用当场出场名单近似开赛日现役名单，分钟全靠上季场均
      opening = true;
      members = gameMins ? [...gameMins.get(teamId).keys()].map((pid) => ({ playerId: pid, n: 0, curMpg: null, teamGames: 0 })) : [];
    }
    const ids = new Set(members.map((m) => m.playerId));
    const window_ = [...(ctx.prevGames.get(teamId) ?? []), ...tracker.history(teamId)];
    const roster = {};
    for (const [k, value] of ctx.values) {
      const raw = members.length ? rosterRaw(members, { priorMpg: ctx.priorMpg, value }) : null;
      roster[k] = raw === null ? null : raw - ctx.center.get(k);
    }
    return { elo: toPts(getElo(teamId)), roster, c: members.length ? continuity(ids, window_, window) : null, opening, n: played.get(teamId) ?? 0 };
  };

  for (const g of games) {
    const today = dayNum(g.date);
    const restOf = (id) => (lastPlayed.has(id) ? today - lastPlayed.get(id) - 1 : null);
    const restPts = (restAdjust(restOf(g.home.teamId)) - restAdjust(restOf(g.away.teamId))) * p.restWeight;
    const st = ctx.stints.get(g.gameId);
    const mins = st ? gameMinutes(st) : null;
    const ok = mins && mins.has(g.home.teamId) && mins.has(g.away.teamId);
    const actual = g.home.pts - g.away.pts;
    rows.push({
      gameId: g.gameId, date: g.date, homeId: g.home.teamId, awayId: g.away.teamId,
      home: teamFeatures(g.home.teamId, ok ? mins : null),
      away: teamFeatures(g.away.teamId, ok ? mins : null),
      hca: g.neutral ? 0 : p.homeAdv, restPts, actual, homeWin: g.home.win,
      teamGp: Math.min(played.get(g.home.teamId) ?? 0, played.get(g.away.teamId) ?? 0),
      mktProb: g.odds ? marketProb(g.odds, 12) : null,
    });
    // ---- 赛后更新（与 lab.replay 完全相同的 Elo 公式）
    if (ok) tracker.record(mins);
    for (const id of [g.home.teamId, g.away.teamId]) { played.set(id, (played.get(id) ?? 0) + 1); lastPlayed.set(id, today); }
    if (p.inSeasonElo !== 0) {
      const eh = getElo(g.home.teamId); const ea = getElo(g.away.teamId);
      const diff = eh + (g.neutral ? 0 : ELO_HOME_ADV) - ea;
      const expHome = 1 / (1 + 10 ** (-diff / 400));
      const winnerEloDiff = g.home.win ? diff : -diff;
      const movMult = ((Math.abs(actual) + 3) ** 0.8) / (7.5 + 0.006 * winnerEloDiff);
      const shift = p.k * movMult * ((g.home.win ? 1 : 0) - expHome);
      elo.set(g.home.teamId, eh + shift);
      elo.set(g.away.teamId, ea - shift);
    }
  }
  return { rows, tracker };
}

/**
 * 联盟平均阵容分：上季全部球员按上季总分钟加权的价值，折成「每队每场」。
 * 只用上季信息，赛季开打前就能算；整季固定，避免开季只有几队有值时均值乱跳。
 * minutes: playerId → 上季总分钟；没有价值的人按 fallback 计。
 */
export function leagueCenter(minutes, value, { teams = 30, games = 82, fallback = REPLACEMENT_IMP } = {}) {
  let s = 0;
  for (const [pid, m] of minutes) {
    const v = value.get(pid);
    s += (m / 48) * (Number.isFinite(v) ? v : fallback);
  }
  return s / (teams * games);
}

/** 开赛日 Elo 与 lab.replay 同口径：上季从零跑 Elo，再回归均值 */
export function eloStartFor(dataset, season, p) {
  const prev = dataset.seasons[priorOf(season)];
  return carryOver(computeElo(expand(prev), { k: p.k }).final, { keep: p.carryKeep });
}

/** 上季逐队逐场分钟（延续度窗口的上季部分），时间顺序按 gameId 近似 */
export function teamGamesFromStints(stintFile) {
  const out = new Map();
  for (const gid of Object.keys(stintFile.games).sort()) {
    for (const [teamId, mins] of gameMinutes(stintFile.games[gid])) {
      if (!out.has(teamId)) out.set(teamId, []);
      out.get(teamId).push(mins);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 模型

/** 由延续度得到 Elo 权重 w（0..1）。c 缺失（窗口为空）时视为 1：只能信 Elo */
export function eloWeight(c, cfg) {
  if (cfg.mode === 'elo') return 1;
  if (cfg.mode === 'roster') return 0;
  if (cfg.mode === 'const') return cfg.w;
  const x = c ?? 1;
  if (cfg.mode === 'pow') return x ** cfg.gamma;
  if (cfg.mode === 'lin') return Math.max(0, Math.min(1, 1 - cfg.beta * (1 - x)));
  throw new Error(`未知模式 ${cfg.mode}`);
}

/** 一支队的强度（每场净胜分）；没有阵容分时退回纯 Elo */
export function strength(t, cfg) {
  if (cfg.mode === 'elo') return t.elo;
  const r = t.roster[cfg.value];
  if (r === null || r === undefined) return t.elo;
  const w = eloWeight(t.c, cfg);
  return w * t.elo + (1 - w) * cfg.a * r;
}

export function predict(row, cfg) {
  const pred = strength(row.home, cfg) - strength(row.away, cfg) + row.hca + row.restPts;
  return { p: normalCdf(pred, cfg.sd), pred, actual: row.actual, homeWin: row.homeWin };
}

export const logLoss = (r) => -Math.log(Math.max(r.homeWin ? r.p : 1 - r.p, 1e-9));

/** 训练集上按平均 log loss 挑配置 */
export function tune(rows, grid) {
  let best = null;
  for (const cfg of grid) {
    let s = 0;
    for (const r of rows) s += logLoss(predict(r, cfg));
    if (!best || s < best.loss) best = { cfg, loss: s };
  }
  return { cfg: best.cfg, logloss: best.loss / rows.length };
}
