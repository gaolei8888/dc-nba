// 独赢盘回测：一次请求的完整视图（筛选校验 → 逐注流水 → 汇总 / 区间 / 分桶 / 校准 / 功效 / 警告 / 结论），
// 以及前向账本（paper_bets）按记录原样接入。worker（历史情景）与主线程（前向账本）共用。
//
// 规则（spec 三、四、五；决定 2、4、5；裁定 M3–M6）：
//   - 历史情景（close / open / closeBest）用重放模型 'replay-elo-wf'；前向账本用线上生产模型
//     'production-logged'，概率按记录原样、不重新校准；两者绝不合并。
//   - 前向主结果 = 账本自己预注册的 edge3 规则，按记录原样（是否下注、方向、价格）；
//     按盈亏平衡重算的 B-edge3 只作次要结果、单独标注（labels.forwardBasis）。
//   - 正式结论只给两种组合（M5）：历史情景 + 测试期 + 预选策略 + 默认成本 + 不缩日期 / 博彩公司（period 'test'）；
//     前向 + 账本原样主规则（早规则）+ 默认成本 + 不缩日期（period 'live'）。其余一律 verdict null、exploratory true。
//   - closeBest 只是敏感性：沿用 close 的选定策略，最优价不进主结论（spec 三.1）→ 不给正式结论（exploratory）；
//     唯一例外是 close 没选出策略 → 仍给 noStrategy 结论（M6）。
//   - 报告缺失或缺该情景的选择结果 → 抛 err.labDataMissing，不冒充「没有策略合格」。
//   - 多重比较只列该情景选择期的可选策略（SELECTABLE），并附完整结果表与选定策略。
import { buildCandidates, runBacktest, summarizeLedger, outcomeFor, DEFAULT_COSTS } from './betBacktest.mjs';
import { STRATEGIES } from './betStrategies.mjs';
import {
  SPLITS, SELECTABLE, FORWARD_PRIMARY, splitOf, selectionScenario, selectForScenario, multipleComparisons,
} from './betSplits.mjs';
import { blockBootstrap, bucketRoi, calibrationVsMarket, powerAnalysis, betsNeeded, mlVerdict, MIN_BETS } from './betStats.mjs';
import { isValidAmerican, americanToDecimal, worsenAmerican, devigPair, edgeOf, evPerUnit } from './oddsMath.mjs';
import { settleBet } from './betSettlement.mjs';
import { US_BOOKS } from './books.mjs';
import { PRIMARY_RULE, LATE_RULE } from './ledger.mjs';
import { MODEL_VERSION_REPLAY } from './walkForward.mjs';
import { msg, codedError } from './messages.mjs';

export const SCENARIOS = ['close', 'open', 'closeBest', 'forward'];
export const SLIPPAGE_OPTIONS = [0, 5, 10];

const SPLIT_OPTIONS = ['train', 'validate', 'test', 'all'];
export const FILTER_KEYS = ['scenario', 'split', 'season', 'from', 'to', 'book', 'strategy', 'slippagePts', 'feeOnWin'];
const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));
const FORWARD_BOOK = 'draftkings';
/** walk-forward 的样本内参数季（无更早赛季可拟合） */
const IN_SAMPLE_SEASONS = ['2022-23'];
const RECENT_BETS = 200;
const BANKROLL0 = 100;

// ---------------------------------------------------------------------------
// 筛选校验

const bad = (field) => codedError('err.badFilter', '筛选条件不合法', { field });
const given = (body, k) => body[k] !== undefined && body[k] !== null;

const isSeason = (s) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
};
const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * 校验并补默认值。body 为请求体（部分 Filters），data 为报告（可为 null）。
 * 默认：scenario 'close'、split 'test'、book 'chain'（closeBest 为 'best'）、成本 0；
 * strategy 默认 = 该情景的预选策略（closeBest 沿用 close；前向 = FORWARD_PRIMARY；无报告或未选出 → null）。
 * 任何非法值（含未知字段）→ codedError('err.badFilter', …, { field })。
 */
