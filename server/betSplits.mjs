// 数据切分、策略选择与多重比较清单。纯函数、无 I/O。
//
// 切分（spec 决定 2）：
//   - 2021-22 只作 Elo 预热，不属于任何情景。
//   - 收盘情景：训练 2022-23（walk-forward 样本内）、验证 2023-24～2024-25（在此选策略）、
//     测试 2025-26——已在此前分析中被看过（paper-backtest、49.1%、edge 规则），报告必须注明。
//   - 开盘情景：只有 2023-24 起有 open；选参 2023-24（selectOn 'train'）、验证 2024-25、测试 2025-26。
//   - 前向账本（本季 = 应用的目标赛季 store.meta.targetSeason，运行时由 splitsFor 填入）：真正干净的检验，不从历史里挑策略。
//   - closeBest（挑最优价敏感性）：沿用 close 的切分，不单独选择，显示时沿用 close 选出的策略（裁定 M6）。
//
// 选择只看选择期：selectForScenario 按赛季重新判定切分（不信任候选上的 split 字段），
// 测试期候选在跑回测前就被丢弃，因此测试期结果不可能影响 selected。
import { STRATEGIES } from './betStrategies.mjs';
import { runBacktest, DEFAULT_COSTS } from './betBacktest.mjs';

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const SPLITS = deepFreeze({
  close: { train: ['2022-23'], validate: ['2023-24', '2024-25'], test: ['2025-26'], selectOn: 'validate', previouslySeen: ['2025-26'] },
  open: { train: ['2023-24'], validate: ['2024-25'], test: ['2025-26'], selectOn: 'train', previouslySeen: ['2025-26'] },
  // 前向的测试期赛季不写死：随应用的目标赛季走（splitsFor），这里留空
  forward: { train: [], validate: [], test: [], selectOn: null, previouslySeen: [] },
});

/** 填入前向赛季（应用当前的目标赛季）后的切分表；season 不合法时前向测试期留空 */
export function splitsFor(forwardSeason) {
  const ok = typeof forwardSeason === 'string' && /^\d{4}-\d{2}$/.test(forwardSeason);
  return deepFreeze({
    close: SPLITS.close, open: SPLITS.open,
    forward: { ...SPLITS.forward, test: ok ? [forwardSeason] : [] },
  });
}

/** 情景 → 用哪套切分（closeBest 沿用 close） */
const splitKey = (scenario) => (scenario === 'closeBest' ? 'close' : scenario);

/** 情景 × 赛季 → 'train' | 'validate' | 'test' | null；未知情景抛错 */
export function splitOf(scenario, season) {
  const sp = SPLITS[splitKey(scenario)];
  if (!sp) throw new Error(`情景非法: ${String(scenario)}`);
  for (const k of ['train', 'validate', 'test']) if (sp[k].includes(season)) return k;
  return null;
}

/** 参与选择的只有固定金额策略（A 是对照，D 只比资金管理） */
export const SELECTABLE = Object.freeze(['B-edge2', 'B-edge3', 'B-edge5', 'B-edge7', 'B-edge10', 'C-ev']);

/**
 * 前向账本主结果（裁定 M3）：账本自己预注册的 edge3 规则，按记录原样（是否下注、边、价）评估。
 * 它是早于本项目冻结的规则（按去水概率比较），与按盈亏平衡重算的 B-edge3 不是同一规则；
 * 因此主结果用这个标记表示「账本原样」，B-edge3 重算只作次要结果、单独标注。
 */
export const FORWARD_PRIMARY = 'ledger-edge3';
export const FORWARD_SECONDARY = 'B-edge3';

/** 哪个情景的选择结果用于该情景：closeBest → close（M6）；forward → null（不选择） */
export function selectionScenario(scenario) {
  if (scenario === 'forward') return null;
  const key = splitKey(scenario);
  if (!SPLITS[key]) throw new Error(`情景非法: ${String(scenario)}`);
  return key;
}

/** 选择期策略合格的最少注数（selectStrategy / selectForScenario 的默认值；视图、报告脚本共用，勿另写字面量） */
export const MIN_SELECT_BETS = 100;

