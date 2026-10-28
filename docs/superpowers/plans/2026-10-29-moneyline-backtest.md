# 独赢盘投注回测与策略评估 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用当时真实可得的美国博彩公司钱线、可复现的逐注流水和按比赛日 block bootstrap 的区间，回答「模型相对独赢盘市场有没有可持续优势」，并在模型实验室新增中英双语标签页「模型能否打败市场？」。

**Architecture:** 先修底层（重放按比赛日批量更新、数据完整性、价格时点与博彩公司选择链、walk-forward 参数与胜率校准、复核 49.1%），再在 `server/` 下新增一组纯函数模块（赔率数学 → 结算 → 选价 → 回测引擎 → 策略 → 切分与选择 → 统计 → 视图）。离线脚本 `scripts/moneyline-backtest.mjs` 把 walk-forward 概率 + 每场美国博彩公司价格 + 预先选定的策略写进 `data/moneyline-backtest.json`；服务端在 worker 池里按筛选条件现算逐注流水与统计（带缓存），前向账本（`paper_bets`）在主线程只读现算。新功能消费 `lab.replay` 记录，不复制重放算法。

**Tech Stack:** Node 22 ESM、`node:sqlite`、`worker_threads`（`server/pool.mjs`）、Express、`node:test`；React 18 + Vite；i18n（`web/src/i18n/*`，服务端 `{ code, params }`）。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-moneyline-backtest-design.md`（含末尾「审阅后补充的决定」，以它为准）。辅助：`docs/superpowers/specs/2026-10-29-betting-backtest-analysis.md`（现状审计，主检出里可能未跟踪，从磁盘读）、`docs/nba-betting-quant-research.md`。

## Global Constraints

- 只做独赢盘；让分 / 大小分不实现、不展示，结算与数据结构按 `market` 抽象留口（`MARKETS = ['moneyline']`）。
- 不接真实投注账户、不下单、不接付费赔率接口（The Odds API、Betfair 历史数据）；需要时停下上报。
- 不改线上生产模型与参数（`server/predict.mjs` 的 `DEFAULT_PARAMS`、Elo）；walk-forward 只是回测新路径；生产参数应否调整只写进报告上报。
- 不请求 stats.nba.com / nba.com；本计划不发任何网络请求（Task 16 的网页核实除外，只读公开网页）。
- 不干扰 `npm run backtest`、`npm run odds:history`、`npm run dataset`、线上预测、账本、影子模式与定时任务；`paper_bets` 只追加约束不变，本计划不写它。
- 下注定价只用 `US_BOOKS`；选价链固定为 DraftKings → ESPN BET → BetMGM → Caesars → 其他美国公司（`US_BOOKS` 里其余顺序：betrivers、unibet、pointsbet、westgate）；Betfair 等交易所不用于定价；「挑最优价」只作单独标注的敏感性情景，不进主结论。
- 公式：盈亏平衡 +A：100/(A+100)，−A：A/(A+100)；`edge = p_model − p_break_even`（按实际下注价）；`EV/单位 = p_model × (decimal − 1) − (1 − p_model)`；Kelly `f* = (b·p − q)/b`，`b = decimal − 1`，`q = 1 − p`，乘以 1 / 0.5 / 0.25 后截到 `[0, 0.05]`（单注上限默认本金 5%，可配置），不允许负仓位或杠杆。收益一律按实际报价结算，去水概率只用于比较模型与市场谁更准。
- 成本默认 0：手续费（赢注净利的比例）、滑点（美式赔率点数）、单注限额；报告给 0 / 5 / 10 点滑点敏感性。
- 两种模型分开报告、绝不合并：历史回测 = 「重放模型」（Elo + 主场 + 休息，walk-forward 校准），`modelVersion = 'replay-elo-wf'`；前向账本 = 「线上生产模型」，概率按记录原样，`modelVersion = 'production-logged'`。
- 切分：2021-22 只作 Elo 预热。收盘价情景：训练 2022-23、验证 2023-24～2024-25（策略在验证期选）、测试 2025-26 且必须注明「已在此前分析中被看过」。开盘价情景：选参 2023-24、验证 2024-25、测试 2025-26。本季（2026-27）前向账本单列为真正干净的检验。两个价格情景分开报告，不合并。
- 结论标准（预先写定）：「有证据表明能赢盘口」需测试期扣除默认成本后 ROI 的 95% 按比赛日 block bootstrap 区间下界 > 0 **且** 投注数 ≥ 300；前向账本同样要求 ≥ 300 注且区间下界 > 0；否则写「无证据」并给出功效分析（达到显著需要多少注）。
- 同一数据与参数重复运行，逐注流水与 ROI 完全一致（随机数一律固定种子，沿用 `fusionLab.rng`，seed 7）。
- 测试不得写 `data/app.db`：涉及库的测试用 `fs.mkdtempSync(os.tmpdir())` 下的临时路径。
- 文案：中文为源；英文按 `docs/i18n-glossary.md`，诚实结论同样直白（「无证据表明模型能赢盘口」→ "No evidence the model beats the market"）；`npm run check:i18n` 与 `npm test` 必须通过。
- 中文注释与文档、中文提交信息；部署走 `deploy/README.md`：回滚标签、数据库备份、不覆盖服务器 `docker-compose.yml` 与 `data-db/`、避开北京时间 22:00 / 06:30 / 14:30 前后 30 分钟。

## Review Focus

- **中立场 / ESPN 主客与我们相反**：价格方向必须随之翻转，否则押主队实际结算成客队价——Task 3 `compactBooks` 翻转用例。
- **链上首家缺该时点或价格异常**：应顺延到下一家美国公司并打标记，而不是整场跳过或用了异常价——Task 3 `selectPrice` 顺延用例、Task 2 `priceAnomaly`。
- **筛选后 0 注或极少注**（某博彩公司某季、日期范围很窄、前向账本刚开始）：汇总与页面不崩，显示样本不足警告与功效分析——Task 8 空流水用例、Task 12 视图用例。
- **Kelly 同日多注**：按日初资金定注，同日下注总额不超过日初资金、资金不为负；限额生效——Task 8 用例。
- **前向账本未结算 / 延期**：`settled_at` 为空或比分缺的行不计盈亏、计入待结算数；作废返还本金不计入下注额——Task 7、Task 12 用例。

---

## 关键事实（来自读代码，写计划时已核实）

- `server/lab.mjs` `replay()` 在 `expand()` 排好的 `date, gameId` 顺序上逐场「先记预测、再更新 Elo」。Elo 更新只改本场两队；**实测 `data/backtest.json` 五季里没有任何球队同日出场两次**（脚本核对：teamTwiceSameDay = 0、dupGameId = 0）。因此「同日泄漏」在现有数据上对任何数字**没有实际影响**；`server/fusionLab.mjs:117` 早已按日批量（`computeElo(dayGames, …)`），且 `tests/fusionLab.test.mjs` 锁定它与 `lab.replay` 逐场一致。按 spec 仍做结构性修复（让不变量由代码保证，而不是靠数据碰巧），预期新旧数字逐位一致——Task 1 用快照哈希证明。
- README 的 66.32% 表来自 `scripts/backtest.mjs`（自带一份逐场循环 `replaySeason`，同样结构）；66.26% / 68.40% / McNemar / 49.12% 来自 `lab.market(lab.replay(…, DEFAULTS))`（4908 场，`odds_*` 单家让分，Betfair 22-24）。
- `data/backtest.json` 是 `scripts/build-dataset.mjs` 产出的**数据集**，与重放无关，修复不会也不应改变它（Task 1 用 sha256 确认）；受重放影响的派生物是 `data/paper-backtest.json`。
- `books_<季>.json`：`{ season, games: { gameId: { eventId, date, home, items:[{ id, name, spread, open, close, current }] } } }`，时点值为 `[主, 客]` 美式钱线（ESPN 主客）。`cleanItems` 已剔 Live / 聚合源 / 离谱线并合并同家多 id。
- `paper_bets` 每场每条规则一行（含 `bet = 0` 的不下注行）：早规则 `edge0` 行即「22:00 那次对每场记下的 DK 价 + `model_p_home`」，晚规则 `edge3-late` 行是 06:30 的价；结算列 `home_score / away_score / settled_at`，收盘列 `close_home_ml / close_away_ml`。
- 消息码必须在所有语言里都有：`tests/serverMessages.test.mjs`「服务端出现的每个消息码在所有语言里都有」会扫描 server 源码。

## File Structure

| 文件 | 职责 |
|---|---|
| `server/lab.mjs`（改） | `replay()` 按比赛日两段式（先算当日全部预测、再统一更新 Elo / 休息 / 场次）；记录新增 `eloPts`、`restRaw` |
| `scripts/backtest.mjs`（改） | `replaySeason` 同样按日批量；`cached()` 在 `BACKTEST_OFFLINE=1` 且缓存缺失时抛错而不是联网 |
| `scripts/replay-snapshot.mjs`（新） | 打印重放与对标盘口关键数字 + 逐场记录哈希，供修复前后对比 |
| `scripts/ats-audit.mjs`（新） | 复核 README 49.1% 的口径与样本 |
| `server/dataIntegrity.mjs`（新） | 异常价判定、逐季完整性审计（重复、缺价、主客颠倒、结算错误、覆盖率） |
| `server/priceSelect.mjs`（新） | 美国公司价格压缩（含主客翻转）、选价链、开盘 / 收盘 / 最优价情景与标记 |
| `server/walkForward.mjs`（新） | 逐测试季只用此前赛季拟合主场优势、休息权重、胜率换算 SD（及逻辑斯蒂诊断） |
| `server/oddsMath.mjs`（新） | 美式 ↔ 十进制、盈亏平衡、去水、edge、EV、Kelly、滑点 |
| `server/betSettlement.mjs`（新） | 按市场结算（只实现 moneyline）：胜 / 负 / 作废、手续费 |
| `server/betBacktest.mjs`（新） | 候选生成、逐注流水、成本、资金曲线与汇总指标 |
| `server/betStrategies.mjs`（新） | 策略 A–D 定义、选边、定注 |
| `server/betSplits.mjs`（新） | 情景 × 赛季 → 训练 / 验证 / 测试；策略选择规则；多重比较清单 |
| `server/betStats.mjs`（新） | block bootstrap、分桶 ROI、校准对比、功效分析、结论消息 |
| `server/moneylineView.mjs`（新） | 筛选校验、前向账本适配、一次请求的完整视图（worker 与主线程共用） |
| `server/moneylineReport.mjs`（新） | 纯函数 `buildMoneylineReport`：生成 `data/moneyline-backtest.json` 的内容 |
| `scripts/moneyline-backtest.mjs`（新） | 读数据 → `buildMoneylineReport` → 写文件 + 控制台摘要；`npm run ml:backtest` |
| `server/worker.mjs`、`server/index.mjs`（改） | `labMoneyline` 任务；`GET /api/lab/moneyline/meta`、`POST /api/lab/moneyline` |
| `web/src/lib/api.js`（改） | `labMoneylineMeta`、`labMoneyline` |
| `web/src/components/MiniCharts.jsx`（新） | 资金曲线、带区间的条形、可靠性图（SVG，仿 `Board.jsx` 的 `Curve` 写法） |
| `web/src/pages/LabMoneyline.jsx`（新）、`web/src/pages/Lab.jsx`（改） | 新标签页；`tabs` 加 `'beat'` |
| `web/src/i18n/locales/zh.js`、`en.js`、`docs/i18n-glossary.md`（改） | `lab.tab.beat`、`lab.beat.*`、`srv.ml.*`、`err.badFilter`；新术语 |
| `docs/moneyline-backtest-technical.md`、`docs/moneyline-backtest-report.md`（新） | 技术说明（含开源 / 商业产品附录）、真实回测报告 |
| `docs/replay-same-day-fix-output.txt`、`docs/ats-491-audit-output.txt`（新） | 修复前后对比与 49.1% 复核的原始输出 |
| `README.md`、`deploy/README.md`、`docs/HANDOFF-2026-10-27.md`（改） | 受影响数字与说明、上线方式、交接 |
| `tests/lab.test.mjs`（改）、`tests/dataIntegrity.test.mjs`、`tests/priceSelect.test.mjs`、`tests/walkForward.test.mjs`、`tests/oddsMath.test.mjs`、`tests/betSettlement.test.mjs`、`tests/betBacktest.test.mjs`、`tests/betStrategies.test.mjs`、`tests/betSplits.test.mjs`、`tests/betStats.test.mjs`、`tests/moneylineView.test.mjs`、`tests/moneylineReport.test.mjs`、`tests/moneylineApi.test.mjs`（新） | 见各任务 |

**共享数据形状（各任务按此对齐）：**

```js
// 压缩后的一场（moneyline-backtest.json 的 games[]；方向已对齐我们的主客）
Game = { gameId, date, season, homeId, awayId, homeWin, actual, void, b2bHome, b2bAway, teamGp,
         pHome /* walk-forward 校准后 */, paramsVersion, modelVersion,
         books: { [book]: { open: [h,a]|null, close: [h,a]|null, current: [h,a]|null } } }
