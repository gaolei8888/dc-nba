# 部署与数据刷新

线上：`gpu.tzspace.cn` 的 `/home/dev/work/works/dc-nba/` → https://ai.tzspace.cn/works/dc-nba/

数据快照烤在镜像里，更新数据 = 换 `data/*.json` + 重建镜像。
2026-27 赛季起由 `deploy/refresh.sh` 每天自动做一次（为什么改成自动，见主 README「部署说明」）。

## 服务器上的部署目录不是 git 工作区的镜像

**不要整目录覆盖，也不要 `git pull` 了事。** 服务器那份 `docker-compose.yml` 改过：
`ENABLE_LEADERBOARD: "1"`，带日期注释（2026-09-07 高磊选择开启、不加备份）。
仓库里保持 `"0"`。覆盖它会让排行榜静默关闭。

`data-db/` 是线上排行榜的 SQLite 卷，同样不能动。

## 自动刷新是怎么搭起来的（2026-10-27 起）

线上服务器的 IP 被 NBA 的 CDN 封了（裸请求 403，带浏览器头返回 200 但内容是 nba.com 首页）。
试过的海外机房 metaclue.net（洛杉矶 Zenixcloud）封得更彻底：www.nba.com、cdn.nba.com 都 403，
stats.nba.com 连上后 60 秒无响应。NBA 封的是机房 IP 段，**只有住宅/办公宽带能抓**。
ESPN 两台服务器都能访问。所以分成两条线：

| 谁 | 何时 | 做什么 | 依赖 |
| --- | --- | --- | --- |
| 服务器 cron | 每天 06:30、14:30、22:00（北京） | `refresh.sh --espn`：比分、Elo、赛前 Elo、战绩、伤病、盘口 | 只要 ESPN |
| 本机计划任务「dc-nba 全量刷新」 | 每天 08:00 太平洋（北京 23:00），错过则开机补跑 | `push-refresh.sh`：本机全量 ingest → 推到服务器 `incoming/` → 远程 `refresh.sh --incoming` | 这台电脑开机 |

本机计划任务默认用 Node 直接抓（`NBA_TRANSPORT=node`）。若 stats.nba.com 开始拦 Node 请求，
在计划任务的环境里加 `NBA_TRANSPORT=chrome`，并先 `sh scripts/nba-chrome.sh` 让专用 Chrome 常开
（push-refresh.sh 本身不用改，环境变量会传给 ingest）。原因与用法见 docs/HANDOFF-2026-10-27.md。

本机关机几天也没关系：比分、Elo、命中率、伤病、盘口照常每天更新，
只有球员/球队的场均与高阶统计停在最后一次全量刷新。`meta.statsFetchedAt` 记着那是哪天。

**ESPN 那条线的正确性锚点**：对一份 ingest 刚写出的数据，删掉 16 场比分再跑
`espn-refresh.mjs`，比分 52/52 与 NBA 官方一致，Elo 与赛前 Elo 差 0。
它和 ingest 用的是同一个 `computeElo`，只是比分来源不同。

**全量推送只推数据，不推代码。** 代码上线仍然手动，见下文「手动上线代码」。

**GB10（办公室宽带）有希望接替本机**，不依赖个人电脑开机。待验证：从办公室网络
`ssh lei@gb10.local` 测 stats.nba.com 返回的是不是 JSON；通了就在 GB10 上 clone 仓库、
放好 `data/history/`、给它一把能登录服务器的密钥，cron 跑 `sh deploy/push-refresh.sh`。

另一个坑：服务器的 Docker 镜像源拉 `node:22-alpine` 会挂住。已经从本机
`docker save | ssh docker load` 传上去一份，只要不 `docker image prune -a` 就一直在。

## 手动上线代码

在本机仓库根目录（先 commit，发的是 HEAD，刻意不带 docker-compose.yml）：

```bash
ssh dev@gpu.tzspace.cn 'docker tag dc-nba-dc-nba:latest dc-nba-dc-nba:pre-$(date +%m%d)'   # 回滚点
git archive HEAD server scripts deploy web docs package.json package-lock.json     Dockerfile .dockerignore README.md   | ssh dev@gpu.tzspace.cn 'tar -x -m -C /home/dev/work/works/dc-nba'
sh deploy/push-refresh.sh      # 顺带推一份新数据，并在服务器上重建、健康检查
```

## 模拟投注（2026-10-28 起，见 `docs/superpowers/specs/2026-10-28-paper-betting-design.md`）

两部分，上线方式不同：

**历史回测**是一个静态文件 `data/paper-backtest.json`（gitignore，和其他快照一样）。
在本机生成：`npm run books:fetch`（ESPN，≤1 请求/秒，约 7000 次、两小时，可中断续跑；
缓存在 `data/history/books_<赛季>.json`）→ `npm run paper:backtest`。上线就是把它放进服务器的 `data/`：

