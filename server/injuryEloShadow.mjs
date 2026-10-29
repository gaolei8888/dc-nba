/**
 * 伤病感知 Elo 影子运行（2026-10-29 高磊批准「只做影子」）：inj-p1（P1，β=0.5）与 inj-a（A，s=0.75）两套赛前预测，
 * 只记录，页面显示的预测、账本规则、所有参数都不变。
 * 预注册：docs/superpowers/specs/2026-10-29-injury-elo-shadow-prereg.md；回测：docs/injury-aware-elo-verdict.md。
 *
 *   inj-p1：base 净胜分 − β·(D_pre主 − D_pre客)
 *   inj-a ：base 净胜分 + w·((Elo_A主 − Elo_A客) − (Elo_P主 − Elo_P客))/28 − s·(D_pre主 − D_pre客)
 * base = 同场 shadow_predictions 的 base 行（北京 22:00 记），没有就用此刻的线上预测；w = 线上 Elo 权重（默认 1）。
 * Elo_P = 线上口径（computeElo 逐场、从 eloPreseasonExact 起），Elo_A = 同样逐场，但期望用 (Elo − 28·s·D_post)。
 * D_post 全为 0 时 Elo_A ≡ Elo_P（单测锁定），inj-a 即退化为 P1(β=s)。
 *
 * 数据（全部是服务器上已有的，零额外请求）：
 *   - 赛果：data/schedule.json（线上 Elo 同源）；只用比赛日（美东）之前的；
 *   - 谁上了场、几分钟：data/player-values.json 的 played（全季逐场），旧文件只有 recent（每队最近 12 场）；
 *   - 赛前报告：库里 injury_reports（scripts/shadow.mjs 抓的那几份）；
 *   - 价值、P(出场|状态)、A 的开季 Elo：server/injury-elo-params-v1.json（回测冻结）。
 * 没有出场数据的比赛：A 的更新里两队 D_post 记 0（回测同），但每行记下两队的覆盖场数与缺的 gameId，不会悄悄记 0。
 *
 * 纯函数（依赖注入，测试用 :memory:）。
 */
import { decisionInstant } from './injuryReport.mjs';
import { matchName, nameIndex } from './injuryLab.mjs';
import { normalCdf } from './lab.mjs';
import { rng } from './fusionLab.mjs';
import { scheduleEloGames, ELO_PER_POINT } from './ratings.mjs';
import { eloShift, healthyRotation, preDeduction, postDeduction } from './injuryEloLab.mjs';
import { captureDate, reportChain, teamReport } from './injuryShadow.mjs';

export const INJ_ELO_VARIANTS = ['inj-p1-22', 'inj-p1-0630', 'inj-a-22', 'inj-a-0630'];
/** 预注册的主变体（06:30 报告链，与回测同口径） */
export const INJ_ELO_PRIMARY = ['inj-p1-0630', 'inj-a-0630'];
export const INJ_ELO_COLS = ['game_id', 'variant', 'params_version', 'captured_at', 'game_date', 'tipoff_utc', 'home_id', 'away_id',
  'base_margin', 'base_source', 'elo_adj', 'scale', 'dpre_home', 'dpre_away', 'margin', 'p_home',
  'home_report', 'home_report_as_of', 'away_report', 'away_report_as_of', 'results_through',
  'games_home', 'games_away', 'covered_home', 'covered_away', 'dpost_coverage',
  'values_built_at', 'data_at', 'inputs'];

/** 报告链最早到「前一天 06:30 那次」那份，给 cron 迟到留 1 小时（与 injuryShadow 同） */
const CHAIN_SLACK_MS = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);

/**
 * 比赛日 d 那场能用的报告：标注时间 ≤ 决策时点 − lag，且早于开赛；不早于前一天 06:30 那份。
 * 决策时点 = min(cutoffMs, 开赛)；开赛时间缺失时调用方不该调（保守：不记）。
 */
