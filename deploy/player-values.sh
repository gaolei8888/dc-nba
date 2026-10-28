#!/bin/sh
# 每天一次：抓本季新结束比赛的 play-by-play、每 7 天重拟合 RAPM，把 player-values.json 推到服务器 data/。
# 服务器北京 22:00 / 06:30 那两次刷新会把它烤进镜像，影子运行（scripts/shadow.mjs）读它。
#
#   sh deploy/player-values.sh
#
# 现在跑在 GB10（lei@192.168.1.49，~/dc-nba）上，由 systemd 用户定时器调用
# （deploy/systemd/dc-nba-player-values.{service,timer}）：北京 19:15 与 20:15 各排一次（都在服务器 22:00 之前），
# 「北京今天 14:00 之后已经推过」就跳过（14:00 前美东前一晚的比赛未必都打完，那时推的不算数，后面还会再推）。
# 关机错过了，Persistent=true 开机后补跑一次；服务器端过期（RAPM > 9 天、轮换 > 3 天）就只记基线。
# 以前在 Mac 上由 launchd 跑（deploy/cn.tzspace.dc-nba.player-values.plist），macOS 不让 launchd 读 ~/Documents，已停用。
#
# DC_NBA_AUTO_PULL=1（定时器里设了）：开跑前把本 checkout 快进到 origin/master；有本地改动或分叉就不跑，日志里写原因。
#
# 请求上限显式给出（nbaClient → politeFetch）：单次 180、单日 500；与全量 ingest 共用状态文件里的单日计数。
set -eu

REMOTE=${DC_NBA_REMOTE:-dev@gpu.tzspace.cn}
RDIR=${DC_NBA_REMOTE_DIR:-/home/dev/work/works/dc-nba}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20${DC_NBA_SSH_KEY:+ -i $DC_NBA_SSH_KEY}"
cd "$(dirname "$0")/.."

log() { echo "[$(date '+%F %T')] [values] $*"; }

# 开跑前快进到 origin/master（只快进；有本地改动或分叉就整次不跑，免得拿不明来路的代码推生产数据）
if [ "${DC_NBA_AUTO_PULL:-0}" = 1 ] && [ "${DC_NBA_PULLED:-0}" != 1 ]; then
  BR=${DC_NBA_BRANCH:-master}
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "checkout 有本地改动，不更新也不跑："; git status --short --untracked-files=no; exit 1
  fi
  if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BR" ]; then log "当前不在 ${BR} 分支，不跑"; exit 1; fi
  git fetch -q origin "$BR" || { log "git fetch 失败，不跑"; exit 1; }
  OLD=$(git rev-parse HEAD)
  git merge -q --ff-only "origin/$BR" || { log "本地 ${BR} 与 origin/${BR} 分叉，不能快进，不跑"; exit 1; }
  NEW=$(git rev-parse HEAD)
  if [ "$OLD" != "$NEW" ]; then
    log "已快进 $(git rev-parse --short "$OLD") → $(git rev-parse --short "$NEW")，用新版本脚本重跑"
    DC_NBA_PULLED=1 exec sh "$0" "$@"
  fi
fi

NODE=${DC_NBA_NODE:-node}
OUT=data/history/shadow/player-values.json
STAMP=data/history/shadow/.pushed-day

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
if [ "$s" != 0 ] && [ "$s" != 3 ]; then log "生成失败（${s}），不推送"; exit 1; fi
[ -s "$OUT" ] || { log "没有 ${OUT}"; exit 1; }

# macOS：服务器密钥带口令，只能经 ssh-agent 用（launchd 会把会话的 SSH_AUTH_SOCK 传给本任务）；
# 重启后 agent 是空的，先把钥匙串里存过口令的私钥装进去（装不上也不报错，ssh 失败时日志里看得到）。Linux 上不需要
if [ "$(uname -s)" = Darwin ]; then ssh-add --apple-load-keychain -q 2>/dev/null || true; fi
# 拿服务器刷新同一把锁再替换，免得 refresh.sh 拷数据拷到一半
$SSH "$REMOTE" "flock -w 900 $RDIR/.refresh.lock sh -c 'cat > $RDIR/data/player-values.json.tmp && mv $RDIR/data/player-values.json.tmp $RDIR/data/player-values.json'" < "$OUT"
log "已推送到 ${REMOTE}:${RDIR}/data/player-values.json"
[ "$HOUR" -ge 14 ] && echo "$DAY" > "$STAMP"
log "完成"
