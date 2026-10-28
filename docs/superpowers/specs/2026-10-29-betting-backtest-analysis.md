# 投注回测升级 · 现状分析（只读调研）— 2026-10-28

范围：钱线 / 让分 / 大小分的 ROI 回测与策略评估（EV、edge、Kelly、walk-forward、风险与显著性、UI）。
本文只陈述现状与数据核查结果，不含方案。基于 master `8df0fb2`。数据核查都是本机 `data/` 上的 node 一行脚本。

## 0. 结论速览

| 项 | 现状 |
| --- | --- |
| 历史钱线 | 有：`books_*.json` 多家，2021-22..2025-26 每季 1230/1230 场；时点只有 open/close/current 标签，**无抓取时间戳** |
| 历史让分**线** | 有（books 每家 `spread`；odds_* 单家 `spread`/`openSpread`） |
| 历史让分**价格** | **没有**。`trimItem` 丢掉了 `spreadOdds` 与 `*.spread.american`；odds_* 也没存 |
| 历史大小分线 + 价格 | 只有 odds_*（单家：22-24 Betfair、24-26 ESPN BET/DK）：`total`、`overOdds`、`underOdds` ≈99.5%；无 open/close 区分；books_* **完全没有** |
| 历史总分预测 | **没有**。`lab.replay` 只出分差/胜率，不出总分/比分 |
| 分差分布 | `spreadSd = 12` 写死未拟合；实测残差 SD 12.9–14.6 → 模型偏自信 |
| Kelly | 全库无 |
| 回测模型 ≠ 线上模型 | 回测用纯 Elo+主场+休息；线上另加阵容更迭 0.15、缺阵修正、IMP |
| 前向账本 | 只有钱线、只有 DK、只记 `model_p_home`，**不记分差/总分/模型版本** |

阻塞项：让分价格（全部赛季）与大小分的多家/开收盘价格，需要按已缓存的 eventId 重抓 ESPN core odds（见 §2.4）。

---

## 1. 预测数据结构与持久化

### 1.1 模型每场输出
`server/predict.mjs:278-345 predictGame`：

| 字段 | 来源 |
| --- | --- |
| `margin`（主队预期净胜分） | `sHome.total − sAway.total + hca + restPts`（:301） |
| `homeWinProb` | `normalCdf(margin, spreadSd)`（:302），`spreadSd=12`（:43） |
| `spread` | `−margin`（:325） |
| `total` | `(homeRtg+awayRtg)·pace/100 + 0.5·(rosterAdj 合计)`（:308-315），rtg/pace 来自**上赛季**整季 `team.adv` |
| `homeScore/awayScore` | `total/2 ± margin/2`（:327-328）——不是独立模型，只是 total 与 margin 的拆分 |

`predictSchedule`（:348-376）把精简版放进 `g.prediction`：`margin, homeWinProb, total, homeScore, awayScore, restHome, restAway, pregame`。
已结束比赛只把 Elo 换回赛前值（`preElo`），**名单/球员价值/参数仍是现在的**（注释 :283-285）。

### 1.2 落库情况（`server/db.mjs`）

| 表 | 记录内容 | 模型版本 | 分差/总分 |
| --- | --- | --- | --- |
| `paper_bets`（:79-112） | `model_p_home`、`home_elo/away_elo`、DK `home_ml/away_ml`、open ML、`book_p_home`、`edge`、`threshold`、`bet/side/bet_ml`；结算 `home_score…profit`、`close_*_ml`、`clv` | **无** | **无** |
| `shadow_predictions`（:141-169） | 伤病影子：`base_margin, margin, p_home`、报告 as_of | `params_version` | margin 有，total 无 |
| `shadow_rr_predictions`（:213-242） | 阵容+战绩影子：`rating_*, hca, rest_pts, margin, p_home` | `params_version`、`board_code` | margin 有，total 无 |
| `live_picks`（:271-288） | 人机对赌：`side, conf, model_p_home, data_at` | 无 | 无 |

赛程页/总表的预测**不落库**，每次请求由 `predictSchedule` 现算（`server/index.mjs:356-369, 379-396`）。

---

## 2. 历史盘口数据

### 2.1 文件与覆盖（实测）

**`data/history/books_<季>.json`**（`scripts/books-history.mjs`，经 `trimItem` 裁剪）：每场 `{eventId, date, home, items:[{id,name,spread,open,close,current}]}`，时点值只有 `[主ML, 客ML]`。

