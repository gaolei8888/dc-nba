# 独赢盘回测技术说明

本文描述「模型能否打败市场？」背后的回测代码**现在的样子**。所有常量取自代码，括号里标了出处。
只做独赢盘（moneyline）；让分、大小分不实现，结算与数据结构按 `market` 留口（`MARKETS = ['moneyline']`，`server/betSettlement.mjs`）。

## 1. 模块与数据流

```
data/backtest.json（逐场重放数据集）
        │
        ▼
server/walkForward.mjs  walkForward()   每个测试季只用此前赛季拟合 homeAdv / restWeight / spreadSd，重算概率 pWF
        │
        ▼                         data/history/books_<季>.json（多家公司的 open / close / current 钱线）
server/moneylineReport.mjs  gameOf()  ◄── compactBooks()（server/priceSelect.mjs：只留美国公司、统一主客方向）
        │  buildCandidates()（selectPrice 选价）→ selectForScenario()（只在选择期选策略）
        ▼
scripts/moneyline-backtest.mjs  →  data/moneyline-backtest.json（原子写：先写 .tmp 再 rename）
        │                           npm run ml:backtest；纯离线，fetch 被封死
        ▼
server/moneylineStore.mjs  reportLoader()   按文件 mtime 重读，报告重建后无需重启
        │
        ▼
server/worker.mjs  →  server/moneylineView.mjs  moneylineView()   筛选 → 流水 → 汇总 / 区间 / 分桶 / 校准 / 功效 / 警告 / 结论
        │
        ▼
POST /api/lab/moneyline、GET /api/lab/moneyline/meta（server/index.mjs）→ 模型实验室页面

paper_bets（本季前向账本，只读）→ forwardCandidates()（主线程）→ moneylineView(…, { forward })
```

要点：

- 历史情景在 worker 里算，响应缓存键 = 报告 mtime + 归一化筛选；前向情景在主线程算，缓存键 = 账本指纹（行数、已结算数、最近结算时间、已回填收盘价行数）+ 筛选。
- 前向账本只读：`paper_bets` 只追加的约束不变，本功能不写它。
- 模块分工：`oddsMath`（赔率数学）、`betSettlement`（结算）、`betStrategies`（选边与定注）、`betBacktest`（候选、引擎、汇总）、`betSplits`（切分与选择）、`betStats`（bootstrap、分桶、校准、功效、结论）。均为纯函数，无 I/O、无当前时间；随机数一律 `fusionLab.rng`，seed 7。
- 同一输入重复运行，逐注流水与 ROI 完全一致；报告里唯一的时间戳是 `builtAt`，比较可复现性时先去掉它。
- 底层修复：重放时同一比赛日先算完当日全部赛前预测再统一更新 Elo（修复同日泄漏），全局生效。

## 2. 两种模型，分开报告

| | 模型 | `modelVersion` | 概率来源 |
|---|---|---|---|
| 历史情景 | 重放模型：Elo + 主场 + 休息，walk-forward 校准 | `replay-elo-wf`（`walkForward.mjs`） | 每季用此前赛季拟合 |
| 前向账本 | 线上生产模型 | `production-logged` | `paper_bets.model_p_home` 按记录原样，不重新校准 |

两者绝不合并；历史视图里混进别的模型版本会直接抛错（`moneylineView.mjs`）。线上模型还含阵容 / 伤病修正，重放模型没有，所以历史结果不代表线上模型。

## 3. walk-forward（裁定 M16）