export function validateFilters(body, data) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw bad('body');
  for (const k of Object.keys(body)) if (!FILTER_KEYS.includes(k)) throw bad(k);

  const scenario = given(body, 'scenario') ? body.scenario : 'close';
  if (!SCENARIOS.includes(scenario)) throw bad('scenario');
  const forward = scenario === 'forward';

  const split = given(body, 'split') ? body.split : 'test';
  if (!SPLIT_OPTIONS.includes(split)) throw bad('split');

  const season = given(body, 'season') ? body.season : null;
  if (season !== null && (typeof season !== 'string' || !isSeason(season))) throw bad('season');
  const from = given(body, 'from') ? body.from : null;
  if (from !== null && (typeof from !== 'string' || !isDate(from))) throw bad('from');
  const to = given(body, 'to') ? body.to : null;
  if (to !== null && (typeof to !== 'string' || !isDate(to))) throw bad('to');
  if (from !== null && to !== null && from > to) throw bad('to');

  // 博彩公司：最优价只能经 closeBest（单独标注的敏感性）；前向账本只有 DraftKings
  let book;
  if (scenario === 'closeBest') {
    book = given(body, 'book') ? body.book : 'best';
    if (book !== 'best') throw bad('book');
  } else if (forward) {
    book = given(body, 'book') ? body.book : 'chain';
    if (book !== 'chain' && book !== FORWARD_BOOK) throw bad('book');
  } else {
    book = given(body, 'book') ? body.book : 'chain';
    if (book !== 'chain' && !US_BOOKS.includes(book)) throw bad('book');
  }

  let strategy;
  if (given(body, 'strategy')) {
    strategy = body.strategy;
    const ok = STRATEGY_BY_ID.has(strategy) || (forward && strategy === FORWARD_PRIMARY);
    if (!ok) throw bad('strategy');
  } else {
    strategy = forward ? FORWARD_PRIMARY : (data?.selected?.[selectionScenario(scenario)] ?? null);
  }

  const slippagePts = given(body, 'slippagePts') ? body.slippagePts : 0;
  if (typeof slippagePts !== 'number' || !SLIPPAGE_OPTIONS.includes(slippagePts)) throw bad('slippagePts');
  const feeOnWin = given(body, 'feeOnWin') ? body.feeOnWin : 0;
  if (typeof feeOnWin !== 'number' || !Number.isFinite(feeOnWin) || feeOnWin < 0 || feeOnWin >= 1) throw bad('feeOnWin');

  return { scenario, split, season, from, to, book, strategy, slippagePts, feeOnWin };
}

// ---------------------------------------------------------------------------
// 前向账本

/**
 * 比赛日期（'YYYY-MM-DD'）→ NBA 赛季 'YYYY-YY'：7 月及以后归入当年开始的赛季，之前归入上一年开始的赛季。
 * 非法日期 → null。
 */
export function seasonOfDate(date) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(date ?? ''));
  if (!m) return null;
  const start = Number(m[2]) >= 7 ? Number(m[1]) : Number(m[1]) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const RUNS = {
  // 早：价格与概率取 edge0 行（每场都有、含不下注的场次）；账本原样决定取同一次记录的 edge3 行
  early: { base: 'edge0', logged: PRIMARY_RULE },
  // 晚：edge3-late 行既是价格来源也是记录下的决定
  late: { base: LATE_RULE, logged: LATE_RULE },
};

/**
 * paper_bets 行 → 候选（每场一行）。字段按 qualityOk 的前向门槛命名：capturedAt、tipoff、scenario 'forward'、
 * priceAt 按记录（'current'）。model_p_home 原样；settled_at 为空 → 计入 pending、不进候选。
 * 每个候选带 logged = 该场账本记下的决定（rule、bet、side、betMl、edge、profit），供主结果按原样评估。
 * season = 前向赛季（应用当前的目标赛季 store.meta.targetSeason，必填）：只取 game_date 落在该赛季的行，
 * 其他赛季的行不进本季前向账本（结论不跨季合并）。
 */