export function usableChain(reports, { cutoffMs, tipMs, date, lagMs }) {
  if (!Number.isFinite(tipMs)) return [];
  const floor = decisionInstant(prevDay(date), '0630') - lagMs - CHAIN_SLACK_MS;
  return reportChain(reports, Math.min(cutoffMs, tipMs) - lagMs, floor).filter((r) => Date.parse(r.asOf) < tipMs);
}

/** player-values.json -> Map(gameId -> Map(teamId -> Map(pid -> 分钟)))，以及用的是哪个字段 */
export function playedIndex(values) {
  const src = values?.played ? 'played' : values?.recent ? 'recent' : null;
  const out = new Map();
  if (!src) return { byGame: out, src };
  for (const [team, list] of Object.entries(values[src])) {
    for (const g of list) {
      if (!out.has(g.gameId)) out.set(g.gameId, new Map());
      out.get(g.gameId).set(Number(team), new Map(Object.entries(g.mins).map(([id, m]) => [Number(id), m])));
    }
  }
  return { byGame: out, src };
}

/** 某队某场的报告状态：Map(pid -> 状态)，与报告名、标注时间、未匹配行数；链上没有这队这场返回 null */
function statusesOf(chain, { date, abbrs, full, roster, idx, nameOf }) {
  const tr = teamReport(chain, { date, abbrs, full });
  if (!tr) return null;
  const st = new Map(); let unmatched = 0;
  for (const r of tr.rows) {
    const id = matchName(r.player, idx, roster, nameOf);
    if (id) st.set(id, r.status); else unmatched += 1;
  }
  return { name: tr.name, asOf: tr.asOf, st, unmatched };
}

/**
 * 本季逐场重放到比赛日 D 之前：两套 Elo、每队的出场记录（供健康基线）、每场 D_post、每队覆盖。
 * games: scheduleEloGames 形状（date, gameId 升序）；只用 date < D 的。
 * eloStartP: 线上开季 Elo（eloPreseasonExact）；A 的开季 = eloStartP + (冻结 A − 冻结 P)，两者一致时就是冻结 A。
 */
