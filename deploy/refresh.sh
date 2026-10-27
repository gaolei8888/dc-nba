#!/bin/sh
# 线上数据定时刷新：抓数据 → 体检 → 换快照 → 重建镜像 → 健康检查，失败自动回滚。
#
# 放在服务器部署目录下（与 docker-compose.yml 同级的 deploy/ 里），由 cron 调用：
#
#   0 18 * * * /opt/works/dc-nba/deploy/refresh.sh >> /opt/works/dc-nba/refresh.log 2>&1
#
#   deploy/refresh.sh --fetch-only   只抓取并体检，不动线上（首次部署先用它测网络）
#
# 设计要点：
#   1. 抓取在临时目录里进行，不碰线上 data/。stats.nba.com 被限流时是挂起而不是报错，
#      抓到一半失败的话，线上快照必须原封不动。
#   2. 体检不过就不换。check-data.mjs 防量纲错误，另外校验 30 队、赛程非空、meta 是刚写的。
#   3. 换快照前留一份 data-prev/，新容器健康检查不过就换回去再建一次。
#   4. flock 防止上一次还没跑完（比如在等限流解除）就叠上第二次。
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd)
CONTAINER=dc-nba
NODE_IMAGE=node:22-alpine
# 正常 1 分钟内抓完；被限流时 nbaClient 会反复重试，给足但要有上限
INGEST_TIMEOUT=1800
FETCH_ONLY=0
[ "${1:-}" = "--fetch-only" ] && FETCH_ONLY=1

log() { echo "[$(date '+%F %T')] $*"; }

exec 9>"$DIR/.refresh.lock"
if ! flock -n 9; then
  log "上一次刷新还在跑，跳过"
  exit 0
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

log "开始刷新（$DIR）"
if [ ! -d "$DIR/data/history" ]; then
  log "缺少 data/history/：IMP 会退化成纯统计栏、实验室数据集会被跳过。先同步一次 history 再跑"
  exit 1
fi

# 只拷 ingest 需要的东西：代码 + 快照 + history。不拷 app.db、备份。
mkdir -p "$STAGE/data"
cp -r "$DIR/server" "$DIR/scripts" "$DIR/package.json" "$STAGE/"
cp "$DIR"/data/*.json "$STAGE/data/"
cp -r "$DIR/data/history" "$STAGE/data/"

# ingest 只依赖 node 内置模块，不需要 npm install
log "抓取数据"
if ! timeout "$INGEST_TIMEOUT" docker run --rm --user "$(id -u):$(id -g)" \
    -v "$STAGE:/app" -w /app "$NODE_IMAGE" node scripts/ingest.mjs; then
  log "抓取失败或超时，线上数据未改动"
  exit 1
fi

log "数据体检"
docker run --rm --user "$(id -u):$(id -g)" -v "$STAGE:/app" -w /app "$NODE_IMAGE" \
  node scripts/check-data.mjs
docker run --rm --user "$(id -u):$(id -g)" -v "$STAGE:/app" -w /app "$NODE_IMAGE" node -e '
  const fs = require("fs");
  const j = (f) => JSON.parse(fs.readFileSync("data/" + f, "utf8"));
  const teams = j("teams.json"), sched = j("schedule.json"), meta = j("meta.json");
  const games = sched.games ?? sched;
  const age = Date.now() - Date.parse(meta.fetchedAt);
  const bad = [];
  if (teams.length !== 30) bad.push(`球队 ${teams.length} 支`);
  if (!games.length) bad.push("赛程为空");
  if (!(age < 3600e3)) bad.push(`meta.fetchedAt=${meta.fetchedAt} 不是刚写的`);
  if (bad.length) { console.error("体检不过：" + bad.join("；")); process.exit(1); }
  console.log(`  ${meta.targetSeason} 已吸收 ${meta.gamesPlayedCurrent} 场，截至 ${meta.lastResultDate}`);
'

if [ "$FETCH_ONLY" = 1 ]; then
  log "--fetch-only：抓取与体检通过，未部署"
  exit 0
fi

log "替换快照（旧的留在 data-prev/）"
rm -rf "$DIR/data-prev"
mkdir -p "$DIR/data-prev"
cp "$DIR"/data/*.json "$DIR/data-prev/"
cp "$STAGE"/data/*.json "$DIR/data/"

healthy() {
  i=0
  while [ $i -lt 24 ]; do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
    [ "$s" = healthy ] && return 0
    sleep 5
    i=$((i + 1))
  done
  return 1
}

cd "$DIR"
if docker compose build && docker compose up -d && healthy; then
  log "完成"
  exit 0
fi

log "新版本不健康，回滚到 data-prev/"
cp "$DIR"/data-prev/*.json "$DIR/data/"
docker compose build && docker compose up -d && healthy && log "已回滚" || log "回滚后仍不健康，需要人工处理"
exit 1
