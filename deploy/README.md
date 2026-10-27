# 部署与数据刷新

线上：`gpu.tzspace.cn` 的 `/opt/works/dc-nba/` → https://ai.tzspace.cn/works/dc-nba/

数据快照烤在镜像里，更新数据 = 换 `data/*.json` + 重建镜像。
2026-27 赛季起由 `deploy/refresh.sh` 每天自动做一次（为什么改成自动，见主 README「部署说明」）。

## 服务器上的部署目录不是 git 工作区的镜像

**不要整目录覆盖，也不要 `git pull` 了事。** 服务器那份 `docker-compose.yml` 改过：
`ENABLE_LEADERBOARD: "1"`，带日期注释（2026-09-07 高磊选择开启、不加备份）。
仓库里保持 `"0"`。覆盖它会让排行榜静默关闭。

`data-db/` 是线上排行榜的 SQLite 卷，同样不能动。

## 首次安装定时刷新

在本机（仓库根目录）：

```bash
# 1. 代码：只同步刷新需要的目录，不碰 docker-compose.yml
scp -r server scripts deploy package.json package-lock.json Dockerfile .dockerignore \
    dev@gpu.tzspace.cn:/opt/works/dc-nba/

# 2. history：ingest 算 APM、实验室数据集都要它，镜像里没有（.dockerignore 排除了）
#    约 21MB，只需同步一次；之后 refresh.sh 在服务器上自己维护
scp -r data/history dev@gpu.tzspace.cn:/opt/works/dc-nba/data/
```

在服务器上：

```bash
cd /opt/works/dc-nba
chmod +x deploy/refresh.sh

# 3. 先只抓不部署——确认这台机器能连上 stats.nba.com。
#    很多云主机 IP 被 stats.nba.com 拒绝或挂起；这一步不通，cron 就不该装。
deploy/refresh.sh --fetch-only

# 4. 通了再完整跑一次，看着它重建、过健康检查
deploy/refresh.sh

# 5. 装 cron（crontab -e）。时间按服务器时区写，先 `date` 确认。
#    美西最晚的比赛约 UTC 07:30 结束，UTC 10:00（北京 18:00）时数据已稳定。
0 18 * * * /opt/works/dc-nba/deploy/refresh.sh >> /opt/works/dc-nba/refresh.log 2>&1
```

日志写在部署目录里，**不要写 `/var/log/`**——普通用户写不进去，cron 的 `>>` 打不开文件时
整条任务直接不跑，且不留任何错误（备份 cron 踩过一次）。

## 怎么确认它真的在跑

不要看 crontab，看结果：

```bash
curl -s https://ai.tzspace.cn/works/dc-nba/api/meta    # fetchedAt 应是今天
tail -30 /opt/works/dc-nba/refresh.log
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
cd /opt/works/dc-nba
cp data-prev/*.json data/ && docker compose build && docker compose up -d
```

## 停掉自动刷新

`crontab -e` 删掉那一行即可。镜像和数据保持最后一次成功刷新时的样子。