export function replaySeason({ games, D, byGame, reports, teams, params, eloStartP, idx, nameOf }) {
  const val = new Map(Object.entries(params.values).map(([id, v]) => [Number(id), v]));
  const team = new Map(teams.map((t) => [t.teamId, t]));
  const lagMs = params.lagMin * 60000;
  const W = params.window; const minGames = params.minGames;
  const eloP = new Map(); const eloA = new Map();
  for (const [id, v] of Object.entries(eloStartP)) {
    eloP.set(Number(id), v);
    eloA.set(Number(id), v + (params.eloStartA[id] ?? v) - (params.eloStartP[id] ?? v));
  }
  const startDrift = Math.max(0, ...Object.entries(eloStartP).map(([id, v]) => Math.abs(v - (params.eloStartP[id] ?? v))));
  const minsBy = new Map();   // pid -> Map(team -> [分钟…])
  const lastTeam = new Map();
  const teamHist = new Map(); // team -> [Map(pid -> 分钟)]（有出场数据的场）
  const cov = new Map();      // team -> { games, covered, missing: [] }
  const dPost = new Map();    // gameId -> { h, a } | null（缺数据）
  const audit = { postNoReport: 0, postWithReport: 0 };
  const covOf = (t) => { if (!cov.has(t)) cov.set(t, { games: 0, covered: 0, missing: [] }); return cov.get(t); };
  const cand = (t) => [...minsBy].filter(([pid, byT]) => byT.has(t) && lastTeam.get(pid) === t).map(([pid]) => pid);
  /** 健康基线：本队少于 minGames 场有数据时为空；资格 = 近 W 场上过，或在赛前报告上 */
  const healthy = (t, onReport) => {
    const hist = teamHist.get(t) ?? [];
    if (hist.length < minGames) return [];
    const recent = new Set(hist.slice(-W).flatMap((m) => [...m.keys()]));
    return healthyRotation(cand(t).filter((pid) => recent.has(pid) || onReport?.has(pid))
      .map((pid) => ({ id: pid, mins: minsBy.get(pid).get(t) })), W);
  };
  const past = games.filter((g) => g.date < D);
  for (let i = 0; i < past.length;) {
    let j = i;
    while (j < past.length && past[j].date === past[i].date) j += 1;
    const day = past.slice(i, j); i = j;
    const updates = [];
    for (const g of day) {
      const h = g.home.teamId; const a = g.away.teamId;
      const m = byGame.get(g.gameId);
      const ok = m?.has(h) && m?.has(a);
      for (const t of [h, a]) { const c = covOf(t); c.games += 1; if (ok) c.covered += 1; else c.missing.push(g.gameId); }
      let d = null;
      if (ok) {
        // 过去这场的健康基线也只用更早日期的出场；「在报告上」用那天 06:30（早场 22:00）能看到的报告
        const tip = Date.parse(g.tipoff ?? '');
        const d0630 = decisionInstant(g.date, '0630');
        const decision = Number.isFinite(tip) && tip > d0630 ? d0630 : decisionInstant(g.date, '22');
        const chain = usableChain(reports, { cutoffMs: decision, tipMs: Number.isFinite(tip) ? tip : decision + 1, date: g.date, lagMs });
        const abbrs = [team.get(h)?.abbr, team.get(a)?.abbr];
        const side = (t) => {
          const s = chain.length ? statusesOf(chain, { date: g.date, abbrs, full: team.get(t)?.full, roster: new Set(cand(t)), idx, nameOf }) : null;
          if (s) audit.postWithReport += 1; else audit.postNoReport += 1;
          return postDeduction(healthy(t, s?.st), new Set(m.get(t).keys()), val, params.valueOpts);
        };
        d = { h: side(h), a: side(a) };
        updates.push(m);
      }
      dPost.set(g.gameId, d);
    }
    // Elo：与 computeElo 同序逐场；D_post 只取决于更早日期，所以先算完当日 D_post 再更新不影响结果
    for (const g of day) {
      const d = dPost.get(g.gameId);
      const h = g.home.teamId; const a = g.away.teamId;
      const ph = eloP.get(h) ?? 1500; const pa = eloP.get(a) ?? 1500;
      const sp = eloShift(ph, pa, g, { k: params.k });
      eloP.set(h, ph + sp); eloP.set(a, pa - sp);
      const ah = eloA.get(h) ?? 1500; const aa = eloA.get(a) ?? 1500;
      const sa = eloShift(ah, aa, g, { k: params.k, s: params.s, dH: d?.h ?? 0, dA: d?.a ?? 0 });
      eloA.set(h, ah + sa); eloA.set(a, aa - sa);
    }
    // 当日全部算完再记出场：同日的出场不进同日的基线
    for (const m of updates) {
      for (const [t, mins] of m) {
        if (!teamHist.has(t)) teamHist.set(t, []);
        teamHist.get(t).push(mins);
        for (const [pid, v] of mins) {
          if (!minsBy.has(pid)) minsBy.set(pid, new Map());
          if (!minsBy.get(pid).has(t)) minsBy.get(pid).set(t, []);
          minsBy.get(pid).get(t).push(v);
          lastTeam.set(pid, t);
        }
      }
    }
  }
  return {
    eloP, eloA, dPost, cov: (t) => cov.get(t) ?? { games: 0, covered: 0, missing: [] }, healthy, cand, val,
    resultsThrough: past.at(-1)?.date ?? null, resultsN: past.length, startDrift, audit,
  };
}

