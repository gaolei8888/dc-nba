/**
 * 独赢盘回测：walk-forward 概率 × 美国公司价格 → data/moneyline-backtest.json（视图 / 接口读它）。
 *
 *   node scripts/moneyline-backtest.mjs      # 先有 data/backtest.json 与 scripts/books-history.mjs 抓好的 books_<季>.json
 *
 * 纯离线：只读 data/backtest.json 与 data/history/books_*.json，不发任何请求（fetch 被封死）。
 * 同一输入重复运行，除 builtAt 外逐字节一致；builtAt 是唯一的时间戳，比较可复现性时先去掉它。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, writeJson } from '../server/nbaClient.mjs';
import { buildMoneylineReport } from '../server/moneylineReport.mjs';
import { WF_SEASONS } from '../server/walkForward.mjs';

globalThis.fetch = () => { throw new Error('moneyline-backtest 只读本地缓存，禁止联网'); };

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (file) => { const buf = fs.readFileSync(file); return { buf, sha: sha(buf) }; };

const bt = read(path.join(DATA_DIR, 'backtest.json'));
const inputsSha = { 'backtest.json': bt.sha };
const books = {};
for (const season of WF_SEASONS) {
  const name = `books_${season}.json`;
  const file = path.join(DATA_DIR, 'history', name);
  if (!fs.existsSync(file)) { console.warn(`缺少 ${name}（该季无价格，将全部缺失）`); continue; }
  const f = read(file);
  inputsSha[name] = f.sha;
  books[season] = JSON.parse(f.buf.toString('utf8'));
}

const report = buildMoneylineReport({ dataset: JSON.parse(bt.buf.toString('utf8')), books, inputsSha });
const out = writeJson('moneyline-backtest.json', { ...report, builtAt: new Date().toISOString() });

// ---------------------------------------------------------------------------
// 控制台摘要
const pct = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const ciStr = (ci) => (ci ? `[${pct(ci.lo)}, ${pct(ci.hi)}]` : '—');

console.log(`写入 ${out}（${report.games.length} 场）`);
console.log('\n== 每季拟合参数 vs 默认 ==');
for (const f of report.fits) {
  console.log(`${f.season} ${f.inSample ? '(样本内)' : `(拟合自 ${f.fitSeasons.join('+')})`} 主场 ${f.homeAdv.toFixed(2)} vs ${f.defaults.homeAdv}`
    + `  休息 ${f.restWeight.toFixed(2)} vs ${f.defaults.restWeight}  SD ${f.spreadSd.toFixed(2)} vs ${f.defaults.spreadSd}`
    + `  Brier ${f.calibration.fitted.brier.toFixed(4)} (SD12 ${f.calibration.sd12.brier.toFixed(4)})`);
}
console.log('\n== 数据完整性 ==');
for (const a of report.integrity) {
  console.log(`${a.season} 场次 ${a.games} 匹配 ${a.matched}（反向 ${a.flipped}）缺 open ${a.missing.open} 缺 close ${a.missing.close}`
    + ` 主客不符 ${a.teamMismatch.length} 异常价 ${a.anomalies.length} 重复 ${a.duplicateGameIds.length} 结算错 ${a.settlementErrors.length}`);
}
console.log('\n== 选定策略与测试期结果（2025-26，默认成本）==');
for (const s of ['close', 'open']) {
  const h = report.headline[s]; const sel = report.selection[s];
  console.log(`[${s}] 选择期 ${sel.selectOn}(${sel.seasons.join('+')}) 比较 ${sel.tried} 个策略（Bonferroni α=${sel.bonferroniAlpha.toFixed(4)}）→ 选定 ${h.strategy ?? '无（无策略达 ' + sel.minBets + ' 注）'}`);
  console.log(`    测试期 注数 ${h.bets} ROI ${pct(h.roi)} 95%CI(按日) ${ciStr(h.ci.day?.roi)}  结论 ${h.verdict?.code ?? '—'}`
    + `  覆盖 ${h.coverage.priced}/${h.coverage.total}（缺失 ${pct(h.coverage.missingRate)}）`);
}
console.log('\n== 滑点敏感性（测试期）==');
for (const r of report.slippage) {
  console.log(`[${r.scenario}] ${r.strategy} 滑点 ${r.slippagePts} 点: 注数 ${r.bets} ROI ${pct(r.roi)} CI ${ciStr(r.ci)}`);
}
