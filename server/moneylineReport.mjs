// 独赢盘回测报告：walk-forward 概率 × 美国公司价格 → 一份可复现的 JSON（视图 / 接口只读它）。
// 纯函数、无 I/O、无网络、无当前时间与随机源（bootstrap 固定种子 7）：同一输入 → 字节一致的输出。
// builtAt 由脚本写文件时另加，不在这里生成，也不属于可复现比较的范围。
//
// 选择：每个历史情景只在自己的选择期上跑 SELECTABLE 策略（selectForScenario，minBets 用共享常量），
// 选出的 id（可为 null = 没有策略合格）写进报告；视图与 headline 只读它，测试期不再挑。
import { walkForward, MODEL_VERSION_REPLAY, WF_SEASONS } from './walkForward.mjs';
import { auditSeason } from './dataIntegrity.mjs';
import { compactBooks } from './priceSelect.mjs';
import { buildCandidates, runBacktest, DEFAULT_COSTS } from './betBacktest.mjs';
import { STRATEGIES } from './betStrategies.mjs';
import {
  SPLITS, MIN_SELECT_BETS, splitOf, selectionRecord,
} from './betSplits.mjs';
import { blockBootstrap } from './betStats.mjs';
import { moneylineView, validateFilters, SLIPPAGE_OPTIONS } from './moneylineView.mjs';
import { US_BOOKS } from './books.mjs';

/** 历史情景（closeBest 沿用 close 的选择，不单独出现在报告里） */
export const REPORT_SCENARIOS = ['close', 'open'];
/** 逐家报告：一家一季至少这么多场有价才单列（零星出现的不报） */
export const PERBOOK_MIN_PRICED = 100;
const BANKROLL0 = 100;
const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

const sortedKeys = (o) => Object.fromEntries(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
const dayCi = (ledger) => blockBootstrap(ledger, { by: 'day' })?.roi ?? null;

/** 重放记录 + 钱线缓存 → 报告里的一场（钱线已统一成 [我们的主, 我们的客]；对不上 / 缺缓存 → books 为空） */
function gameOf(r, cache) {
  const entry = cache?.[r.gameId];
  const compact = entry ? compactBooks(entry, r.homeId, r.awayId) : null;
  return {
    gameId: r.gameId, date: r.date, season: r.season, homeId: r.homeId, awayId: r.awayId,
    homeWin: r.homeWin, actual: r.actual, void: false,
    b2bHome: r.b2bHome, b2bAway: r.b2bAway, teamGp: r.teamGp,
    pHome: r.pWF, paramsVersion: r.paramsVersion, modelVersion: MODEL_VERSION_REPLAY,
    books: compact ? compact.books : {},
  };
}

/**
 * @param {{dataset:object, books:Record<string,{games:object}>, inputsSha:object}} args
 *   dataset = data/backtest.json；books = 季 → books_<季>.json；inputsSha = 输入文件名 → sha256
 */
export function buildMoneylineReport({ dataset, books, inputsSha }) {
  const wf = walkForward(dataset, { seasons: WF_SEASONS });
  const games = wf.records.map((r) => gameOf(r, books?.[r.season]?.games));
  const seasons = wf.fits.map((f) => f.season);

  const integrity = seasons.map((season) => auditSeason({
    season, records: wf.records.filter((r) => r.season === season), cache: books?.[season]?.games ?? {},
  }));

  // 选择（只看选择期）
  const selected = {}; const selection = {}; const cand = {};
  for (const scenario of REPORT_SCENARIOS) {
    cand[scenario] = buildCandidates(games, { scenario, splitOf: (s) => splitOf(scenario, s) });
    selection[scenario] = selectionRecord(cand[scenario].candidates, scenario, { minBets: MIN_SELECT_BETS });
    selected[scenario] = selection[scenario].selected;
  }

  // 视图消费的就是这份报告：headline 直接取视图的默认口径（测试期、选定策略、默认成本、chain 价）
  const core = { games, selected, selection };
  const headline = {};
  for (const scenario of REPORT_SCENARIOS) {
    const v = moneylineView(core, validateFilters({ scenario }, core));
    headline[scenario] = {
      strategy: v.strategy, bets: v.summary.bets, roi: v.summary.roi, ci: v.ci,
      verdict: v.verdict, coverage: v.coverage, previouslySeen: v.labels.previouslySeen,
      tried: selection[scenario].tried, bonferroniAlpha: selection[scenario].bonferroniAlpha,
    };
  }

  // 测试期 0 / 5 / 10 点滑点（选定策略；没选出 → 不出行）
  const slippage = [];
  for (const scenario of REPORT_SCENARIOS) {
    const id = selected[scenario];
    if (id == null) continue;
    const test = cand[scenario].candidates.filter((c) => c.split === 'test');
    for (const slippagePts of SLIPPAGE_OPTIONS) {
      const { ledger, summary } = runBacktest(test, STRATEGY_BY_ID.get(id), { costs: { ...DEFAULT_COSTS, slippagePts }, bankroll0: BANKROLL0 });
      slippage.push({ scenario, strategy: id, slippagePts, bets: summary.bets, roi: summary.roi, ci: dayCi(ledger) });
    }
  }

  // 逐家 × 逐季 × 情景（选定策略；价只用该家，缺该家价的场次不下注）：只报告，不据此调参
  const perBook = [];
  for (const scenario of REPORT_SCENARIOS) {
    const id = selected[scenario];
    if (id == null) continue;
    for (const book of US_BOOKS) {
      for (const season of seasons) {
        if (splitOf(scenario, season) == null) continue;
        const built = buildCandidates(games.filter((g) => g.season === season), { scenario, book, splitOf: (s) => splitOf(scenario, s) });
        if (built.priced < PERBOOK_MIN_PRICED) continue;
        const { ledger, summary } = runBacktest(built.candidates, STRATEGY_BY_ID.get(id), { bankroll0: BANKROLL0 });
        perBook.push({
          book, season, scenario, split: splitOf(scenario, season), strategy: id,
          bets: summary.bets, roi: summary.roi, ci: dayCi(ledger), coverage: built.priced / built.total,
        });
      }
    }
  }

  return {
    version: 1,
    inputs: { sha: sortedKeys(inputsSha), modelVersion: MODEL_VERSION_REPLAY, seasons, splits: SPLITS },
    fits: wf.fits,
    integrity,
    games,
    selected,
    selection,
    headline,
    perBook,
    slippage,
  };
}
