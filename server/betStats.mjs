// 独赢盘回测的风险与显著性：block bootstrap、分桶 ROI、模型 vs 去水市场校准、功效分析与结论规则。
// 纯函数、无 I/O；随机数一律用 fusionLab.rng（默认 seed 7），同一输入 → 完全相同的区间。
//
// 规则（spec 四、决策 5；plan Task 11；裁定 M2、M7）：
//   - 作废注（result === 'void'）一律不参与 ROI、命中率与分桶。
//   - 按块有放回重抽：by 'day' 以比赛日为块（同日所有注一起抽），by 'season' 以赛季为块。
//     块数 K，每次重抽 K 块；ROI = Σprofit / Σstake；realizedEdge = 命中率 − 平均盈亏平衡概率（按实际结算价）。
//   - 分位取法与 fusionLab.bootstrapCI 一致：lo = 排序后第 floor(0.025B) 个，hi = 第 ceil(0.975B) − 1 个。
//   - 按赛季 bootstrap 在不足 2 个赛季时没有意义 → roi / realizedEdge 为 null 并给 reason（M7）。
//   - 功效分析：见 betsNeeded 的注释。
import { rng } from './fusionLab.mjs';
import { calibration } from './lab.mjs';
import { devigPair, breakEven, isValidAmerican } from './oddsMath.mjs';
import { msg } from './messages.mjs';
import { outcomeFor } from './betBacktest.mjs';

export const MIN_BETS = 300;

// 正态分位：z_{1−α/2}（α = 0.05）与 z_{power}（power = 0.8）
const Z_975 = 1.959964;
const Z_80 = 0.841621;
const LOGLOSS_EPS = 1e-9;   // 与 lab.score 的截断一致

const isVoid = (b) => b.result === 'void';
const settled = (ledger) => ledger.filter((b) => !isVoid(b));
const priceOf = (b) => (isValidAmerican(b.american) ? b.american : b.quoted);

// ---------------------------------------------------------------------------
// bootstrap 内核

/** 把非作废注按块聚合：每块 { profit, stake, wins, n, be }（be = 盈亏平衡概率之和） */
function blocksOf(bets, keyOf) {
  const map = new Map();
  for (const b of bets) {
    const k = keyOf(b);
    let blk = map.get(k);
    if (!blk) { blk = { profit: 0, stake: 0, wins: 0, n: 0, be: 0 }; map.set(k, blk); }
    blk.profit += b.profit;
    blk.stake += b.stake;
    blk.wins += b.result === 'win' ? 1 : 0;
    blk.n += 1;
    blk.be += breakEven(priceOf(b));
  }
  // Map 保留插入顺序；按键排序让结果与流水顺序无关
  return [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([, v]) => v);
}

/** 对块做 B 次有放回重抽，返回每次的 ROI 与 realizedEdge（未排序） */
function replicates(blocks, B, seed) {
  const K = blocks.length;
  const rand = rng(seed);
  const roi = new Array(B);
  const edge = new Array(B);
  for (let r = 0; r < B; r += 1) {
    let p = 0; let s = 0; let w = 0; let n = 0; let be = 0;
    for (let i = 0; i < K; i += 1) {
      const blk = blocks[Math.floor(rand() * K)];
      p += blk.profit; s += blk.stake; w += blk.wins; n += blk.n; be += blk.be;
    }
    roi[r] = p / s;
    edge[r] = (w - be) / n;
  }
  return { roi, edge };
}

const interval = (vals, B) => {
  const v = [...vals].sort((x, y) => x - y);
  return { lo: v[Math.floor(0.025 * B)], hi: v[Math.ceil(0.975 * B) - 1] };
};

const pointOf = (bets) => {
  let p = 0; let s = 0; let w = 0; let be = 0;
  for (const b of bets) { p += b.profit; s += b.stake; w += b.result === 'win' ? 1 : 0; be += breakEven(priceOf(b)); }
  return { roi: p / s, hitRate: w / bets.length, realizedEdge: (w - be) / bets.length };
};

/** 块键：缺 date / season 的非作废注无法归块 → 直接抛错（不静默并成 'undefined' 一块） */
const keyBy = (field) => (b) => {
  const k = b[field];
  if (typeof k !== 'string' || !k) throw new Error(`注单缺 ${field}，无法按块 bootstrap: ${String(b.gameId)}`);
  return k;
};
const BLOCK_KEY = { day: keyBy('date'), season: keyBy('season') };

