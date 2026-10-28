/**
 * 伤病报告影子运行（2026-10-28 高磊批准，见 docs/injury-report-experiment-verdict.md「上线计划」）：
 * 每场常规赛记三套赛前预测，只记录，页面显示的预测不变。
 *   - base  ：线上默认预测（与模拟投注账本同一个 predictSchedule，不套缺阵勾选），北京 22:00 那次记；
 *   - r22   ：base 的净胜分 += β·(主调整 − 客调整)，用 22:00 那次能看到的官方报告，同一次记；
 *   - r0630 ：同上，用北京 06:30 那次（--late）能看到的报告。06:30 之前就开打的场（下午场）
 *             在 22:00 那次就记，沿用 22:00 的报告、用 06:30 的参数——与实验口径相同。
 * 调整的算法、P(出场 | 状态)、β 全部冻结在 server/injury-params-v1.json（实验在训练季上拟合），影子期内不调。
 * 球员价值（RAPM）与常规轮换来自本机每天推上来的 data/player-values.json（scripts/player-values.mjs）。
 * 盘口不进任何输入。切换条件（预注册）：≥300 场且 06:30 方案 Δlog loss < 0。
 *
 * 纯函数 + 收库句柄的读写（依赖注入，测试用 :memory:）。
 */
import { decisionInstant, toEt } from './injuryReport.mjs';
import { matchName, nameIndex, reportAdj, usualRotation } from './injuryLab.mjs';
import { normalCdf } from './lab.mjs';
import { bootstrapCI } from './fusionLab.mjs';

export const VARIANTS = ['base', 'r22', 'r0630'];
/** 页面汇总里的全部方案：rr22 / rr0630 来自 shadow_rr_predictions（server/rosterResultsShadow.mjs） */
export const SUMMARY_VARIANTS = [...VARIANTS, 'rr22', 'rr0630'];
export const TARGET_GAMES = 300;
/** 运行时刻离决策时点超过这么久，就不算这个时点（14:30 那次、补跑太晚的都不记） */
export const CAPTURE_TOL_H = 2;
/** 球员价值：RAPM 每周重拟合，给 2 天余量；轮换分钟每天推，给 2 天余量 */
export const MAX_FIT_AGE_D = 9;
export const MAX_BUILD_AGE_D = 3;
/** 报告链最早到「前一天 06:30 那次」那份（实验的 pPrev），给 cron 迟到留 1 小时 */
const CHAIN_SLACK_MS = 3600e3;

/** 美东日期 + 当天第几分钟 -> UTC 毫秒（美东只有 −4 / −5 两种偏移，试出对的那个） */
export function etToUtc(date, min) {
  const base = Date.parse(`${date}T00:00:00Z`) + min * 60000;
  for (const h of [4, 5]) {
    const t = base + h * 3600e3;
    const e = toEt(t);
    if (e.date === date && e.min === min) return t;
  }
  throw new Error(`美东时间不存在：${date} ${min}`);
}

/** 现在是哪个美东比赛日的这个时点（前后 tolH 小时内），不是返回 null */
export function captureDate(now, slot, tolH = CAPTURE_TOL_H) {
  const d = toEt(now).date;
  const shift = (k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400e3).toISOString().slice(0, 10);
  return [d, shift(-1), shift(1)].find((x) => Math.abs(now - decisionInstant(x, slot)) <= tolH * 3600e3) ?? null;
}

/**
 * 当时能看到的报告，从新到旧：标注时间 ≤ cutoff，且不早于 floorMs。
 * 与实验同：链 = 本时点那份 →（06:30 时）同日 22:00 那份 → 前一天 06:30 那份，再早的不用
 */
export const reportChain = (reports, cutoffMs, floorMs = -Infinity) => reports
  .filter((r) => { const t = Date.parse(r.asOf); return t <= cutoffMs && t >= floorMs; })
  .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));

/**
 * 某队这场用哪份报告：链上第一份「列了这场、且这队不是 NOT YET SUBMITTED」的。
 * 返回 { name, asOf, rows: 这队这场的行 } 或 null（没有信息，调整记 0）
 */
export function teamReport(chain, { date, abbrs, full }) {
  const ofGame = (x) => x.gameDate === date && x.matchup && abbrs.every((a) => x.matchup.split('@').includes(a));
  for (const r of chain) {
    if (!r.rows.some(ofGame) && !r.notSubmitted.some(ofGame)) continue;
    if (r.notSubmitted.some((x) => ofGame(x) && x.team === full)) continue;
    return { name: r.name, asOf: r.asOf, rows: r.rows.filter((x) => ofGame(x) && x.team === full) };
  }
  return null;
}

