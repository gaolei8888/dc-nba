# HANDOFF：自动刷新与 GB10（2026-10-27）

接手前先读 [deploy/README.md](deploy/README.md)「自动刷新是怎么搭起来的」。这份只写**现状、没做完的事、怎么做完**。

> 2026-11-03 更新：最新进展看 [docs/HANDOFF-2026-10-27.md](docs/HANDOFF-2026-10-27.md) 末尾。

## 换电脑接手先看这里

- `git clone git@github.com:gaolei8888/dc-nba.git`，读这份文件即可接上。原电脑上的 Claude 记忆不会跟过来，要点都已写在这里和 deploy/README.md。
- **新电脑的 SSH 公钥要先加到服务器**才能部署：在一台已能登录的机器上把它追加到 `dev@gpu.tzspace.cn:~/.ssh/authorized_keys`。
- **连 GB10 要在办公室局域网里**（`192.168.1.49`），同样要先把新电脑的公钥加进 GB10 的 `~/.ssh/authorized_keys`。
- `data/history/` 大部分不在 git 里（只有 `stints_*.json.gz`）。

## 一句话现状

全量推送 2026-11-03 起由 GB10 的 systemd 定时器做（每天北京 15:30），不再依赖个人电脑；Windows 计划任务退役，由高磊手动删除。

## 正在运行的

| 什么 | 在哪 | 时间（北京） | 状态 |
| --- | --- | --- | --- |
| ESPN 刷新（比分/Elo/赛前预测/战绩/联盟排名/伤病/盘口） | gpu 服务器 crontab，`deploy/refresh.sh --espn` | 每天 06:30、14:30、22:00 | 在跑 |
| 全量推送（另加球员/球队统计、IMP） | GB10 `dc-nba-full-push.timer`，`~/dc-nba`，`deploy/push-refresh.sh` | 每天 15:30 | 已启用；**首次定时运行是 2026-11-04 15:30，当时还没真跑过** |
| player-values（PBP + RAPM） | GB10 `dc-nba-player-values.timer` | 每天 19:15 / 20:15 | 在跑 |
| 网站 | gpu 服务器 docker 容器 `dc-nba` | — | 健康 |

验收全量推送：`curl -s https://ai.tzspace.cn/works/dc-nba/api/meta` 里 `statsFetchedAt` 是当天，GB10 `~/dc-nba-logs/full-push.log` 末尾是 `[push] 完成`。

GB10（`lei@192.168.1.49`，主机名 dc-llm-gb10，aarch64，太平洋时区）与家里 Mac 共用一个公网出口 IP：同一个 IP 每天别全量抓两次。

## 必须知道的坑

1. **NBA 封机房 IP。** gpu 服务器（200 但返回首页 HTML）、metaclue.net（洛杉矶机房，403/挂起）都抓不了；只有宽带能抓。判断要看返回是不是 JSON，**不看状态码**。
2. **限流是挂起，不是 429。** 一个 IP 一天内全量抓七八次就会触发（今天就是这么来的）。正常每天一次没问题。
3. **别在定时任务运行时改 `deploy/*.sh`。** `sh` 边读边执行，今天两次因此报语法错误（线上没受影响）。避开北京 06:30 / 14:30 / 22:00 和 GB10 的 15:30。
4. **代码上线是手动的**，自动刷新只推数据。步骤见 deploy/README.md「手动上线代码」。**不要把仓库的 `docker-compose.yml` 发到服务器**——服务器那份开着排行榜（`ENABLE_LEADERBOARD: "1"`），仓库里是 `"0"`。
5. **服务器拉 `node:22-alpine` 会挂住**（镜像源问题）。已经手动 `docker save | docker load` 进去，别 `docker image prune -a`。

## 回滚

- 网站：服务器上 `docker image ls dc-nba-dc-nba` 能看到 `pre-*` 标签（`pre-incoming0800` 是最近一个），`docker tag dc-nba-dc-nba:<标签> dc-nba-dc-nba:latest && docker compose up -d --no-build`
- 数据：`cp data-prev/*.json data/ && docker compose build && docker compose up -d`
- 停自动刷新：服务器 `crontab -e` 删 `refresh.sh --espn` 两行；GB10 `systemctl --user disable --now dc-nba-full-push.timer`；Windows 计划任务还没删的话删掉
- 收回 GB10 的服务器权限：服务器 `~/.ssh/authorized_keys` 里删注释为 `dc-nba-gb10` 的那行

## 今天改了什么（都在 master 上）

赛季切到 2026-27 显示；IMP 用上季 + 本季加权（K=20，**未验证**）；「今日比赛」页；已结束比赛显示赛前预测 vs 实际与命中率（用赛前 Elo 重算，避免事后诸葛亮）；ESPN 刷新与全量推送两条线。细节看 `git log f254556..HEAD`。