```bash
scp data/paper-backtest.json dev@gpu.tzspace.cn:/home/dev/work/works/dc-nba/data/
```

之后每次刷新都会带着它：`refresh.sh` 把线上 `data/*.json` 整个拷进临时目录再拷回来，
`push-refresh.sh` 推的是本机 `data/*.json`（本机有这个文件就一起推）。没有这个文件，页面只显示前向账本。

**前向账本**是 SQLite 表 `paper_bets`，和排行榜同一个库（`DB_PATH`，线上是 `data-db/app.db` 卷），
`CREATE TABLE IF NOT EXISTS`，不动已有的表。只追加由触发器保证：重复插入忽略（连 `INSERT OR REPLACE` 也是）、
不能删、记录字段不能改、结算字段只写一次。

谁来写：`refresh.sh` 在新容器健康之后 `docker exec dc-nba node scripts/ledger.mjs settle`、再 `capture`。
**不能放在取数那一步**——那一步在 `mktemp` 临时目录里、用一次性的 node 容器跑，里面根本没有 `data-db/`，
写进去的库会随临时目录一起删掉。只有运行中的 `dc-nba` 容器挂着持久的卷。
（2026-10-27 本机验证：同样的 `docker run -v data-db:/app/data-db` + `docker exec … capture`，
删掉容器重建后 12 行都在，新容器的 `/api/paper` 读得到。）

- `capture`：记开赛前 **14 小时内**的比赛，DK 价来自本次刷新刚写进镜像的 `odds.json`，零额外请求。
  所以由 22:00（北京）那次记录；14:30 那次离开赛 16 小时以上，不记。
- `settle`：用 `schedule.json` 的比分结算；每场最多 1 个 ESPN 请求取 DK 收盘价算 CLV（每天约 8 次），
  取不到就留空，三天内的下次刷新再补。
- 账本失败只写 `refresh.log`，不影响刷新与回滚。
- 开关：`ENABLE_LEDGER=0` 关掉页面读取（与 `ENABLE_LEADERBOARD` 无关；账本不含用户数据）。
  服务器 compose 不需要改。

**北京 06:30 那次（2026-10-28 高磊同意后加进 crontab）**：UTC 22:30，开赛前约 0.5–4 小时，
`refresh.sh --espn`，盘口更接近收盘。同一 (比赛, 规则, 博彩商) 只认第一次记录，
所以临近开赛的价另起一条预注册规则 **`edge3-late`**（同样 edge ≥ 3%、DK、平注 1 单位），与 22:00 的 `edge3` 并存：

- 运行身份显式给出，不按钟点猜：`refresh.sh --late` → `ledger.mjs capture --late`（或 `LEDGER_RUN=late`）只记 `edge3-late`；
  不带 `--late` 的运行只记早规则 `edge0/3/6`。
- 晚规则只记**按赛程还没开赛**、开赛前 8 小时内的比赛，且赔率快照必须是 2 小时内新抓、早于开赛的
  （刷新失败时容器里是前一晚的旧快照，那不是临近收盘价，宁可不记）；`odds_fetched_at` 记下快照时间。
- 结算、CLV、只追加触发器对两条规则一样适用；表结构没变（`rule` 本来就在主键里）。
- 代价：06:30 不再给 22:00 失败的那晚补记早规则（以前它会用 06:30 的价补记 `edge3`，把早晚混在一起）。
  22:00 失败时 EXIT trap 仍会用容器里上一份快照记早规则。
- **需要改服务器 crontab 的 06:30 那一行**（代码部署后再改；不改的话 06:30 照旧按早规则跑，只是什么都不会新记）：

```
30 6 * * *  /home/dev/work/works/dc-nba/deploy/refresh.sh --espn --late >> /home/dev/work/works/dc-nba/refresh.log 2>&1
```

**ESPN 请求量与熔断（2026-10-28 核过）**：每次 `--espn` 约 15 个请求（14 个比赛日的 scoreboard
+ 1 伤病 + 每个待补比分的日期 1 个），账本结算每场最多 1 个（3 天内没取到收盘价的会重试），
一天三次合计 < 200，默认上限每次 3000 / 每天 12000（`ESPN_MAX_REQUESTS` / `ESPN_MAX_PER_DAY`）。
熔断状态文件 `data/raw/fetch-state.json` 在取数的临时目录里，**不跨运行保存**：
被拦（403/429/超时/非 JSON）时本次运行停手、`refresh.log` 里有 `!! [espn] 熔断：…`，
下一次 cron 照常再试，不会把刷新冻住；代价是跨运行的指数退避和单日上限实际上只在单次运行内生效。
404 不算被拦（盘口端点按「这场没盘口」处理）；扫盘口中途熔断时保留旧 `odds.json`，不写空。