export function forwardCandidates(rows, { run = 'early', season } = {}) {
  const spec = RUNS[run];
  if (!spec) throw new Error(`run 非法: ${String(run)}（early | late）`);
  if (typeof season !== 'string' || !isSeason(season)) throw new Error(`前向赛季非法: ${String(season)}`);
  const byGame = new Map();
  for (const r of rows ?? []) {
    if (r.book !== FORWARD_BOOK) continue;
    if (seasonOfDate(r.game_date) !== season) continue;
    if (r.rule !== spec.base && r.rule !== spec.logged) continue;
    const e = byGame.get(r.game_id) ?? {};
    if (r.rule === spec.base) e.base = r;
    if (r.rule === spec.logged) e.logged = r;
    byGame.set(r.game_id, e);
  }
  const candidates = [];
  let pending = 0;
  let unmatched = 0;   // 有记录下的决定行（edge3）却没有价格行（edge0）的场次：不静默丢，计数上报
  for (const { base, logged } of byGame.values()) {
    if (!base) { if (logged) unmatched += 1; continue; }
    if (base.settled_at == null) { pending += 1; continue; }
    const scored = typeof base.home_score === 'number' && typeof base.away_score === 'number';
    candidates.push({
      gameId: base.game_id, date: base.game_date, season,
      homeId: base.home_id, awayId: base.away_id,
      homeWin: scored ? base.home_score > base.away_score : null,
      actual: scored ? base.home_score - base.away_score : null,
      void: !scored,
      b2bHome: null, b2bAway: null, teamGp: null,
      pHome: base.model_p_home,
      paramsVersion: 'production', modelVersion: 'production-logged',
      scenario: 'forward', split: 'test',
      ml: [base.home_ml, base.away_ml],
      books: [FORWARD_BOOK, FORWARD_BOOK],
      priceAt: base.price_at,
      closeMl: base.close_home_ml != null && base.close_away_ml != null ? [base.close_home_ml, base.close_away_ml] : null,
      flags: [],
      capturedAt: base.captured_at,
      tipoff: base.tipoff_utc,
      logged: logged ? {
        rule: logged.rule, bet: logged.bet, side: logged.side, betMl: logged.bet_ml,
        edge: logged.edge, threshold: logged.threshold, profit: logged.profit,
      } : null,
    });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  candidates.sort((a, b) => cmp(a.date, b.date) || cmp(a.gameId, b.gameId));
  return { candidates, pending, unmatched, run, season };
}

/**
 * 主结果：账本记下的决定按原样成注（平注 1 单位）；价格为记下的 bet_ml，成本（滑点、手续费）照筛选施加，
 * 0 成本时盈亏与账本的 profit 一致。edge / ev 按实际价的盈亏平衡算（与分桶口径一致），账本的去水 edge 另存 loggedEdge。
 */
function loggedLedger(candidates, { slippagePts, feeOnWin }) {
  const ledger = [];
  let bankroll = BANKROLL0;
  for (const c of candidates) {
    const lg = c.logged;
    if (!lg || lg.bet !== 1 || (lg.side !== 'home' && lg.side !== 'away')) continue;
    const quoted = lg.betMl;
    const valid = isValidAmerican(quoted);
    const american = valid ? worsenAmerican(quoted, slippagePts) : quoted;
    const pModel = lg.side === 'home' ? c.pHome : 1 - c.pHome;
    const outcome = outcomeFor(c);
    const settled = settleBet({ market: 'moneyline', side: lg.side, american, stake: 1, outcome, feeOnWin });
    bankroll += settled.profit;
    let clv = null;
    const flags = [];
    const at = valid ? devigPair(c.ml[0], c.ml[1]) : null;
    const cl = c.closeMl ? devigPair(c.closeMl[0], c.closeMl[1]) : null;
    if (at && cl) clv = cl[lg.side] - at[lg.side];
    else flags.push('noCloseForClv');
    const bet = {
      gameId: c.gameId, date: c.date, season: c.season, homeId: c.homeId, awayId: c.awayId,
      modelVersion: c.modelVersion, paramsVersion: c.paramsVersion,
      scenario: c.scenario, split: c.split, priceAt: c.priceAt, book: FORWARD_BOOK,
      strategy: FORWARD_PRIMARY, market: 'moneyline', side: lg.side, pModel,
      quoted, american, decimal: valid ? americanToDecimal(american) : null,
      edge: valid ? edgeOf(pModel, quoted) : null, ev: valid ? evPerUnit(pModel, quoted) : null,
      loggedEdge: lg.edge, loggedRule: lg.rule,
      stake: 1, result: settled.result, profit: settled.profit, bankrollAfter: bankroll,
      clv, flags, b2bSide: null, b2bOpp: null, teamGp: null,
    };
    const reason = settled.reason ?? (settled.result === 'void' ? outcome.reason : undefined);
    if (reason) bet.reason = reason;
    ledger.push(bet);
  }
  return { ledger, summary: summarizeLedger(ledger, { bankroll0: BANKROLL0 }) };
}

// ---------------------------------------------------------------------------
// 视图

const baseScenario = (scenario) => (scenario === 'closeBest' ? 'close' : scenario);
const splitKey = baseScenario;

/** 当前筛选覆盖的赛季（按切分 + 赛季筛选，不看日期） */
function seasonsInView(filters) {
  const sp = SPLITS[splitKey(filters.scenario)];
  const all = filters.split === 'all' ? [...sp.train, ...sp.validate, ...sp.test] : [...sp[filters.split]];
  return filters.season ? all.filter((s) => s === filters.season) : all;
}

/** 是否是「不缩范围」的默认口径：日期不缩、成本默认、赛季筛选不改变集合（前向的测试期赛季由调用方给出） */
function untouched(filters, forwardSeason = null) {
  const test = filters.scenario === 'forward' ? (forwardSeason ? [forwardSeason] : []) : SPLITS[splitKey(filters.scenario)].test;
  const seasonOk = filters.season == null || (test.length === 1 && test[0] === filters.season);
  return filters.from == null && filters.to == null && seasonOk
    && filters.slippagePts === DEFAULT_COSTS.slippagePts && filters.feeOnWin === DEFAULT_COSTS.feeOnWin;
}

const ciOf = (ledger) => blockBootstrap(ledger, { by: 'day' })?.roi ?? null;

function powerOf(ledger) {
  const pa = powerAnalysis(ledger);
  const at = (roi) => (pa.sd == null ? null : betsNeeded({ sd: pa.sd, roi, deff: pa.deff }));
  return { sd: pa.sd, deff: pa.deff, needed: pa.betsNeeded, neededAt: { '0.01': at(0.01), '0.02': at(0.02), '0.03': at(0.03) } };
}

/** 历史情景：选择期的多重比较（只用 SELECTABLE、按 chain 价、默认成本、不受当前筛选影响） */
function selectionComparisons(data, scenario, selected) {
  const selScen = selectionScenario(scenario);
  const { candidates } = buildCandidates(data?.games ?? [], { scenario: selScen, splitOf: (s) => splitOf(selScen, s) });
  const sel = selectForScenario(candidates, selScen);
  const rows = SELECTABLE.map((id) => ({ id, split: sel.selectOn, bets: sel.results[id].bets, roi: sel.results[id].roi }));
  return { ...multipleComparisons(rows, { selectSplit: sel.selectOn }), selectOn: sel.selectOn, seasons: sel.seasons, results: sel.results, selected };
}

/**
 * 一次请求的完整视图。data 为报告（历史情景必需 games）；filters 来自 validateFilters；
 * opts.forward = forwardCandidates 的输出（前向情景用；缺省视为空账本）。
 */
export function moneylineView(data, filters, { forward } = {}) {
  const isForward = filters.scenario === 'forward';
  if (!isForward) {
    // 历史情景需要报告：games 与该情景的选择结果（键必须存在，值可为 null = 没有策略合格）
    const selScen = selectionScenario(filters.scenario);
    if (!data || !Array.isArray(data.games) || !data.selected || !Object.hasOwn(data.selected, selScen)) {
      throw codedError('err.labDataMissing', `独赢盘回测数据缺失或缺少 ${selScen} 的选择结果`, { scenario: filters.scenario });
    }
  }
  const costs = { ...DEFAULT_COSTS, feeOnWin: filters.feeOnWin, slippagePts: filters.slippagePts };
  const inRange = (x) => (filters.season == null || x.season === filters.season)
    && (filters.from == null || x.date >= filters.from) && (filters.to == null || x.date <= filters.to);

  // 1. 候选与覆盖
  let candidates; let coverage;
  if (isForward) {
    const fwd = forward ?? { candidates: [], pending: 0, run: 'early' };
    candidates = fwd.candidates.filter((c) => inRange(c) && (filters.split === 'all' || filters.split === c.split));
    coverage = { total: candidates.length, priced: candidates.length, missingRate: candidates.length ? 0 : null, missing: {}, pending: fwd.pending, unmatched: fwd.unmatched ?? 0 };
  } else {
    const scen = baseScenario(filters.scenario);
    const keep = (season) => {
      const sp = splitOf(filters.scenario, season);
      return sp != null && (filters.split === 'all' || sp === filters.split) ? sp : null;
    };
    const built = buildCandidates((data?.games ?? []).filter(inRange), { scenario: scen, book: filters.book, splitOf: keep });
    candidates = built.candidates;
    // 历史情景只能是重放模型：候选里混进别的模型版本即视为数据错误（两种模型绝不合并）
    const other = candidates.find((c) => c.modelVersion !== MODEL_VERSION_REPLAY);
    if (other) throw new Error(`历史情景混入非重放模型的候选: ${String(other.gameId)} ${String(other.modelVersion)}`);
    const nMissing = Object.values(built.missing).reduce((s, x) => s + x, 0);
    coverage = { total: built.total, priced: built.priced, missingRate: built.total ? nMissing / built.total : null, missing: built.missing };
  }

  // 2. 全部策略（同一成本）；前向另加账本原样主规则一行
  const runs = new Map();
  if (isForward) runs.set(FORWARD_PRIMARY, { family: 'ledger', ...loggedLedger(candidates, costs) });
  for (const s of STRATEGIES) runs.set(s.id, { family: s.family, ...runBacktest(candidates, s, { costs, bankroll0: BANKROLL0 }) });
  const strategies = [...runs.entries()].map(([id, r]) => ({
    id, family: r.family, bets: r.summary.bets, roi: r.summary.roi, ci: ciOf(r.ledger), selectable: SELECTABLE.includes(id),
  }));

  // 3. 所选策略
  const chosen = filters.strategy == null ? null : runs.get(filters.strategy);
  const ledger = chosen ? chosen.ledger : [];
  const summary = chosen ? chosen.summary : summarizeLedger([], { bankroll0: BANKROLL0 });
  const ci = { day: blockBootstrap(ledger, { by: 'day' }), season: blockBootstrap(ledger, { by: 'season' }) };
  const buckets = Object.fromEntries(['odds', 'edge', 'prob', 'homeAway', 'b2b', 'phase'].map((d) => [d, bucketRoi(ledger, d)]));

  // 4. 选择与多重比较
  const selected = isForward ? FORWARD_PRIMARY : data.selected[selectionScenario(filters.scenario)];
  const mc = isForward
    ? { ...multipleComparisons([], { selectSplit: null }), selectOn: null, seasons: [], results: {}, selected }
    : selectionComparisons(data, filters.scenario, selected);

  // 5. 标签与警告
  const seasons = seasonsInView(filters);
  const previouslySeen = !isForward && seasons.some((s) => SPLITS[splitKey(filters.scenario)].previouslySeen.includes(s));
  const labels = {
    modelVersion: isForward ? 'production-logged' : MODEL_VERSION_REPLAY,
    historical: !isForward,
    previouslySeen,
    priceScenario: filters.scenario,
    forwardBasis: isForward ? (filters.strategy === FORWARD_PRIMARY ? 'asLogged' : 'recomputed') : null,
  };
  const warnings = [];
  if (filters.scenario === 'close' || filters.scenario === 'closeBest') warnings.push(msg('srv.ml.warn.closingPrice'));
  if (filters.scenario === 'closeBest') warnings.push(msg('srv.ml.warn.bestPrice'));
  if (previouslySeen) warnings.push(msg('srv.ml.warn.previouslySeen'));
  if (!isForward && seasons.some((s) => IN_SAMPLE_SEASONS.includes(s))) warnings.push(msg('srv.ml.warn.inSample'));
  // 只要有比赛被剔除就警告；带场数（剔除 / 总数），比例极小时前端显示「<0.1%」而不是「0.0%」
  const nMissingGames = coverage.total - coverage.priced;
  if (nMissingGames > 0) warnings.push(msg('srv.ml.warn.missingPrices', { n: nMissingGames, total: coverage.total, rate: coverage.missingRate }));
  const nCurrent = candidates.filter((c) => (c.flags ?? []).includes('currentAsClose')).length;
  if (nCurrent > 0) warnings.push(msg('srv.ml.warn.currentAsClose', { n: nCurrent }));
  if (coverage.unmatched > 0) warnings.push(msg('srv.ml.warn.forwardUnmatched', { n: coverage.unmatched }));
  if (summary.bets < MIN_BETS) warnings.push(msg('srv.ml.warn.smallSample', { bets: summary.bets, need: MIN_BETS }));

  // 6. 结论（只给预先写定的两种组合，M5）
  let verdict = null;
  if (isForward) {
    const run = forward?.run ?? 'early';
    const canonical = filters.strategy === FORWARD_PRIMARY && run === 'early'
      && (filters.split === 'test' || filters.split === 'all') && untouched(filters, forward?.season ?? null);
    if (canonical) verdict = mlVerdict({ period: 'live', roi: summary.roi, bets: summary.bets, ci: ci.day?.roi ?? null });
  } else {
    const defaultBook = filters.scenario === 'closeBest' ? 'best' : 'chain';
    const canonical = filters.split === 'test' && filters.book === defaultBook && untouched(filters) && filters.strategy === selected;
    if (canonical && selected == null) {
      verdict = msg('srv.ml.verdict.test.noStrategy', { reason: 'noStrategyQualified', bets: 0, min: MIN_BETS });
    } else if (canonical && filters.scenario !== 'closeBest') {
      verdict = mlVerdict({ period: 'test', roi: summary.roi, bets: summary.bets, ci: ci.day?.roi ?? null });
    }
  }

  return {
    filters, labels, coverage,
    strategy: filters.strategy,
    summary, ci, strategies, selected, buckets,
    calibration: calibrationVsMarket(candidates),
    power: powerOf(ledger),
    multipleComparisons: mc,
    warnings,
    verdict,
    exploratory: verdict == null,
    bets: ledger.slice(-RECENT_BETS),
  };
}