| 赛季 | 场数 | 主要可下注博彩商（条目数） | 有 close 的家 | 有 open 的家 |
| --- | --- | --- | --- | --- |
| 2021-22 | 1230/1230 | DK 1229、Caesars×4、MGM 1228、Unibet、SugarHouse、Westgate、PointsBet 897 | **无**（全是 current） | 无 |
| 2022-23 | 1230/1230 | Betfair、DK 1230、ESPN BET 1230、MGM、Caesars、Unibet… | 只有 ESPN BET 1168 | 无 |
| 2023-24 | 1230/1230 | Betfair、DK 1229、ESPN BET、MGM、Caesars、Unibet、SugarHouse | 全有 | DK 1136 / MGM 1228 / Betfair 1208 |
| 2024-25 | 1230/1230 | **只有 ESPN BET** | 1230 | 1230 |
| 2025-26 | 1230/1230 | DK 979、ESPN BET 299 | DK 967 | DK 973 |

**`data/history/odds_<季>.json`**（`scripts/odds-history.mjs` → `parseOddsItem` 单家，`server/oddsClient.mjs:89-123`；无 2021-22）：

| 赛季 | 有盘口 | provider | spread | openSpread | total | ML | ML open | over/under 价格 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2022-23 | 1230 | Betfair 1230 | 1230 | 0 | 1229 | 1230 | 0 | 1229 |
| 2023-24 | 1230 | Betfair 1229 | 1230 | 1209 | 1230 | 1230 | 0 | 1230 |
| 2024-25 | 1224 | ESPN BET | 1224 | 1224 | 1224 | 1224 | 0 | 1224 |
| 2025-26 | 1224 | DK 974 / ESPN BET 249 | 1224 | 1224 | 1223 | 1219 | 0 | 1223 |

`backtest.json` 的 `o = [spread, total, homeMl, awayMl]`（`server/lab.mjs:57-65`）就是由它压出来的；不含 over/under 价格。
注意：22-23/23-24 是 Betfair（英国交易所），`docs/paper-betting-verdict.md` 已记 pickBook 修复后未重抓。
ML open 全为 0：`homeMlOpen` 字段是后加的，历史缓存抓于其前。`openSpread` 有 15–27 场/季与收盘异号且 |Δ|>3，质量需抽查。

### 2.2 `trimItem` 保留/丢弃（`server/books.mjs:50-65`）
保留：`provider.id/name`、顶层 `spread`（一个数，不分时点）、`{open,close,current}.moneyLine.american`（主、客）。
丢弃：`homeTeamOdds/awayTeamOdds.spreadOdds`、`*.{open,close,current}.pointSpread`（分时点让分线）、`*.{open,close,current}.spread.american`（**让分价格**）、顶层 `overUnder/overOdds/underOdds`、`item.{open,close,current}.{over,under,total}`（**大小分线与价格**）、`details`、`favorite`。

### 2.3 原始 item 里有没有 → 有
`tests/fixtures/books/*.json`（原始 ESPN core items）实测：
- 2021-22：`homeTeamOdds.spreadOdds:-110`、`current.spread.american:"-110"`、`current.{over,under,total}`；只有 current。
- 2023-24 / 2025-26 / 2026-27：`open/close/current` 三时点都有 `pointSpread`、`spread.american`（让分价格，如 −108/−112）、顶层 `open/close.{over,under,total}`。

即：让分价格与大小分的分时点价格**ESPN 有，只是被裁掉了**；缓存里没有原始 items，必须重抓。

### 2.4 重抓估算
- eventId 已全部缓存在 `books_*.json.events`，**只需 core odds 端点**：每场 1 请求，5 季 × 1230 = **6150**（只抓 2023-24..2025-26：3690）。
- 上次 books 抓取 6963 请求 / 128 分钟 / 0 失败（verdict 文档）。
- 限制：`server/espnClient.mjs:21-32` `maxPerRun 3000`、`maxPerDay 12000`、gap 300–800ms + 每 20–40 次停 2–6s，熔断/BLOCKED；books-history 另加全局 1.1s 间隔（:29-38）、`MAX_REQUESTS` 分批、可续跑、带锁。→ 6150 需 ≥3 次 run（受 maxPerRun），一天内可完成，约 2 小时。
- 用户规则（memory）：只用 politeFetch 模拟浏览器 + 节奏 + 熔断，不用代理/验证码绕过。只访问 ESPN，不碰 stats.nba.com（家宽已被 NBA 封）。
- 建议改动点（供规划）：新的 trim 应保留让分线/价格与 total/over/under 三时点；或直接存原始 items（约 6.8KB/场 → ~40MB/5 季，gzip 后小得多）。