本地：`ENABLE_LEADERBOARD=0 node server/index.mjs` 也能看账本，库默认 `data/app.db`；
`DB_PATH=/tmp/x.db node scripts/ledger.mjs capture|settle|show` 可在副本上演练。

## 独赢盘回测（模型实验室「模型能否打败市场？」，见 `docs/moneyline-backtest-report.md`）

历史部分读一个静态报告 `data/moneyline-backtest.json`（gitignore）。**服务器上生成不了**：运行镜像不带
`scripts/`，`.dockerignore` 也排除了 `data/history/`。所以在本机生成、再放进服务器的 `data/`，部署前后都可以：

```bash
npm run ml:backtest          # 纯离线，读 data/backtest.json + data/history/books_<赛季>.json，约 1 秒
scp data/moneyline-backtest.json dev@gpu.tzspace.cn:/home/dev/work/works/dc-nba/data/
```

数据是烤进镜像的（见 `Dockerfile`），所以放进 `data/` 后要等下一次重建镜像才生效：最近一次定时刷新，
或者部署时紧接着跑的那次 `refresh.sh`（避开北京 22:00 / 06:30 / 14:30 前后 30 分钟）。此后每次 `refresh.sh`
都先把 `data/*.json` 拷进临时目录，会一直带着它（`push-refresh.sh` 也会推本机这份）。
漏了这一步页面不会崩，只显示「回测报告尚未生成」；本季前向账本直接读 `paper_bets`，不依赖这个文件。

核对（重建之后；两边 sha 应一致；`builtAt` 是本机生成时间；`selected` 当前应为 close B-edge7 / open B-edge10）：

```bash
shasum -a 256 data/moneyline-backtest.json
ssh dev@gpu.tzspace.cn 'sha256sum /home/dev/work/works/dc-nba/data/moneyline-backtest.json'
curl -s https://ai.tzspace.cn/works/dc-nba/api/lab/moneyline/meta | jq '{available, builtAt, selected}'
```

报告里的 `inputs.sha` 记着生成时所用 `backtest.json` 与各季 `books_*.json` 的 sha256；本机这些输入变了就重跑、重新上传。

## 怎么确认它真的在跑

不要看 crontab，看结果：

```bash
curl -s https://ai.tzspace.cn/works/dc-nba/api/meta    # fetchedAt 应是今天
tail -30 /home/dev/work/works/dc-nba/refresh.log
```

## 失败时会发生什么

| 环节 | 失败表现 | 线上 |
| --- | --- | --- |
| 抓取（限流挂起、断网） | 30 分钟超时退出 | 不动，继续用旧快照 |
| 体检（量纲错、不足 30 队、赛程空） | 退出 | 不动 |
| 重建后健康检查不过 | 换回 `data-prev/` 再建 | 回到旧快照 |
| 上一次还没跑完 | `flock` 跳过本次 | 不动 |

## 手动回滚

```bash
cd /home/dev/work/works/dc-nba
cp data-prev/*.json data/ && docker compose build && docker compose up -d
```

## 停掉自动刷新

- 服务器：`crontab -e`，删掉 `dc-nba/deploy/refresh.sh --espn` 那三行
- 本机：`Unregister-ScheduledTask -TaskName 'dc-nba 全量刷新'`（PowerShell），或在「任务计划程序」里删

镜像和数据保持最后一次成功刷新时的样子。

## 人机对赌「本季实战」（2026-10-28 起，`server/livePlay.mjs`）

- 存储：SQLite 新表 `live_picks`（`CREATE TABLE IF NOT EXISTS`，加法迁移，不动 `players` / `picks` / `paper_bets`），
  线上与排行榜同库同句柄（`data-db/app.db`），身份就是排行榜令牌；排行榜「玩家档案」页可切「本季实战」榜（`/api/leaderboard?mode=season`）。
- 每行：用户选择 + 提交那一刻模型的赛前预测（`model_p_home`、`home_elo`/`away_elo`、数据快照 `data_at`）。
  开赛前可改（模型快照随之更新到改的那一刻）；到赛程开赛时间即锁：应用层用服务端时钟拒收，库里触发器按真实时钟兜底；不能删；
  `INSERT OR REPLACE` 绕不过。结算不落库：比分来自 ESPN 刷新写的 `schedule.json`，读时现算。
