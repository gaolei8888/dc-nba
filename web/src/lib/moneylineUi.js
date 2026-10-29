// 「模型能否打败市场？」标签的纯函数：筛选状态 ↔ 请求体、各情景可选项、图表比例尺。node 可直接导入。
//
// 规则（spec 五；裁定）：
//   - 发给接口的只有 Filters 字段（FILTER_KEYS），其余界面状态（模型版本等）不发；
//     默认值不发（空 / null 一律省略），让服务端补默认，这样默认请求与服务端缓存的默认口径一致。
//   - 模型版本决定可选情景：重放模型 → 收盘 / 开盘 / 最优价敏感性；线上模型 → 本季前向账本。
//   - 最优价只能经 closeBest（单独标注的敏感性）；前向账本只有 DraftKings。

export const FILTER_KEYS = ['scenario', 'split', 'season', 'from', 'to', 'book', 'strategy', 'slippagePts', 'feeOnWin'];
export const SCENARIOS = ['close', 'open', 'closeBest', 'forward'];
export const SLIPPAGE_OPTIONS = [0, 5, 10];
export const MODELS = ['replay', 'production'];
export const FORWARD_BOOK = 'draftkings';
export const FORWARD_PRIMARY = 'ledger-edge3';

/** 情景 → 模型版本（界面用的两类：重放 / 线上） */
export const modelOf = (scenario) => (scenario === 'forward' ? 'production' : 'replay');

/** 模型版本 → 可选情景 */
export const scenariosOf = (model) => (model === 'production' ? ['forward'] : ['close', 'open', 'closeBest']);

/** 情景用哪套切分（closeBest 沿用 close） */
export const splitKeyOf = (scenario) => (scenario === 'closeBest' ? 'close' : scenario);

/** 情景的默认博彩公司选项 */
export const defaultBook = (scenario) => (scenario === 'closeBest' ? 'best' : 'chain');

/** 情景可选的博彩公司：closeBest 只有 best；前向只有选价链与 DraftKings；其余 = 选价链 + 各美国公司 */
export function bookOptions(scenario, books = []) {
  if (scenario === 'closeBest') return ['best'];
  if (scenario === 'forward') return ['chain', FORWARD_BOOK];
  return ['chain', ...books];
}

/** 情景可选的切分：前向账本只有测试期（2026-27）与全部 */
export const splitOptions = (scenario) => (scenario === 'forward' ? ['test', 'all'] : ['train', 'validate', 'test', 'all']);

/** 某情景某切分覆盖的赛季（splits 为 meta.splits；缺该情景 → 空） */
export function seasonsOf(scenario, split, splits) {
  const sp = splits?.[splitKeyOf(scenario)];
  if (!sp) return [];
  if (split === 'all') return [...(sp.train ?? []), ...(sp.validate ?? []), ...(sp.test ?? [])];
  return [...(sp[split] ?? [])];
}

/** 默认筛选状态（界面状态，含模型版本） */
export const defaultState = () => ({
  scenario: 'close', split: 'test', season: null, from: null, to: null, book: 'chain', strategy: null, slippagePts: 0,
});

/**
 * 换情景：模型版本随之变；博彩公司、策略回默认；切分不在新情景可选项里 → test；赛季不在新范围 → 清空。
 */
export function withScenario(state, scenario, splits) {
  const split = splitOptions(scenario).includes(state.split) ? state.split : 'test';
  const seasons = seasonsOf(scenario, split, splits);
  return {
    ...state, scenario, split,
    season: state.season && seasons.includes(state.season) ? state.season : null,
    book: defaultBook(scenario), strategy: null,
  };
}

/** 换模型版本：转到该模型的第一个情景（当前情景已属于该模型则不变） */
export function withModel(state, model, splits) {
  if (modelOf(state.scenario) === model) return state;
  return withScenario(state, scenariosOf(model)[0], splits);
}

/** 换切分：赛季不在新范围 → 清空 */
export function withSplit(state, split, splits) {
  const seasons = seasonsOf(state.scenario, split, splits);
  return { ...state, split, season: state.season && seasons.includes(state.season) ? state.season : null };
}

/**
 * 界面状态 → 请求体：只含 FILTER_KEYS；null / 空串省略；博彩公司为该情景默认值时省略；
 * scenario、split、slippagePts 总是发送（数字型的滑点保持数字）。
 */
export function toFilters(state) {
  const out = { scenario: state.scenario, split: state.split, slippagePts: Number(state.slippagePts) || 0 };
  for (const k of ['season', 'from', 'to', 'strategy']) {
    const v = state[k];
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  if (state.book && state.book !== defaultBook(state.scenario)) out.book = state.book;
  for (const k of Object.keys(out)) if (!FILTER_KEYS.includes(k)) delete out[k];
  return out;
}

/** 平均 CLV 是否不适用：按收盘价下注（close / closeBest）时 CLV 恒为 0，没有意义 */
export const clvNotApplicable = (scenario) => scenario === 'close' || scenario === 'closeBest';

// ---------------------------------------------------------------------------
// 图表比例尺

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * 数值域：包含所有有限值与 extra（如 0 线、起始资金）；全相等时上下各扩 1，保证非零宽度。
 * 没有任何有限值 → null。
 */
export function domainOf(values, extra = []) {
  const xs = [...values, ...extra].filter(fin);
  if (!xs.length) return null;
  let lo = Math.min(...xs); let hi = Math.max(...xs);
  if (lo === hi) { lo -= 1; hi += 1; }
  return [lo, hi];
}

/** 线性比例尺 [d0, d1] → [r0, r1]（按比例，不截断） */
export function linear([d0, d1], [r0, r1]) {
  const k = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** 区间条图的数值域：各行 value / lo / hi 与 0 */
export const ciDomain = (rows) => domainOf(rows.flatMap((r) => [r.value, r.lo, r.hi]), [0]);