---

## 3. 时间戳

| 时间 | 前向（2026-27） | 历史回测 |
| --- | --- | --- |
| 预测生成时刻 | `paper_bets.captured_at`（ledger 运行时刻，`server/ledger.mjs:51,63`） | 无（replay 现算） |
| 开赛时刻 | `paper_bets.tipoff_utc` ← schedule `dateTimeUtc` | **无**：`backtest.json` 只有日期 `d`；books 缓存只有 `date`（ESPN `dateUtc` 未存） |
| 盘口抓取时刻 | `odds_fetched_at` ← `odds.json.fetchedAt`（:73）；`price_at:'current'` | **无**；只有 open/close/current 标签 |
| 收盘价 | 赛后 3 天内抓 DK core `close`（`scripts/ledger.mjs:72-75, 86`） | close 标签 |

早规则（edge0/3/6）：北京 22:00 cron，开赛前 9–12h，窗口 14h（`ledger.mjs:29`）。晚规则 edge3-late：北京 06:30，开赛前 0.5–4h，快照须 2h 内新抓且早于开赛（:31-36,50,57）。cron 见 `deploy/refresh.sh:17-19`。

历史回测用哪个价：`priceOf` = close > current，不用 open（`books.mjs:84-88`）；决策（去水 p）与结算都用这个价（`paperBetting.mjs:92-94`）。`at:'open'` 变体只用于 CLV（:87-91，要求同家有 close）。2021-22/2022-23 几乎全是 current（对已完赛比赛 ≈ 最后一次报价，视作近似收盘）。

---

## 4. 泄漏检查

| 项 | 结论 | 证据 |
| --- | --- | --- |
| Elo 赛前性 | 严格：先算预测再更新 Elo | `lab.mjs:140-171`（records.push 在 update 之前） |
| 赛季初 | 上季 `computeElo` 从 1500 起 → `carryOver(keep 0.75)`；只用上季 | `lab.mjs:109`，`ratings.mjs:71` |
| **同日多场** | 按 `date, gameId` 排序逐场更新 → 同日较晚场次用到了同日较早（可能同时开打）比赛的结果 | `lab.mjs:69`；对比 rr 影子表明确要求 `results_through < game_date`（`db.mjs:249-251`） |
| 参数来源 | `k=20`、`carryKeep 0.75`、ELO 主场 100、MOV 公式取自 FiveThirtyEight（外部，非本数据调参，README:550-551）。**`homeAdv 1.6` 由 2024-25/2025-26 实测得出、`restWeight 1.8` 由回测背靠背实测、`wNet=0` 与 `turnoverWeight 0.15` 由 2022-26 回测选定**（`predict.mjs:20-39`）→ 在评估季上是样本内。未找到 Elo 参数的 LOSO 记录；LOSO 只用于 rr（K=12，README:896）与伤病 β（deploy/README:181）。`spreadSd 12` 未拟合 |
| 投注门槛 | 只在 2022-23 看，headline 只用 2023-24/2025-26 DK | `paperBetting.mjs:14-17`，`paper-backtest.mjs:93` |
| 下注价 = 收盘价 | 决策与成交同用 close：不是信息泄漏（模型不看盘口），但**可得性**不现实（需恰在收盘成交）；且收盘最锐利，对 ROI 偏保守 | `paperBetting.mjs:92-94` |
| 回测模型与线上不同 | replay 只有 Elo/主场/休息；线上有阵容更迭、缺阵、IMP | `lab.mjs:131-141` vs `predict.mjs:241-302` |
| 本季 56 场成绩 | Elo 换赛前值，但名单/IMP（含本季加权）是现在的 → 轻度事后信息 | `predict.mjs:283-285` |
| 本季总分 | 用上季 `team.adv`（顶层字段为上季，README:43-47）→ 无本季泄漏，但也不吸收本季信息 | `predict.mjs:308-313` |
| fusionLab / 其他 lab | 复用 `replay` 记录，泄漏性质同上；`bootstrapCI` 是 iid 按注重抽 | `fusionLab.mjs:173-185` |

---

## 5. 是否 walk-forward