- 线上 `ENABLE_LEADERBOARD=1` 不用改 compose。`ENABLE_LEADERBOARD=0` 的 production 部署不收任何用户数据，本季实战显示不可用。
- 本地：`ENABLE_LEADERBOARD=0 node server/index.mjs`（非 production）也能玩，选择按浏览器档案 id 记在 `DB_PATH`（默认 `data/app.db`）。
  `PLAY_NOW=2026-10-29T00:30:00Z` 可把服务端「现在」拨到某一刻演示锁定（production 下忽略）。
  在副本上演练：复制库要用 `sqlite3 app.db ".backup copy.db"`（WAL 模式，直接 cp 会漏掉 -wal 里的新行）。

## 伤病报告影子运行（2026-10-28 起，`server/injuryShadow.mjs`）

依据 `docs/injury-report-experiment-verdict.md`。每场常规赛记三套赛前预测，**只记录，页面上显示的预测不变**：

| 方案 | 何时记（北京） | 内容 |
| --- | --- | --- |
| `base` | 22:00 那次 | 线上默认预测（与模拟投注账本同一个 `predictSchedule`，不套缺阵勾选） |
| `r22` | 22:00 那次 | base 净胜分 + β·(主调整 − 客调整)，用「现在 − 15 分钟」之前最新的官方报告 |
| `r0630` | 06:30 那次（`--late`） | 同上，06:30 时能看到的报告；06:30 前就开打的下午场在 22:00 那次就记（沿用 22:00 的报告，与实验同） |

谁做什么：

| 谁 | 何时（北京） | 做什么 |
| --- | --- | --- |
| 服务器 cron（已有三行，不改） | 22:00 / 06:30 / 14:30 | `refresh.sh` 收尾时 `docker exec dc-nba node scripts/shadow.mjs settle` + `capture [--late]`。22:00 / 06:30 各抓 **1 份**官方 PDF（`ak-static.cms.nba.com`，2026-10-28 实测服务器直连 200），镜像里的 `pdftotext` 解析，存进库表 `injury_reports`；14:30 那次不在时点窗口，只结算 |
| GB10 systemd 用户定时器 `dc-nba-player-values.timer` | 每天北京 19:15 与 20:15（按北京日期去重） | `deploy/player-values.sh`（GB10 `~/dc-nba`，开跑前快进到 origin/master）：增量抓本季新结束比赛的 PBP（stats.nba.com 只能家里宽带抓），每 7 天重拟合 RAPM，把 `player-values.json` 拿 `.refresh.lock` 推到服务器 `data/`，22:00 那次刷新烤进镜像 |

- **冻结参数** `server/injury-params-v1.json`（`npm run injury:lab` 写出，影子期内不改）：λ=2000、minPoss 0.25、本季 1 + 上季 0.5 + 上上季 0.25、
  轮换 = 比赛日之前最近 10 场、β：22:00 **0.60** / 06:30 **0.65**（在 2022–26 四个评估季上合起来选；LOSO 各折 0.50–0.70）、
  P(出场 | 状态) 用 2021–26 全部赛季。
- **库**：`shadow_predictions`（主键 `(game_id, variant)`）与 `injury_reports`，和 `paper_bets` 同一个库、同一个句柄、同一个开关 `ENABLE_LEDGER`。
  触发器：重复插入忽略（含 OR REPLACE）、不能删、预测与输入字段不能改、比分只写一次、**开赛后插不进**、
  **用到的报告标注时间必须比 `captured_at` 早至少 15 分钟**（不偷看未来）；某行被拒只丢那一行。报告链最早到前一天 06:30 那次那份（与实验同）。
- **过期就只记基线**：`player-values.json` 的 RAPM 超过 9 天或轮换超过 3 天（本机几天没开），`r22`/`r0630` 不记，`base` 照记。
- **请求量**：官方报告每次 capture ≤ 15、每天 ≤ 40（正常每次 1 个；S3 对不存在的文件回 403 AccessDenied XML，按「没有」跳过，别的 403 熔断），
  熔断状态在 `data-db/injury-fetch-state.json`。PBP：leaguegamelog 1 + commonallplayers 1 + 每场 2 个，
  一周约 50 场 ≈ 100 个，按天跑每天 15–30 个；显式上限每次 180 / 每天 500（与全量 ingest 共享单日计数），单次最多 80 场，剩下的下次续。
- **页面**：预测总表 → 统计 最下面「影子模式（不影响显示的预测）」卡片，`/api/shadow`（开启账号后匿名只回预告，查账本用 `docker exec dc-nba node scripts/shadow.mjs show`）。
- **切换（预注册）**：06:30 方案与基线配对满 300 场、Δ 对数损失 < 0（且没比基线差 0.005 以上）再提出切换，由高磊决定。