/**
 * 本次运行要记的 inj-p1 / inj-a 行。
 * slate: [{ gameId, date, tipoff, homeId, awayId, margin(线上净胜分), dataAt }]；baseMargins: Map(gameId -> 22:00 记的 base 净胜分)；
 * store: { schedule, teams }；values: player-values.json；reports: 库里的报告；eloWeight = 线上 wElo/(wElo+wNet)。
 * 返回 { rows, skipped: [{ game_id, variant, why }], info }
 */
export function injEloRows({ slate, slot, now, params, store, values, reports, baseMargins = new Map(), eloWeight = 1, code = null }) {
  const D = captureDate(now, slot);
  const rows = []; const skipped = [];
  if (!D) return { rows, skipped, info: null };
  const variantsOf = (tip) => (slot === '22'
    ? ['inj-p1-22', 'inj-a-22', ...(tip <= decisionInstant(D, '0630') ? ['inj-p1-0630', 'inj-a-0630'] : [])]
    : ['inj-p1-0630', 'inj-a-0630']);
  const todays = slate.filter((g) => g.date === D);
  const skipAll = (why) => { for (const g of todays) for (const v of INJ_ELO_VARIANTS.filter((x) => x.endsWith(slot === '22' ? '22' : '0630'))) skipped.push({ game_id: g.gameId, variant: v, why }); };
  const { byGame, src } = playedIndex(values);
  if (!src) { skipAll('player-values.json 缺失或没有 played / recent'); return { rows, skipped, info: null }; }
  if (!values.people) { skipAll('player-values.json 没有姓名表'); return { rows, skipped, info: null }; }
  if (Date.parse(values.builtAt) > now) { skipAll(`player-values 生成时间在未来：${values.builtAt}`); return { rows, skipped, info: null }; }
  const teams = store.teams;
  const eloStartP = Object.fromEntries(teams.map((t) => [t.teamId, t.eloPreseasonExact ?? t.eloPreseason]));
  if (Object.values(eloStartP).some((v) => !Number.isFinite(v))) { skipAll('teams.json 缺开季 Elo'); return { rows, skipped, info: null }; }
  const names = new Map(values.people.map(([id, n]) => [id, n]));
  const idx = nameIndex(values.people.map(([id, name]) => ({ id, name })));
  const nameOf = (i) => names.get(i);
  const tipOf = new Map(store.schedule.games.map((x) => [x.gameId, x.dateTimeUtc ?? null]));
  const games = scheduleEloGames(store.schedule.games, teams).map((g) => ({ ...g, tipoff: tipOf.get(g.gameId) ?? null }));
  const st = replaySeason({ games, D, byGame, reports, teams, params, eloStartP, idx, nameOf });
  if (st.resultsThrough && st.resultsThrough >= D) throw new Error(`用了比赛日当天或之后的赛果：${st.resultsThrough}`);
  // 核对：D_post 全为 0 时的 Elo 就是线上 Elo（teams.json 的 elo 保留一位小数）。只记录，不拦
  const eloCheck = Math.max(0, ...teams.filter((t) => Number.isFinite(t.elo) && st.eloP.has(t.teamId))
    .map((t) => Math.abs(st.eloP.get(t.teamId) - t.elo)));
  const team = new Map(teams.map((t) => [t.teamId, t]));
  const lagMs = params.lagMin * 60000;
  const at = iso(now);
  for (const g of todays) {
    const tip = Date.parse(g.tipoff ?? '');
    if (!Number.isFinite(tip)) {
      // 保守：没有开赛时间就没法证明报告早于开赛，不记
      for (const v of variantsOf(Infinity)) skipped.push({ game_id: g.gameId, variant: v, why: '没有开赛时间（保守分支：不记）' });
      continue;
    }
    if (!(tip > now)) continue;
    const variants = variantsOf(tip);
    const chain = usableChain(reports, { cutoffMs: now, tipMs: tip, date: D, lagMs });
    const abbrs = [team.get(g.homeId)?.abbr, team.get(g.awayId)?.abbr];
    const side = (t) => {
      const s = statusesOf(chain, { date: D, abbrs, full: team.get(t)?.full, roster: new Set(st.cand(t)), idx, nameOf });
      const H = st.healthy(t, s?.st);
      const dPre = s ? preDeduction(H, (id) => s.st.get(id), params.pPlay, st.val, params.valueOpts) : 0;
      if (s && !(Date.parse(s.asOf) + lagMs <= now && Date.parse(s.asOf) < tip)) throw new Error(`报告 ${s.name} 标注 ${s.asOf} 不早于记录时刻 / 开赛`);
      return { s, H, dPre, cov: st.cov(t) };
    };
    const h = side(g.homeId); const a = side(g.awayId);
    const fromShadow = baseMargins.get(g.gameId);
    const base = Number.isFinite(fromShadow) ? fromShadow : g.margin;
    const eloAdj = eloWeight * (((st.eloA.get(g.homeId) ?? 1500) - (st.eloA.get(g.awayId) ?? 1500))
      - ((st.eloP.get(g.homeId) ?? 1500) - (st.eloP.get(g.awayId) ?? 1500))) / ELO_PER_POINT;
    const gamesN = h.cov.games + a.cov.games; const coveredN = h.cov.covered + a.cov.covered;
    const info = (x) => ({
      H: x.H.length, statuses: x.s ? [...x.s.st] : null, unmatched: x.s?.unmatched ?? null, missing: x.cov.missing,
    });
    for (const variant of variants) {
      const isA = variant.startsWith('inj-a');
      const scale = isA ? params.s : params.beta;
      const margin = base + (isA ? eloAdj : 0) - scale * (h.dPre - a.dPre);
      rows.push({
        game_id: g.gameId, variant, params_version: params.version, captured_at: at, game_date: D, tipoff_utc: iso(tip),
        home_id: g.homeId, away_id: g.awayId, base_margin: base, base_source: Number.isFinite(fromShadow) ? 'shadow-base' : 'live',
        elo_adj: isA ? eloAdj : null, scale, dpre_home: h.dPre, dpre_away: a.dPre, margin, p_home: normalCdf(margin, params.spreadSd),
        home_report: h.s?.name ?? null, home_report_as_of: h.s?.asOf ?? null, away_report: a.s?.name ?? null, away_report_as_of: a.s?.asOf ?? null,
        results_through: st.resultsThrough,
        games_home: h.cov.games, games_away: a.cov.games, covered_home: h.cov.covered, covered_away: a.cov.covered,
        dpost_coverage: gamesN ? coveredN / gamesN : null,
        values_built_at: values.builtAt ?? null, data_at: g.dataAt ?? null,
        inputs: JSON.stringify({
          home: info(h), away: info(a), playedSrc: src, resultsN: st.resultsN,
          eloA: [st.eloA.get(g.homeId), st.eloA.get(g.awayId)], eloP: [st.eloP.get(g.homeId), st.eloP.get(g.awayId)],
          eloCheck, startDrift: st.startDrift, postReport: st.audit, valuesGamesThrough: values.gamesThrough ?? null, code,
        }),
      });
    }
  }
  return { rows, skipped, info: { D, src, resultsThrough: st.resultsThrough, resultsN: st.resultsN, eloCheck, startDrift: st.startDrift, audit: st.audit } };
}