- 重放模型的分差 = Elo 分差 + 主场优势 + 休息权重 × 休息差；胜率 = Φ(分差 / σ)。
- 固定不拟合：`k = 20`、`carryKeep`（`FIXED_PARAMS`，取自 FiveThirtyEight NBA Elo 方法）。
- 拟合三个数：主场优势、休息权重（无截距 OLS，解 2×2 正规方程）、σ（对数损失最小，黄金分割搜索，区间 [6, 24]，容差 1e-4）。逻辑斯蒂刻度只作诊断。
- **扩展窗口**：测试季 N 用此前所有重放赛季拟合（`present.slice(0, idx)`）。看到近期窗口在样本外略差后，**没有**改成近期或加权窗口，那等于按测试结果选方法。报告 `fits[].calibration` 如实给出 walk-forward 拟合与全局默认值的对比：`fitted`（拟合 σ）、`sd12`（同一组 walk-forward 分差、σ = 12）、`allDefaults`（主场、休息、σ 三项都用全局默认值的原重放）。
- `WF_SEASONS = 2022-23 ~ 2025-26`。2021-22 只作 Elo 预热，没有重放记录；所以 2022-23 没有可用的此前赛季，只能样本内拟合，记为 `in-sample:2022-23`、`inSample: true`，页面会警告。
- 全局默认值（`lab.mjs` `DEFAULTS`）：主场 1.6、休息 1.8、σ 12。
- 本机现有报告里的拟合值（主场 / 休息 / σ）：2022-23 样本内 2.29 / 1.97 / 12.70；2023-24 2.29 / 1.97 / 12.70；2024-25 2.20 / 2.16 / 11.77；2025-26 1.99 / 2.32 / 11.41。休息权重拟合值高于线上的 1.8；**线上参数是否该调不在本项目内改，只上报**。

## 4. 公式

记美式赔率 A，十进制 d，模型胜率 p（所押一边）。

- 十进制：A > 0 时 d = 1 + A/100；A < 0 时 d = 1 + 100/(−A)。有效赔率要求 |A| ≥ 100。
- 盈亏平衡概率：+A → 100/(A+100)；−A → A/(A+100)。
- 去水（双侧按比例）：同一公司、同一时点两侧的盈亏平衡概率 h、a，overround = h + a，公平概率 = h / overround、a / overround。**只用于比较模型与市场谁更准、以及算 CLV，绝不用于结算**。
- edge = p_model − p_break_even（按实际下注价）。
- EV / 单位 = p·(d − 1) − (1 − p)。注意 EV = (p − 盈亏平衡)·d，所以 EV > 0 与 edge > 0 等价。策略 C 与 B 的区别有两处：B 要求 edge 达到最小阈值（2% ~ 10%，`edge ≥ minEdge`），C 没有最小阈值，只要 EV > 0（即 edge > 0，等价于阈值为 0）；C 另有数据质量门槛（`qualityOk`），B 没有。（依据 `betStrategies.mjs` 的 `pickBet`。）
- Kelly：b = d − 1，f* = (b·p − q)/b，q = 1 − p；乘以 1 / 0.5 / 0.25 后截到 [0, 0.05]；f* ≤ 0 返回 0，不做空、无杠杆。
- 滑点：把美式价映射到以 ±100 为原点的一维轴（正价 a → a − 100，负价 a → a + 100），减去点数后映回，越过 ±100 时连续。
- 结算：胜 / 负 / 作废（NBA 无平局）。赢注净利 = stake·(d − 1)·(1 − feeOnWin)，手续费只扣净利；输 = −stake；延期、取消、缺比分、报价非法 → 作废（盈亏 0、本金退回）。比分相等记 `tie_score`，比分方向与 `homeWin` 矛盾记 `score_mismatch`，均作废。
- ROI = 总净利润 / 总下注额；作废注不进分母与命中率。
- CLV = 所押一边收盘去水概率 − 下注报价去水概率。收盘价情景下注价就是收盘价，CLV 记 null（标 `clvAtClose`）；开盘情景缺收盘价时记 null（标 `noCloseForClv`）。
- realized edge = 命中率 − 平均盈亏平衡概率（按实际结算价）。
- block bootstrap（`betStats.mjs`）：按比赛日为块（主）或按赛季为块（辅），有放回重抽 K 块，ROI = Σprofit / Σstake；`B = 2000`，`seed = 7`；区间取排序后第 floor(0.025B) 个与第 ceil(0.975B) − 1 个。按赛季时不足 2 个赛季返回 null（原因 `fewerThan2Seasons`）。分桶 ROI 的区间用 `B = 1000`。
- 设计效应 deff = 按日 block bootstrap 的 ROI 方差 / 按注 iid bootstrap 的 ROI 方差（同 B、同 seed）。
- 功效分析：n = ⌈deff · ((z₀.₉₇₅ + z₀.₈) · σ / μ)²⌉，z₀.₉₇₅ = 1.959964，z₀.₈ = 0.841621（写死，仅支持 α = 0.05、功效 0.8）；σ 为每注 profit/stake 的样本标准差（n − 1，不按注额加权，Kelly 下只是近似）；μ ≤ 0 时 null。页面另给 μ = 1% / 2% / 3% 时所需注数。
- 多重比较：Bonferroni α = 0.05 / 选择期内比较过的不同策略配置数（裁定 M9）。