演练（本地副本，不碰线上）：`DB_PATH=/tmp/x.db SHADOW_NOW=2026-10-28T14:05:00Z node scripts/shadow.mjs capture`，`… show`。
GB10（`ssh lei@192.168.1.49`）：`systemctl --user list-timers dc-nba-player-values.timer`；日志 `~/dc-nba-logs/player-values.log`；手动跑 `systemctl --user start dc-nba-player-values.service`。单元文件在 `deploy/systemd/`，node 是用户级 `~/.local/opt/node`（v22）。关机错过的开机补跑，赶不上 22:00 就用前一天的值。Mac 上的 launchd 版已停用（macOS 不让 launchd 读 ~/Documents），plist 挪到 `~/Library/LaunchAgents/disabled/`。

Docker 镜像多了 `poppler-utils`：服务器连 `dl-cdn.alpinelinux.org` 会挂住，Dockerfile 默认换成 `mirrors.aliyun.com`（`APK_MIRROR` 构建参数）。

## 伤病感知 Elo 影子运行（inj-p1 / inj-a，`server/injuryEloShadow.mjs`）

依据 `docs/injury-aware-elo-verdict.md`；前向评估规则预注册在 `docs/superpowers/specs/2026-10-29-injury-elo-shadow-prereg.md`。
**只记录**：线上预测、页面、账本规则、所有参数都不变。挂在上面那套影子运行的同一次 `capture` / `settle` 里，出错只记日志，不影响 base / r22 / r0630 / rr。

| 方案 | 何时记（北京） | 内容 |
| --- | --- | --- |
| `inj-p1-22` / `inj-p1-0630` | 22:00 / 06:30（06:30 前开打的场在 22:00 记 0630） | base 净胜分 − 0.5·(D_pre主 − D_pre客)。D_pre = 健康基线 × 收缩 IMP × P(出场 \| 报告状态) |
| `inj-a-22` / `inj-a-0630` | 同上 | base + (伤病感知 Elo 差 − 线上 Elo 差)/28 − 0.75·ΔD_pre |

- 主变体是 `*-0630`。base 用 22:00 记下的那行（`base_source = shadow-base`），没有就用此刻线上预测（`live`）。
- **冻结参数** `server/injury-elo-params-v1.json`：`INJURY_ELO_FREEZE=1 npm run lab:injury-elo` 写出（只写这个文件就退出，不改实验输出）。
  含 s / β、P(出场 | 状态)、2025-26 收缩 IMP、A 的开季 Elo（冻结时核对 D=0 时与 `teams.json` 的 `eloPreseasonExact` 逐位相同）。影子期内不改。
- **D_post 的数据**：`data/player-values.json` 的 `played`（每队全季逐场球员分钟），由 GB10 的 `scripts/player-values.mjs` 用它本来就抓的 PBP 生成，**不多发一个请求**。
  旧文件只有 `recent`（每队最近 12 场），代码照样能用，超过 12 场的比赛记为「缺」。
  每行记两队已赛场数 / 有出场数据的场数 / 缺的 gameId（`games_*`、`covered_*`、`dpost_coverage`、`inputs.home.missing`），缺数据不会悄悄当 0。
- **库**：新表 `shadow_inj_elo_predictions`（`openLedger` 启动时 `CREATE TABLE IF NOT EXISTS`，无迁移）。规则同另两张影子表：只追加、重复忽略、不能删、
  预测字段不能改、比分只写一次、开赛后插不进；另加：报告标注时间 ≤ `captured_at` − 15 分钟且早于开赛、`results_through < game_date`、
  player-values 生成时间与数据快照时间不晚于 `captured_at`、覆盖场数必填。没有开赛时间的场不记。
- **读数**：`/api/shadow` 的 `injElo` 字段（页面不显示）；`docker exec dc-nba node scripts/shadow.mjs show` 最后几行。
  共同结算场上 base / inj-p1-0630 / inj-a-0630 / rr0630 的 log loss 与 Brier，三组配对差按比赛日分块 bootstrap。
- **上线步骤**（需要批准；本分支没做）：
  1. 合并进 master、推到 origin（GB10 下一次跑会快进到它，开始写 `played`）。
  2. 按「手动上线代码」那一节：先打回滚标签，再 `git archive HEAD …` 解到服务器（新增 `server/injuryEloShadow.mjs`、`server/injury-elo-params-v1.json`），
     然后重建。家里宽带被 NBA 封着时不要用 `push-refresh.sh`，直接
     `ssh dev@gpu.tzspace.cn 'cd /home/dev/work/works/dc-nba && docker compose build -q && docker compose up -d'`。新表在容器启动时自动建。
  3. 下一次 22:00 刷新后看 `~/dc-nba/refresh.log` 里「伤病感知 Elo 影子」那一行：`出场数据 played`、`线上 Elo 核对差` ≤ 0.05。
     如果写的是 `recent`，说明 GB10 还没跑到新代码，12 场以内照样全覆盖。