// ---------------------------------------------------------------------------
// 公开接口

/**
 * 按块 bootstrap。返回 { n, blocks, roi: { est, lo, hi }, realizedEdge: { est, lo, hi } }；
 * 空流水（或全作废）→ null；by 'season' 且不足 2 个赛季 → roi/realizedEdge 为 null，reason 'fewerThan2Seasons'。
 */
export function blockBootstrap(ledger, { by = 'day', B = 2000, seed = 7 } = {}) {
  if (by !== 'day' && by !== 'season') throw new Error(`by 非法: ${String(by)}`);
  const bets = settled(ledger ?? []);
  if (!bets.length) return null;
  const blocks = blocksOf(bets, BLOCK_KEY[by]);
  if (by === 'season' && blocks.length < 2) {
    return { n: bets.length, blocks: blocks.length, roi: null, realizedEdge: null, reason: 'fewerThan2Seasons' };
  }
  const pt = pointOf(bets);
  const rep = replicates(blocks, B, seed);
  return {
    n: bets.length,
    blocks: blocks.length,
    roi: { est: pt.roi, ...interval(rep.roi, B) },
    realizedEdge: { est: pt.realizedEdge, ...interval(rep.edge, B) },
  };
}

const variance = (xs) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

/**
 * 设计效应 = 按日 block bootstrap 的 ROI 方差 / 按注 iid bootstrap 的 ROI 方差（同 B、同 seed）。
 * 同日注单正相关时 > 1；空流水或 iid 方差为 0 → null。
 */
export function designEffect(ledger, { B = 2000, seed = 7 } = {}) {
  const bets = settled(ledger ?? []);
  if (bets.length < 2) return null;
  const day = replicates(blocksOf(bets, BLOCK_KEY.day), B, seed).roi;
  const iid = replicates(bets.map((b, i) => blocksOf([b], () => i)[0]), B, seed).roi;
  const vi = variance(iid);
  if (!(vi > 0)) return null;
  return variance(day) / vi;
}

/**
 * 每注单位收益率 profit / stake 的样本标准差（n − 1）；不足 2 注 → null。
 * 不按 stake 加权：固定金额策略下与 Σprofit/Σstake 的方差一致；Kelly 等变动注额时只是近似
 * （大注权重被低估），功效分析的结论按近似看待。
 */
export function perBetSd(ledger) {
  const r = settled(ledger ?? []).map((b) => b.profit / b.stake);
  if (r.length < 2) return null;
  return Math.sqrt(variance(r));
}

/**
 * 功效分析：要让「95% 区间下界 > 0」以 power 的概率成立，需要多少注。
 * 设每注单位收益率均值 μ（= 真实 ROI）、标准差 σ，n 注的 ROI 标准误 ≈ σ·√(deff/n)。
 * 要求 μ − z_{1−α/2}·SE > 0 的概率为 power ⇔ μ = (z_{1−α/2} + z_power)·SE
 * ⇒ n = deff·((z_{1−α/2} + z_power)·σ/μ)²，向上取整。μ ≤ 0 时永远达不到 → null。
 * z 值写死常量（α = 0.05、power = 0.8）；其他 α/power 不支持，避免引入分位函数。
 */
export function betsNeeded({ sd, roi, deff = 1, alpha = 0.05, power = 0.8 }) {
  if (alpha !== 0.05 || power !== 0.8) throw new Error('只支持 alpha 0.05、power 0.8');
  if (!(roi > 0) || !(sd > 0)) return null;
  return Math.ceil(deff * ((Z_975 + Z_80) * sd / roi) ** 2);
}

/**
 * 对一份流水做功效分析：σ 取该流水自己的每注方差（前向账本用前向账本的），deff 取该流水的按日设计效应
 * （算不出时按 1）；目标 ROI 默认取观测 ROI，也可显式给 roi。
 * 返回 { bets, roi, sd, deff, betsNeeded }。
 */
