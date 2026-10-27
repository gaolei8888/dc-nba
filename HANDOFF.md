# HANDOFF：自动刷新与 GB10（2026-10-27）

接手前先读 [deploy/README.md](deploy/README.md)「自动刷新是怎么搭起来的」。这份只写**现状、没做完的事、怎么做完**。

## 一句话现状

线上（https://ai.tzspace.cn/works/dc-nba/）已是最新数据，自动刷新两条线在跑；
**GB10 装到最后一步停住了**——办公室出口 IP 被 NBA 临时限流，`setup-gb10.sh` 的「NBA 返回 JSON」检查过不去。

## 正在运行的

| 什么 | 在哪 | 时间 | 状态 |
| --- | --- | --- | --- |
| ESPN 刷新（比分/Elo/赛前预测/战绩/伤病/盘口） | gpu 服务器 crontab，`deploy/refresh.sh --espn` | 每天 14:30、22:00 北京 | 已装，服务器上实测通过 |
| 全量推送（另加球员/球队统计、IMP） | 本机 Windows 计划任务「dc-nba 全量刷新」，`deploy/push-refresh.sh` | 每天 08:00 PT，错过开机补跑 | 已装，计划任务环境实测返回 0 |
| 网站 | gpu 服务器 docker 容器 `dc-nba` | — | 健康；最新全量数据是 2026-10-27 08:01 PT 抓的 |

## 没做完的：GB10 接替本机做全量推送

**为什么要换**：本机要开机才跑；GB10（`lei@192.168.1.49`，主机名 dc-llm-gb10，aarch64，PDT，办公室宽带）一直开着。
**两台共用同一个公网出口 IP**，所以装好 GB10 后必须删掉本机计划任务——同一个 IP 每天抓两次更容易被限流。

已经做好的：

- [x] GB10 上生成专用密钥 `~/.ssh/dc_nba`，公钥已加到 `dev@gpu.tzspace.cn`，带 `from=` 限制只能从办公室出口 IP 用；实测 GB10 → 服务器能登录
- [x] 服务器原 `authorized_keys` 备份在 `~/.ssh/authorized_keys.bak-20261027`
- [x] GB10 没装 node，用 docker 的 `node:22-alpine`（已 pull，v22.23.4）；没往 GB10 装任何系统软件
- [x] 刷新代码 + `data/`（含 21MB 的 `history/`）已放在 GB10 的 `~/dc-nba-refresh`（commit e568bc6 的版本）

剩下的，**在能连到 192.168.1.49 的机器上**：

```bash
# 1. 确认限流解除了：必须打印出 {"resource":   —— 空的或 HTML 都是还没解除
ssh lei@192.168.1.49 'curl -s -m 30 --compressed -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" -H "Referer: https://www.nba.com/" -H "Origin: https://www.nba.com" -H "x-nba-stats-origin: stats" -H "x-nba-stats-token: true" "https://stats.nba.com/stats/leaguestandingsv3?LeagueID=00&Season=2026-27&SeasonType=Regular%20Season" | head -c 12'

# 2. 检查并装 cron（默认 00:30 PT = 北京 15:30，在服务器 ESPN 刷新之后）
ssh lei@192.168.1.49 'cd ~/dc-nba-refresh && sh deploy/setup-gb10.sh'

# 3. 照第 2 步最后打印的命令试跑一次完整推送（会更新线上），确认以「[push] 完成」结尾

# 4. 成功后删掉本机计划任务（PowerShell）
Unregister-ScheduledTask -TaskName 'dc-nba 全量刷新' -Confirm:$false
```

第 2 步任何一项检查不过都会停下、不改动任何东西。第 2 项失败 = 还在限流，过一阵再试（实测一般几十分钟，最晚隔天）。

验收：`curl -s https://ai.tzspace.cn/works/dc-nba/api/meta` 里 `statsFetchedAt` 是当天，且服务器 `refresh.log` 末尾是 `[incoming] 完成`。

## 必须知道的坑

1. **NBA 封机房 IP。** gpu 服务器（200 但返回首页 HTML）、metaclue.net（洛杉矶机房，403/挂起）都抓不了；只有宽带能抓。判断要看返回是不是 JSON，**不看状态码**。
2. **限流是挂起，不是 429。** 一个 IP 一天内全量抓七八次就会触发（今天就是这么来的）。正常每天一次没问题。
3. **别在定时任务运行时改 `deploy/*.sh`。** `sh` 边读边执行，今天两次因此报语法错误（线上没受影响）。避开 08:00 PT、14:30/22:00 北京，以及 GB10 装好后的 00:30 PT。
4. **代码上线是手动的**，自动刷新只推数据。步骤见 deploy/README.md「手动上线代码」。**不要把仓库的 `docker-compose.yml` 发到服务器**——服务器那份开着排行榜（`ENABLE_LEADERBOARD: "1"`），仓库里是 `"0"`。
5. **服务器拉 `node:22-alpine` 会挂住**（镜像源问题）。已经手动 `docker save | docker load` 进去，别 `docker image prune -a`。

## 回滚

- 网站：服务器上 `docker image ls dc-nba-dc-nba` 能看到 `pre-*` 标签（`pre-incoming0800` 是最近一个），`docker tag dc-nba-dc-nba:<标签> dc-nba-dc-nba:latest && docker compose up -d --no-build`
- 数据：`cp data-prev/*.json data/ && docker compose build && docker compose up -d`
- 停自动刷新：服务器 `crontab -e` 删 `refresh.sh --espn` 两行；GB10 `crontab -e` 删 `push-refresh.sh` 一行；本机删计划任务
- 收回 GB10 的服务器权限：服务器 `~/.ssh/authorized_keys` 里删注释为 `dc-nba-gb10` 的那行

## 今天改了什么（都在 master 上）

赛季切到 2026-27 显示；IMP 用上季 + 本季加权（K=20，**未验证**）；「今日比赛」页；已结束比赛显示赛前预测 vs 实际与命中率（用赛前 Elo 重算，避免事后诸葛亮）；ESPN 刷新与全量推送两条线。细节看 `git log f254556..HEAD`。
