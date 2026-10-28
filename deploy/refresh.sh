#!/bin/sh
# 线上数据刷新：取数据 → 体检 → 换快照 → 重建镜像 → 健康检查，失败自动回滚。
#
# 数据从哪来，三选一（体检、切换、回滚都走同一套）：
#
#   deploy/refresh.sh --espn       服务器自己用 ESPN 补比分/Elo/伤病/盘口（统计数据不动）。
#                                  这台服务器的 IP 被 NBA 封了，只能走这条，由 cron 每天跑。
#   deploy/refresh.sh --incoming   接收别处（本机 / GB10）推上来的全量数据：incoming/*.json。
#                                  由 deploy/push-refresh.sh 远程调用，推完立刻跑。
#   deploy/refresh.sh              在这里跑全量 ingest。要求能访问 stats.nba.com——
#                                  2026-10-27 起这台服务器不行，保留给以后换了网络或配了代理。
#   加 --fetch-only                只取数据、体检，不动线上。
#   加 --late                      账本按「临近开赛」身份记录（只记 edge3-late），给北京 06:30 那次用。
#                                  不加就是默认的早规则 edge0/3/6。身份由 cron 行显式给出，不按钟点猜。
#
# cron（服务器时区 CST）：
#   30 6 * * *  /home/dev/work/works/dc-nba/deploy/refresh.sh --espn --late >> /home/dev/work/works/dc-nba/refresh.log 2>&1
#   30 14 * * * /home/dev/work/works/dc-nba/deploy/refresh.sh --espn >> /home/dev/work/works/dc-nba/refresh.log 2>&1
#   0 22 * * *  /home/dev/work/works/dc-nba/deploy/refresh.sh --espn >> /home/dev/work/works/dc-nba/refresh.log 2>&1
#
# 设计要点：
#   1. 取数据在临时目录里进行，不碰线上 data/。抓到一半失败，线上快照原封不动。
#   2. 体检不过就不换。check-data.mjs 防量纲错误，另外校验 30 队、赛程非空、meta 是新写的。
#   3. 换快照前留一份 data-prev/，新容器健康检查不过就换回去再建一次。
#   4. flock 串行化：cron 的 ESPN 刷新和别处推来的全量刷新不会撞在一起。
#   5. 模拟投注账本（scripts/ledger.mjs）在新容器健康之后用 docker exec 跑：
#      取数据的临时目录和 node 容器里没有 data-db/，只有运行中的 dc-nba 挂着那份持久的 SQLite，
#      在别处写只会写进一份随即丢弃的副本。先结算（每场最多 1 个 ESPN 请求取 DK 收盘价），
#      再记录开赛前 14 小时内的比赛（用镜像里刚烤进去的 odds.json，零额外请求）。
#      放在 EXIT trap 里：取数失败、体检不过、回滚时也照跑（运行中的容器里还是上一份 odds.json，
#      账本会记下那份快照的时间）——否则 22:00 那次一失败，当晚的比赛就永远没记。
#      账本失败只记日志，不影响刷新结果；整个账本步骤限时 5 分钟，不会一直占着锁。
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd)
CONTAINER=dc-nba
NODE_IMAGE=node:22-alpine
# 正常 1 分钟内抓完；被限流时 nbaClient 会反复重试，给足但要有上限
INGEST_TIMEOUT=1800
MODE=ingest
FETCH_ONLY=0
LATE=
for a in "$@"; do
  case "$a" in
    --espn) MODE=espn ;;
    --incoming) MODE=incoming ;;
    --fetch-only) FETCH_ONLY=1 ;;
    --late) LATE=--late ;;
    *) echo "未知参数 $a"; exit 2 ;;
  esac
done

log() { echo "[$(date '+%F %T')] [$MODE] $*"; }
node_in() {
  docker run --rm --user "$(id -u):$(id -g)" -v "$STAGE:/app" -w /app "$NODE_IMAGE" "$@"
}

exec 9>"$DIR/.refresh.lock"
# 推送来的全量数据值得等一等；cron 的轻量刷新撞上了就跳过，下次再来
if [ "$MODE" = incoming ]; then
  flock -w 900 9 || { log "等锁超时，放弃"; exit 1; }
elif ! flock -n 9; then
  log "上一次刷新还在跑，跳过"
  exit 0
fi

