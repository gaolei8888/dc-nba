# 预注册：上季 IMP 缺失时的回退先验（IMP fallback prior）

- 写于 **2026-10-29（PDT 晚，北京 2026-10-30）**，分支 `imp-fallback`。本文件先单独提交，之后才写对比代码、算任何回退值或评估数字。
- 提交前做过的唯一计算：原样重跑 `scripts/injury-elo-lab.mjs` 与 `scripts/roster-results-backtest.mjs`，确认在本工作区能逐字复现已提交的输出（只有时间戳不同）。**没有算过任何回退值。**
- 看到结果后不改本文件。若必须偏离，只在文末追加带日期的「偏离」一节，写明原因。
- 纯离线实验：不部署、不推送、不访问 stats.nba.com。生产接入只在「采纳」时做。

## 问题

球员价值 IMP 只给上季出场 ≥20 场、场均 ≥10 分钟的人（`server/impact.mjs` 的 `MIN_GP=20`、`MIN_MPG=10`）。
上季大半时间缺阵的人（Tatum 2025-26 只打 16 场；Haliburton / Lillard / Kyrie 0 场；Walker Kessler 5 场）因此没有上季 IMP，
在轮换价值、阵容榜、伤病扣分里都按替补级 `REPLACEMENT_IMP = −0.5` 算；赛季中（`scripts/ingest.mjs` 的 `currentImpact`）也要本季满 20 场才有 IMP。

## 规则（用户已批准，固定，不调参）

对上季出场 < 20 场的球员（上季整季没打、根本没有上季数据行的也算）：

1. **找合格赛季**：从上季往前最多 3 季（上季 − 1 … 上季 − 3），取最近的一季，该季 gp ≥ 20 且场均 min ≥ 10。
   该季的 IMP 完全按管线的方式算：同一个模型应用 + 用**该季**人群均值的 `shrinkByMinutes`（该季出场总分钟）。
   - 实验里「管线」= 各回测共用的 `valuesUpto`（SPM 只在 ≤ 评估季前一季训练；衰减 APM 取以合格季为最后一季的窗口，窗口里没有 lineups 的季就截短，与 `valuesUpto` 校准段对早期赛季的做法相同；最后乘同一个量纲 `scale`）。
   - 生产里「管线」= `ingest.mjs` 的上季 IMP：`impactOf(model, row, 衰减APM, aged)` 再 `shrinkByMinutes`，人群均值 = 该季够门槛球员的 aged SPM 均值。
2. **年龄**：对合格季与上季之间每隔一季，用现行逐项年龄曲线（`server/impactAging.mjs`，线上的 5b 曲线）平移一次 SPM 特征，
   g = 上季序号 − 合格季序号（1..3），第 k 次（k = 0..g−1）用合格季年龄 + k 岁的曲线值。
   - 实验：现行 `valuesUpto` 不做年龄平移，所以回退值共平移 g 次；年龄曲线每折只用 ≤ 评估季前一季的相邻赛季对拟合（`fitAgeCurves`，与 fit-impact 同法），不泄漏。
   - 生产：上季 IMP 本身已平移一岁（aged，上季 → 本季），所以回退值共平移 g + 1 次。
   - APM 那一半不做年龄调整（与管线相同）。
3. **向人群均值收缩**（不是向替补级）：value = μ + 0.8^g × (aged − μ)。
   μ = 管线给上季 IMP 做 `shrinkByMinutes` 时用的那个人群均值（上季够门槛球员 SPM 的简单均值；生产是 aged SPM 均值；实验再乘 `scale`）。
   这就是收缩后 IMP 的人群中心（`shrinkByMinutes` 把每个人拉向它）。
4. **上季有少量出场**（gp ≥ 1 且场均 ≥ 10 分钟）时，按 `currentImpact` 的 K=20 加权混入：
   value = (20 × 回退值 + gp × spm_partial)/(20 + gp)，spm_partial = 模型以 minGp=1 套在上季数据行上（实验不做年龄平移、乘 `scale`；生产按上季 IMP 同样平移一岁）。不做分钟收缩、不混 APM。