const validRoi = (r) => typeof r?.roi === 'number' && Number.isFinite(r.roi);

/**
 * ROI 最高且注数 ≥ minBets 的 SELECTABLE 策略；并列取 SELECTABLE 中靠前者；无合格者 → null。
 * 不在 SELECTABLE 里的键（A / D）忽略。
 */
export function selectStrategy(results, { minBets = MIN_SELECT_BETS } = {}) {
  let best = null;
  for (const id of SELECTABLE) {
    const r = results?.[id];
    if (!r || !(r.bets >= minBets) || !validRoi(r)) continue;
    if (best == null || r.roi > results[best].roi) best = id;   // 严格大于：并列保留靠前者
  }
  return best;
}

const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

/**
 * 在情景的选择期上跑全部 SELECTABLE 策略并选择。
 * candidates：buildCandidates 的输出（任意赛季都可传入，函数自己按赛季过滤到选择期）。
 * 返回 { scenario, selectOn, seasons, selected, results: { id: { bets, roi } }, tried }。
 * forward：不从历史中挑，直接返回预注册主规则；closeBest：抛错（应沿用 close 的选择）。
 */
export function selectForScenario(candidates, scenario, { minBets = MIN_SELECT_BETS, costs = DEFAULT_COSTS } = {}) {
  if (scenario === 'forward') {
    return { scenario, selectOn: null, seasons: [], selected: FORWARD_PRIMARY, source: 'pre-registered', results: {}, tried: 0 };
  }
  if (scenario === 'closeBest') throw new Error('closeBest 是敏感性情景，不单独选择：沿用 close 的选择结果');
  const sp = SPLITS[scenario];
  if (!sp || !sp.selectOn) throw new Error(`情景非法: ${String(scenario)}`);

  const seasons = [...sp[sp.selectOn]];
  // 按赛季重新判定，不读候选自带的 split；测试期在这里就被丢弃
  const pool = candidates.filter((c) => splitOf(scenario, c.season) === sp.selectOn);
  const results = {};
  for (const id of SELECTABLE) {
    const { summary } = runBacktest(pool, STRATEGY_BY_ID.get(id), { costs });
    results[id] = { bets: summary.bets, roi: summary.roi };
  }
  return { scenario, selectOn: sp.selectOn, seasons, selected: selectStrategy(results, { minBets }), results, tried: SELECTABLE.length };
}

/**
 * 报告里存档的选择记录（data.selection[scenario]）：选择期各 SELECTABLE 策略的注数与 ROI、选定策略、
 * 比较数与 Bonferroni α。报告生成时算一次，视图只读这份记录，不在请求里重算（最终审阅 m2）。
 */
export function selectionRecord(candidates, scenario, { minBets = MIN_SELECT_BETS, costs = DEFAULT_COSTS } = {}) {
  const sel = selectForScenario(candidates, scenario, { minBets, costs });
  const rows = SELECTABLE.map((id) => ({ id, split: sel.selectOn, bets: sel.results[id].bets, roi: sel.results[id].roi }));
  const mc = multipleComparisons(rows, { selectSplit: sel.selectOn });
  return {
    selectOn: sel.selectOn, seasons: sel.seasons, minBets, selected: sel.selected,
    tried: mc.tried, bonferroniAlpha: mc.bonferroniAlpha, rows: mc.rows,
  };
}

/**
 * 多重比较清单（裁定 M9）：tried = 选择期内比较过的不同策略配置数（按 id 去重），
 * 不是策略 × 切分的行数；测试期 / 其他切分的行照样列在 rows 里（inSelection 标注），但不计数。
 * selectSplit 缺省时，除 'test' 以外的行都视为选择阶段。tried 为 0（未做选择）时 α 不校正。
 */
export function multipleComparisons(rows, { selectSplit = null, alpha = 0.05 } = {}) {
  const inSel = (r) => (selectSplit ? r.split === selectSplit : r.split !== 'test');
  const out = rows.map((r) => ({ ...r, inSelection: inSel(r) }));
  const tried = new Set(out.filter((r) => r.inSelection).map((r) => r.id)).size;
  return { tried, bonferroniAlpha: alpha / Math.max(tried, 1), rows: out };
}
