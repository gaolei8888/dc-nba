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

# DC_NBA_AUTO_PULL=1（GB10 定时器里设了）：开跑前把本 checkout 快进到 origin/master；
# 有本地改动、不在 master、fetch 失败或分叉就整次不跑，免得拿不明来路的代码推生产数据（同 player-values.sh）
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
  # 本地领先 origin 时 --ff-only 也算成功，但那不是 origin/master 的代码
  if [ "$NEW" != "$(git rev-parse "origin/$BR")" ]; then log "本地 ${BR} 领先 origin/${BR}，不跑"; exit 1; fi
  if [ "$OLD" != "$NEW" ]; then
    log "已快进 $(git rev-parse --short "$OLD") → $(git rev-parse --short "$NEW")，用新版本脚本重跑"
    DC_NBA_PULLED=1 exec sh "$0" "$@"
  fi
fi

log "开始（推送到 ${REMOTE}）"
if [ ! -d data/history ]; then
  log "缺少 data/history/，ingest 算不出完整的 IMP，停止"
  exit 1
fi
# 光有目录不够：IMP 的 APM 那一半要基准赛季及之前共 3 季的 lineups 缓存（impact-model.json 的
# decaySpan）。2026-10 曾因本机缺这些文件，线上 IMP 全退化成纯 SPM 跑了一阵。ingest 自己也会查。
y=$(date +%Y); m=$(date +%m); m=${m#0}
if [ "$m" -ge 7 ]; then py=$((y - 1)); else py=$((y - 2)); fi
[ -n "${PRIOR_SEASON:-}" ] && py=${PRIOR_SEASON%%-*}
missing=""
for back in 2 1 0; do
  s=$((py - back))
  f=$(printf 'data/history/lineups_%d-%02d.json' "$s" $(((s + 1) % 100)))
  [ -s "$f" ] || missing="${missing} ${f}"
done
if [ -n "$missing" ]; then
  log "缺少${missing}（IMP 会退化为纯 SPM），停止，线上未改动"
  log "从 GB10 拷：rsync -a lei@192.168.1.49:dc-nba-refresh/data/history/ data/history/"
  exit 1
fi

log "抓取数据（stats.nba.com）"
$NODE scripts/ingest.mjs > "${TMPDIR:-/tmp}/dc-nba-ingest.log" 2>&1 || {
  tail -20 "${TMPDIR:-/tmp}/dc-nba-ingest.log"
  log "抓取失败，线上未改动"
  exit 1
}
grep -E "已吸收|用时|赛季快照" "${TMPDIR:-/tmp}/dc-nba-ingest.log" || true

log "本地体检"
$NODE scripts/check-data.mjs > /dev/null || { $NODE scripts/check-data.mjs; log "体检不过，不推送"; exit 1; }

log "上传"
# player-values.json 由 GB10 的 deploy/player-values.sh 单独推到服务器，这里永远不带：
# 否则本地那份旧文件会把线上新的盖掉（服务器 refresh.sh 把 incoming/*.json 拷过线上 data/）。
# backtest.json 同理：ingest 每次都从 data/history/ 的 gamelog_/teamadv_/odds_ 缓存重建它，
# GB10 没有这些缓存，写出的是 101 字节的空壳；2026-11-04 起两次推送把线上实验室清空了。
# 它只在本机重建（npm run dataset）后 scp 到服务器 data/，见 deploy/README.md。
tar -c --exclude=data/player-values.json --exclude=data/backtest.json data/*.json | gzip -1 | $SSH "$REMOTE" \
  "mkdir -p '$RDIR/incoming' && rm -f '$RDIR'/incoming/*.json && gunzip | tar -x -m -C '$RDIR/incoming' --strip-components=1"

log "远程部署"
# 管道会吞掉 refresh.sh 的退出码，所以先写日志、再单独取状态
$SSH "$REMOTE" \
  "cd '$RDIR' && n=\$(wc -l < refresh.log 2>/dev/null || echo 0); sh deploy/refresh.sh --incoming >> refresh.log 2>&1; s=\$?; tail -n +\$((n + 1)) refresh.log | grep '^\['; exit \$s" \
  || { log "服务器部署失败（线上已回滚或未改动，详见服务器 refresh.log）"; exit 1; }
log "完成"