export const injEloAll = (db) => db.prepare('SELECT * FROM shadow_inj_elo_predictions ORDER BY game_date, game_id, variant').all();

// ---------------------------------------------------------------- 读数（预注册：共同结算场、按比赛日分块 bootstrap）

const ll = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-12));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** 按比赛日分块的 bootstrap：items = [{ day, d }]，返回 { mean, lo, hi, days } */
export function dayBlockCI(items, { B = 2000, seed = 7 } = {}) {
  if (!items.length) return null;
  const byDay = new Map();
  for (const x of items) { if (!byDay.has(x.day)) byDay.set(x.day, []); byDay.get(x.day).push(x.d); }
  const blocks = [...byDay.values()].map((v) => [v.reduce((s, d) => s + d, 0), v.length]);
  const rand = rng(seed); const K = blocks.length; const means = [];
  for (let b = 0; b < B; b += 1) {
    let s = 0; let n = 0;
    for (let i = 0; i < K; i += 1) { const [bs, bn] = blocks[Math.floor(rand() * K)]; s += bs; n += bn; }
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return { mean: mean(items.map((x) => x.d)), lo: means[Math.floor(0.025 * B)], hi: means[Math.ceil(0.975 * B) - 1], days: K };
}

/**
 * 预注册的读数：base、inj-p1-0630、inj-a-0630 都已结算的共同场上，四套（另加 rr0630，在共同场里有就算）的 log loss / Brier，
 * 与三组配对差（按比赛日分块 bootstrap）。rows = shadow_predictions + shadow_rr_predictions + shadow_inj_elo_predictions 的行。
 */
export function injEloSummary(rows, { B = 2000, seed = 7, target = 300 } = {}) {
  const done = rows.filter((r) => r.settled_at != null && r.home_win != null);
  const by = (v) => new Map(done.filter((r) => r.variant === v).map((r) => [r.game_id, r]));
  const arms = ['base', ...INJ_ELO_PRIMARY, 'rr0630'];
  const m = Object.fromEntries([...arms, 'inj-p1-22', 'inj-a-22'].map((v) => [v, by(v)]));
  const common = [...m.base.keys()].filter((gid) => INJ_ELO_PRIMARY.every((v) => m[v].has(gid))).sort();
  const score = (v, ids) => {
    const rs = ids.map((gid) => m[v].get(gid)).filter(Boolean);
    return { variant: v, n: rs.length, logLoss: mean(rs.map((r) => ll(r.p_home, r.home_win))), brier: mean(rs.map((r) => (r.home_win - r.p_home) ** 2)) };
  };
  const diff = (a, b, ids, f) => dayBlockCI(ids.map((gid) => ({ day: m[a].get(gid).game_date, d: f(m[a].get(gid)) - f(m[b].get(gid)) })), { B, seed });
  const lossF = (r) => ll(r.p_home, r.home_win); const brierF = (r) => (r.home_win - r.p_home) ** 2;
  const pairs = [['inj-a-0630', 'inj-p1-0630'], ['inj-p1-0630', 'base'], ['inj-a-0630', 'base']];
  const full = common.filter((gid) => { const r = m['inj-a-0630'].get(gid); return r.covered_home === r.games_home && r.covered_away === r.games_away; });
  const injRows = rows.filter((r) => r.variant === 'inj-a-0630');
  const teamGames = injRows.reduce((s, r) => s + (r.games_home ?? 0) + (r.games_away ?? 0), 0);
  const teamCovered = injRows.reduce((s, r) => s + (r.covered_home ?? 0) + (r.covered_away ?? 0), 0);
  return {
    available: true, target, n: common.length, firstDate: common.length ? m.base.get(common[0]).game_date : null,
    pending: new Set(rows.filter((r) => r.settled_at == null && (r.variant.startsWith('inj-'))).map((r) => r.game_id)).size,
    arms: arms.map((v) => score(v, common)),
    deltas: pairs.map(([a, b]) => ({
      a, b, n: common.length, dLogLoss: diff(a, b, common, lossF), dBrier: diff(a, b, common, brierF),
    })),
    fullCoverage: {
      n: full.length,
      dLogLoss: diff('inj-a-0630', 'inj-p1-0630', full, lossF),
    },
    dpostCoverage: teamGames ? teamCovered / teamGames : null,
    late22: ['inj-p1-22', 'inj-a-22'].map((v) => score(v, [...m[v].keys()])),
  };
}