ledger() {
  # shadow = 伤病报告影子运行（scripts/shadow.mjs）：同样在运行中的容器里写 data-db/，
  # capture 在 22:00 / 06:30（--late）那两次各抓 1 份官方报告、记预测；14:30 那次不在时点窗口，只结算
  for s in ledger shadow; do
    for c in settle capture; do
      # --late 只对 capture 有意义；$LATE 为空时不传
      # shellcheck disable=SC2086
      timeout 300 docker exec -e NODE_NO_WARNINGS=1 "$CONTAINER" node scripts/$s.mjs "$c" $([ "$c" = capture ] && echo $LATE) \
        || log "$s $c 失败（不影响线上）"
    done
  done
}

STAGE=$(mktemp -d)
# --fetch-only 不碰线上，账本也不跑
trap '[ "$FETCH_ONLY" = 1 ] || ledger; rm -rf "$STAGE"' EXIT

log "开始刷新（${DIR}）"
# 只拷取数据需要的东西：代码 + 快照。不拷 app.db、备份。
mkdir -p "$STAGE/data"
cp -r "$DIR/server" "$DIR/scripts" "$DIR/package.json" "$STAGE/"
cp "$DIR"/data/*.json "$STAGE/data/"

case "$MODE" in
  ingest)
    if [ ! -d "$DIR/data/history" ]; then
      log "缺少 data/history/：IMP 会退化成纯统计栏、实验室数据集会被跳过。先同步一次 history 再跑"
      exit 1
    fi
    cp -r "$DIR/data/history" "$STAGE/data/"
    log "抓取数据（stats.nba.com）"
    # ingest 只依赖 node 内置模块，不需要 npm install
    if ! timeout "$INGEST_TIMEOUT" docker run --rm --user "$(id -u):$(id -g)" \
        -v "$STAGE:/app" -w /app "$NODE_IMAGE" node scripts/ingest.mjs; then
      log "抓取失败或超时，线上数据未改动"
      exit 1
    fi
    ;;
  espn)
    log "ESPN 补比分 / Elo / 伤病 / 盘口"
    if ! timeout 600 docker run --rm --user "$(id -u):$(id -g)" \
        -v "$STAGE:/app" -w /app "$NODE_IMAGE" node scripts/espn-refresh.mjs; then
      log "ESPN 刷新失败，线上数据未改动"
      exit 1
    fi
    ;;
  incoming)
    if ! ls "$DIR"/incoming/*.json >/dev/null 2>&1; then
      log "incoming/ 里没有数据"
      exit 1
    fi
    log "使用推送来的全量数据"
    cp "$DIR"/incoming/*.json "$STAGE/data/"
    # 推送的数据可能比线上已有的比分旧（抓取之后 ESPN 又补了几场），再补一次。
    # 补不上不要紧，全量数据本身是完整的
    timeout 600 docker run --rm --user "$(id -u):$(id -g)" \
      -v "$STAGE:/app" -w /app "$NODE_IMAGE" node scripts/espn-refresh.mjs \
      || log "ESPN 补比分失败，只用推送的数据"
    ;;
esac

log "数据体检"
node_in node scripts/check-data.mjs
node_in node -e '
  const fs = require("fs");
  const j = (f) => JSON.parse(fs.readFileSync("data/" + f, "utf8"));
  const teams = j("teams.json"), sched = j("schedule.json"), meta = j("meta.json");
  const games = sched.games ?? sched;
  const age = Date.now() - Date.parse(meta.fetchedAt);
  const bad = [];
  if (teams.length !== 30) bad.push(`球队 ${teams.length} 支`);
  if (!games.length) bad.push("赛程为空");
  // 推送的数据从抓取到这里要经过上传，给 3 小时余量
  if (!(age < 3 * 3600e3)) bad.push(`meta.fetchedAt=${meta.fetchedAt} 不是新写的`);
  if (bad.length) { console.error("体检不过：" + bad.join("；")); process.exit(1); }
  console.log(`  ${meta.targetSeason} 已结束 ${meta.gamesPlayedCurrent} 场，截至 ${meta.lastResultDate}`
    + `；统计数据 ${String(meta.statsFetchedAt ?? meta.fetchedAt).slice(0, 10)}`);
'

if [ "$FETCH_ONLY" = 1 ]; then
  log "--fetch-only：取数据与体检通过，未部署"
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
if docker compose build -q && docker compose up -d && healthy; then
  [ "$MODE" = incoming ] && rm -f "$DIR"/incoming/*.json
  log "完成"
  exit 0
fi

log "新版本不健康，回滚到 data-prev/"
cp "$DIR"/data-prev/*.json "$DIR/data/"
docker compose build -q && docker compose up -d && healthy && log "已回滚" || log "回滚后仍不健康，需要人工处理"
exit 1