- **回滚**：回退代码重建镜像即可。表留着不删（只追加，删不掉）；不再写入就是停了。

演练（本地副本，不碰线上）：拷一份 `server/ scripts/ package.json data/*.json` 到临时目录，
`DB_PATH=/tmp/x.db SHADOW_NO_FETCH=1 SHADOW_NOW=2026-10-29T14:05:00Z node scripts/shadow.mjs capture`，再 `--late`（`SHADOW_NOW=…T22:35:00Z`）与 `show`。

## 用户系统（2026-10-29 起）

手机号验证码登录（无密码）。**仓库的 `docker-compose.yml` 里 `ENABLE_ACCOUNTS: "0"`，默认关闭**；
是否上线由高磊决定。服务器上的 `docker-compose.yml` 与 `data-db/` 是服务器自己的，部署命令从不覆盖它们
（`git archive` 刻意不含 compose）——所以环境变量要**手工**加到服务器那份 compose，仓库版的改动不会自动过去。
新表 `CREATE TABLE IF NOT EXISTS`，加法迁移，旧镜像不读它们。

开启后，预测总表页用到的三个接口 `/api/predictions/summary`、`/api/paper`、`/api/shadow` 对未登录请求只回预告字段
（服务端裁剪）。其余接口不变。

### 1. 环境变量（代码实际读取的全部，只列名字与默认）

| 变量 | 说明 |
|---|---|
| `ENABLE_ACCOUNTS` | `"1"` 才开启账号；其它值或未设置 = 关闭 |
| `TENCENT_SMS_SECRET_ID`、`TENCENT_SMS_SECRET_KEY` | **机密**。缺任一个则国内短信通道关闭（`/api/health` 的 `sms.mainland` 为 `disabled…`） |
| `TENCENT_SMS_SDK_APP_ID`、`TENCENT_SMS_SIGN_NAME`、`TENCENT_SMS_TEMPLATE_ID`、`TENCENT_SMS_REGION` | 非机密，代码有默认值（应用 ID `1400683809`、签名「上海磊宁科技有限公司」、模板 `1417875`、`ap-guangzhou`） |
| `TENCENT_SMS_PARAM2` | 模板第二个变量，默认 `"5"`；设为空串 `""` 表示模板只有一个参数 |
| `SMS_PROVIDER` | **一般不设**。production 下：未设置或 `tencent` = 真发腾讯云；`console`、`disabled`、或任何无法识别的值 = 短信关闭（`console` 与无法识别的值还会在日志里打 `!! [sms]` 警告）。`console` 只在非 production 用于本地演练 |
| `SMS_DAILY_CAP`、`SMS_IP_HOURLY`、`SMS_IP_DAILY` | 限额：全站每日（默认 500）、单 IP 每小时（默认 5）、单 IP 每天（默认 20）；「每天」按北京时间自然日 |
| `ENABLE_OVERSEAS_SMS` | `"1"` 且下面三个 Twilio 变量齐全才开海外号；默认关，区号只有 +86 |
| `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`、`TWILIO_VERIFY_SERVICE_SID` | **机密**（AUTH_TOKEN）；开通 Twilio Verify 后再加 |
| `TRUST_PROXY` | 默认不设；收窄的风险与写法见下「真实 IP」 |
| `ENABLE_LEADERBOARD` | 与账号的关系：为 `0` 时账号用自己独立的库结构，登录不绑定玩家档案；非 `0` 时与排行榜共用库，登录绑定 / 新建排行榜玩家档案 |

服务器那份 `docker-compose.yml` 的 `environment` 里手工加：

```yaml
      ENABLE_ACCOUNTS: "1"
      TENCENT_SMS_SECRET_ID: ${TENCENT_SMS_SECRET_ID}
      TENCENT_SMS_SECRET_KEY: ${TENCENT_SMS_SECRET_KEY}
      # 以下非机密，代码里有同样的默认值，写出来是为了一眼看清
      TENCENT_SMS_SDK_APP_ID: "1400683809"
      TENCENT_SMS_SIGN_NAME: 上海磊宁科技有限公司
      TENCENT_SMS_TEMPLATE_ID: "1417875"
      TENCENT_SMS_REGION: ap-guangzhou
      TENCENT_SMS_PARAM2: "5"          # 先到控制台核对模板 1417875 第二个变量的含义再定
      SMS_DAILY_CAP: "500"
      SMS_IP_HOURLY: "5"
      SMS_IP_DAILY: "20"
      ENABLE_OVERSEAS_SMS: "0"
      # TRUST_PROXY: "10.139.170.151, 172.18.0.0/16"   # 仅示例值，上线前必须按实际网络替换；不确定就不设（保持默认），见下「真实 IP」
      # 开通 Twilio 后再加：TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID: ${...}
```