## 5. 选价链与时点标注（裁定 M15：时点优先）

- 只用美国公司（`US_BOOKS`：draftkings、caesars、betmgm、betrivers、unibet、espnbet、pointsbet、westgate）。Betfair 等交易所不用于定价。
- 公司链 `BOOK_PRIORITY`：draftkings → espnbet → betmgm → caesars → betrivers → unibet → pointsbet → westgate；链外的其余美国公司按字母序补后。
- **先定时点，再沿链找**（不是先定公司）：
  - 收盘情景：沿整条链找合格 close；全链都没有合格 close，才再沿链找 current，并标 `currentAsClose`。
  - 开盘情景：沿整条链找合格 open，不退到 close / current。
  - 某家价格异常（`priceAnomaly`）则顺延到下一家，标 `skippedAnomaly`。
- 全链无价则该场跳过并按原因计缺失：`noUsBook`、`bookAbsent`、`anomaly`、`noOpen`、`noPrice`。
- 每注记录 `priceAt`（open / close / current）与 `book`；同一季内公司会变化（这是 M15 的代价），按公司的覆盖率与结果在报告 `perBook` 里分别给出（一家一季至少 100 场有价才单列）。
- 「挑最优价」`closeBest`：每侧取各家最高十进制赔率（标 `bestPrice`），只作敏感性情景，沿用 close 选出的策略，不给正式结论。
- 主客方向：`compactBooks` 用 `homeAwayStatus` 判定；反向则两侧钱线对调，对不上则丢弃。

## 6. 策略（`betStrategies.mjs`）

| id | 规则 |
|---|---|
| A-model / A-home / A-favorite | 对照：押模型看好的一方 / 押主队 / 押热门（平价押主队） |
| B-edge2 / 3 / 5 / 7 / 10 | 两侧各算 edge，取较大一侧，edge > 0 且 ≥ 2% / 3% / 5% / 7% / 10% |
| C-ev | EV > 0 且数据质量合格（`qualityOk`） |
| D-kelly-full / half / quarter | 同 B 的选边，Kelly 乘数 1 / 0.5 / 0.25，单注上限 5% |

定注：A / B / C 每注恒为 1 单位，不受资金约束（资金曲线只是累计盈亏的记账，可以为负）；D = 日初资金 × 截后 Kelly 分数。初始资金 100。
`qualityOk`：open 情景要求 `priceAt = 'open'`，close 情景要求 `priceAt = 'close'`（current 冒充 close 不行）；不得带 `skippedAnomaly` / `bestPrice`；前向账本要求 `current` 价且记录时间早于开赛时间。

## 7. 成本假设（`DEFAULT_COSTS`、`SLIPPAGE_OPTIONS`）

- 默认全 0：`feeOnWin = 0`（赢注净利的比例，允许 [0, 1)）、`slippagePts = 0`（美式点数）、`maxStake = null`（单注限额）。
- 滑点敏感性取 0 / 5 / 10 点（`SLIPPAGE_OPTIONS = [0, 5, 10]`）。
- 决策（选边、edge、EV、Kelly）用报价；结算用滑点后的价；收益一律按实际价。
- 同日敞口（裁定 M10，只对 Kelly）：D 在一个比赛日各注都用日初资金定注；当日下注总额超过日初资金则按比例缩减（标 `exposureScaled`）；资金耗尽后不再下注。固定金额策略（A / B / C）不受这两条约束，每注恒为 1 单位（`maxStake` 仍适用），否则资金耗尽会截断它们的 ROI 并影响策略选择（最终审阅 I1）。