5. 主规则**不另加伤病折扣**。敏感性变体（只报告，不参与决策）：若合格季之后到上季（含）之间有一整季没有出场（没有数据行或 gp = 0），
   回退值（第 3 步的结果、第 4 步混合之前）的 (value − μ) 再乘 0.85。
6. 新秀 / 3 季内没有合格赛季的人：不变（仍无 IMP，按原有替补级 / 估计处理）。上季 gp ≥ 20 但场均 < 10 分钟的人也不变。
7. 不泄漏：评估季 X 只用 X 之前的数据（价值 = `valuesUpto(X−1)` 加回退，回退只看 ≤ X−1 季的数据行）。

## 评估（两个主检验，必须都通过）

评估季 2022-23..2025-26（4920 场），2021-22 只做热身，与原实验相同。两套价值：「现状」= 现行 `valuesUpto`；「回退」= 同一份价值加上述回退值（只新增原来没有价值的人，原有价值逐位不变）。
每个检验除价值外一切不变，逐场配对。

- **(a) 伤病扣分模型 P1**：`scripts/injury-elo-lab.mjs` / `server/injuryEloLab.mjs` 的留一赛季设置。
  胜率 = Φ((Elo 净胜分 − 0.5·(D_pre_主 − D_pre_客))/12)，β 固定 0.5（影子运行冻结值），P(出场 | 状态) 每折只用其余赛季估（与原实验同）。
  健康基线、报告链、时间核对全部不变；只有 `preDeduction` 用的价值表换了。
- **(b) 阵容榜**：`scripts/roster-results-backtest.mjs` 的 batch1 先验（`RR_PRIOR=batch1`、收缩 IMP）+ `server/rosterResults.mjs` 的战绩修正，
  配置固定为线上 `RESULTS`（K=12、近期加权 0.4/60 天），sd=12，不重新选参。
- 指标：Δ log loss = 回退 − 现状，四季合并；按**比赛日分块** bootstrap 95% 区间（`server/injuryEloShadow.mjs` 的 `dayBlockCI`，B=2000，seed 7）。

## 采纳规则（非劣效，用户已批准）

**(a) 与 (b) 的 Δ log loss 95% 区间上界都 < +0.0005 → 采纳**；否则不采纳。不看其它数字改判。

## 只报告（不参与决策）

- 「受影响比赛」子集上的 Δ（任一队有轮换球员用的是回退值：(a) 健康基线 H 里；(b) 阵容先验里健康时分钟 > 0），同样的分块区间；
- 逐季 Δ；
- 敏感性变体（×0.85）的 (a)、(b) Δ；
- (b) 的「只看阵容」（K=∞）Δ；
- 各评估季回退覆盖的人数；
- 指名球员的现状 vs 回退值（`valuesUpto(2025-26)`，即用于 2026-27 的那份）：Tatum、Haliburton、Lillard、Kyrie Irving、Trae Young、Sabonis、Dejounte Murray、VanVleet、Ty Jerome、Zach Edey、Walker Kessler。

## 采纳后（只在采纳时做）

- 生产接入同一规则：`ingest.mjs` 上季 IMP 对 gp < 20 的人用回退；`currentImpact` 照旧以 K=20 混本季。
- 单测：生产函数与实验函数在夹具上相等；上季 ≥ 20 场的人与改动前逐位相同。
- 结论文档 `docs/imp-fallback-verdict.md`；`deploy/README.md` 加一节（回滚标签 `pre-impfb`）。

## 实现与复现

- 规则核心 `server/impFallback.mjs`（纯函数，生产与实验共用）；实验 `server/impFallbackLab.mjs`、`scripts/imp-fallback-lab.mjs`、`npm run lab:imp-fallback`；单测 `tests/impFallbackLab.test.mjs`。
- 共用的 `valuesUpto` 抽成 `server/impFallbackLab.mjs` 的辅助函数，两份回测改为调用它；改前改后两份回测输出逐字相同（时间戳除外）。