**密钥只放服务器的 `/home/dev/work/works/dc-nba/.env`**（compose 自动读取），不进仓库、不进镜像（`.dockerignore` 已排除 `.env`）、
不贴聊天或工单。**不要把值写在命令行里**（`echo KEY=... >> .env`、`export`、`docker compose run -e KEY=...` 都会进 shell 历史或 argv）：
用编辑器打开（`vi .env`）手工粘贴，然后 `chmod 600 .env`；注意 `docker compose config` 会把 `.env` 的值展开打印出来，别运行后贴输出。

### 2. 真实 IP（TRUST_PROXY）

按 IP 限频依赖 `req.ip`。默认值 `loopback, linklocal, uniquelocal` 会信任 `works-net` 上所有同网容器，
理论上别的作品容器能伪造 `X-Forwarded-For` 绕过限频；但**收窄有风险**：访问链路是 Traefik → works-gateway(nginx) → 本容器，
如果只信任 works-gateway，而 nginx 又是把 Traefik 那一跳的地址追加进 XFF，`req.ip` 就会变成 Traefik 那一跳，
**所有访客共用一个限频桶**。所以：

- **除非验证过，否则保持默认值，不设 `TRUST_PROXY`。**
- 要收窄时，受信列表必须包含访客与本容器之间的**每一个**代理跳：Traefik / 宿主机那一跳（例如 `10.139.170.151` 或其所在子网）
  加上 works-gateway 所在的 `works-net` 子网。优先写**子网**而不是单个容器 IP（容器重建后 IP 会变）。
- works-gateway 的 nginx 配置**不在本仓库**，是否透传 / 追加 `X-Forwarded-For` 要先到服务器上看过配置再定。
- 只接受 IP / 子网列表；`1`、`true` 这类值会让服务启动即崩溃。
- 验收就是下面的 `proxy.ip` 检查：它不是你的公网 IP，就调整列表（或回到默认值）。

上线后核验（同时确认网关确实透传了 `X-Forwarded-For`）：

```bash
curl -s https://ai.tzspace.cn/works/dc-nba/api/health -H 'Cookie: probe=1' | grep -o '"proxy":{[^}]*}'
curl -s ifconfig.me          # 在你自己的网络上跑：proxy.ip 必须等于你的公网 IP；否则按 IP 限频无效或全站共用一个桶，调整 TRUST_PROXY（或回到默认）并检查网关 nginx 的 XFF 配置
```

`proxy.cookieSeen` 只检验**请求方向**（网关是否把 Cookie 头传给应用），不检验响应里的 `Set-Cookie` 是否被剥掉；
`false` 只说明请求方向的 Cookie 被去掉了，不能据此断言「双向剥离」（本方案用 Bearer，不影响实现，只影响文档措辞）。

### 3. 上线前检查清单（用户自己确认）

- [ ] 腾讯云短信密钥**已轮换**（旧密钥曾进过 Gitee，视为泄露；新密钥只进服务器 `.env`）。
- [ ] 控制台里模板 `1417875` 的**第二个参数**含义已核对，并据此设好 `TENCENT_SMS_PARAM2`（`"5"` 即「5 分钟」；若模板只有一个参数则设为 `""`）。签名与模板仍为「已通过」；短信套餐有余量；在腾讯云控制台另设发送频率限制与余额告警，作为第二道防线。
- [ ] **用真密钥做一次真实 SendSms 冒烟**，发到团队成员的手机：这是 TC3 签名唯一的外部验证（单测只能验到自己算的签名）。
- [ ] 审阅并补全《用户协议》《隐私政策》草稿（`web/src/legal/zh.js`、`en.js`）里的占位：中文的 `【待用户填写】` / `【待用户确认】`，英文的 `[TO BE FILLED BY OWNER …]` / `[TO BE CONFIRMED BY OWNER …]` 标记（以文件内实际标记为准，grep `TO BE`）。并**决定数据保留期**：`sms_sends` 由触发器保证只追加，任何清理都需要另行设计、单独审批的变更（放开删除条件），上线时隐私政策里写的保留期必须与实际做法一致。
- [ ] 决定预告的暴露面：未登录时 `/api/predictions/summary` 只回 `summary[0]` / `summaryMsg[0]` 与 `teaser: {completed, remaining}`
（`server/entitlements.mjs` 的 `teaserBoard`）。`summary[0]` 在本季已有完赛时就是「本季常规赛已结束 N 场，我们的模型赛前猜对 X 场、猜错 Y 场，
准确率 …（95% 置信区间 …），Brier …、对数损失 …」，即**总体准确率、置信区间、Brier 与对数损失都是公开的**（赛季刚开打时则是「还没有已结束的比赛」）；
`completed` = 已完赛场数，`remaining` = 剩余场数。确认这些可以公开。
- [ ] 知道现有缺口：没有任何东西主动推送 `/api/health` 的 `alarms`（如 `sms.dailyCapReached`）和日志里的 `!! [sms]`；需要通知的话另起任务（例如 `deploy/refresh.sh` 收尾时读 `/api/health` 写进 `refresh.log`，或接企业微信 / 邮件）。