## 8. 切分与策略选择（`betSplits.mjs`）

| 情景 | 训练 | 验证 | 测试 | 选择依据 |
|---|---|---|---|---|
| 收盘价 close | 2022-23 | 2023-24、2024-25 | 2025-26 | 验证期 |
| 开盘价 open | 2023-24 | 2024-25 | 2025-26 | 训练期（`selectOn: 'train'`） |
| 前向账本 forward | — | — | 本季（应用的目标赛季 `meta.targetSeason`，现为 2026-27；只取比赛日期落在该季的账本行） | 不从历史选 |

- 2021-22 只作 Elo 预热，不属于任何情景。两个价格情景分开报告，不合并。
- 2025-26 在此前的分析中已被看过（`paper-backtest`、49.1%、edge 规则），**不是完全干净的测试**，页面与报告都要注明（`previouslySeen`）。本季（2026-27）前向账本才是干净的检验。
- 选择只看选择期，测试期候选在跑回测前就被丢弃。参选的只有固定金额策略 `SELECTABLE = B-edge2/3/5/7/10、C-ev`（A 是对照，D 只比资金管理）。
- 规则：选择期 ROI 最高且投注数 ≥ `MIN_SELECT_BETS = 100`；并列取靠前者；没有策略达标则 `selected = null`，结论为「无证据」（原因：没有策略合格，裁定 M6、M18）。ROI 最高的规则容易偏向样本稀少的高阈值规则，所以报告同时列出全部候选策略的结果表。
- closeBest 不单独选择，沿用 close 的选择（M6）。
- 前向账本：`FORWARD_PRIMARY = 'ledger-edge3'`——账本自己预注册的 edge3 规则，按记录原样（是否下注、方向、价格），是主结果（M3）；`FORWARD_SECONDARY = 'B-edge3'`——按盈亏平衡重算，只作次要结果、单独标注。预注册规则不能事后重新定义。早规则取 edge0 行的价格与概率；晚规则（`edge3-late`）未作为筛选项暴露。

## 9. 结论规则（预先写定）

规则（`mlVerdict`，`betStats.mjs`）：

1. 投注数 < `MIN_BETS = 300` → 「注数不足」，仍是「无证据」；
2. 否则，按日 block bootstrap 的 95% ROI 区间下界 > 0 → 「有证据」；
3. 其余（含区间为空）→ 「无证据」。

历史测试期与前向账本用同一规则、各用自己的区间，文案按期别区分（裁定 M17）。结论只在两种组合下给出（裁定 M5、M18）：

- 历史情景 + 测试期 + 预选策略 + 默认成本 + 不缩日期 / 公司 / 赛季（`period: 'test'`）；
- 前向 + 账本原样主规则 + 早规则 + 默认成本 + 不缩日期（`period: 'live'`）。

其他任何筛选都显示「探索性、不给结论」。closeBest 不给正式结论。

结论文案原文（`web/src/i18n/locales/zh.js`，`{…}` 为参数）：

- 测试期，有证据：`测试期 {bets} 注、ROI {roi, pct1}（95% 区间 [{lo, pct1}, {hi, pct1}]）：有证据表明模型能赢盘口——仍需前向账本确认`
- 测试期，无证据：`测试期 {bets} 注、ROI {roi, pct1}（95% 区间 [{lo, pct1}, {hi, pct1}]）：无证据表明模型能赢盘口`
- 测试期，注数不足：`测试期仅 {bets} 注，少于 {min} 注的结论门槛：无证据表明模型能赢盘口`
- 测试期，没有策略：`选择期没有任何策略达到选择门槛，测试期没有可检验的策略：无证据表明模型能赢盘口`
- 前向，有证据：`前向账本 {bets} 注、ROI {roi, pct1}（95% 区间 [{lo, pct1}, {hi, pct1}]）：有证据表明模型能赢盘口`
- 前向，无证据：`前向账本 {bets} 注、ROI {roi, pct1}（95% 区间 [{lo, pct1}, {hi, pct1}]）：无证据表明模型能赢盘口`
- 前向，注数不足：`前向账本仅 {bets} 注，少于 {min} 注的结论门槛：无证据表明模型能赢盘口`

