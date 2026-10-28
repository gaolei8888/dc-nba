#!/bin/sh
# 本机每天一次：抓本季新结束比赛的 play-by-play、每 7 天重拟合 RAPM，把 player-values.json 推到服务器 data/。
# 服务器北京 22:00 / 06:30 那两次刷新会把它烤进镜像，影子运行（scripts/shadow.mjs）读它。
#
#   sh deploy/player-values.sh
#
# 由 launchd 调用（deploy/cn.tzspace.dc-nba.player-values.plist）：本机是 America/Los_Angeles，
# launchd 只认本机时区，北京 21:15 在夏令时是本地 06:15、冬令时是 05:15——两个都排上，
# 「北京今天 14:00 之后已经推过」就跳过（14:00 前美东前一晚的比赛未必都打完，那时推的不算数，后面还会再推）。
# 本机睡着错过了，launchd 醒来补跑一次；服务器端过期（RAPM > 9 天、轮换 > 3 天）就只记基线。
#
# 请求上限显式给出（nbaClient → politeFetch）：单次 180、单日 500；与全量 ingest 共用状态文件里的单日计数。
set -eu

REMOTE=${DC_NBA_REMOTE:-dev@gpu.tzspace.cn}
RDIR=${DC_NBA_REMOTE_DIR:-/home/dev/work/works/dc-nba}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20${DC_NBA_SSH_KEY:+ -i $DC_NBA_SSH_KEY}"
cd "$(dirname "$0")/.."
NODE=${DC_NBA_NODE:-node}
OUT=data/history/shadow/player-values.json
STAMP=data/history/shadow/.pushed-day

log() { echo "[$(date '+%F %T')] [values] $*"; }

DAY=$(TZ=Asia/Shanghai date +%F)
HOUR=$(TZ=Asia/Shanghai date +%H)
if [ "$(cat "$STAMP" 2>/dev/null || true)" = "$DAY" ]; then
  log "北京 ${DAY} 已推过，跳过"
  exit 0
fi

log "开始（北京 $(TZ=Asia/Shanghai date '+%F %H:%M')）"
s=0
NBA_MAX_REQUESTS=${NBA_MAX_REQUESTS:-180} NBA_MAX_PER_DAY=${NBA_MAX_PER_DAY:-500} $NODE scripts/player-values.mjs || s=$?
# 3 = 中途被拦或到上限，文件仍是完整可用的（少几场），照推
if [ "$s" != 0 ] && [ "$s" != 3 ]; then log "生成失败（$s），不推送"; exit 1; fi
[ -s "$OUT" ] || { log "没有 $OUT"; exit 1; }

# 拿服务器刷新同一把锁再替换，免得 refresh.sh 拷数据拷到一半
$SSH "$REMOTE" "flock -w 900 $RDIR/.refresh.lock sh -c 'cat > $RDIR/data/player-values.json.tmp && mv $RDIR/data/player-values.json.tmp $RDIR/data/player-values.json'" < "$OUT"
log "已推送到 ${REMOTE}:${RDIR}/data/player-values.json"
[ "$HOUR" -ge 14 ] && echo "$DAY" > "$STAMP"
log "完成"
