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
