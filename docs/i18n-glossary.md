# 英文术语表（i18n）

后续所有批次写 `web/src/i18n/locales/en.js` 译文必须遵守本表。测试 `tests/i18n.test.mjs` 会逐行检查：en 译文不得出现「避免」列中的写法（按单词边界、不分大小写匹配）。

约定：
- 「避免」列为逗号分隔的禁用英文写法；`—` 表示无。
- 「状态」：`已定` = 可直接使用；`待确认` = 初稿建议，等用户拍板（拍板后改成 `已定`，必要时改英文列）。
- 诚实表述保持直白，不软化：
  - 「无证据表明模型能赢盘口」 → "No evidence the model beats the market"
  - 「未经回测验证」 → "Not backtested" / "Unvalidated"
  - 「避免」列中的软化写法（如 "may help", "promising", "slight edge"）一律不用于这类结论。
- 「避免」项首尾必须是字母或数字（测试会检查）；默认不分大小写匹配，前缀 `=` 表示区分大小写（如 `=ELO`）。
- 数字、球队缩写（BOS 等）、IMP 等缩写两种语言保持一致。

| 中文 | English | 避免 | 状态 |
| --- | --- | --- | --- |
| 净效率 | Net Rating | Net Efficiency | 已定 |
| 进攻效率 | Offensive Rating | Offensive Efficiency, Off Efficiency | 已定 |
| 防守效率 | Defensive Rating | Defensive Efficiency, Def Efficiency | 已定 |
| 在场 / 不在场 | On/Off | On-Off | 已定 |
| 背靠背 | back-to-back (B2B) | back to back | 已定 |
| 休息天数 | rest days | — | 已定 |
| 主场优势 | home-court advantage | home advantage, home field advantage | 已定 |
| 让分 | spread | handicap | 已定 |
| 总分 | total | — | 已定 |
| 钱线 | moneyline | money line | 已定 |
| 回测 | backtest | back-test, back test | 已定 |
| 样本外 | out-of-sample | out of sample | 已定 |
| 置信区间 | confidence interval (95% CI) | confidence range | 已定 |
| 准确率 | accuracy | — | 已定 |
| 对数损失 | log loss | logarithmic loss | 已定 |
| 冷门 | upset | surprise result | 已定 |
| 保本胜率 | break-even win rate | breakeven rate, break even rate | 已定 |
| 最大回撤 | max drawdown | maximum loss streak | 已定 |
| 轮换 | rotation | lineup rotation | 已定 |
| 替补级 | replacement level | bench level | 已定 |
| 收缩 | shrinkage | — | 已定 |
| 逐项年龄曲线 | per-stat age curves | — | 待确认 |
| 尺子（验证标准，如「第二把尺子」） | yardstick | — | 待确认 |
| 缺阵 | Out | Injured Out | 已定 |
| 出战成疑 | Questionable | — | 已定 |
| 大概率出战 | Probable | — | 已定 |
| 存疑 | Doubtful | — | 已定 |
| 每日观察 | Day-to-day | Daily Observation, day to day | 已定 |
| 美东时间 | ET | EST, Eastern Standard Time | 已定 |
| 分区 | Conference | — | 已定 |
| 赛区 | Division | — | 已定 |
| 无证据表明模型能赢盘口 | No evidence the model beats the market | promising edge, slight edge, may beat the market, likely beats the market, could beat the market | 已定 |
| 未经回测验证 | Not backtested (or "Unvalidated" in context) | not fully validated, still being refined, promising, may help | 已定 |
| 阵容先验 | Roster prior | Lineup prior, Roster baseline | 已定 |
| 战绩修正 | Record adjustment | Record correction, Record fix, Results adjustment | 已定 |
| 旧模型分 | Legacy model score | Old model score, Old model rating | 已定 |
| 阵容实验榜 | Roster rankings (experimental) | Lineup experiment board, Roster experiment ranking | 已定 |
| 实力榜 | Power rankings | Strength list, Power list | 已定 |
| 本季实战（标签/模式名；本季真实比赛，开赛前提交的预测） | Live this season | Live season, Real season play, Current-season record | 已定 |
| 上季回放 | Last season replay | Last season rerun, Prior season replay | 已定 |
| 收盘线价值 | closing line value (CLV) | closing value | 已定 |
| 品牌「NBA超级幻想」 | NBA Super Fantasy | NBA Super Fan | 已定 |
| IMP（球员影响力，自研综合指标） | IMP | Impact Score, Player Impact Rating | 已定 |
| Elo | Elo rating | =ELO, Elo score | 已定 |
| 盘口 | the market (general); line (numeric lines) | handicap | 已定 |
| 去水胜率 | no-vig probability | fair odds, vig-free odds | 已定 |
| 模拟投注 | Paper betting | Simulated betting, Fake betting | 已定 |
| 前向账本 | Live ledger | Forward ledger, Forward book | 已定 |
| 影子模式 | Shadow mode | — | 已定 |
| 人机对赌 | You vs. the Model | Human vs AI wager, Man vs. machine | 已定 |
| 预测总表 | Prediction Scorecard (page title); Scorecard (nav label) | Prediction Summary Table, Prediction Master List | 已定 |
| 玩家档案 | Profiles | Player Profiles | 已定 |
| 按满勤计权 | Weight by full availability | Weight by full attendance, Assume full health | 已定 |
| 阵容更迭 ΔROS | Roster turnover | Roster churn, Roster shuffle | 已定 |
| 北京时间 | Beijing time | CST, China Standard Time | 已定 |
| 注 / 单位 | units (stakes); bets (counts) | — | 已定 |
| 个百分点（概率 / CLV 之差的单位，同 paper.clv.pp） | pp | — | 已定 |
| 锋卫摇摆等位置 | G-F / F-C (code shown as-is) | swingman | 已定 |
| 期望值 EV | expected value (EV) | — | 待确认 |
| 优势 Edge | edge | advantage score | 待确认 |
| 凯利 | Kelly | — | 待确认 |
| 开盘价 | opening price | — | 待确认 |
| 收盘价 | closing price | — | 待确认 |
| 历史价格情景模拟 | Historical price simulation | historical results, actual returns | 待确认 |
| 按比赛日区块自助法 | game-day block bootstrap | — | 待确认 |
| 按比赛日区间（95% 区间，按比赛日区块自助法） | game-day interval | — | 待确认 |
| 功效分析 | power analysis | — | 待确认 |
| 多重比较 | multiple comparisons | — | 待确认 |
| 训练 / 验证 / 测试期 | training / validation / test period | — | 待确认 |
| 已被看过 | previously examined | — | 待确认 |
