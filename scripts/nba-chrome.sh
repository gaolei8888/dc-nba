#!/bin/sh
# 启动给 NBA_TRANSPORT=chrome 用的专用 Chrome（已在运行就什么也不做）。
#
#   sh scripts/nba-chrome.sh
#   NBA_TRANSPORT=chrome node scripts/ingest.mjs
#
# - 专用 profile（默认 ~/.dc-nba-chrome）：Chrome ≥136 在默认 profile 上会忽略
#   --remote-debugging-port，所以不能复用日常的 Chrome。cookie 留在这个 profile 里，跨运行保留。
# - 普通方式启动，不带 --enable-automation：navigator.webdriver 保持 false，
#   和手动打开的 Chrome 没有区别（--no-first-run 只是跳过首次欢迎页）。
# - 端口默认 9223：本机日常用的 Chrome 已经占了 9222。
# - 窗口要一直开着；抓取时它会自己加载一次 www.nba.com/stats 预热。
set -eu
PORT=${NBA_CHROME_PORT:-9223}
PROFILE=${NBA_CHROME_PROFILE:-$HOME/.dc-nba-chrome}
CHROME=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}

up() { curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" > /dev/null; }
if up; then echo "专用 Chrome 已在运行（127.0.0.1:${PORT}）"; exit 0; fi

mkdir -p "${PROFILE}"
nohup "$CHROME" --user-data-dir="${PROFILE}" --remote-debugging-port="${PORT}" \
  --no-first-run --no-default-browser-check "https://www.nba.com/stats" > /dev/null 2>&1 &

i=0
while [ $i -lt 30 ]; do
  if up; then echo "专用 Chrome 已启动（127.0.0.1:${PORT}，profile ${PROFILE}）"; exit 0; fi
  sleep 1; i=$((i + 1))
done
echo "30 秒内没等到 127.0.0.1:${PORT}。看看 Chrome 窗口是否弹了对话框（首次运行/登录提示），点掉后重跑本脚本。" >&2
exit 1
