# 英文术语表（i18n）

后续所有批次写 `web/src/i18n/locales/en.js` 译文必须遵守本表。测试 `tests/i18n.test.mjs` 会逐行检查：en 译文不得出现「避免」列中的写法（按单词边界、不分大小写匹配）。

约定：
- 「避免」列为逗号分隔的禁用英文写法；`—` 表示无。
- 「状态」：`已定` = 可直接使用；`待确认` = 初稿建议，等用户拍板（拍板后改成 `已定`，必要时改英文列）。
- 诚实表述保持直白，不软化：
  - 「无证据表明模型能赢盘口」 → "No evidence the model beats the market"
  - 「未经回测验证」 → "Not backtested" / "Unvalidated"
  - 「避免」列中的软化写法（如 "may help", "promising", "slight edge"）一律不用于这类结论。
- 数字、球队缩写（BOS 等）、IMP 等缩写两种语言保持一致。

| 中文 | English | 避免 | 状态 |
| --- | --- | --- | --- |
| 净效率 | Net Rating | Net Efficiency | 已定 |
| 进攻效率 | Offensive Rating | Offensive Efficiency, Off Efficiency | 已定 |
| 防守效率 | Defensive Rating | Defensive Efficiency, Def Efficiency | 已定 |
| 在场 / 不在场 | On/Off | On-Off, On Court Off Court | 已定 |
| 背靠背 | back-to-back（缩写 B2B） | back to back, backtoback | 已定 |
| 休息天数 | rest days | days off | 已定 |
| 主场优势 | home-court advantage | home advantage, home field advantage | 已定 |
| 让分 | spread | handicap, point spread line | 已定 |
| 总分 | total | over/under total, combined points line | 已定 |
| 钱线 | moneyline | money line, straight odds | 已定 |
| 回测 | backtest | back-test, back test | 已定 |
| 样本外 | out-of-sample | out of sample, holdout set | 已定 |
| 置信区间 | confidence interval（95% CI） | confidence range, credible band | 已定 |
| 准确率 | accuracy | hit rate, correctness | 已定 |
| 对数损失 | log loss | logarithmic loss, cross-entropy loss | 已定 |
| 冷门 | upset | surprise result, shocker | 已定 |
| 保本胜率 | break-even win rate | breakeven rate, safe win rate | 已定 |
| 最大回撤 | max drawdown | maximum loss streak, peak decline | 已定 |
| 轮换 | rotation | lineup rotation, substitution pattern | 已定 |
| 替补级 | replacement level | bench level, scrub level | 已定 |
| 收缩 | shrinkage | shrinking, regularization | 已定 |
| 缺阵 | Out | Absent, Missing, Injured Out | 已定 |
| 存疑 | Doubtful | Uncertain, Doubt | 已定 |
| 每日观察 | Day-to-day | Daily Observation, day to day | 已定 |
| 美东时间 | ET | EST, Eastern Standard Time | 已定 |
| 分区 | Division | District | 已定 |
| 赛区 | Conference | League Side | 已定 |
| 无证据表明模型能赢盘口 | No evidence the model beats the market | Model may beat the market, promising edge, slight edge | 已定 |
| 未经回测验证 | Not backtested / Unvalidated | Not fully validated, still being refined, preliminary | 已定 |
| 阵容先验 | Roster prior | Lineup prior, Roster baseline | 已定 |
| 战绩修正 | Results adjustment | Record correction, Record fix | 已定 |
| 旧模型分 | Legacy model score | Old model score, Old model rating | 已定 |
| 阵容实验榜 | Roster experiment ranking | Lineup experiment board | 已定 |
| 实力榜 | Power rankings | Strength list, Power list | 已定 |
| 本季实战 | This season live | Live season, Real season play | 已定 |
| 上季回放 | Last season replay | Last season rerun, Prior season replay | 已定 |
| 收盘线价值 | closing line value (CLV) | closing value, closing line worth | 已定 |
| 品牌「NBA超级幻想」 | NBA Super Fantasy | NBA Super Fan, NBA Fantasy Super | 待确认 |
| IMP（球员影响力，自研综合指标） | IMP（"Impact", our own composite metric；缩写保留） | Impact Score, Player Impact Rating | 待确认 |
| Elo | Elo rating | Elo score, ELO | 待确认 |
| 盘口 | the market / betting line | handicap | 待确认 |
| 去水胜率 | no-vig probability | fair odds, vig-free odds | 待确认 |
| 模拟投注 | Paper betting | Simulated betting, Fake betting | 待确认 |
| 前向账本 | Live ledger | Forward ledger, Forward book | 待确认 |
| 影子模式 | Shadow mode | Ghost mode, Dark mode test | 待确认 |
| 人机对赌 | You vs. the Model | Man vs. Machine bet, Human vs AI wager | 待确认 |
| 预测总表 | Prediction Scorecard | Prediction Summary Table, Prediction Master List | 待确认 |
| 玩家档案 | Profiles | Player Profiles | 待确认 |
| 按满勤计权 | Weight by full availability | Weight by full attendance, Weight by ironman | 待确认 |
| 阵容更迭 ΔROS | Roster turnover | Roster change, Roster shuffle | 待确认 |
| 北京时间 | Beijing time | CST, China Standard Time | 待确认 |
| 注 / 单位 | units | stakes, bets | 待确认 |
| 锋卫摇摆等位置 | 直接用 G-F / F-C 代码 | swingman, wing guard | 待确认 |