- `replay` 在每季内是严格时间顺序的在线更新（Elo 滚动），但**参数全局固定、不随时间重拟合**，不是真正的 walk-forward（没有 train 窗口 → fit → 下一段 test）。
- 留出方式：投注只有「2022-23 可看门槛 / 之后只报告」一刀切；没有 train 2022-25 / test 2025-26 的正式 holdout；Elo 参数没有 LOSO。
- 已有可借鉴的 holdout/LOSO 框架：`tests/rosterReplay.test.mjs:49-74,169-173`（holdout、paired season-block bootstrap）、rr / 伤病实验。

---

## 6. 现有策略框架与记录

| 组件 | 位置 | 内容 |
| --- | --- | --- |
| 规则 | `paperBetting.mjs:14-35`，`ledger.mjs:19-24` | edge = p_model − p_book（去水）；edge0 / edge3（主）/ edge6；edge3-late；平注 1 单位 |
| 博彩商 | `books.mjs:17-34`，`paperBetting.mjs:74-111` | 逐家、`best`（去水中位数判断、美国持牌家里取最高价，`US_BOOKS`）、DK-only（账本） |
| 清洗 | `books.mjs:68-81` | 剔 Live / 聚合源 / 离中位让分 >3 分；同家多 id 合并 |
| 结算 | `paperBetting.mjs:38-42`；账本 `ledger.mjs:114-142` | 只有钱线胜负；无 push、无让分/大小分 |
| CLV | `paperBetting.mjs:61-66` | 所押边：收盘去水 p − 下注价去水 p |
| 指标 | `paperBetting.mjs:153-183` | 注数、胜率、units、ROI、bootstrap 95%（iid 按注，B=2000，seed 7）、保本胜率、最大回撤、累计曲线、CLV 区间 |
| 结论文字 | `paperBetting.mjs:191-197` | 区间 >0 才说「有证据」 |
| 回测产物 | `scripts/paper-backtest.mjs` → `data/paper-backtest.json` | book×season×threshold 表、CLV 表、模型 vs 市场 logloss/Brier |
| 账本表/触发器 | `db.mjs:72-125` | 只追加：重复忽略、禁删、记录字段冻结、结算字段只写一次 |
| 账本运行 | `scripts/ledger.mjs`，`deploy/refresh.sh:67-82` | capture（早/晚）、settle（DK 收盘价 1 请求/场）、show |
| API | `server/index.mjs:402-410` `/api/paper` | backtest 静态 + ledgerReport（B=1000） |
| UI | `web/src/pages/Board.jsx:13, 288-446, 580` | 「预测总表 → 模拟投注」：headline、账本早/晚对照、待结算注单、book×季表、CLV 表 |
| 结论 | `docs/paper-betting-verdict.md` | 样本外 DK ≥3%：1596 注 ROI −11.8% [−19.3, −4.6]；模型 logloss 比市场高 0.02–0.03 |

缺：Kelly/分数 Kelly、资金曲线（bankroll）、EV 定义（目前 edge 是概率差，不是期望收益）、让分/大小分、push 处理、按日聚类 bootstrap、多重比较校正、显著性（相对 0 的 p 值）、`lab.market` 的 ATS 只按 −110 固定保本线（`lab.mjs:386, 462-480`）。

---

## 7. 让分 / 大小分概率模型

- 分差：`P(主胜) = Φ(margin/12)`；没有校准过的分差分布。replay（生产参数）实测：

| 赛季 | 模型残差 SD | 模型 MAE | 盘口残差 SD | 盘口 MAE | 盘口总分残差 SD / MAE | 用 SD=12 算 P(cover) 的 Brier（vs 0.25 抛硬币） | \|P−0.5\|>0.1 场次的过盘率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2022-23 | 12.89 | 10.19 | 12.50 | 9.78 | 18.23 / 14.16 | 0.2631 | 51.5%（470） |
| 2023-24 | 14.09 | 10.99 | 13.57 | 10.53 | 17.59 / 14.05 | 0.2646 | 50.4%（448） |
| 2024-25 | 14.08 | 11.01 | 13.51 | 10.48 | 17.59 / 14.10 | 0.2650 | 49.0%（486） |
| 2025-26 | 14.62 | 11.43 | 13.94 | 10.89 | 18.36 / 14.61 | 0.2683 | 49.6%（556） |

  → SD=12 明显偏窄；`P(cover)=Φ((margin−mktLine)/σ)` 的 Brier 每季都**劣于抛硬币**，说明模型相对盘口的分差信号为零或负，过盘率在 49–52% 而保本 52.4%。