英文：`No evidence the model beats the market`。「无证据」时给功效分析（达到显著还需多少注）。

## 10. 已知局限

1. **没有报价采集时间戳，也没有历史开赛时间。** 历史价只能标「open / close / current」三个时点，无法证明某个价格在决策时刻真的可成交。收盘价情景明确写「以收盘价模拟，不代表更早决策时能成交」。只有前向账本带记录时间与开赛时间，是唯一真正「决策时点可得」的价格，但样本小。
2. **2021-22 与 2022-23 几乎只有 current。** 本机缓存统计：2021-22 的 1230 场所有报价都只有 current（没有 open / close），该季只作 Elo 预热，不进任何情景；2022-23 美国公司里只有 ESPN BET 有 close（1168 场），其余公司只有 current，且 2022-23 同时是 walk-forward 的样本内季。
3. **2024-25 只有 ESPN BET**（1230 场）。
4. **2025-26：DraftKings 973 场、ESPN BET 299 场**，其余公司没有。本文起草时的任务说明写「2025-26 起只有 DraftKings」，按本机缓存实际数据并不准确，以此处为准。前向账本（2026-27）只有 DraftKings。
5. **重放模型 ≠ 线上模型**（无阵容 / 伤病修正）；历史结果不能直接外推到线上。
6. 2025-26 已被看过，不是干净测试；干净的检验只有 2026-27 前向账本，且样本小。
7. 开盘情景只有 2023-24 起有 open；样本小。按赛季 bootstrap 在测试期只有一个赛季时没有意义。
8. 同一季内公司会变（M15 的代价）；公司的报价口径差异没有校正。
9. 功效分析的 σ 不按注额加权，Kelly 下只是近似。
10. 数据来源都是本机缓存（`data/` 不入库）；表中覆盖数字来自缓存文件，重新抓取会变。
11. 让分、大小分未评估。

## 附录：开源库与商业产品核实

核实日期 2026-10-28。方法：用 WebFetch 对每个页面各发一次请求（仓库首页、commits 页、LICENSE 原文），不绕过任何拦截。「最近提交」取自仓库 commits 页。许可证以 LICENSE 文件为准（取前三行）。**没有克隆仓库、没有运行任何代码，所以「测试情况」只表示仓库里能看到测试目录与 CI，不代表测试通过。**

### 开源仓库

| 项 | BacktestBuddy | flumine | betanalysis | betting-backtester |
|---|---|---|---|---|
| 地址 | github.com/Pacman1984/backtestbuddy | github.com/betcode-org/flumine | github.com/austinbyron/betanalysis | github.com/R1ch1k/betting-backtester |
| 可访问 | 是（公开） | 是（公开） | 是（公开） | 是（公开） |
| 最近提交 | 2026-10-28 | 2026-10-19 | 2026-10-04 | 2026-04-19 |
| 许可证（LICENSE 文件） | MIT，Copyright 2024 Pacman1984 | MIT，Copyright 2026 Liam Pauling | MIT，Copyright 2026 Austin Byron | MIT，Copyright 2026 Richik Mandal |
| 运行环境 | Python ≥ 3.9（CI 3.9–3.13） | Python 3.10+ | Go（`go.mod`），PostgreSQL、Docker | Python 3.12，pydantic / scipy / numpy，uv |
| 功能覆盖 | 预测回测与 walk-forward 模型回测；固定 / Kelly / 价值注 / 单位注；ROI、Sharpe、Sortino、回撤、Brier / LogLoss / ECE、CLV、去水、赔率压力测试 | 事件驱动的 Betfair 交易与策略框架；模拟、纸面交易、风控 | 赔率采集（The Odds API）、去水后混合概率、分数 Kelly（上限 5%）、无前视回测、MLB 先发投手修正 | walk-forward、按场次 bootstrap 区间、Betfair 式佣金、Kelly、Dixon-Coles 简化模型、对冲套利 |
| 测试情况 | 有 `tests/`、`pytest.ini` 与 CI 徽章（未运行） | 有 `tests/` 与 CI 工作流（未运行） | 页面未见 `tests/` 目录；README 称 `go test ./...` 覆盖投注数学、回测重放等（未核实） | 有测试目录；README 称约 800 个测试、同输入逐字节一致（未运行、未核实） |
| 是否依赖真实投注账户 | README 未提及，称数据来自 DataFrame；未读源码，**未能完全确认** | 实盘需要 Betfair 账户（示例用 `betfairlightweight` 登录） | 否，README 称仅纸面交易；赔率来自 The Odds API 与非官方接口 | 否，README 称不下单、无真实场所对接 |
| 可借鉴 | CLV、去水、校准指标的接口形状；walk-forward 与回测分离的 API；压力测试思路 | 事件模型与模拟 / 纸面交易的分层；对 dc-nba 无必要 | 项目结构、无前视回测的做法 | 按场次 bootstrap 区间、walk-forward 评估器、逐字节可复现的测试写法 |
| 结论 | 只借鉴，不移植、不新增依赖 | 只借鉴，不移植、不新增依赖 | 只借鉴，不移植、不新增依赖 | 只借鉴，不移植、不新增依赖 |

