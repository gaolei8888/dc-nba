#!/bin/sh
# 在能访问 stats.nba.com 的机器上（本机 / GB10）全量抓取，推到线上服务器部署。
#
#   sh deploy/push-refresh.sh
#
# 线上服务器的 IP 被 NBA 封了，全量数据只能在别处抓。这个脚本负责：
#   本地 ingest → 本地体检 → 上传到服务器 incoming/ → 远程 refresh.sh --incoming
# 服务器那边会再体检一次、用 ESPN 补上抓取之后才打完的比分、切换、健康检查、失败回滚。
#
# **只推数据，不推代码。** 代码上线仍然手动做（见 deploy/README.md）——
# 否则本地任何一次没准备好的改动都会被定时任务自动推上线。
#
# 需要：node ≥ 22（或 DC_NBA_NODE 指向 docker 里的 node，见 setup-gb10.sh）、
#       ssh 免密登录服务器、仓库里有 data/history/（ingest 算 IMP 要用）。
set -eu

REMOTE=${DC_NBA_REMOTE:-dev@gpu.tzspace.cn}
RDIR=${DC_NBA_REMOTE_DIR:-/home/dev/work/works/dc-nba}
# 专用密钥（GB10 上用它自己的一把，不动 ~/.ssh 里的默认钥匙）
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20${DC_NBA_SSH_KEY:+ -i $DC_NBA_SSH_KEY}"
cd "$(dirname "$0")/.."
NODE=${DC_NBA_NODE:-node}

log() { echo "[$(date '+%F %T')] [push] $*"; }

log "开始（推送到 ${REMOTE}）"
if [ ! -d data/history ]; then
  log "缺少 data/history/，ingest 算不出完整的 IMP，停止"
  exit 1
fi

log "抓取数据（stats.nba.com）"
$NODE scripts/ingest.mjs > "${TMPDIR:-/tmp}/dc-nba-ingest.log" 2>&1 || {
  tail -20 "${TMPDIR:-/tmp}/dc-nba-ingest.log"
  log "抓取失败，线上未改动"
  exit 1
}
grep -E "已吸收|用时" "${TMPDIR:-/tmp}/dc-nba-ingest.log" || true

log "本地体检"
$NODE scripts/check-data.mjs > /dev/null || { $NODE scripts/check-data.mjs; log "体检不过，不推送"; exit 1; }

log "上传"
tar -c data/*.json | gzip -1 | $SSH "$REMOTE" \
  "mkdir -p '$RDIR/incoming' && rm -f '$RDIR'/incoming/*.json && gunzip | tar -x -m -C '$RDIR/incoming' --strip-components=1"

log "远程部署"
# 管道会吞掉 refresh.sh 的退出码，所以先写日志、再单独取状态
$SSH "$REMOTE" \
  "cd '$RDIR' && n=\$(wc -l < refresh.log 2>/dev/null || echo 0); sh deploy/refresh.sh --incoming >> refresh.log 2>&1; s=\$?; tail -n +\$((n + 1)) refresh.log | grep '^\['; exit \$s" \
  || { log "服务器部署失败（线上已回滚或未改动，详见服务器 refresh.log）"; exit 1; }
log "完成"