### 4. 上线步骤（需用户逐步确认后才执行）

避开北京时间 06:30 / 14:30 / 22:00 三个 cron 前后各 30 分钟，以及本机 23:00 的全量推送。

**先带着 `ENABLE_ACCOUNTS=0` 发新代码**，确认没有副作用，再开：

```bash
# 1) 回滚点 + 库备份（备份用 VACUUM INTO，不要 cp 正在写的 SQLite）
ssh dev@gpu.tzspace.cn 'docker tag dc-nba-dc-nba:latest dc-nba-dc-nba:pre-accounts'
ssh dev@gpu.tzspace.cn 'docker exec -e KEEP=100000 dc-nba node scripts/backup-db.mjs /app/data-db/keep'   # 容器内跑（DB_PATH 来自 compose）；KEEP=100000 使 keep/ 实际不轮转（默认只留最近 7 份）
# 2) 先把 user-system 合并进 master，再发代码（HEAD，不含 docker-compose.yml 与 data-db/）
git archive HEAD server scripts deploy web docs package.json package-lock.json Dockerfile .dockerignore README.md | ssh dev@gpu.tzspace.cn 'tar -x -m -C /home/dev/work/works/dc-nba'
ssh dev@gpu.tzspace.cn 'cd /home/dev/work/works/dc-nba && docker compose build && docker compose up -d'
```

3) **关闭态验证**：`/api/predictions/summary`、`/api/paper`、`/api/shadow` 返回与上线前一致（仍是全量公开）；`/api/meta` 的
`features.accounts.enabled` 为 `false`；原有各表行数与上线前一致（容器内没有 sqlite3 命令行，用 node）：

```bash
ssh dev@gpu.tzspace.cn "docker exec dc-nba node -e \"const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DB_PATH,{readOnly:true});for(const t of ['paper_bets','shadow_predictions','shadow_rr_predictions','shadow_inj_elo_predictions','players','live_picks'])console.log(t,d.prepare('SELECT COUNT(*) n FROM '+t).get().n)\""
```

（上线前先跑一遍留底，上线后再跑对比；新增的账号表应为空。）
4) 到服务器上编辑 `.env`（写密钥，`chmod 600`）和 `docker-compose.yml`（加上面那段，`ENABLE_ACCOUNTS` 改 `"1"`，如需收窄再设 `TRUST_PROXY`），`docker compose up -d`。
5) **开启态验证**：

```bash
curl -s https://ai.tzspace.cn/works/dc-nba/api/meta   | grep -o '"accounts":{[^}]*}'   # enabled:true, overseas:false
curl -s https://ai.tzspace.cn/works/dc-nba/api/health | grep -o '"sms":{[^}]*}'        # mainland:"tencent"
curl -s https://ai.tzspace.cn/works/dc-nba/api/health | grep -o '"alarms":[^]]*]'      # 无 sms.dailyCapReached
curl -s https://ai.tzspace.cn/works/dc-nba/api/paper | head -c 200                     # locked:true
```

再核对第 2 节的 `proxy.ip`，最后用**团队成员的手机**端到端登录一次（收到短信、有效期与 5 分钟一致、登录后三个接口返回全量、退出后恢复预告）。

### 5. 运维变化

开启账号后 `/api/paper`、`/api/shadow` 匿名只回预告，查账本与影子改用
`docker exec dc-nba node scripts/ledger.mjs show` / `docker exec dc-nba node scripts/shadow.mjs show`。
`/api/health` 的 `alarms` 出现 `sms.dailyCapReached` 表示当日已停发。

### 6. 回滚

- 只关登录、保留新代码：服务器 compose 改 `ENABLE_ACCOUNTS: "0"` 后 `docker compose up -d`（三个接口恢复全公开）。
- 回退代码：`docker tag dc-nba-dc-nba:pre-accounts dc-nba-dc-nba:latest && docker compose up -d --no-build`。
- 新表是加法迁移，旧镜像不读，**不用动库**，也不要删表；万一要还原库，用上线前 `keep/` 里的备份。
