#!/bin/sh
# 在 GB10（办公室宽带）上安装「只刷新数据」：每天全量抓 stats.nba.com，推到线上服务器。
# GB10 不跑网站，只跑 deploy/push-refresh.sh。
#
#   sh deploy/setup-gb10.sh           检查 + 安装 cron
#   sh deploy/setup-gb10.sh --check   只检查，不装
#
# 每一步先验证再动手，任何一步不通就停下并说明原因：
#   1. node ≥ 22（ingest 只用 node 内置模块，不需要 npm install）
#   2. 这台机器能从 stats.nba.com 拿到 **JSON**——状态码 200 不算数，
#      gpu 服务器就是 200 但返回 nba.com 首页
#   3. 专用密钥 ~/.ssh/dc_nba 能免密登录 dev@gpu.tzspace.cn
#   4. data/history/ 与 data/impact-model.json 在（算 IMP 要用）
set -eu

cd "$(dirname "$0")/.."
DIR=$(pwd)
KEY=${DC_NBA_SSH_KEY:-$HOME/.ssh/dc_nba}
REMOTE=${DC_NBA_REMOTE:-dev@gpu.tzspace.cn}
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

ok() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }

echo "检查 GB10 数据刷新环境（$DIR）"

# 1. node
command -v node >/dev/null || fail "没有 node。装 22 版：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "node 版本 $(node -v)，需要 ≥ 22"
ok "node $(node -v)"

# 2. NBA 可达，且返回的是 JSON
node --input-type=module -e '
  import { nbaGet, statsUrl } from "./server/nbaClient.mjs";
  const p = await nbaGet(statsUrl("leaguestandingsv3", { LeagueID: "00", Season: "2026-27", SeasonType: "Regular Season" }), { tries: 1 });
  if (!p?.resultSets?.length) { console.error("返回的不是积分榜 JSON"); process.exit(1); }
' 2>/dev/null || fail "从这台机器拿不到 stats.nba.com 的 JSON（被封或网络不通）。GB10 不能做数据源"
ok "stats.nba.com 返回 JSON"

# 3. 专用密钥
[ -f "$KEY" ] || fail "没有密钥 $KEY。生成：ssh-keygen -t ed25519 -f $KEY -N '' -C dc-nba-gb10，然后把 $KEY.pub 发给管理员加到服务器"
ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$REMOTE" true 2>/dev/null \
  || fail "密钥 $KEY 还登录不了 $REMOTE（公钥还没加到服务器？）"
ok "密钥能登录 $REMOTE"

# 4. 历史数据
[ -d data/history ] && [ -f data/impact-model.json ] || fail "缺少 data/history/ 或 data/impact-model.json"
ok "data/history/ 与 impact-model.json 齐全"

if [ "$CHECK_ONLY" = 1 ]; then
  echo "全部通过（--check，未安装 cron）"
  exit 0
fi

# 5. cron：北京 14:00。美西最晚的比赛约北京 13:00 结束；
#    服务器 14:30 的 ESPN 刷新会再补上这之后才出的比分
LINE="0 14 * * * cd $DIR && DC_NBA_SSH_KEY=$KEY sh deploy/push-refresh.sh >> $DIR/push-refresh.log 2>&1"
if crontab -l 2>/dev/null | grep -q "deploy/push-refresh.sh"; then
  echo "  cron 已经装过，不重复添加："
  crontab -l | grep "deploy/push-refresh.sh"
else
  { crontab -l 2>/dev/null; echo "# dc-nba：全量抓 NBA 数据并推到 gpu.tzspace.cn（GB10 只做数据刷新）"; echo "$LINE"; } | crontab -
  ok "cron 已安装：$LINE"
fi
echo "时区：$(date +%Z)（cron 按本机时区执行，若不是 CST 请把 14 改成对应小时）"
echo "立刻试跑一次：cd $DIR && DC_NBA_SSH_KEY=$KEY sh deploy/push-refresh.sh"