export function powerAnalysis(ledger, { roi = null, B = 2000, seed = 7 } = {}) {
  const bets = settled(ledger ?? []);
  const target = roi ?? (bets.length ? pointOf(bets).roi : null);
  const sd = perBetSd(bets);
  const deff = designEffect(bets, { B, seed }) ?? 1;
  return { bets: bets.length, roi: target, sd, deff, betsNeeded: sd == null || target == null ? null : betsNeeded({ sd, roi: target, deff }) };
}

// ---------------------------------------------------------------------------
// 分桶

/** 区间一律左闭右开 [lo, hi)。odds 为区间对，按所押报价（quoted，−100 视同 +100）；edge/prob 为切点，按小数；phase 按 teamGp */
export const BUCKETS = {
  odds: [[-Infinity, -200], [-200, -100], [100, 200], [200, Infinity]],
  edge: [-Infinity, 0, 0.02, 0.03, 0.05, 0.07, 0.10, Infinity],   // 首桶 '<0'（M7：基准 A 的负 edge 注）
  prob: [0, 0.4, 0.5, 0.6, 0.7, 1.0001],
  phase: [['early', 0, 10], ['mid', 10, 40], ['late', 40, Infinity]],   // 同 scripts/backtest.mjs PHASES
};

const ODDS_KEYS = ['<-200', '-200~-100', '+100~+200', '>=+200'];
const EDGE_KEYS = ['<0', '0-2', '2-3', '3-5', '5-7', '7-10', '10+'];
const PROB_KEYS = ['0-40', '40-50', '50-60', '60-70', '70-100'];
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const inRange = (ranges, keys, x) => {
  if (!fin(x)) return null;
  const i = ranges.findIndex(([lo, hi]) => x >= lo && x < hi);
  return i < 0 ? null : keys[i];
};
const toRanges = (cuts) => cuts.slice(0, -1).map((lo, i) => [lo, cuts[i + 1]]);
const edgeRanges = toRanges(BUCKETS.edge);
const probRanges = toRanges(BUCKETS.prob);

const DIMS = {
  odds: { keys: ODDS_KEYS, of: (b) => inRange(BUCKETS.odds, ODDS_KEYS, b.quoted === -100 ? 100 : b.quoted) },
  edge: { keys: EDGE_KEYS, of: (b) => inRange(edgeRanges, EDGE_KEYS, b.edge) },
  prob: { keys: PROB_KEYS, of: (b) => inRange(probRanges, PROB_KEYS, b.pModel) },
  homeAway: { keys: ['home', 'away'], of: (b) => (b.side === 'home' || b.side === 'away' ? b.side : null) },
  b2b: {
    keys: ['side', 'opp', 'both', 'neither'],
    of: (b) => {
      if (typeof b.b2bSide !== 'boolean' || typeof b.b2bOpp !== 'boolean') return null;
      if (b.b2bSide && b.b2bOpp) return 'both';
      return b.b2bSide ? 'side' : b.b2bOpp ? 'opp' : 'neither';
    },
  },
  phase: {
    keys: BUCKETS.phase.map(([k]) => k),
    of: (b) => inRange(BUCKETS.phase.map(([, lo, hi]) => [lo, hi]), BUCKETS.phase.map(([k]) => k), b.teamGp),
  },
};

/**
 * 分桶 ROI：每桶 { key, n, roi, hitRate, ci }，ci 为该桶的按日 block bootstrap ROI 区间 { lo, hi }。
 * 键固定齐全（空桶 n 0、其余 null）；缺字段的非作废注归入末尾的 'n/a' 桶（仅当存在时出现），
 * 故各桶 n 之和恒等于非作废注数。
 */