/** 球员价值文件能不能用：RAPM 不超过 9 天、轮换分钟不超过 3 天 */
export const valuesUsable = (v, now) => !!v?.rapm && !!v?.recent
  && now - Date.parse(v.fittedAt) <= MAX_FIT_AGE_D * 86400e3 && now - Date.parse(v.builtAt) <= MAX_BUILD_AGE_D * 86400e3;

const iso = (ms) => new Date(ms).toISOString();

/**
 * 本次运行要记的影子预测行。
 * slate: [{ gameId, date(美东), tipoff, homeId, awayId, margin(线上净胜分), dataAt }]
 * reports: [{ name, asOf(ISO), rows, notSubmitted }]；teams: [{ teamId, abbr, full }]
 */
export function shadowRows({ slate, slot, now, params, values, reports, teams }) {
  const D = captureDate(now, slot);
  if (!D) return [];
  const sd = params.spreadSd ?? 12;
  const at = iso(now);
  const usable = valuesUsable(values, now);
  const lag = (params.lagMin ?? 15) * 60000;
  const prevDay = new Date(Date.parse(`${D}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
  const chain = reportChain(reports, now - lag, decisionInstant(prevDay, '0630') - lag - CHAIN_SLACK_MS);
  const team = new Map(teams.map((t) => [t.teamId, t]));
  let val; let idx; let names;
  if (usable) {
    val = new Map(Object.entries(values.rapm).map(([k, v]) => [Number(k), v]));
    names = new Map(values.people.map(([id, n]) => [id, n]));
    idx = nameIndex(values.people.map(([id, name]) => ({ id, name })));
  }
  const side = (teamId, abbrs) => {
    const tr = teamReport(chain, { date: D, abbrs, full: team.get(teamId)?.full });
    const usual = usualRotation(values.recent[teamId] ?? [], D, params.window ?? 10);
    const roster = new Set(Object.entries(values.firstSeen?.[teamId] ?? {}).filter(([, d]) => d < D).map(([id]) => Number(id)));
    const st = new Map();
    let unmatched = 0;
    for (const r of tr?.rows ?? []) {
      const id = matchName(r.player, idx, roster, (i) => names.get(i));
      if (id) st.set(id, r.status); else unmatched += 1;
    }
    return {
      tr, usual, st, unmatched,
      adj: (pPlay) => (tr && usual ? reportAdj(usual, (id) => st.get(id), pPlay, val, params.opts) : 0),
    };
  };
  const rows = [];
  for (const g of slate) {
    const tip = Date.parse(g.tipoff);
    if (g.date !== D || !(tip > now)) continue;
    const common = {
      game_id: g.gameId, params_version: params.version, captured_at: at, game_date: D, tipoff_utc: iso(tip),
      home_id: g.homeId, away_id: g.awayId, base_margin: g.margin, data_at: g.dataAt ?? null,
    };
    const variants = slot === '22' ? ['base', 'r22', ...(tip <= decisionInstant(D, '0630') ? ['r0630'] : [])] : ['r0630'];
    let h; let a;
    for (const v of variants) {
      if (v === 'base') { rows.push({ ...common, variant: v, margin: g.margin, p_home: normalCdf(g.margin, sd) }); continue; }
      if (!usable) continue;
      const abbrs = [team.get(g.homeId)?.abbr, team.get(g.awayId)?.abbr];
      h ??= side(g.homeId, abbrs);
      a ??= side(g.awayId, abbrs);
      // 06:30 之前开打的场在 22:00 那次记 r0630：报告是 22:00 的，参数是 06:30 的
      const p = params.slots[v.slice(1)];
      const adjHome = h.adj(p.pPlay); const adjAway = a.adj(p.pPlay);
      const margin = g.margin + p.beta * (adjHome - adjAway);
      const info = (s) => ({ statuses: [...s.st], unmatched: s.unmatched, usualN: s.usual?.length ?? 0 });
      rows.push({
        ...common, variant: v, beta: p.beta, adj_home: adjHome, adj_away: adjAway, margin, p_home: normalCdf(margin, sd),
        home_report: h.tr?.name ?? null, home_report_as_of: h.tr?.asOf ?? null,
        away_report: a.tr?.name ?? null, away_report_as_of: a.tr?.asOf ?? null,
        values_fitted_at: values.fittedAt, values_built_at: values.builtAt,
        inputs: JSON.stringify({ home: info(h), away: info(a) }),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- 库

const COLS = ['game_id', 'variant', 'params_version', 'captured_at', 'game_date', 'tipoff_utc', 'home_id', 'away_id',
  'base_margin', 'beta', 'adj_home', 'adj_away', 'margin', 'p_home', 'home_report', 'home_report_as_of',
  'away_report', 'away_report_as_of', 'values_fitted_at', 'values_built_at', 'data_at', 'inputs'];

const tx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

/**
 * 插入；已有的 (game_id, variant) 由触发器忽略。每行一个保存点：某场恰在运行中开赛被触发器拒，
 * 只丢那一行，不连累整晚。返回 { n: 新插入行数, rejected: [{ game_id, variant, why }] }
 */
export function insertShadow(db, rows, { table = 'shadow_predictions', cols = COLS } = {}) {
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const rejected = [];
  const n = tx(db, () => rows.reduce((k, r) => {
    db.exec('SAVEPOINT row');
    try {
      const c = Number(stmt.run(...cols.map((col) => r[col] ?? null)).changes ?? 0);
      db.exec('RELEASE row');
      return k + c;
    } catch (e) {
      db.exec('ROLLBACK TO row'); db.exec('RELEASE row');
      rejected.push({ game_id: r.game_id, variant: r.variant, why: String(e.message) });
      return k;
    }
  }, 0));
  return { n, rejected };
}

/** scores: { gameId: { homeScore, awayScore } }。只写还没结算的行，返回写入行数 */
export function settleShadow(db, scores, at = new Date().toISOString(), table = 'shadow_predictions') {
  const stmt = db.prepare(`UPDATE ${table} SET home_score = ?, away_score = ?, home_win = ?, settled_at = ?
    WHERE game_id = ? AND settled_at IS NULL`);
  return tx(db, () => Object.entries(scores).reduce((n, [gid, s]) => (s.homeScore == null || s.awayScore == null ? n
    : n + Number(stmt.run(s.homeScore, s.awayScore, s.homeScore > s.awayScore ? 1 : 0, at, gid).changes ?? 0)), 0));
}

export const shadowAll = (db) => db.prepare('SELECT * FROM shadow_predictions ORDER BY game_date, game_id, variant').all();

/** 存一份解析好的报告（同名忽略）。rep: { name, asOf(UTC ISO), fetchedAt, rows, notSubmitted } */
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export function storeReport(db, rep) {
  if (!ISO.test(rep.asOf)) throw new Error(`报告标注时间必须是 UTC ISO：${rep.asOf}`);
  return Number(db.prepare('INSERT INTO injury_reports (name, as_of, fetched_at, json) VALUES (?, ?, ?, ?)')
    .run(rep.name, rep.asOf, rep.fetchedAt, JSON.stringify({ rows: rep.rows, notSubmitted: rep.notSubmitted })).changes ?? 0);
}

/** 标注时间不早于 sinceIso 的报告 */
export const storedReports = (db, sinceIso) => db.prepare('SELECT * FROM injury_reports WHERE as_of >= ? ORDER BY as_of')
  .all(sinceIso).map((r) => ({ name: r.name, asOf: r.as_of, fetchedAt: r.fetched_at, ...JSON.parse(r.json) }));

// ---------------------------------------------------------------- 页面汇总

const ll = (p, y) => -Math.log(Math.max(y ? p : 1 - p, 1e-12));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/**
 * 每套方案：已结算场数、log loss、Brier；方案还给出与基线在同一批场次上的配对差（bootstrap 95% 区间）。
 * progress = 06:30 方案与基线都已结算的场数（切换门槛按它算）；rrProgress 同理按 rr0630。
 * rows 可以是 shadow_predictions 与 shadow_rr_predictions 两张表的行拼在一起（按 variant 区分）
 */
export function shadowSummary(rows, { B = 1000, target = TARGET_GAMES } = {}) {
  const done = rows.filter((r) => r.settled_at != null && r.home_win != null);
  const base = new Map(done.filter((r) => r.variant === 'base').map((r) => [r.game_id, r]));
  const variants = SUMMARY_VARIANTS.map((variant) => {
    const mine = done.filter((r) => r.variant === variant);
    const out = {
      variant, n: mine.length,
      logLoss: mean(mine.map((r) => ll(r.p_home, r.home_win))),
      brier: mean(mine.map((r) => (r.home_win - r.p_home) ** 2)),
    };
    if (variant === 'base') return out;
    const paired = mine.filter((r) => base.has(r.game_id));
    const diff = (f) => (paired.length ? bootstrapCI(paired.map((r) => f(r) - f(base.get(r.game_id))), { B }) : null);
    return {
      ...out, paired: paired.length,
      dLogLoss: diff((r) => ll(r.p_home, r.home_win)),
      dBrier: diff((r) => (r.home_win - r.p_home) ** 2),
    };
  });
  return {
    target,
    progress: variants.find((v) => v.variant === 'r0630').paired,
    // 阵容+战绩榜的预注册主方案是 rr0630（见 docs/roster-results-update-verdict.md「影子运行预注册」）
    rrProgress: variants.find((v) => v.variant === 'rr0630').paired,
    pending: new Set(rows.filter((r) => r.settled_at == null).map((r) => r.game_id)).size,
    firstDate: rows[0]?.game_date ?? null,
    variants,
  };
}