- 总分：只有线上 `predictGame.total`（上季效率×节奏，全季不变 + 缺阵小修正）；**历史回测没有总分预测**。重建需要上季 OFF/DEF/PACE：`backtest.json.teamAdv` 只有 `{t, n, p}`（无 off/def），但 `data/history/teamadv_*.json` 有 `OFF_RATING/DEF_RATING/PACE`，可用。本季 56 场总分残差：均值 +0.16、SD 18.4（与盘口总分残差 SD ~18 同量级，但盘口 MAE 14.1 < 我们 15.1）。
- 若要 P(cover)/P(over)，需验证：σ（分差、总分）是否随赛季/让分大小/总分高低变化；残差正态性与关键数字（3、7 等）处的离散质量（push 概率）；margin 与 total 残差相关性（若做比分联合分布）；均值偏置（本季 margin bias +1.56）；对盘口的 Brier/logloss 与 PIT 校准；以及「对盘口的 edge」在样本外是否单调。

---

## 8. 本季（2026-27）数据

- 已完赛常规赛 **56 场**（2026-10-20 ~ 10-27），全部带 `preElo`；本季常规赛 1206 场在赛程里。
- 用户引用的数字由 `server/predictionBoard.mjs` 计算，本机复算一致：

| 指标 | 本机复算 | 代码 |
| --- | --- | --- |
| Brier | 0.2087 | `score()` :20-32 |
| LogLoss | 0.6000 | `score()` :30 |
| 准确率 | 34/56 = 60.7%（Wilson 47.6–72.4%） | `score()`+`wilson()` :9-17 |
| 分差 MAE / 偏置 | 11.57 / +1.56 | `errors()` :68-82 |
| 总分 MAE / 偏置 | 15.06 / +0.16 | `errors()` |
| 单队得分 MAE | 9.83 | `errors()` :79-80 |

  入口：`/api/predictions/summary`（`server/index.mjs:376-396`）= `buildBoard(predictSchedule(...))`，新工作应复用 `score / errors / buckets / wilson`。
  `market.n = 0`：`marketOf` 只来自 `odds.json`（仅未开赛场次），已完赛场次在本地没有盘口快照。
- `data/odds.json`（fetchedAt 2026-10-28T14:16Z，17 场未开赛，DK）：有 `spread, openSpread, total, homeMl, awayMl, homeMlOpen, awayMlOpen, homeProb, eventId`；**`overOdds/underOdds` 全为 null**（scoreboard 端点结构不同，`parseOddsItem` 只读顶层 `item.overOdds`，`oddsClient.mjs:119-120`）；无让分价格、无 total 开盘。
- 线上账本（prod SQLite，不可查）：`scripts/ledger.mjs capture` 每晚写 edge0/3/6（早）+ edge3-late（晚）每场各一行（含不下注的行，`bet=0`），`settle` 写比分/盈亏与 DK 收盘 ML/CLV。只有钱线。`shadow.mjs` 写两张影子表（margin、p_home，无总分）。
- 本季已完赛 56 场的让分/大小分价格可用 core odds 补抓（56 请求）。

---

## 9. 阻塞项与依赖（供规划）

1. **让分价格**：任何赛季都没有 → 必须重抓（≤6150 请求，按 §2.4 限制分 ≥3 批）。没有它只能假设 −110，会高估/低估 ROI。
2. **大小分多家/分时点价格**：只有 odds_* 单家单时点（且 22-24 是 Betfair）→ 同批重抓一并解决。
3. **历史总分预测**：需新写（基于 `teamadv_*.json` 上季效率，或滚动本季效率——后者要防泄漏）。
4. **σ 校准**：spreadSd=12 偏窄，P(cover) 前需拟合（建议只在训练季上）。
5. **回测模型 ≠ 线上模型**、**同日多场顺序**、**homeAdv/restWeight 在评估季上测得**：walk-forward 设计时需处理或明示。
6. **前向账本扩展**：需新表（paper_bets 的 CHECK/冻结列不宜改），记 market/line/price/margin/total/params_version，以及 `odds.json` 补 over/under 价格解析。
7. **历史无开赛时间与抓取时间**：只能以 open/close 标签近似「决策时点」，无法做「开赛前 N 小时」的精确回测。
