/**
 * 阵容榜分钟回测的逐场上下文（从 scripts/minutes-backtest.mjs 抽出，供 roster-results-backtest 复用同一套赛前特征）。
 *
 * minutesLab({ dataset, teams, players, stints, injDir, allSeasons }) 返回：
 *   buildContexts(season)  每场每队的候选名单与赛前特征（上季出场时场均、本季此前出场数与场均、球队已赛场数、
 *                          当天北京 22:00 时点可见的官方伤病状态）、本场真实分钟（缩放到 240）、首发
 *   newRows(side, mode, values, cfg)  线上新版（rotationMinutes + P(出场|状态)）的逐人输入，喂 projectExpectedRotation
 *   matchStats             伤病报告匹配统计
 * 说明与防泄漏口径见 scripts/minutes-backtest.mjs 文件头。只读本地文件，不联网；盘口不进任何输入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { gameMinutes } from './continuityLab.mjs';
import { expand, restAdjust } from './lab.mjs';
import { matchName, nameIndex } from './injuryLab.mjs';
import { rotationMinutes, playProbability } from './rotationMinutes.mjs';
import { REPLACEMENT_IMP } from './ratings.mjs';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

export const availOf = (r, mode) => (mode === 'oracle' ? (r.played ? 1 : 0) : null);
export const impactRow = (r, values) => ({ playerId: r.pid, impact: values?.get(r.pid) ?? null,
  impactPrior: { value: REPLACEMENT_IMP, source: '上季无 IMP：替补级先验' } });

export function newRows(side, mode, values, cfg = {}) {
  return side.rows.map((r) => {
    const rm = rotationMinutes({ priorMpg: r.priorMpg, curMpg: r.curMpg, n: r.n, teamGames: side.T,
      listed: r.status !== null && r.status !== 'Available' }, cfg);
    // oracle：已知他上场，轮换概率记 1
    return { ...impactRow(r, values), projectedMinutes: rm.minutes, rotation: mode === 'oracle' ? 1 : rm.rotation,
      availability: availOf(r, mode) ?? playProbability(r.status) };
  });
}

export function minutesLab({ dataset, teams, players, stints, injDir, allSeasons, P = { homeAdv: 1.6, restWeight: 1.8 } }) {
  const prevOf = (s) => allSeasons[allSeasons.indexOf(s) - 1];
  const fullOf = new Map(teams.map((t) => [t.teamId, t.full]));
  const abbrOf = new Map(teams.map((t) => [t.teamId, t.abbr]));
  const indexFile = read(path.join(injDir, 'index.json'));
  const picks = indexFile.picks_lag15;
  const reportCache = new Map();
  const report = (name) => {
    if (!reportCache.has(name)) reportCache.set(name, read(path.join(injDir, 'json', `${name}.json`)));
    return reportCache.get(name);
  };
  const people = []; const seenId = new Set();
  for (const s of allSeasons) for (const p of players[s]) if (!seenId.has(p.playerId)) { seenId.add(p.playerId); people.push({ id: p.playerId, name: p.name }); }
  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const idx = nameIndex(people);
  const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const matchStats = { rows: 0, matched: 0, teamGames: 0, withReport: 0 };
  /** 返回 Map(playerId → 官方状态) 或 null（没有可用报告） */
  function statusesFor(date, teamId, oppId, roster) {
    const abbrs = [abbrOf.get(teamId), abbrOf.get(oppId)];
    const ofGame = (rep) => rep.rows.concat(rep.notSubmitted).filter((x) => x.gameDate === date
      && x.matchup && abbrs.every((a) => x.matchup.split('@').includes(a)));
    const chain = [picks[`${date}|22`], picks[`${prevDay(date)}|0630`]];
    matchStats.teamGames += 1;
    const name = chain.find((n) => n && ofGame(report(n)).length
      && !report(n).notSubmitted.some((x) => x.gameDate === date && x.team === fullOf.get(teamId)));
    if (!name) return null;
    matchStats.withReport += 1;
    const st = new Map();
    for (const row of report(name).rows.filter((x) => x.gameDate === date && x.team === fullOf.get(teamId))) {
      const id = matchName(row.player, idx, roster, (i) => nameById.get(i));
      matchStats.rows += 1;
      if (id) { matchStats.matched += 1; st.set(id, row.status); }
    }
    return st;
  }
  
  // ---------------------------------------------------------------- 逐场重放
  /** 一季的逐场上下文：每场每队的候选名单、赛前特征、本场真实分钟（缩放到 240）、首发 */
  function buildContexts(s) {
    const prev = prevOf(s);
    // 上季：出场时场均（≥10 场）与最后效力的球队
    const prevTot = new Map(); const prevGp = new Map(); const prevTeam = new Map();
    for (const gid of Object.keys(stints[prev].games).sort()) {
      for (const [t, mins] of gameMinutes(stints[prev].games[gid])) {
        for (const [pid, m] of mins) { prevTot.set(pid, (prevTot.get(pid) ?? 0) + m); prevGp.set(pid, (prevGp.get(pid) ?? 0) + 1); prevTeam.set(pid, t); }
      }
    }
    const priorMpg = (pid) => ((prevGp.get(pid) ?? 0) >= 10 ? prevTot.get(pid) / prevGp.get(pid) : null);
    const games = expand(dataset.seasons[s]);
    // 每队本季的场次序号；每名球员为每队的出场序号
    const teamIdx = new Map(); const gameTeamIdx = new Map();
    for (const g of games) for (const t of [g.home.teamId, g.away.teamId]) {
      const k = teamIdx.get(t) ?? 0; gameTeamIdx.set(`${g.gameId}|${t}`, k); teamIdx.set(t, k + 1);
    }
    const apps = new Map(); // pid → [{ t, k, order }]
    let order = 0;
    for (const g of games) {
      const st = stints[s].games[g.gameId];
      if (!st) continue;
      for (const [t, mins] of gameMinutes(st)) for (const pid of mins.keys()) {
        if (!apps.has(pid)) apps.set(pid, []);
        apps.get(pid).push({ t, k: gameTeamIdx.get(`${g.gameId}|${t}`), order });
      }
      order += 1;
    }
    const tenure = new Map(); // t → [{ pid, start, end }]
    for (const [pid, a] of apps) {
      const byTeam = new Map();
      for (const x of a) { if (!byTeam.has(x.t)) byTeam.set(x.t, []); byTeam.get(x.t).push(x); }
      for (const [t, xs] of byTeam) {
        const first = xs[0]; const last = xs.at(-1);
        const carry = prevTeam.get(pid) === t && a[0].t === t;
        const laterOther = a.some((x) => x.t !== t && x.order > last.order);
        if (!tenure.has(t)) tenure.set(t, []);
        tenure.get(t).push({ pid, start: carry ? 0 : Math.max(0, first.k - 5), end: laterOther ? last.k : Infinity });
      }
    }
    const curN = new Map(); const curMin = new Map(); const played = new Map(); const lastPlayed = new Map();
    const out = [];
    for (const g of games) {
      const st = stints[s].games[g.gameId];
      const mins = st ? gameMinutes(st) : null;
      const today = dayNum(g.date);
      const restOf = (id) => (lastPlayed.has(id) ? today - lastPlayed.get(id) - 1 : null);
      if (mins && mins.has(g.home.teamId) && mins.has(g.away.teamId)) {
        const starters = new Set(st[2][0].slice(0, 10));
        const side = (t, opp) => {
          const k = gameTeamIdx.get(`${g.gameId}|${t}`);
          const actual = mins.get(t);
          const tot = [...actual.values()].reduce((a, v) => a + v, 0);
          const cand = new Set((tenure.get(t) ?? []).filter((x) => x.start <= k && k <= x.end).map((x) => x.pid));
          for (const pid of actual.keys()) cand.add(pid);
          const status = statusesFor(g.date, t, opp, cand);
          const rows = [...cand].map((pid) => ({
            pid, priorMpg: priorMpg(pid), n: curN.get(pid) ?? 0,
            curMpg: curN.get(pid) ? curMin.get(pid) / curN.get(pid) : null,
            status: status?.get(pid) ?? null, played: actual.has(pid), starter: starters.has(pid),
            actual: (actual.get(pid) ?? 0) * 240 / tot,
          }));
          return { teamId: t, T: played.get(t) ?? 0, rows, hasReport: status !== null };
        };
        out.push({
          season: s, gameId: g.gameId, date: g.date, homeWin: g.home.win,
          hca: g.neutral ? 0 : P.homeAdv, restPts: (restAdjust(restOf(g.home.teamId)) - restAdjust(restOf(g.away.teamId))) * P.restWeight,
          home: side(g.home.teamId, g.away.teamId), away: side(g.away.teamId, g.home.teamId),
        });
        for (const [, m] of mins) for (const [pid, v] of m) { curN.set(pid, (curN.get(pid) ?? 0) + 1); curMin.set(pid, (curMin.get(pid) ?? 0) + v); }
      }
      for (const id of [g.home.teamId, g.away.teamId]) { played.set(id, (played.get(id) ?? 0) + 1); lastPlayed.set(id, today); }
    }
    return out;
  }
  return { buildContexts, matchStats };
}