// 选价结果
Price = { ml: [h,a], books: [homeBook, awayBook], priceAt: 'open'|'close'|'current', closeMl: [h,a]|null, flags: string[] }
// 候选（一场可下注的机会）
Candidate = Game 去掉 books + { scenario, split, ml, books, priceAt, closeMl, flags }
// 逐注流水
Bet = { gameId, date, season, homeId, awayId, modelVersion, paramsVersion, scenario, split, priceAt, book,
        strategy, market: 'moneyline', side, pModel, quoted, american, decimal, edge, ev,
        stake, result: 'win'|'loss'|'void', profit, bankrollAfter, clv, b2bSide, b2bOpp, teamGp }
```

---

## 第一阶段：底层修复

### Task 1: 重放按比赛日批量更新（全局）与修复前后对比

**Files:**
- Create: `scripts/replay-snapshot.mjs`, `docs/replay-same-day-fix-output.txt`
- Modify: `server/lab.mjs:94-191`（`replay` 的逐场循环）, `scripts/backtest.mjs:37-47`（`cached`）与 `:282-330`（`replaySeason` 循环）, `README.md`（「回测」节首段与「对标博彩盘口」节，见 Step 9）
- Test: `tests/lab.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `replay(dataset, seasons, opts)` 签名与记录字段不变，语义改为「同一 `date` 的全部预测用当日开始时的 Elo / 休息 / 场次」；`scripts/replay-snapshot.mjs` 输出 JSON `{ recordsSha256, score: {season: score}, market: { n, model, marketModel, mcnemar, ats: ats.all, byEdge }, paperHeadline }`

- [ ] **Step 1: 加离线护栏与快照脚本**（先于任何代码修改）
  - `scripts/backtest.mjs` 的 `cached(name, fetcher)`：文件不存在且 `process.env.BACKTEST_OFFLINE === '1'` 时 `throw new Error(\`离线模式缺缓存 ${name}，不联网\`)`。
  - `scripts/replay-snapshot.mjs`：读 `data/backtest.json`，`replay(bt, ['2022-23','2023-24','2024-25','2025-26'], DEFAULTS)`；`recordsSha256` = 对 `records.map(r => [r.gameId, r.p.toFixed(12), r.pred.toFixed(9)])` 的 JSON 取 sha256；`score` 按季 `lab.score`；`market` 取 `lab.market(records)` 的上述字段；`paperHeadline` 按 `scripts/paper-backtest.mjs` 同口径（DK、`PRIMARY`、2022-23 之后）重算 `summarize(...)` 的 `{bets, roi, ci}`（B=2000）。

- [ ] **Step 2: 记录修复前的数字**

Run:
```bash
ls data/history/gamelog_202{1,2,3,4,5}-*.json data/history/teamadv_202{1,2,3,4,5}-*.json   # 缺任何一个就停下，不联网
sha256sum data/backtest.json > "$SCRATCH/before.sha"
node scripts/replay-snapshot.mjs > "$SCRATCH/snapshot-before.json"
BACKTEST_OFFLINE=1 npm run backtest > "$SCRATCH/backtest-before.txt"
```
（`$SCRATCH` = 会话 scratchpad 目录。）Expected: 三条命令退出码 0；`backtest-before.txt` 的「滚动Elo＋纯Elo（基线）」行为 66.32%。

- [ ] **Step 3: 写失败测试**（`tests/lab.test.mjs` 追加）

```js
test('replay：同一比赛日的预测只用当日开始时的评级（同日共享球队也不互相影响）', () => {
  // 预热季 + 测试季；测试季 D 日人为放两场都含 1 号队的比赛（真实数据里不会出现，用来钉住不变量）
  const prior = [{ i: 'P1', d: '2021-11-01', s: [[1, 110, 1], [2, 100, 0]] }, { i: 'P2', d: '2021-11-02', s: [[3, 105, 1], [1, 100, 0]] }];
  const day = (g1Home) => [
    { i: 'G1', d: '2022-11-01', s: [[1, g1Home, 1], [2, 100, 0]] },
    { i: 'G2', d: '2022-11-01', s: [[3, 101, 1], [1, 99, 0]] },
    { i: 'G3', d: '2022-11-02', s: [[1, 100, 1], [3, 98, 0]] },
  ];
  const run = (g1Home) => replay({ seasons: { '2021-22': prior, '2022-23': day(g1Home) }, teamAdv: {} }, ['2022-23']);
  const a = run(140); const b = run(60);           // G1 大胜 vs 大败
  const g2 = (rs) => rs.find((r) => r.gameId === 'G2');
  assert.equal(g2(a).p, g2(b).p);                   // 同日第二场不受第一场结果影响
  assert.equal(g2(a).eloDiff, g2(b).eloDiff);
  assert.notEqual(a.find((r) => r.gameId === 'G3').p, b.find((r) => r.gameId === 'G3').p); // 次日照常吸收
  assert.equal(g2(a).restAway, null);               // 同日已出场不算「前一场」
});
```

- [ ] **Step 4: 运行确认失败**
Run: `node --test tests/lab.test.mjs`
Expected: FAIL，`g2(a).p` 与 `g2(b).p` 不等（旧代码逐场更新）。

- [ ] **Step 5: 实现**：`replay` 内按 `date` 分组（`games` 已按 `date, gameId` 排序），每组先对全部比赛算 `restOf / strength / margin / prob` 并 `records.push`，再统一更新 `played`、`lastPlayed`、Elo（Elo 增量按组内各场用**组开始时**的评级算出后再一次性加上）。记录字段与顺序不变。`scripts/backtest.mjs` 的 `replaySeason` 做同样改动。不动 `server/replay.mjs`、`server/rosterReplay.mjs`、`scripts/ingest.mjs`（见 Step 9 的上报）。

- [ ] **Step 6: 运行确认通过**
Run: `npm test`
Expected: `# fail 0`（含 `tests/fusionLab.test.mjs`、`tests/continuityLab.test.mjs` 里「与 lab.replay 逐场一致」的用例）。

- [ ] **Step 7: 修复后重跑并对比**

Run:
```bash
sha256sum -c "$SCRATCH/before.sha"
node scripts/replay-snapshot.mjs > "$SCRATCH/snapshot-after.json"
BACKTEST_OFFLINE=1 npm run backtest > "$SCRATCH/backtest-after.txt"
diff "$SCRATCH/snapshot-before.json" "$SCRATCH/snapshot-after.json"; diff "$SCRATCH/backtest-before.txt" "$SCRATCH/backtest-after.txt"
```
Expected: `data/backtest.json: OK`；两个 `diff` 均无输出（预期新旧一致，因为真实数据里没有球队同日出场两次）。**若有差异：停下，把差异贴给用户，不要继续**——这说明数据里有重复或同日两场，需先查 Task 2。

- [ ] **Step 8: 写对比记录** `docs/replay-same-day-fix-output.txt`：修复前后 `recordsSha256`、按季 `score`、`market`（66.26% / 68.40% / χ² 15.70 / 49.12%）、`paperHeadline`、`npm run backtest` 关键行，各列「修复前 / 修复后 / 差」；末尾一句结论：「差异为零的原因：Elo 更新只改本场两队，数据中没有球队同日出场两次（2021-22～2025-26 逐季核对为 0）」。`data/paper-backtest.json` 无需重新生成（数字不变）；若 Step 7 有差异则改为重跑 `npm run paper:backtest` 并记录。

- [ ] **Step 9: README 与上报**：`README.md`「回测」节「不存在信息泄漏」之后加一句：同一比赛日的全部预测先算完再统一更新（2026-10-29 起结构性保证），修复前后数字逐位一致，见 `docs/replay-same-day-fix-output.txt`；表格数字不改（若 Step 7 有差异则按新值更新并在报告中列差）。在对比记录末尾单列「同结构但本次未改」：`server/replay.mjs`（人机对赌题库）、`server/rosterReplay.mjs`、`scripts/ingest.mjs` 的生产赛前 Elo（`computeElo` 逐场）——同理不受影响，不改线上，交给用户决定。

- [ ] **Step 10: 提交**
```bash
git add server/lab.mjs scripts/backtest.mjs scripts/replay-snapshot.mjs tests/lab.test.mjs docs/replay-same-day-fix-output.txt README.md
git commit -m "重放按比赛日批量更新：同日预测只用当日开始时的评级；修复前后数字逐位一致（记录见 docs）"
```

### Task 2: 数据完整性检查

**Files:**
- Create: `server/dataIntegrity.mjs`
- Test: `tests/dataIntegrity.test.mjs`

**Interfaces:**
- Consumes: `cleanItems`, `bookOf`, `US_BOOKS`（`server/books.mjs`）；`replay` 记录（Task 1）
- Produces:
  - `export const ANOMALY = { maxAbs: 5000, overroundLo: 1.0, overroundHi: 1.15 }`
  - `priceAnomaly(ml: [number, number] | null): null | 'missing' | 'invalidAmerican' | 'liveLike' | 'overroundLow' | 'overroundHigh'`
  - `auditSeason({ season: string, records: Record[], cache: object /* books_<季>.json 的 games */ }): Audit`，`Audit = { season, games, fetched, matched, flipped, teamMismatch: string[], duplicateGameIds: string[], duplicateEventIds: string[], settlementErrors: string[], coverage: { [book]: { open, close, current } }, missing: { open: number, close: number }, anomalies: [{ gameId, book, at, ml, reason }] }`

- [ ] **Step 1: 写失败测试**

```js
test('priceAnomaly：正常价、滚球价、非法美式、过低 / 过高抽水', () => {
  assert.equal(priceAnomaly([-110, -110]), null);
  assert.equal(priceAnomaly([-150, 130]), null);
  assert.equal(priceAnomaly(null), 'missing');
  assert.equal(priceAnomaly([50, -110]), 'invalidAmerican');      // |A| < 100
  assert.equal(priceAnomaly([-100000, 5000]), 'liveLike');        // |A| > 5000
  assert.equal(priceAnomaly([150, 130]), 'overroundLow');         // 两边都正：隐含概率和 < 1
  assert.equal(priceAnomaly([-1000, -1000]), 'overroundHigh');    // 和 > 1.15
});
test('auditSeason：主客翻转计数、球队对不上、重复 gameId / eventId、结算错误、覆盖率与缺失', () => { /* 合成 3 场 + 1 重复 */ });
```
`auditSeason` 用例的断言：一场 ESPN `home` = 我们的客队 → `flipped === 1`；一场 `home` 是第三支队 → `teamMismatch` 含该 gameId；两场同 `eventId` → `duplicateEventIds` 含它；一条记录 `homeWin: true, actual: -3` → `settlementErrors` 含它；只有 Betfair（id 50）一家的场次计入 `missing.close`，不计入任何 `coverage` 键；`coverage.draftkings.close` 等于有 DK close 的场数。

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/dataIntegrity.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: 实现** `server/dataIntegrity.mjs`。`priceAnomaly` 判定顺序：missing → invalidAmerican（非有限数或 |A| < 100）→ liveLike → 隐含概率和 `< ANOMALY.overroundLo` / `> ANOMALY.overroundHi`。`auditSeason` 只统计 `US_BOOKS`；`settlementErrors` 判据 `actual === 0 || homeWin !== (actual > 0)`。

- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/dataIntegrity.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add server/dataIntegrity.mjs tests/dataIntegrity.test.mjs
git commit -m "数据完整性检查：异常钱线判定与逐季审计（重复、缺价、主客颠倒、结算错误、美国公司覆盖率）"
```

### Task 3: 价格时点标注与博彩公司选择链

**Files:**
- Create: `server/priceSelect.mjs`
- Test: `tests/priceSelect.test.mjs`

**Interfaces:**
- Consumes: `cleanItems`, `US_BOOKS`（`server/books.mjs`）；`priceAnomaly`（Task 2）
- Produces:
  - `export const BOOK_PRIORITY = ['draftkings', 'espnbet', 'betmgm', 'caesars', 'betrivers', 'unibet', 'pointsbet', 'westgate']`
  - `compactBooks(entry: { home, items } | undefined, homeId: number, awayId: number): { books: Record<string, { open, close, current }>, flipped: boolean } | null`（只留 `US_BOOKS`；ESPN 主队 = 我们客队时三个时点都翻转；`home` 两队都不是返回 `null`）
  - `selectPrice(books, scenario: 'open' | 'close', { book = 'chain' }: { book?: 'chain' | 'best' | string }): Price | { missing: 'noUsBook' | 'noOpen' | 'noPrice' | 'bookAbsent' | 'anomaly' }`
  - 标记：`'currentAsClose'`（收盘情景用了 current）、`'bestPrice'`、`'noCloseForClv'`（开盘情景该家没有 close）、`'skippedAnomaly'`（链上有家因异常价被跳过）

- [ ] **Step 1: 写失败测试**

```js
test('选择链：先按博彩公司优先级取一家，再在这家里取时点（close > current）', () => {
  const books = { draftkings: { open: null, close: null, current: [-120, 100] }, espnbet: { open: null, close: [-130, 110], current: [-130, 110] } };
  const p = selectPrice(books, 'close', {});
  assert.deepEqual([p.books, p.priceAt, p.ml, p.flags], [['draftkings', 'draftkings'], 'current', [-120, 100], ['currentAsClose']]);
});
test('开盘情景：链上第一家有 open 的；CLV 用同一家的 close', () => {
  const books = { draftkings: { open: null, close: [-120, 100], current: null }, espnbet: { open: [-140, 120], close: [-130, 110], current: null } };
  const p = selectPrice(books, 'open', {});
  assert.deepEqual([p.books[0], p.priceAt, p.ml, p.closeMl], ['espnbet', 'open', [-140, 120], [-130, 110]]);
});
test('异常价顺延到下一家并打标记；全链都没有返回缺失原因', () => {
  const books = { draftkings: { open: null, close: [150, 130], current: null }, betmgm: { open: null, close: [-115, -105], current: null } };
  const p = selectPrice(books, 'close', {});
  assert.equal(p.books[0], 'betmgm'); assert.ok(p.flags.includes('skippedAnomaly'));
  assert.deepEqual(selectPrice({}, 'close', {}), { missing: 'noUsBook' });
  assert.deepEqual(selectPrice({ draftkings: { open: null, close: [-110, -110], current: null } }, 'open', {}), { missing: 'noOpen' });
  assert.deepEqual(selectPrice({ draftkings: { open: null, close: [-110, -110], current: null } }, 'close', { book: 'betmgm' }), { missing: 'bookAbsent' });
});
test('挑最优价：每方取美国公司里赔付最高的价，单独标注', () => {
  const books = { draftkings: { open: null, close: [-120, 100], current: null }, espnbet: { open: null, close: [-125, 110], current: null } };
  const p = selectPrice(books, 'close', { book: 'best' });
  assert.deepEqual([p.ml, p.books, p.flags], [[-120, 110], ['draftkings', 'espnbet'], ['bestPrice']]);
});
test('compactBooks：Betfair 不进；ESPN 主客与我们相反时三个时点都翻转；球队对不上返回 null', () => {
  const items = [
    { id: '50', name: 'Betfair', spread: -3, open: [-150, 130], close: [-150, 130], current: null },
    { id: '40', name: 'Draft Kings', spread: -3, open: [-150, 130], close: [-160, 140], current: [-160, 140] },
  ];
  assert.deepEqual(Object.keys(compactBooks({ home: 1, items }, 1, 2).books), ['draftkings']);
  const f = compactBooks({ home: 2, items }, 1, 2);
  assert.deepEqual([f.flipped, f.books.draftkings.open, f.books.draftkings.close], [true, [130, -150], [140, -160]]);
  assert.equal(compactBooks({ home: 9, items }, 1, 2), null);
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/priceSelect.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: 实现** `server/priceSelect.mjs`。链 = `BOOK_PRIORITY` 中出现在 `books` 的家，其后补 `books` 里其余美国公司（字母序）。开盘情景只认 `open`；收盘情景在**选定那一家**里 close 优先、否则 current（打 `currentAsClose`）。每个候选价先过 `priceAnomaly`，异常则顺延并记 `skippedAnomaly`；全链因异常而无价时返回 `{ missing: 'anomaly' }`。`best`：两边各自在全部美国公司该时点价里取十进制赔率最高者（同价按链顺序），`closeMl: null`。

- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/priceSelect.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add server/priceSelect.mjs tests/priceSelect.test.mjs
git commit -m "选价：只用美国博彩公司，DK → ESPN BET → BetMGM → Caesars → 其他；标注价格时点，最优价单列为敏感性情景"
```

### Task 4: walk-forward 参数拟合与胜率校准

**Files:**
- Create: `server/walkForward.mjs`
- Modify: `server/lab.mjs`（`replay` 记录加 `eloPts`、`restRaw`）
- Test: `tests/walkForward.test.mjs`, `tests/lab.test.mjs`

**Interfaces:**
- Consumes: `replay`, `DEFAULTS`, `normalCdf`（`server/lab.mjs`）；`rng`（`server/fusionLab.mjs`，仅测试造数据）
- Produces:
  - `replay` 记录新增：`eloPts`（`strength(home) − strength(away)`，不含主场与休息）、`restRaw`（`restAdjust(restHome) − restAdjust(restAway)`）；满足 `pred === eloPts + (neutral ? 0 : homeAdv) + restWeight * restRaw`
  - `fitMarginParams(rows): { homeAdv: number, restWeight: number }`（无截距 OLS：`actual − eloPts ~ homeAdv·(neutral?0:1) + restWeight·restRaw`）
  - `fitSpreadSd(rows, margins: number[]): number`（使 `Φ(margin/σ)` 对数损失最小的 σ，黄金分割，区间 [6, 24]，容差 1e-4）
  - `fitLogistic(rows, margins): { a: number, b: number }`（`p = 1/(1+e^{−(a + b·margin)})`，牛顿法，诊断用）
  - `walkForward(dataset, { seasons = ['2022-23','2023-24','2024-25','2025-26'] } = {}): { records: (Record & { pWF, marginWF, paramsVersion })[], fits: Fit[] }`，`Fit = { season, fitSeasons: string[], inSample: boolean, n, homeAdv, restWeight, spreadSd, logistic: { a, b }, defaults: { homeAdv: 1.6, restWeight: 1.8, spreadSd: 12 } }`
  - `paramsVersion`：测试季 N 用 `wf:<最后一个拟合季>`（如 2025-26 → `'wf:2024-25'`）；2022-23 没有此前重放季，**样本内拟合**，记 `'in-sample:2022-23'`、`inSample: true`
  - `export const MODEL_VERSION_REPLAY = 'replay-elo-wf'`
  - `k = 20`、`carryKeep = 0.75` 来自 FiveThirtyEight（外部来源），不拟合，在 `fits` 旁写明

- [ ] **Step 1: 写失败测试**

```js
test('replay 记录：pred = eloPts + 主场 + restWeight·restRaw', () => { /* 用 Task 1 的合成数据，homeAdv 2, restWeight 1.5 */ });
test('fitMarginParams：无噪声数据精确还原主场优势与休息权重', () => {
  const rows = Array.from({ length: 200 }, (_, i) => {
    const eloPts = (i % 17) - 8; const restRaw = [-1.1, 0, 0.35, 0.5][i % 4]; const neutral = i % 50 === 0;
    return { eloPts, restRaw, neutral, actual: eloPts + (neutral ? 0 : 2.0) + 1.5 * restRaw };
  });
  const f = fitMarginParams(rows);
  assert.ok(Math.abs(f.homeAdv - 2.0) < 1e-9 && Math.abs(f.restWeight - 1.5) < 1e-9);
});
test('fitSpreadSd：按 Φ(m/13) 生成的胜负，拟合 σ 在 13 ± 0.6 内', () => { /* rng(7)，n = 20000，margin 均匀于 [-15, 15] */ });
test('walkForward：测试季参数只用此前赛季——改动 2025-26 的比分不改变 2025-26 的拟合', () => {
  // 用真实 data/backtest.json（只读）；深拷贝后把 2025-26 每场比分对调
  // 断言：fits 中 2025-26 的 homeAdv/restWeight/spreadSd 两次完全相等；fitSeasons = ['2022-23','2023-24','2024-25']
  // 断言：2022-23 的 inSample === true、paramsVersion === 'in-sample:2022-23'；2025-26 记录的 paramsVersion === 'wf:2024-25'
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/walkForward.test.mjs tests/lab.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND` 与 `eloPts` 为 `undefined`

- [ ] **Step 3: 实现**：`lab.mjs` 记录加两个字段（不改其他字段）。`walkForward` 只调用一次 `replay(dataset, seasons, DEFAULTS)`（Elo 轨迹与 homeAdv / restWeight / spreadSd 无关），对每个测试季用此前赛季记录拟合，再按 `marginWF = eloPts + hca + restWeight·restRaw`、`pWF = normalCdf(marginWF, spreadSd)` 重算。主概率用正态 SD；逻辑斯蒂只放进 `fits` 作诊断（设计决定，见文末）。

- [ ] **Step 4: 运行确认通过**
Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 5: 提交**
```bash
git add server/walkForward.mjs server/lab.mjs tests/walkForward.test.mjs tests/lab.test.mjs
git commit -m "walk-forward：每个测试季只用此前赛季拟合主场优势、休息权重与胜率换算 SD；2022-23 标为样本内"
```

### Task 5: 复核 README 的 49.1%

**Files:**
- Create: `scripts/ats-audit.mjs`, `docs/ats-491-audit-output.txt`

**Interfaces:**
- Consumes: `replay`, `market`, `DEFAULTS`（`server/lab.mjs`）；`data/history/odds_<季>.json`
- Produces: 控制台输出（无导出），被 Task 17 报告引用

- [ ] **Step 1: 写脚本** `scripts/ats-audit.mjs`：重放 2022-23～2025-26（`DEFAULTS`）→ `lab.market`；打印：样本数（有盘口 / 全部）、`ats.all` 的 win / lose / push、命中率、95% 半宽 `1.96·√(r(1−r)/(win+lose))`、按季命中率；逐季 `odds_*.json` 的 provider 计数与 `spread` 字段来源（`parseOddsItem` 读 ESPN 顶层 `item.spread`，对已完赛比赛 ≈ 最后一次报价，无时点标签）；参数口径（`homeAdv 1.6` 由 2024-25/2025-26 实测得出 → 在评估季上是样本内）；push 定义（`edge === 0` 或 `cover === 0` 不进分母）；让分价格缺失（`trimItem` 未存），所以 ROI 只能在「统一 −110」假设下给出：`ROI = r·(100/110) − (1 − r)`，并标注「假设情景，不是历史实际收益」。
- [ ] **Step 2: 运行**
Run: `node scripts/ats-audit.mjs | tee docs/ats-491-audit-output.txt`
Expected: 合计 4908、命中率 49.12%（与 README 一致；不一致则在输出末尾写明差异与原因，不改 README 的数而是在 Task 17 报告里说明）。
- [ ] **Step 3: 提交**
```bash
git add scripts/ats-audit.mjs docs/ats-491-audit-output.txt
git commit -m "复核 README 让分命中率 49.1%：口径、样本、push 处理、盘口来源与样本内参数"
```

## 第二阶段：独赢盘赔率数学、结算与回测引擎

### Task 6: 赔率数学

**Files:**
- Create: `server/oddsMath.mjs`
- Test: `tests/oddsMath.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `isValidAmerican(a: unknown): boolean`（有限数且 |a| ≥ 100）
  - `americanToDecimal(a: number): number`；`decimalToAmerican(d: number): number`（取整）
  - `breakEven(a: number): number`
  - `devigPair(homeMl: number, awayMl: number): { home: number, away: number, overround: number } | null`
  - `edgeOf(p: number, a: number): number`；`evPerUnit(p: number, a: number): number`
  - `kellyFraction(p: number, a: number, { mult = 1, cap = 0.05 } = {}): number`
  - `worsenAmerican(a: number, pts: number): number`（按美式赔率点数变差，越过 ±100 时连续：+102 变差 5 点 → −103）

- [ ] **Step 1: 写失败测试**

```js
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
test('美式 ↔ 十进制', () => {
  close(americanToDecimal(150), 2.5); close(americanToDecimal(-150), 1.6666667); close(americanToDecimal(-110), 1.9090909);
  assert.equal(decimalToAmerican(2.5), 150); assert.equal(decimalToAmerican(1 + 100 / 150), -150);
});
test('盈亏平衡：+150 → 0.4，−150 → 0.6，−110 → 0.5238095', () => {
  close(breakEven(150), 0.4); close(breakEven(-150), 0.6); close(breakEven(-110), 0.5238095);
});
test('去水：同一家两侧按比例归一', () => {
  const d = devigPair(-150, 130); close(d.home, 0.5798319); close(d.away, 0.4201681); close(d.overround, 1.0347826);
  close(devigPair(-110, -110).home, 0.5); assert.equal(devigPair(null, -110), null);
});
test('edge 与 EV', () => {
  close(edgeOf(0.45, 150), 0.05); close(evPerUnit(0.45, 150), 0.125);
  close(evPerUnit(0.6, -150), 0); close(evPerUnit(0.5, -110), -0.0454545);
});
test('Kelly：f* = (b·p − q)/b，乘分数后截到 [0, cap]', () => {
  close(kellyFraction(0.5, 150), 0.05);                       // f* = 0.1666667 → 上限 5%
  close(kellyFraction(0.5, 150, { mult: 0.25 }), 0.0416667);
  close(kellyFraction(0.55, -110, { mult: 0.5 }), 0.0275);    // f* = 0.055
  close(kellyFraction(0.55, -110, { mult: 0.5, cap: 1 }), 0.0275);
  assert.equal(kellyFraction(0.35, 150), 0);                  // 负期望不下、不做空
});
test('滑点：按美式点数变差，越过 ±100 连续', () => {
  assert.equal(worsenAmerican(150, 5), 145); assert.equal(worsenAmerican(-150, 5), -155);
  assert.equal(worsenAmerican(102, 5), -103); assert.equal(worsenAmerican(100, 5), -105); assert.equal(worsenAmerican(-110, 0), -110);
});
test('isValidAmerican', () => { assert.equal(isValidAmerican(-110), true); assert.equal(isValidAmerican(50), false); assert.equal(isValidAmerican(NaN), false); });
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/oddsMath.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/oddsMath.mjs`（纯函数，不依赖其他模块；`paperBetting.mjs` 不改）。
- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/oddsMath.test.mjs`
Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/oddsMath.mjs tests/oddsMath.test.mjs
git commit -m "赔率数学：美式/十进制换算、盈亏平衡、去水、edge、EV、分数 Kelly（单注上限）、滑点"
```

### Task 7: 结算（按市场抽象，只实现独赢盘）

**Files:**
- Create: `server/betSettlement.mjs`
- Test: `tests/betSettlement.test.mjs`

**Interfaces:**
- Consumes: `americanToDecimal`（Task 6）
- Produces:
  - `export const MARKETS = ['moneyline']`
  - `outcomeOf(game: { homeWin: boolean | null, void?: boolean }): { homeWin: boolean | null, void: boolean }`（比分缺失或 `void` → 作废）
  - `settleBet({ market, side: 'home' | 'away', american, stake, outcome, feeOnWin = 0 }): { result: 'win' | 'loss' | 'void', profit: number }`；`market` 不在 `MARKETS` 时 `throw new Error('未实现的市场：<market>')`

- [ ] **Step 1: 写失败测试**

```js
test('独赢盘结算：赢按实际报价，输 −stake，作废 0', () => {
  const o = (homeWin) => outcomeOf({ homeWin });
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: o(true) }), { result: 'win', profit: 1.5 });
  const w = settleBet({ market: 'moneyline', side: 'away', american: -150, stake: 2, outcome: o(false) });
  assert.equal(w.result, 'win'); assert.ok(Math.abs(w.profit - 4 / 3) < 1e-9);
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: -150, stake: 1, outcome: o(false) }), { result: 'loss', profit: -1 });
  assert.deepEqual(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: outcomeOf({ homeWin: null }) }), { result: 'void', profit: 0 });
});
test('手续费只扣赢注净利', () => {
  assert.ok(Math.abs(settleBet({ market: 'moneyline', side: 'home', american: 150, stake: 1, outcome: outcomeOf({ homeWin: true }), feeOnWin: 0.02 }).profit - 1.47) < 1e-9);
});
test('未实现的市场直接报错（让分 / 大小分本期不做）', () => {
  assert.throws(() => settleBet({ market: 'spread', side: 'home', american: -110, stake: 1, outcome: outcomeOf({ homeWin: true }) }), /未实现的市场/);
  assert.deepEqual(MARKETS, ['moneyline']);
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/betSettlement.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/betSettlement.mjs`：按 `market` 分派到 `settleMoneyline`；NBA 无平局，不实现 push。
- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/betSettlement.test.mjs`
Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/betSettlement.mjs tests/betSettlement.test.mjs
git commit -m "结算：按市场分派（本期只实现独赢盘），胜/负/作废与赢注手续费"
```

### Task 8: 回测引擎——候选、逐注流水、成本与汇总指标

**Files:**
- Create: `server/betBacktest.mjs`
- Test: `tests/betBacktest.test.mjs`

**Interfaces:**
- Consumes: `selectPrice`（Task 3）；`americanToDecimal`, `edgeOf`, `evPerUnit`, `worsenAmerican`, `devigPair`（Task 6）；`settleBet`, `outcomeOf`（Task 7）；策略接口 `pickBet`, `stakeFor`（Task 9，本任务测试用最小桩策略对象，形状同 Task 9）
- Produces:
  - `export const DEFAULT_COSTS = { feeOnWin: 0, slippagePts: 0, maxStake: null }`
  - `buildCandidates(games: Game[], { scenario: 'open' | 'close', book = 'chain', splitOf: (season) => string | null }): { candidates: Candidate[], missing: Record<string, number>, priced: number, total: number }`（`splitOf` 返回 `null` 的赛季不进候选也不计缺失）
  - `runBacktest(candidates: Candidate[], strategy: Strategy, { costs = DEFAULT_COSTS, bankroll0 = 100 } = {}): { ledger: Bet[], summary: Summary }`
  - `summarizeLedger(ledger: Bet[], { bankroll0 = 100 } = {}): Summary`，`Summary = { bets, staked, profit, roi, wins, losses, voids, hitRate, avgDecimal, maxDrawdown: { units, pctOfPeak, days, bets, recovered }, longestLosingStreak, months, profitableMonthShare, curve: [{ date, profit, bankroll }], clv: { n, mean, beatClose } | null }`
  - 引擎规则：按 `date, gameId` 排序；**按日初资金定注**（同日各注都用当日开始时的 bankroll）；决策用报价 `quoted`，结算用滑点后的 `american`；`stake` 先过 `maxStake`；作废注 `stake` 不计入 `staked` 与 ROI 分母；`clv` = 所押一边收盘去水概率 − 下注报价去水概率（无 `closeMl` 或收盘情景下注价即收盘价时为 `null`）；`b2bSide` / `b2bOpp` 按所押一边取 `b2bHome` / `b2bAway`

- [ ] **Step 1: 写失败测试**（Candidate 用小工厂函数造；`flat3` 桩：`{ id: 'B-edge3', family: 'B', minEdge: 0.03 }`）

```js
test('确定性：同一输入两次运行，逐注流水与汇总完全一致', () => { assert.deepEqual(runBacktest(c, flat3), runBacktest(c, flat3)); });
test('决策用报价、结算用滑点后的价', () => {
  const { ledger } = runBacktest([cand({ pHome: 0.45, ml: [150, -170], homeWin: true })], flat3, { costs: { ...DEFAULT_COSTS, slippagePts: 10 } });
  assert.deepEqual([ledger[0].quoted, ledger[0].american, ledger[0].profit], [150, 140, 1.4]);
});
test('作废：profit 0，不计入下注额与 ROI 分母', () => { /* 一注作废 + 一注赢 +1.5 → staked 1、roi 1.5、voids 1 */ });
test('Kelly 按日初资金定注：同日两注各 5% × 100', () => { /* 两场同日 p=0.5 @ +150，D-kelly-full → stake 5 与 5；次日 bankroll 按两注结果 */ });
test('maxStake 截住单注', () => { /* maxStake 3 → Kelly 注 3 */ });
test('summarizeLedger：最大回撤与持续、最长连亏（作废不打断）、盈利月份比例、资金曲线', () => {
  // 逐日 profit [+1, −2, −1, +3]（d1..d4）→ maxDrawdown.units 3、days 3（d1 高点到 d4 收复）、recovered true
  // 结果序列 [win, loss, loss, void, loss, win] → longestLosingStreak 3
  // 1 月 +1、2 月 −1、3 月 +0.5 → profitableMonthShare 2/3
});
test('空流水：不抛错，bets 0、roi null、curve []', () => { assert.deepEqual(summarizeLedger([]).bets, 0); assert.equal(summarizeLedger([]).roi, null); });
test('buildCandidates：缺价按原因计数；splitOf 为 null 的赛季不进', () => { /* 一场无美国公司 → missing.noUsBook 1；2021-22 不进 */ });
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/betBacktest.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/betBacktest.mjs`。`maxDrawdown` 在资金曲线（bankroll）上算：`units` = 峰值 − 谷值，`pctOfPeak` = 回撤 / 峰值，`days` = 峰值日到收复日（未收复则到最后一日，`recovered: false`）的日历天数，`bets` = 期间注数。
- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/betBacktest.test.mjs`
Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/betBacktest.mjs tests/betBacktest.test.mjs
git commit -m "回测引擎：候选与缺价计数、逐注流水（模型/参数版本、价格时点、博彩公司）、成本、资金曲线与回撤连亏等指标"
```

## 第三阶段：策略、切分与选择

### Task 9: 策略 A–D

**Files:**
- Create: `server/betStrategies.mjs`
- Modify: `server/betBacktest.mjs`（改为从本模块导入 `pickBet` / `stakeFor`，去掉 Task 8 的内联桩逻辑）
- Test: `tests/betStrategies.test.mjs`

**Interfaces:**
- Consumes: `edgeOf`, `evPerUnit`, `kellyFraction`（Task 6）
- Produces:
  - `export const STRATEGIES: Strategy[]`，顺序固定（也是并列时的取舍顺序）：`'A-model'`（押模型看好的一方）、`'A-home'`、`'A-favorite'`（押报价更低的一方，平价押主队）、`'B-edge2'`、`'B-edge3'`、`'B-edge5'`、`'B-edge7'`、`'B-edge10'`（`minEdge` 0.02 / 0.03 / 0.05 / 0.07 / 0.10）、`'C-ev'`（EV > 0 且数据质量合格）、`'D-kelly-full'`、`'D-kelly-half'`、`'D-kelly-quarter'`（`mult` 1 / 0.5 / 0.25，`cap` 0.05）
  - `Strategy = { id, family: 'A' | 'B' | 'C' | 'D', pick?: 'model' | 'home' | 'favorite', minEdge?, kelly?: { mult, cap } }`
  - `pickBet(c: Candidate, s: Strategy): { side: 'home' | 'away', edge: number, ev: number } | null`
  - `stakeFor(s: Strategy, { p, american, bankroll, flatStake = 1, cap }): number`（A/B/C 固定 1 单位；D = `bankroll × kellyFraction(p, american, { mult, cap: cap ?? s.kelly.cap })`）
  - 质量门槛（C 专用）：`flags` 不含 `currentAsClose` / `skippedAnomaly` / `bestPrice`，且 `priceAt` 与情景一致（开盘情景 = `open`，收盘情景 = `close`）

- [ ] **Step 1: 写失败测试**

```js
test('B 阈值：edge ≥ 门槛才下（浮点容差），押有正 edge 的一边', () => {
  assert.equal(pickBet(cand({ pHome: 0.42, ml: [150, -170] }), byId('B-edge3')), null);       // edge 0.02
  assert.equal(pickBet(cand({ pHome: 0.42, ml: [150, -170] }), byId('B-edge2')).side, 'home');
  assert.equal(pickBet(cand({ pHome: 0.30, ml: [150, -170] }), byId('B-edge3')).side, 'away'); // 0.70 − 0.6296 = 0.070
});
test('C 正 EV：EV 恰为 0 不下；价格时点不符情景（current 冒充 close）不下', () => {
  assert.equal(pickBet(cand({ pHome: 0.6, ml: [-150, 130] }), byId('C-ev')), null);
  assert.equal(pickBet(cand({ pHome: 0.7, ml: [-150, 130], priceAt: 'current', flags: ['currentAsClose'] }), byId('C-ev')), null);
  assert.equal(pickBet(cand({ pHome: 0.7, ml: [-150, 130], priceAt: 'current', flags: ['currentAsClose'] }), byId('B-edge3')).side, 'home');
});
test('A 基准：模型方 / 主队 / 热门，与价格无关', () => {
  const c = cand({ pHome: 0.4, ml: [-150, 130] });
  assert.deepEqual(['A-model', 'A-home', 'A-favorite'].map((id) => pickBet(c, byId(id)).side), ['away', 'home', 'home']);
});
test('D Kelly：定注 = 资金 × 截后分数；负期望不下', () => {
  assert.equal(stakeFor(byId('D-kelly-quarter'), { p: 0.5, american: 150, bankroll: 100 }).toFixed(4), '4.1667');
  assert.equal(stakeFor(byId('D-kelly-full'), { p: 0.5, american: 150, bankroll: 100 }), 5);
  assert.equal(pickBet(cand({ pHome: 0.35, ml: [150, -170] }), byId('D-kelly-half')), null);
});
test('STRATEGIES 顺序与 id 固定', () => {
  assert.deepEqual(STRATEGIES.map((s) => s.id), ['A-model', 'A-home', 'A-favorite', 'B-edge2', 'B-edge3', 'B-edge5', 'B-edge7', 'B-edge10', 'C-ev', 'D-kelly-full', 'D-kelly-half', 'D-kelly-quarter']);
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/betStrategies.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/betStrategies.mjs`；B/C/D 两侧各算 edge，取 edge 较大且满足条件的一侧（正常抽水下至多一侧为正）；`EPS = 1e-12` 与 `paperBetting.decide` 一致。改 `betBacktest.mjs` 引用。
- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/betStrategies.test.mjs tests/betBacktest.test.mjs`
Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/betStrategies.mjs server/betBacktest.mjs tests/betStrategies.test.mjs
git commit -m "策略：A 基准（模型方/主队/热门）、B edge 2-10%、C 正 EV + 数据质量门槛、D Full/Half/Quarter Kelly（单注上限 5%）"
```

### Task 10: 数据切分、策略选择与多重比较

**Files:**
- Create: `server/betSplits.mjs`
- Test: `tests/betSplits.test.mjs`

**Interfaces:**
- Consumes: `STRATEGIES`（Task 9）
- Produces:
  - `export const SPLITS = { close: { train: ['2022-23'], validate: ['2023-24', '2024-25'], test: ['2025-26'], selectOn: 'validate', previouslySeen: ['2025-26'] }, open: { train: ['2023-24'], validate: ['2024-25'], test: ['2025-26'], selectOn: 'train', previouslySeen: ['2025-26'] }, forward: { train: [], validate: [], test: ['2026-27'], selectOn: null, previouslySeen: [] } }`；`closeBest`（最优价敏感性）沿用 `close` 的切分
  - `splitOf(scenario: string, season: string): 'train' | 'validate' | 'test' | null`
  - `export const SELECTABLE = ['B-edge2', 'B-edge3', 'B-edge5', 'B-edge7', 'B-edge10', 'C-ev']`（固定金额策略才参与选择；A 是对照，D 只比资金管理）
  - `selectStrategy(results: Record<string, { bets: number, roi: number | null }>, { minBets = 100 } = {}): string | null`（ROI 最高且注数 ≥ minBets；并列取 `SELECTABLE` 中靠前者）
  - `export const FORWARD_PRIMARY = 'B-edge3'`（前向账本的预注册主规则 edge3，早于本项目设定）
  - `multipleComparisons(rows: [{ id, split, bets, roi, ci }]): { tried: number, bonferroniAlpha: number, rows }`

- [ ] **Step 1: 写失败测试**

```js
test('切分：收盘 / 开盘 / 前向', () => {
  assert.deepEqual(['2021-22', '2022-23', '2023-24', '2024-25', '2025-26'].map((s) => splitOf('close', s)), [null, 'train', 'validate', 'validate', 'test']);
  assert.deepEqual(['2022-23', '2023-24', '2024-25', '2025-26'].map((s) => splitOf('open', s)), [null, 'train', 'validate', 'test']);
  assert.equal(splitOf('forward', '2026-27'), 'test'); assert.equal(splitOf('closeBest', '2023-24'), 'validate');
});
test('selectStrategy：注数不足的排除，并列取靠前者', () => {
  assert.equal(selectStrategy({ 'B-edge2': { bets: 500, roi: 0.01 }, 'B-edge3': { bets: 300, roi: 0.03 }, 'B-edge5': { bets: 80, roi: 0.08 }, 'C-ev': { bets: 600, roi: 0.03 } }), 'B-edge3');
  assert.equal(selectStrategy({ 'B-edge5': { bets: 80, roi: 0.08 } }), null);
});
test('多重比较：列出全部尝试并给 Bonferroni α', () => {
  const m = multipleComparisons([{ id: 'B-edge2', split: 'validate' }, { id: 'B-edge3', split: 'validate' }, { id: 'C-ev', split: 'validate' }, { id: 'B-edge3', split: 'test' }]);
  assert.equal(m.tried, 4); assert.ok(Math.abs(m.bonferroniAlpha - 0.0125) < 1e-12);
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/betSplits.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/betSplits.mjs`。
- [ ] **Step 4: 运行确认通过**
Run: `node --test tests/betSplits.test.mjs`
Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/betSplits.mjs tests/betSplits.test.mjs
git commit -m "切分与选择：收盘/开盘情景的训练-验证-测试、只在选择期挑固定金额策略、多重比较清单"
```

## 第四阶段：风险与显著性

### Task 11: block bootstrap、分桶、校准、功效分析与结论

**Files:**
- Create: `server/betStats.mjs`
- Test: `tests/betStats.test.mjs`

**Interfaces:**
- Consumes: `rng`（`server/fusionLab.mjs`）；`calibration`（`server/lab.mjs`）；`devigPair`, `breakEven`（Task 6）；`msg`（`server/messages.mjs`）
- Produces:
  - `blockBootstrap(ledger: Bet[], { by = 'day', B = 2000, seed = 7 }: { by?: 'day' | 'season' }): { roi: { lo, hi }, realizedEdge: { lo, hi }, blocks: number } | null`（按块有放回重抽，ROI = Σprofit / Σstake，`realizedEdge` = 命中率 − 平均盈亏平衡概率；作废注不参与；空流水返回 `null`）
  - `designEffect(ledger, opts): number`（按日 bootstrap 的 ROI 方差 / 按注 iid bootstrap 方差，同 seed）
  - `export const BUCKETS = { odds: [[-Infinity, -200], [-200, -100], [100, 200], [200, Infinity]] /* 美式，按所押价 */, edge: [0, 0.02, 0.03, 0.05, 0.07, 0.10, Infinity], prob: [0, 0.4, 0.5, 0.6, 0.7, 1.0001], phase: [['early', 0, 10], ['mid', 10, 40], ['late', 40, Infinity]] /* teamGp，同 scripts/backtest.mjs PHASES */ }`；`homeAway`：home / away；`b2b`：side / opp / both / neither
  - `bucketRoi(ledger, dim: 'odds' | 'edge' | 'prob' | 'homeAway' | 'b2b' | 'phase', { B = 1000 } = {}): [{ key, n, roi, hitRate, ci }]`
  - `calibrationVsMarket(candidates: Candidate[]): { n, model: { brier, logloss }, market: { brier, logloss }, reliability: { model: Bin[], market: Bin[] } }`（同一批比赛；市场概率 = 所选价两侧去水；`Bin` 同 `lab.calibration`）
  - `betsNeeded({ sd, roi, deff = 1, alpha = 0.05, power = 0.8 }): number | null`（`ceil(deff·((z_{1−α/2} + z_power)·sd/roi)²)`，`roi ≤ 0` 返回 `null`；z 值写常量 1.959964、0.841621）
  - `export const MIN_BETS = 300`
  - `mlVerdict({ bets, ci }: { bets: number, ci: { lo, hi } | null }): { code, params }`：`ci.lo > 0 && bets ≥ 300` → `srv.ml.verdict.evidence`；`bets < 300` → `srv.ml.verdict.tooFew`（仍是「无证据」）；否则 `srv.ml.verdict.noEvidence`；params `{ bets, roi, lo, hi, min: 300 }`

- [ ] **Step 1: 写失败测试**

```js
test('blockBootstrap 按日：同日注单一起被抽', () => {
  // A 日两注 +1/+1（stake 1），B 日两注 −1/−1 → 每次重抽 ROI ∈ {−1, 0, 1}
  const r = blockBootstrap(ledger, { by: 'day', B: 500 });
  for (const v of [r.roi.lo, r.roi.hi]) assert.ok([-1, 0, 1].includes(v));
  assert.deepEqual(blockBootstrap(ledger, { by: 'day', B: 500 }), r);     // 固定种子可复现
  assert.equal(blockBootstrap([], {}), null);
});
test('全赢：区间退化为点', () => { const r = blockBootstrap(allWin, { by: 'day', B: 200 }); assert.deepEqual([r.roi.lo, r.roi.hi], [1.5, 1.5]); });
test('betsNeeded：sd 1、ROI 5% → 3140 注；设计效应 2 → 6280；ROI ≤ 0 → null', () => {
  assert.equal(betsNeeded({ sd: 1, roi: 0.05 }), 3140); assert.equal(betsNeeded({ sd: 1, roi: 0.05, deff: 2 }), 6280); assert.equal(betsNeeded({ sd: 1, roi: -0.01 }), null);
});
test('mlVerdict：下界 > 0 且 ≥ 300 注才是 evidence', () => {
  assert.equal(mlVerdict({ bets: 300, ci: { lo: 0.001, hi: 0.05 } }).code, 'srv.ml.verdict.evidence');
  assert.equal(mlVerdict({ bets: 299, ci: { lo: 0.001, hi: 0.05 } }).code, 'srv.ml.verdict.tooFew');
  assert.equal(mlVerdict({ bets: 1000, ci: { lo: -0.01, hi: 0.03 } }).code, 'srv.ml.verdict.noEvidence');
  assert.equal(mlVerdict({ bets: 0, ci: null }).code, 'srv.ml.verdict.tooFew');
});
test('bucketRoi：每桶 n 之和 = 非作废注数；键齐全', () => { /* edge 桶键 ['0-2','2-3','3-5','5-7','7-10','10+'] */ });
test('calibrationVsMarket：市场概率用同一价两侧去水', () => { /* 单场 [-150,130] → 市场 p 0.5798319 */ });
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/betStats.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/betStats.mjs`；分位取法与 `fusionLab.bootstrapCI` 一致（`floor(0.025B)`、`ceil(0.975B) − 1`）。`srv.ml.verdict.*` 三个码同时加进 `zh.js` / `en.js`（`srv.ml.verdict.evidence`：「测试期 {bets} 注、ROI {roi, pct1}（95% 区间 [{lo, pct1}, {hi, pct1}]）：有证据表明能赢盘口——仍需前向账本确认」/ "Test period: {bets} bets, ROI {roi, pct1} (95% CI [{lo, pct1}, {hi, pct1}]): evidence the model beats the market — still needs the live ledger to confirm"；`noEvidence`：「…：无证据表明模型能赢盘口」/ "…: No evidence the model beats the market"；`tooFew`：「仅 {bets} 注，少于 {min} 注的结论门槛：无证据表明模型能赢盘口」/ "Only {bets} bets, below the {min}-bet threshold: No evidence the model beats the market"）。
- [ ] **Step 4: 运行确认通过**
Run: `npm test`
Expected: `# fail 0`（含「服务端出现的每个消息码在所有语言里都有」）
- [ ] **Step 5: 提交**
```bash
git add server/betStats.mjs tests/betStats.test.mjs web/src/i18n/locales/zh.js web/src/i18n/locales/en.js
git commit -m "风险与显著性：按比赛日/赛季 block bootstrap、分桶 ROI、模型 vs 去水市场校准、功效分析与预先写定的结论规则"
```

### Task 12: 一次请求的完整视图与前向账本适配

**Files:**
- Create: `server/moneylineView.mjs`
- Test: `tests/moneylineView.test.mjs`

**Interfaces:**
- Consumes: `buildCandidates`, `runBacktest`, `DEFAULT_COSTS`（Task 8）；`STRATEGIES`（Task 9）；`SPLITS`, `splitOf`, `FORWARD_PRIMARY`, `multipleComparisons`（Task 10）；Task 11 全部；`ledgerRows`、`openLedger`（测试用临时库）；`msg`, `codedError`
- Produces:
  - `export const SCENARIOS = ['close', 'open', 'closeBest', 'forward']`；`export const SLIPPAGE_OPTIONS = [0, 5, 10]`
  - `validateFilters(body: object, data: Report | null): Filters`，`Filters = { scenario, split: 'train' | 'validate' | 'test' | 'all', season: string | null, from: string | null, to: string | null, book: 'chain' | string, strategy: string, slippagePts: 0 | 5 | 10, feeOnWin: number }`；非法值 `throw codedError('err.badFilter', '筛选条件不合法', { field })`；默认 `scenario 'close'`、`split 'test'`、`book 'chain'`、`strategy` = `data.selected[scenario]`（前向为 `FORWARD_PRIMARY`）、成本 0
  - `forwardCandidates(rows: PaperBetRow[], { run = 'early' }: { run?: 'early' | 'late' }): { candidates: Candidate[], pending: number }`（早 = `rule === 'edge0'` 行，晚 = `rule === 'edge3-late'` 行，每场一行；`model_p_home` 原样；`priceAt 'current'`、`books ['draftkings','draftkings']`、`closeMl` 来自 `close_*_ml`；`settled_at` 为空的计入 `pending` 不进候选；`modelVersion 'production-logged'`、`paramsVersion 'production'`、`split 'test'`、`season '2026-27'`）
  - `moneylineView(data: Report, filters: Filters, { forward?: { candidates, pending } } = {}): View`，`View = { filters, labels: { modelVersion, historical: boolean, previouslySeen: boolean, priceScenario }, coverage: { total, priced, missingRate, missing, pending? }, strategy, summary, ci: { day, season }, strategies: [{ id, family, bets, roi, ci, selectable }], selected, buckets, calibration, power: { sd, deff, needed, neededAt: { '0.01', '0.02', '0.03' } }, multipleComparisons, warnings: Msg[], verdict: Msg, bets: Bet[] /* 最近 200 注 */ }`
  - 警告码：`srv.ml.warn.closingPrice`（收盘价情景：不代表更早决策时能成交）、`srv.ml.warn.previouslySeen`（收盘 / 开盘情景测试期 2025-26 已被看过）、`srv.ml.warn.missingPrices` `{ rate }`（缺失率 > 0）、`srv.ml.warn.currentAsClose` `{ n }`、`srv.ml.warn.smallSample` `{ bets, need }`（< 300）、`srv.ml.warn.bestPrice`（最优价情景：事后挑价、有利偏差、不进主结论）、`srv.ml.warn.inSample`（筛选含训练期 2022-23 样本内参数）

- [ ] **Step 1: 写失败测试**

```js
test('默认：收盘情景、测试期、选定策略；带「收盘价」「已被看过」警告与结论码', () => {
  const v = moneylineView(tinyReport, validateFilters({}, tinyReport));
  assert.deepEqual([v.filters.scenario, v.filters.split, v.strategy, v.labels.previouslySeen, v.labels.modelVersion], ['close', 'test', tinyReport.selected.close, true, 'replay-elo-wf']);
  const codes = v.warnings.map((w) => w.code);
  for (const c of ['srv.ml.warn.closingPrice', 'srv.ml.warn.previouslySeen', 'srv.ml.warn.smallSample']) assert.ok(codes.includes(c));
  assert.match(v.verdict.code, /^srv\.ml\.verdict\./);
});
test('缺价警告带缺失率；最优价情景带 bestPrice 警告', () => { /* tinyReport 里 1/4 场无美国公司 → rate 0.25 */ });
test('validateFilters：非法情景 / 策略 / 滑点报 err.badFilter', () => {
  assert.throws(() => validateFilters({ scenario: 'spread' }, tinyReport), (e) => e.code === 'err.badFilter' && e.params.field === 'scenario');
  assert.throws(() => validateFilters({ slippagePts: 7 }, tinyReport), (e) => e.code === 'err.badFilter');
});
test('筛选到 0 注：不抛错，summary.bets 0，结论 tooFew', () => { /* from = to = 没有比赛的日期 */ });
test('前向账本：只取已结算的早规则行，未结算计 pending；概率原样、模型版本 production-logged', () => {
  // 临时库：fs.mkdtempSync(path.join(os.tmpdir(), 'ml-fwd-')) + openLedger(tmp)；insertBets 三场（captureRows 造），settleBets 结算两场
  // 断言：candidates.length 2、pending 1、candidates[0].pHome === 行里的 model_p_home、modelVersion 'production-logged'
  // moneylineView(tinyReport, validateFilters({ scenario: 'forward' }, tinyReport), { forward }) 的 strategy === 'B-edge3'、labels.historical === false
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/moneylineView.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/moneylineView.mjs`：`data.games` → 按 `filters.season/from/to/split` 过滤 → `buildCandidates`（`closeBest` 即 `close` + `book: 'best'`）→ 对全部 `STRATEGIES` 跑 `runBacktest`（同一成本）→ 所选策略做 bootstrap / 分桶 / 功效；`power.sd` = 所选策略逐注 profit 的标准差（stake 1），`deff` = `designEffect`，`neededAt` 给假设 ROI 1% / 2% / 3% 的注数。消息码与 `err.badFilter` 的中英文同时加进 `zh.js` / `en.js`（英文直白，例如 closingPrice → "Simulated at closing prices. It does not show what could have been bet earlier in the day."）。
- [ ] **Step 4: 运行确认通过**
Run: `npm test`
Expected: `# fail 0`
- [ ] **Step 5: 提交**
```bash
git add server/moneylineView.mjs tests/moneylineView.test.mjs web/src/i18n/locales/zh.js web/src/i18n/locales/en.js
git commit -m "独赢盘视图：筛选校验、全部策略对比、所选策略的区间/分桶/校准/功效、警告与结论；前向账本按记录原样接入"
```

### Task 13: 生成脚本与可复现性

**Files:**
- Create: `server/moneylineReport.mjs`, `scripts/moneyline-backtest.mjs`
- Modify: `package.json`（`"ml:backtest": "node scripts/moneyline-backtest.mjs"`）
- Test: `tests/moneylineReport.test.mjs`

**Interfaces:**
- Consumes: `walkForward`, `MODEL_VERSION_REPLAY`（Task 4）；`auditSeason`（Task 2）；`compactBooks`（Task 3）；`moneylineView`, `validateFilters`（Task 12）；`selectStrategy`, `SELECTABLE`, `SPLITS`（Task 10）
- Produces:
  - `buildMoneylineReport({ dataset, books: Record<season, booksJson>, inputsSha: object }): Report`，`Report = { version: 1, inputs, fits, integrity: Audit[], games: Game[], selected: { close: string | null, open: string | null }, selection: { close: rows, open: rows }, headline: { close: View 摘要, open: View 摘要 }, perBook: [{ book, season, scenario, bets, roi, ci, coverage }], slippage: [{ scenario, slippagePts, bets, roi, ci }] }`（**不含** `builtAt`；脚本写文件时另加 `builtAt`）
  - 选择：`selected[scenario] = selectStrategy(各 SELECTABLE 策略在 SPLITS[scenario].selectOn 期的 { bets, roi })`，写进文件后视图与报告只读它，测试期不再挑
  - `data/moneyline-backtest.json`（gitignore 已覆盖 `data/*.json`）

- [ ] **Step 1: 写失败测试**

```js
test('buildMoneylineReport：同一输入两次结果逐字节一致（逐注流水与 ROI 可复现）', () => {
  const a = JSON.stringify(buildMoneylineReport(fixture)); const b = JSON.stringify(buildMoneylineReport(fixture));
  assert.equal(a, b);
});
test('选择只看选择期：改动测试期比分不改变 selected', () => { /* fixture 深拷贝，2025-26 结果全翻 → selected 不变，headline 变 */ });
test('games 方向已对齐我们的主客，2021-22 不出现', () => { /* fixture 含一场 ESPN 主客相反的比赛 */ });
```
`fixture` 用真实 `data/backtest.json` 的两季子集 + `tests/fixtures/` 下手写的小份 books（不读 `data/history`，测试不依赖未跟踪文件）。

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/moneylineReport.test.mjs`
Expected: FAIL，`ERR_MODULE_NOT_FOUND`
- [ ] **Step 3: 实现** `server/moneylineReport.mjs` 与 `scripts/moneyline-backtest.mjs`（只读 `data/backtest.json`、`data/history/books_*.json`，算 sha256，写 `data/moneyline-backtest.json`，控制台打印：每季拟合参数 vs 默认、完整性摘要（覆盖率 / 缺失率 / 异常数）、两个情景的选定策略、测试期所选策略的 `{bets, roi, ci.day}` 与结论、0 / 5 / 10 点滑点）。不发任何网络请求。
- [ ] **Step 4: 运行确认通过**
Run:
```bash
node --test tests/moneylineReport.test.mjs
H='const a=require("./data/moneyline-backtest.json");delete a.builtAt;console.log(require("crypto").createHash("sha256").update(JSON.stringify(a)).digest("hex"))'
npm run ml:backtest && node -e "$H" > "$SCRATCH/h1" && npm run ml:backtest >/dev/null && node -e "$H" > "$SCRATCH/h2" && diff "$SCRATCH/h1" "$SCRATCH/h2" && echo 可复现
```
Expected: PASS；脚本打印上述摘要；最后输出 `可复现`（两次生成去掉 `builtAt` 后哈希相同）。
- [ ] **Step 5: 提交**
```bash
git add server/moneylineReport.mjs scripts/moneyline-backtest.mjs package.json tests/moneylineReport.test.mjs tests/fixtures
git commit -m "独赢盘回测生成脚本：walk-forward 概率 × 美国公司价格 → data/moneyline-backtest.json；策略只在选择期选定并写死"
```

## 第五阶段：接口与页面

### Task 14: 接口、worker 与缓存

**Files:**
- Modify: `server/worker.mjs`（`HANDLERS.labMoneyline`）, `server/index.mjs`（启动时读 `moneyline-backtest.json`；`runLab` 兜底分支；两个路由）, `web/src/lib/api.js`
- Test: `tests/moneylineApi.test.mjs`

**Interfaces:**
- Consumes: `validateFilters`, `moneylineView`, `forwardCandidates`, `SCENARIOS`, `SLIPPAGE_OPTIONS`（Task 12）；`STRATEGIES`；`SPLITS`；`cached`, `runInPool`（`server/pool.mjs`）；`ledgerRows`
- Produces:
  - `GET /api/lab/moneyline/meta` → `{ available: boolean, builtAt, scenarios, splits: SPLITS, strategies: [{ id, family }], books: string[], seasons: string[], selected, fits, integrity: [{ season, matched, missing, anomalies: number }], forward: { available: boolean, captured: number, pending: number } }`（文件缺失时 `{ available: false, reasonCode: 'srv.ml.reason.noData' }`）
  - `POST /api/lab/moneyline`（`rateLimit({ max: 30 })`）body = `Filters` 的部分字段 → `View`；历史情景走 `cached('labMoneyline', JSON.stringify(filters), () => runLab('labMoneyline', { filters }), { max: 60 })`；`forward` 在主线程算，缓存键 = `paper_bets` 行数 + `MAX(settled_at)`（同 `/api/shadow`）；`ledgerDb` 不可用时 `forward` 返回 `{ available: false, reasonCode }`；非法筛选 `sendError(res, 400, 'err.badFilter', …, { field })`
  - 响应与语言无关（不读 `?lang`），缓存不按语言分裂
  - `api.labMoneylineMeta()`、`api.labMoneyline(body)`

- [ ] **Step 1: 写失败测试**（仿 `tests/serverMessages.test.mjs`「真实进程」用例：临时 `DB_PATH`、`ENABLE_LEADERBOARD=0`、`ENABLE_LEDGER=0`、随机端口）

```js
test('接口：meta 形状；非法情景 400 err.badFilter；前向账本关闭时说明原因', async (t) => {
  // GET /api/lab/moneyline/meta → 200，typeof available === 'boolean'；available 时 scenarios 含 'close','open','closeBest','forward'
  // POST { scenario: 'spread' } → 400，code 'err.badFilter'，params.field 'scenario'
  // POST { scenario: 'forward' } → 200，available false，reasonCode 'srv.reason.ledgerOff'
  // available 时：POST {} 两次 → 第二次与第一次 JSON 相同；POST {} 与 POST {}?lang=en 相同
});
```

- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/moneylineApi.test.mjs`
Expected: FAIL，meta 返回 404
- [ ] **Step 3: 实现**：worker 启动时 `readJson('moneyline-backtest.json')`（与 `labData` 同样各持一份）；`index.mjs` 在 `store` 里放同一份用于 meta 与兜底；`srv.ml.reason.noData` 中英文加进语言文件。
- [ ] **Step 4: 运行确认通过**
Run: `npm test`
Expected: `# fail 0`
- [ ] **Step 5: 本地冒烟**
Run: `ENABLE_LEADERBOARD=0 node server/index.mjs &` 后 `curl -s localhost:<PORT>/api/lab/moneyline/meta | head -c 300` 与 `curl -s -XPOST -H 'content-type: application/json' -d '{}' localhost:<PORT>/api/lab/moneyline | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(v.strategy,v.summary.bets,v.verdict.code,v.warnings.map(w=>w.code))})"`
Expected: `available: true`；第二条打印选定策略、注数、`srv.ml.verdict.*` 与含 `srv.ml.warn.previouslySeen` 的警告列表。结束后 kill 进程。
- [ ] **Step 6: 提交**
```bash
git add server/worker.mjs server/index.mjs web/src/lib/api.js tests/moneylineApi.test.mjs web/src/i18n/locales/zh.js web/src/i18n/locales/en.js
git commit -m "接口：/api/lab/moneyline（worker 计算 + 缓存）与 meta；前向账本只读现算；非法筛选返回 err.badFilter"
```

### Task 15: 模型实验室新标签「模型能否打败市场？」（双语）

**Files:**
- Create: `web/src/pages/LabMoneyline.jsx`, `web/src/components/MiniCharts.jsx`
- Modify: `web/src/pages/Lab.jsx:10-11, 62-69`（`tabs` 加 `'beat'`，渲染 `<MoneylineTab />`）, `web/src/i18n/locales/zh.js`、`en.js`（`lab.tab.beat`、`lab.beat.*`）, `docs/i18n-glossary.md`
- Test: `tests/i18n.test.mjs`（已有：键一致、en 无中文、术语表「避免」列）

**Interfaces:**
- Consumes: `api.labMoneylineMeta`, `api.labMoneyline`（Task 14）；`useI18n`（`t`, `fmt`）、`renderMsg`（`web/src/i18n/msg.js`）；`StatTile`, `DataTable`, `Segmented`, `Loading`, `ErrorBox`（`components/common.jsx`）
- Produces:
  - `export function MoneylineTab({ meta })`（`meta` 为实验室 meta；内部自取 moneyline meta）
  - `MiniCharts.jsx`：`LineChart({ points: [{ date, value }], label })`、`CiBars({ rows: [{ key, label, value, lo, hi }], label })`、`ReliabilityPlot({ model: Bin[], market: Bin[], label })`
  - 键：`lab.tab.beat` = 「模型能否打败市场？」/ "Can the model beat the market?"；`lab.beat.*`（标题、六个顶部指标、四张图标题、筛选标签与选项、两类数据来源标签、明细表列名、空状态）

- [ ] **Step 1: 写失败测试**：先只在 `zh.js` 加 `lab.tab.beat` 与 `lab.beat.*` 全部键（不加 en）。
- [ ] **Step 2: 运行确认失败**
Run: `node --test tests/i18n.test.mjs`
Expected: FAIL，「locales：每种语言的键集合与 zh 一致」列出缺的 en 键
- [ ] **Step 3: 实现**
  - 补 `en.js` 译文。术语表新增行（状态 `待确认`，交用户拍板）：期望值 EV → "expected value (EV)"；优势 Edge → "edge"（避免 "advantage score"）；凯利 → "Kelly"；开盘价 → "opening price"；收盘价 → "closing price"；历史价格情景模拟 → "Historical price simulation"（避免 "historical results, actual returns"）；回撤持续 → "drawdown duration"；最长连亏 → "longest losing streak"；按比赛日区块自助法 → "game-day block bootstrap"；功效分析 → "power analysis"；多重比较 → "multiple comparisons"；训练 / 验证 / 测试期 → "training / validation / test period"；已被看过 → "previously examined"。
  - 页面布局（自上而下）：数据来源条（醒目区分「历史价格情景模拟（重放模型）」与「本季前向账本（决策时点真实价格，线上模型）」；测试期 2025-26 显示「已在此前分析中被看过，不是完全干净的测试」）→ 警告列表（`renderMsg`）→ 结论句（`renderMsg(view.verdict)`）→ 顶部指标：总投注数、总下注额、净利润、ROI（带按日区间）、胜率、最大回撤（含持续天数）、平均 CLV（收盘情景显示「不适用」）→ 四张图：累计资金曲线、策略 ROI 比较（带区间，标出选定策略与 A 基准）、Edge 区间 vs 实际 ROI、校准图（模型 vs 去水市场）→ 分桶表（赔率 / 概率 / 主客 / 背靠背 / 赛季阶段）→ 功效分析一句（「按观测方差，达到显著约需 N 注」）→ 多重比较清单 → 逐注明细（最近 200 注：日期、对阵、方向、价格时点、博彩公司、p_model、赔率、下注额、结果、净利润、CLV、模型 / 参数版本）。
  - 筛选（`Segmented` / `select`）：模型版本（重放模型 / 线上模型，决定可选情景）、价格情景（开盘 / 收盘 / 最优价敏感性 / 本季前向账本）、数据切分（训练 / 验证 / 测试 / 全部，默认测试）、赛季、日期起止、博彩公司（选择链 / 单家 / 最优价）、策略（默认选定策略）、滑点（0 / 5 / 10 点）。
  - 不显示任何让分 / 大小分入口。
- [ ] **Step 4: 运行确认通过**
Run: `npm test && npm run check:i18n && npm run build`
Expected: `# fail 0`；`i18n 中文残留检查通过`；vite build 成功
- [ ] **Step 5: 浏览器核对** `npm run dev`，打开 `#/lab` →「模型能否打败市场？」：默认收盘情景测试期、选定策略，数据来源条与「已被看过」警告可见；切到前向账本，标签变为线上模型，本地无账本时显示不可用原因；`?lang=en` 下执行 `[...document.body.innerText.matchAll(/[㐀-鿿＀-￯　-〿]+/g)].map((m) => m[0])`。
Expected: 中英两版数字一致；英文版中文残留只有语言切换按钮「中文」。
- [ ] **Step 6: 提交**
```bash
git add web/src/pages/LabMoneyline.jsx web/src/components/MiniCharts.jsx web/src/pages/Lab.jsx web/src/i18n/locales/zh.js web/src/i18n/locales/en.js docs/i18n-glossary.md
git commit -m "模型实验室新标签「模型能否打败市场？」：默认测试期、区分历史价格情景与本季前向账本、缺价警告、中英双语"
```

## 第六阶段：文档与上线

### Task 16: 技术说明（含开源库与商业产品附录）

**Files:**
- Create: `docs/moneyline-backtest-technical.md`

**Interfaces:**
- Consumes: Task 1–15 的模块与常量
- Produces: 技术说明（中文）

- [ ] **Step 1: 写正文**：模块与数据流（`books_*.json` → `compactBooks` → `walkForward` → `buildMoneylineReport` → `data/moneyline-backtest.json` → worker `moneylineView` → 页面；`paper_bets` → `forwardCandidates`）；公式（盈亏平衡、去水、edge、EV、Kelly、滑点、ROI = 总净利润 / 总下注额、CLV、realized edge、block bootstrap、功效分析）；选价链与时点标记；切分表（两情景 + 前向）与选择规则；成本假设与默认值；结论规则原文；已知局限（无报价时间戳与开赛时间、2021-22 / 2022-23 几乎只有 current、2024-25 只有 ESPN BET、2025-26 起只有 DK、重放模型 ≠ 线上模型）。
- [ ] **Step 2: 附录核实**：逐个打开研究文档第 3 节的四个仓库（BacktestBuddy、flumine、betanalysis、betting-backtester）与五个产品网站（OddsJam、Unabated、Rithmm、Betaminic、Pikkit），记录：可访问性、最近提交 / 维护、许可证（以仓库 LICENSE 文件为准）、运行环境、功能覆盖、测试情况、是否依赖真实投注账户、可借鉴的接口或测试、结论（「只借鉴，不移植、不新增依赖」）。打不开或查不到的写「未能核实」，不猜。
- [ ] **Step 3: 提交**
```bash
git add docs/moneyline-backtest-technical.md
git commit -m "独赢盘回测技术说明：模块、数据流、公式、切分、假设；附开源库与商业产品核实表"
```

### Task 17: 真实回测报告与 README

**Files:**
- Create: `docs/moneyline-backtest-report.md`
- Modify: `README.md`（「对标博彩盘口」节末加「独赢盘回测」小节）, `docs/paper-betting-verdict.md`（末尾追加一行带日期的指向说明，不改原文）

**Interfaces:**
- Consumes: `data/moneyline-backtest.json`（Task 13）、`docs/replay-same-day-fix-output.txt`（Task 1）、`docs/ats-491-audit-output.txt`（Task 5）、本地 `/api/lab/moneyline` 前向账本视图（线上账本不可查时注明只用到截至部署时的行数，部署后在 Task 18 补线上数）

- [ ] **Step 1: 生成数字**：`npm run ml:backtest | tee "$SCRATCH/ml-backtest.txt"`；对两情景各取训练 / 验证 / 测试的全部策略表、选定策略、测试期结论、0 / 5 / 10 点滑点、按博彩公司覆盖率与结果、最优价敏感性、分桶、校准（模型 vs 市场 Brier / LogLoss）、功效分析、每季拟合参数 vs 生产参数。
- [ ] **Step 2: 写报告**，每条结论标三级证据之一：「README 记载」/「已复现」（附命令与输出文件）/「待验证」。必须包含：
  - 六个问题逐一作答：有没有正向 Edge；哪个市场最有潜力（只评估了独赢盘；让分没有历史价格、大小分只有单家单时点，为何未评估）；哪种策略 ROI 最高（只在选择期选、测试期报告）；扣费用 / 滑点后是否仍盈利；证据是否足以支持真实资金（按预先写定的规则）；还需多少样本（功效分析）。
  - 同日泄漏修复前后对比（预期为零差异及原因）；49.1% 的口径复核；66% 胜负命中率为什么不等于盈利。
  - 收盘情景测试期 2025-26「已在此前分析中被看过」的声明；开盘情景样本小照实写；前向账本单列，注数 < 300 时直接写「无证据，样本不足」。
  - 多重比较清单与 Bonferroni α；walk-forward 拟合参数与生产参数的差异——若显示生产参数应调整，写成「单独上报」一节，不在本项目改线上。
- [ ] **Step 3: README**：新增「独赢盘回测」小节（3–6 行：做了什么、结论一句、指向报告与技术说明、`npm run ml:backtest`）；若 Task 1 有数字变化，此处已在 Task 1 更新，不重复。
- [ ] **Step 4: 提交**
```bash
git add docs/moneyline-backtest-report.md README.md docs/paper-betting-verdict.md
git commit -m "独赢盘回测报告：三级证据、六个问题、修复前后对比、49.1% 复核、预先写定的结论标准"
```

### Task 18: 上线

**Files:**
- Modify: `deploy/README.md`（「模拟投注」节后加「独赢盘回测」：`npm run ml:backtest` 本机生成、`scp data/moneyline-backtest.json` 上线、之后随 `refresh.sh` 保留）, `docs/HANDOFF-2026-10-27.md`（上线记录）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无

- [ ] **Step 1: 上线前确认**：把将要上线的提交列表与 `git diff <线上 commit>..HEAD --stat` 给用户看，**得到用户明确同意再继续**。线上 commit 以 `docs/HANDOFF-2026-10-27.md` 最近一次上线记录为准，不确定就问。
- [ ] **Step 2: 时间窗**
Run: `TZ=Asia/Shanghai date +%H:%M`
Expected: 不在 21:30–22:30、06:00–07:00、14:00–15:00 之内；否则等。
- [ ] **Step 3: 回滚点与数据库备份**
```bash
npm test && npm run build
git tag pre-ml <线上 commit> && git push origin pre-ml
ssh dev@gpu.tzspace.cn 'docker tag dc-nba-dc-nba:latest dc-nba-dc-nba:pre-ml'
# KEEP 设大：backup-db 会按 /^app-.*\.db$/ 清理同目录旧文件，keep/ 里已有的 app-pre-*.db 不能被清掉
ssh dev@gpu.tzspace.cn 'docker exec -e KEEP=100000 dc-nba node scripts/backup-db.mjs /app/data-db/backups/keep && docker exec dc-nba sh -c "cd /app/data-db/backups/keep && mv \"\$(ls -t app-2*.db | head -1)\" app-pre-ml.db && ls -la"'
ssh dev@gpu.tzspace.cn "docker exec dc-nba node -e \"const D=require('node:sqlite').DatabaseSync;const d=new D('/app/data-db/app.db',{readOnly:true});console.log(['paper_bets','shadow_predictions','shadow_rr_predictions'].map(t=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join(', '))\""
```
Expected: 标签已推送；镜像标签存在；`keep/` 下出现 `app-pre-ml.db` 且原有 `app-pre-i18n.db` 等仍在；记下三张表行数。
- [ ] **Step 4: 发代码与数据**
```bash
git archive HEAD server scripts deploy web docs package.json package-lock.json Dockerfile .dockerignore README.md | ssh dev@gpu.tzspace.cn 'tar -x -m -C /home/dev/work/works/dc-nba'
scp data/moneyline-backtest.json dev@gpu.tzspace.cn:/home/dev/work/works/dc-nba/data/
ssh dev@gpu.tzspace.cn 'cd /home/dev/work/works/dc-nba && deploy/refresh.sh --espn'
```
Expected: 健康检查通过。不跑 `push-refresh.sh`（会请求 stats.nba.com）。
- [ ] **Step 5: 线上核对**
Run: `curl -s https://ai.tzspace.cn/works/dc-nba/api/lab/moneyline/meta | head -c 400`；`ssh dev@gpu.tzspace.cn 'grep -n ENABLE_LEADERBOARD /home/dev/work/works/dc-nba/docker-compose.yml'`；重跑 Step 3 的行数命令；浏览器打开 `/works/dc-nba/#/lab` 与 `?lang=en`。
Expected: `available: true`；`ENABLE_LEADERBOARD: "1"` 未被覆盖；`data-db/` 未动；三张表行数只按定时任务变化；新标签中英文正常、前向账本视图有数（线上开启账本）。
- [ ] **Step 6: 记录并提交**：`docs/HANDOFF-2026-10-27.md` 加「独赢盘回测已上线」：时间、回滚点（git `pre-ml`、镜像 `dc-nba-dc-nba:pre-ml`）、备份 `data-db/backups/keep/app-pre-ml.db`、行数前后；线上前向账本的注数与结论补进 `docs/moneyline-backtest-report.md` 的前向一节。
```bash
git add deploy/README.md docs/HANDOFF-2026-10-27.md docs/moneyline-backtest-report.md
git commit -m "交接文档：独赢盘回测已上线，回滚标签 pre-ml、DB 备份路径、前向账本线上数字"
```

---

## Self-Review

1. **Spec 覆盖：** 底层修复 1 同日泄漏 → Task 1；2 walk-forward → Task 4；3 概率校准 → Task 4（拟合）+ Task 11（Brier / LogLoss / 可靠性）；4 价格时点与选择链 → Task 3（含「审阅后补充」1：美国公司、固定优先级、最优价只作敏感性、按博彩公司覆盖率 → Task 2 / 13 `perBook`）；5 完整性 → Task 2；6 复核 49.1% → Task 5。独赢盘回测（换算、去水、edge、EV、结算、逐注字段、汇总指标、成本、可复现）→ Task 6–8、13。策略 A–D 与切分（含补充 2：已被看过、开盘情景样本小、前向单列）→ Task 9、10。风险与显著性（按日 / 按季 bootstrap、分桶、校准、样本量与功效、多重比较）→ Task 10、11。结论标准（补充 5）→ Task 11 `mlVerdict`、Task 12。两模型不合并（补充 4）→ Task 4 / 12 `modelVersion` 与页面模型筛选。重放修复范围（补充 3：全局、`backtest.json`、README、差异进报告）→ Task 1、17。页面 → Task 14、15。报告与附录 → Task 16、17。约束（不联网、worker、缓存、只追加、部署）→ Global Constraints、Task 1 Step 1 离线护栏、Task 14、18。
2. **步骤扫描：** 每个代码步骤给出文件、签名与 spec 数值；测试步骤给出用例名与断言；无 TBD。报告类任务（16、17）以「必须包含」清单代替测试。
3. **类型一致：** `Game` / `Price` / `Candidate` / `Bet` / `Summary` / `Filters` / `View` 形状在 File Structure 定义并在各任务沿用；`selectPrice`、`buildCandidates`、`runBacktest`、`pickBet`、`stakeFor`、`splitOf`、`selectStrategy`、`blockBootstrap`、`mlVerdict`、`validateFilters`、`moneylineView`、`forwardCandidates`、`buildMoneylineReport` 名称前后一致；策略 id 全计划统一（`B-edge3` 等）。
4. **Review Focus：** 五条各有归属测试（Task 3 翻转与顺延、Task 8 空流水与 Kelly 日初资金、Task 7 / 12 作废与待结算）。
5. **比例：** 只给签名、测试名与断言；函数体留给实现者；唯一给出算法细节的是重放的按日两段式与 Kelly 日初定注（签名决定不了）。

## Spec 中发现的缺口与设计决定（供用户确认）

- **「同日泄漏」在现有数据上没有实际影响。** Elo 更新只改本场两队，五季数据里没有球队同日出场两次（已逐季核对为 0）；`fusionLab` 早已按日批量且被测试锁定与 `lab.replay` 一致。Task 1 仍按 spec 做结构性修复并用哈希证明新旧一致；README 数字预计不变，`data/backtest.json` 是数据集、本来就不受影响。同结构的 `server/replay.mjs`（人机对赌题库）、`rosterReplay`、生产赛前 Elo 不改，只在记录里上报。
- **2022-23 没有可用于拟合的此前重放季**（2020-21 不在数据集里）：计划把它定为「训练期、样本内参数」，收盘情景的策略选择改在验证期 2023-24～2024-25 上做。
- **选择链是「先选家、再选时点」**：DK 只有 current 而 ESPN BET 有 close 时用 DK 的 current 并标注（2022-23 因此大多是 current）。若想「先找有 close 的家」，请告知。
- **C（正 EV）与 B 的关系**：EV = 十进制赔率 × edge，所以 EV > 0 ⇔ edge > 0；C 与 B 的区别只在阈值为 0 与数据质量门槛。
- **前向账本的主策略**沿用早已预注册的 edge3（`B-edge3`），而不是用历史回测选出来的策略——它在本项目之前就已冻结，是最干净的对照；其余策略同样列出。晚规则（06:30 价）作为可选口径。
- **概率校准**：主概率用 walk-forward 拟合的正态 SD；逻辑斯蒂只作诊断。`k = 20`、`carryKeep = 0.75` 是外部来源（538），不拟合。
- **滑点按美式赔率点数**，按报价决策、按滑点后价格结算；**最长连亏中作废不打断**；**Kelly 按日初资金定注**，未设「当日总敞口上限」（研究文档提过，spec 未要求；NBA 单日最多 15 场 × 5% < 100%，资金不会为负）——需要的话可加一个配置项。
- **新英文术语**（EV、Kelly、开盘 / 收盘价、历史价格情景模拟、回撤持续、block bootstrap、功效分析、多重比较、已被看过等）在术语表里标「待确认」，需要你拍板。
- **上线**（Task 18）会改线上服务，执行时会先停下请你确认。