export function bucketRoi(ledger, dim, { B = 1000, seed = 7 } = {}) {
  const d = DIMS[dim];
  if (!d) throw new Error(`dim 非法: ${String(dim)}`);
  const groups = new Map(d.keys.map((k) => [k, []]));
  for (const b of settled(ledger ?? [])) {
    const k = d.of(b) ?? 'n/a';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  return [...groups.entries()].map(([key, bets]) => {
    if (!bets.length) return { key, n: 0, roi: null, hitRate: null, ci: null };
    const pt = pointOf(bets);
    const bs = blockBootstrap(bets, { by: 'day', B, seed });
    return { key, n: bets.length, roi: pt.roi, hitRate: pt.hitRate, ci: { lo: bs.roi.lo, hi: bs.roi.hi } };
  });
}

// ---------------------------------------------------------------------------
// 校准

const scoreProbs = (rows) => {
  let brier = 0; let logloss = 0;
  for (const r of rows) {
    const y = r.homeWin ? 1 : 0;
    brier += (r.p - y) ** 2;
    logloss += -(y * Math.log(Math.max(r.p, LOGLOSS_EPS)) + (1 - y) * Math.log(Math.max(1 - r.p, LOGLOSS_EPS)));
  }
  return { brier: brier / rows.length, logloss: logloss / rows.length };
};

/**
 * 模型 vs 去水市场：同一批比赛，只收能公平去水的候选；其余按原因计入 excluded：
 *   - dataError：引擎会判作废的（无结果、比分相等、比分与 homeWin 矛盾）——直接复用 betBacktest.outcomeFor；
 *   - mixedBooks：两侧来自不同公司或带 bestPrice 标记（挑最优价拼出的对）——不同公司 / 时点的两侧不能一起去水；
 *   - noPrice：缺 ml、任一侧非法价、缺 books、或 pHome 非有限数。
 * 市场主队概率 = 同一家同一时点 ml = [主, 客] 两侧按比例去水；仅用于比较谁更准，不用于结算。
 * reliability 的 Bin 同 lab.calibration（10 档，空档省略，n 之和 = n）。
 */
export function calibrationVsMarket(candidates) {
  const model = []; const market = [];
  const excluded = { dataError: 0, mixedBooks: 0, noPrice: 0 };
  for (const c of candidates ?? []) {
    const out = outcomeFor(c);
    if (out.void) { excluded.dataError += 1; continue; }
    if (!fin(c.pHome) || !Array.isArray(c.ml) || !Array.isArray(c.books) || !c.books[0]) { excluded.noPrice += 1; continue; }
    if (c.books[0] !== c.books[1] || (c.flags ?? []).includes('bestPrice')) { excluded.mixedBooks += 1; continue; }
    const dv = devigPair(c.ml[0], c.ml[1]);
    if (!dv) { excluded.noPrice += 1; continue; }
    model.push({ p: c.pHome, homeWin: out.homeWin });
    market.push({ p: dv.home, homeWin: out.homeWin });
  }
  if (!model.length) return { n: 0, excluded, model: null, market: null, reliability: { model: [], market: [] } };
  return {
    n: model.length,
    excluded,
    model: scoreProbs(model),
    market: scoreProbs(market),
    reliability: { model: calibration(model), market: calibration(market) },
  };
}

// ---------------------------------------------------------------------------
// 结论（预先写定）

// 消息码逐个写成字面量，供 serverMessages 测试的扫描器核对各语言都有
const VERDICT = {
  test: {
    evidence: (p) => msg('srv.ml.verdict.test.evidence', p),
    noEvidence: (p) => msg('srv.ml.verdict.test.noEvidence', p),
    tooFew: (p) => msg('srv.ml.verdict.test.tooFew', p),
  },
  live: {
    evidence: (p) => msg('srv.ml.verdict.live.evidence', p),
    noEvidence: (p) => msg('srv.ml.verdict.live.noEvidence', p),
    tooFew: (p) => msg('srv.ml.verdict.live.tooFew', p),
  },
};

/**
 * 预先写定的结论规则；period 必填：'test'（历史回测测试期）或 'live'（前向账本），文案按期别区分（M17）。
 * bets < 300 → tooFew（仍是「无证据」）；否则 ci.lo > 0 → evidence；其余（含 ci 为 null）→ noEvidence。
 * roi 显式传入（M2）。前向账本用同一规则、用它自己的区间。
 */
export function mlVerdict({ period, roi = null, bets, ci }) {
  if (!Object.hasOwn(VERDICT, String(period))) throw new Error(`period 非法: ${String(period)}`);
  const v = VERDICT[period];
  const params = { bets, roi, lo: ci?.lo ?? null, hi: ci?.hi ?? null, min: MIN_BETS };
  if (!(bets >= MIN_BETS)) return v.tooFew(params);
  if (ci && ci.lo > 0) return v.evidence(params);
  return v.noEvidence(params);
}
