/**
 * 复核 README 的「让分命中率 49.1%」：口径、样本、push 处理、盘口来源、样本内参数。
 *
 *   node scripts/ats-audit.mjs | tee docs/ats-491-audit-output.txt
 *
 * 纯离线：只读 data/backtest.json 与 data/history/odds_*.json；不发请求、不写库。
 * 审计脚本，不扩展让分功能。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../server/nbaClient.mjs';
import { replay, DEFAULTS, market, BREAK_EVEN } from '../server/lab.mjs';

const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const pct = (x, d = 2) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const half = (win, lose) => { const n = win + lose; const r = win / n; return 1.96 * Math.sqrt(r * (1 - r) / n); };

const bt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backtest.json'), 'utf8'));
const records = replay(bt, SEASONS, DEFAULTS);
const m = market(records);
const a = m.ats.all;

console.log('让分命中率 49.1% 复核');
console.log('=====================');
console.log('\n[1] 公式（server/lab.mjs market().atsOf）');
console.log('  edge  = pred − mktPred        模型预测的主队净胜分 − 盘口隐含的主队净胜分（mktPred = −spread）');
console.log('  cover = actual − mktPred      实际主队分差 − 盘口');
console.log('  选边：edge>0 选主队让分，edge<0 选客队；cover 同号即命中');
console.log('  push：edge===0 或 cover===0 不进分母（整数盘口刚好打平；edge===0 几乎不会发生）');
console.log('  命中率 = win / (win + lose)；半宽 = 1.96·√(r(1−r)/(win+lose))');

console.log('\n[2] 样本');
console.log(`  重放场次 ${records.length}；有盘口 ${m.n}（覆盖 ${pct(m.coverage)}）；无盘口 ${records.length - m.n}`);
console.log(`  win ${a.win} / lose ${a.lose} / push ${a.push}（push 不在分母）；n(含 push)=${a.n}，分母=${a.win + a.lose}`);
const r = a.win / (a.win + a.lose);
const hw = half(a.win, a.lose);
console.log(`  命中率 ${pct(r)}，95% 区间 ±${(hw * 100).toFixed(2)}pp → [${pct(r - hw)}, ${pct(r + hw)}]`);
console.log(`  与打平线 ${pct(BREAK_EVEN)} 的差 ${((r - BREAK_EVEN) * 100).toFixed(2)}pp；区间上界${r + hw < BREAK_EVEN ? '低于' : '不低于'}打平线`);
console.log(`  README 写的 ±1.41 对应分母 ${a.win + a.lose}（不含 push），表内「合计 4908」含 push 与 ${a.push} 场 push`);
console.log(`  与 50% 比：区间${r - hw <= 0.5 && r + hw >= 0.5 ? '包含' : '不含'} 50%（命中率与随机无法区分，不是显著亏损；但相对 −110 打平线是显著低于）`);

console.log('\n[3] 按季');
for (const s of SEASONS) {
  const sub = records.filter((x) => x.season === s);
  const ms = market(sub);
  if (!ms.available) { console.log(`  ${s}  无盘口`); continue; }
  const t = ms.ats.all;
  const rr = t.win / (t.win + t.lose);
  console.log(`  ${s}  有盘口 ${ms.n}/${sub.length}  win ${t.win} lose ${t.lose} push ${t.push}  命中率 ${pct(rr)} ±${(half(t.win, t.lose) * 100).toFixed(2)}pp`);
}

console.log('\n[4] 分歧分档（README 表；分歧 = |pred − mktPred|）');
for (const b of m.ats.byEdge) {
  console.log(`  ${b.label.padEnd(10)} n ${String(b.n).padStart(4)}  win ${b.win} lose ${b.lose} push ${b.push}  命中率 ${pct(b.rate, 1)}`);
}
console.log(`  合计 n ${m.ats.byEdge.reduce((s, b) => s + b.n, 0)}`);

console.log('\n[5] 盘口来源与时点（data/history/odds_*.json）');
const provByGame = {};
for (const s of SEASONS) {
  const f = path.join(DATA_DIR, 'history', `odds_${s}.json`);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  const games = Object.values(c.games ?? {});
  const withSpread = games.filter((g) => g.spread !== null && g.spread !== undefined);
  const withOpen = games.filter((g) => g.openSpread !== null && g.openSpread !== undefined);
  const withPrice = games.filter((g) => 'spreadPrice' in g || 'homeSpreadOdds' in g || 'spreadOdds' in g);
  const integer = withSpread.filter((g) => Number.isInteger(g.spread)).length;
  console.log(`  ${s}  场 ${games.length}  有 spread ${withSpread.length}  有 openSpread ${withOpen.length}  整数盘口 ${integer}  让分价格字段 ${withPrice.length}`);
  console.log(`      provider ${JSON.stringify(c.providers)}  builtAt ${c.builtAt}`);
  for (const [id, g] of Object.entries(c.games ?? {})) provByGame[id] = g.provider;
}
console.log('  spread 取值：parseOddsItem 逐级回退 close → current → ESPN 顶层 item.spread；对已完赛比赛');
console.log('  顶层 spread ≈ 最后一次报价（接近收盘），但无时点标签；文件只存最终取到的数，不存是哪一级。');
console.log('  2022-23 / 2023-24 几乎全部是 BetfairSportsbook（交易所），不是美国博彩公司；2024-25 为 ESPN BET，');
console.log('  2025-26 主要为 Draft Kings。四季来源不同，让分口径并不统一。');
console.log('  让分价格（−110 还是 −105/−115）不在 odds_*.json，books_*.json 的 trimItem 也只存 spread 与钱线，');
console.log('  故历史让分价格缺失，无法按实际价格结算。');

console.log('\n  按盘口来源拆分命中率（同一批 4908 场）');
const withMkt = records.filter((x) => x.mktPred !== null && x.mktPred !== undefined);
const byProv = {};
for (const x of withMkt) (byProv[provByGame[x.gameId] ?? '未知'] ??= []).push(x);
for (const [p, rows] of Object.entries(byProv).sort((x, y) => y[1].length - x[1].length)) {
  const t = market(rows).ats.all;
  const dn = t.win + t.lose;
  console.log(`  ${p.padEnd(32)} n ${String(rows.length).padStart(4)}  win ${t.win} lose ${t.lose} push ${t.push}  命中率 ${dn ? pct(t.win / dn) : 'n/a'}${dn >= 100 ? ` ±${(half(t.win, t.lose) * 100).toFixed(2)}pp` : '（样本太小）'}`);
}

console.log('\n[6] 参数是否在同一批赛季上调过（样本内问题）');
console.log(`  DEFAULTS: homeAdv ${DEFAULTS.homeAdv}, restWeight ${DEFAULTS.restWeight}, spreadSd ${DEFAULTS.spreadSd}, k ${DEFAULTS.k}, carryKeep ${DEFAULTS.carryKeep}`);
console.log('  README「逐年测量」：homeAdv 1.6 由 2024-25（1.60）/ 2025-26（1.62）实测，并据此「改成 1.6 后偏置归零」；');
console.log('  restWeight 1.8 由背靠背实测 −1.98 分得出。二者都用到了评估季本身的数据 → 对 2024-25、2025-26 是样本内；');
console.log('  2022-23 / 2023-24 实测值（2.39 / 2.15）与 1.6 不同，对这两季是「用后来的参数」，同样不是干净的样本外。');
console.log('  k=20、carryKeep=0.75、spreadSd=12 的来源 README 未说明是否在这四季上调过（本审计无法证实，待核）。');
console.log('  walk-forward（每季只用此前赛季拟合）见提交 98a14e8，本脚本未使用。');
console.log('  敏感性（只读重放，不改默认）：');
for (const [label, o] of [['homeAdv 2.4（旧值）', { homeAdv: 2.4 }], ['homeAdv 1.6（现值）', {}], ['restWeight 1.1（旧表）', { restWeight: 1.1 }]]) {
  const t = market(replay(bt, SEASONS, { ...DEFAULTS, ...o })).ats.all;
  console.log(`    ${label.padEnd(22)} win ${t.win} lose ${t.lose} push ${t.push}  命中率 ${pct(t.win / (t.win + t.lose))}`);
}

console.log('\n[7] 理论 ROI（假设情景，不是历史实际收益）');
console.log('  历史让分价格缺失 → 实际价格结算「不可计算」。下面仅在「统一 −110、等额下注、无手续费」假设下换算：');
console.log('  ROI = r·(100/110) − (1 − r)；push 退款，不计入分母');
const roi = (x) => x * (100 / 110) - (1 - x);
console.log(`  r = ${pct(r)}（点估计）  → ROI ${pct(roi(r))}`);
console.log(`  r 区间 [${pct(r - hw)}, ${pct(r + hw)}] → ROI [${pct(roi(r - hw))}, ${pct(roi(r + hw))}]`);
console.log(`  打平线 ${pct(BREAK_EVEN, 3)} → ROI ${pct(roi(BREAK_EVEN))}（校验）`);
console.log(`  对照 research 文档 §10.2 的 49.1% → ${pct(roi(0.491))}（文档记 −6.26%，一致）`);
console.log('  注意：这是无选择的「全部分歧场」全押，不是任何可执行策略；价格与时点均非历史实际可成交。');

console.log('\n[8] 与 README 数字对照');
console.log(`  README 49.12%（±1.41）、合计 4908；本次实测 ${pct(r)}、n=${a.n}。`);
console.log(`  差异 ${((r - 0.4912) * 100).toFixed(2)}pp：合计一致；win/lose/push = ${a.win}/${a.lose}/${a.push}。`);
console.log('  原因未能证实：当前快照为 66.32% / χ² 14.87 / 49.18%（docs/replay-same-day-fix-output.txt），');
console.log('  「按比赛日批量更新」修复前后逐位一致，所以不是该修复造成；推测 README 数字来自较早的数据版本（待核，无记录可证）。');
console.log('  README 分档表的场次是「win+lose」（不含 push，合计 4862），而表头写「合计 4908」；本次含 push 为 4908。');
console.log('  分档命中率也有 0.1~0.3pp 的差（如 1~2 分档 README 48.4% vs 实测 48.7%）。');
console.log('  README 不改；差异交 Task 17 报告说明。');