不移植的理由（共通）：dc-nba 是 Node 22 ESM，不引入 Python / Go 依赖或常驻服务；本项目已有等价的纯函数实现与测试。许可证均为 MIT，不构成障碍，但我们并不拷贝代码。betanalysis 的 README 说它从 The Odds API 采集赔率；是否需要付费密钥未能核实（The Odds API 有免费档，额度与条款未核实）。无论如何，引入它就要接外部赔率接口，与本项目「不接付费赔率接口、不新增依赖」的约束不符，所以只借鉴。

### 商业产品（只参考功能与交互，不复制专有代码）

| 产品 | 可访问性 | 功能（据首页） | 是否需绑定投注账户 | 可借鉴 | 结论 |
|---|---|---|---|---|---|
| OddsJam（oddsjam.com） | 返回 HTTP 403，未获取内容，不尝试绕过 | 未能核实 | 未能核实 | 未能核实 | 未能核实；只借鉴，不移植、不新增依赖 |
| Unabated（unabated.com） | 可访问 | 无水公平线（Unabated Line）、无水计算器、多家赔率对比屏、CLV 计算器、对冲 / 让球计算器；首页未提回测 | 首页未说明 | 无水公平概率的展示方式；CLV 计算 | 只借鉴，不移植、不新增依赖 |
| Rithmm（rithmm.com） | 可访问（营销页） | 胜率与置信度预测、模型概率 vs 赔率的 edge、跨平台比价、无代码建模、模型排行榜、个人投注记录；首页未出现「回测」字样，未能确认是否有历史回测；付费档 $29.99 / $49.99 / $99.99 每月 | 首页未说明（提到可把注单发送到支持的博彩公司，机制未说明） | 预测加解释性的页面组织 | 只借鉴，不移植、不新增依赖 |
| Betaminic（betaminic.com） | 可访问 | 足球与网球统计；Betamin Builder 建策略并看结果（称 10 万+ 场、111 个联赛）；邮件 / Telegram 提醒；BF Bot Manager（自动下注）；首页未出现「回测」字样；页面上的收益数字为自报、未核实 | 首页未说明 | 条件策略与历史结果的展示方式 | 只借鉴，不移植、不新增依赖 |
| Pikkit（pikkit.com） | 可访问 | 注单追踪、CLV 图、情景分析、日历视图、比价；BookSync 只读同步 30+ 家博彩公司的注单；未明确提到资金曲线图 | 需要（BookSync 同步注单，页面称只读、不能下注 / 转账） | 注单流水与 CLV 图表的组织 | 只借鉴，不移植、不新增依赖 |

产品页面内容为营销文案经 WebFetch 摘要所得，价格、规模等均为其自称，未独立核实。

### 总体结论

**只借鉴，不移植、不新增依赖。** 本项目不接真实投注账户、不接付费赔率接口；不引入上述任何库或产品的代码或依赖。OddsJam 未能核实。
