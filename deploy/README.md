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
| 服务器 cron | 每天 14:30、22:00（北京） | `refresh.sh --espn`：比分、Elo、赛前 Elo、战绩、伤病、盘口 | 只要 ESPN |
| 本机计划任务「dc-nba 全量刷新」 | 每天 08:00 太平洋（北京 23:00），错过则开机补跑 | `push-refresh.sh`：本机全量 ingest → 推到服务器 `incoming/` → 远程 `refresh.sh --incoming` | 这台电脑开机 |

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

- 服务器：`crontab -e`，删掉 `dc-nba/deploy/refresh.sh --espn` 那两行
- 本机：`Unregister-ScheduledTask -TaskName 'dc-nba 全量刷新'`（PowerShell），或在「任务计划程序」里删

镜像和数据保持最后一次成功刷新时的样子。
