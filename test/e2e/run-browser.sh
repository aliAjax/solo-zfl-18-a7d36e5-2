#!/bin/sh
# 在无 root 的容器里跑真实浏览器走查：
# 1) 如需本地系统库，先执行 test/e2e/fetch-chromium-deps.sh
# 2) 再执行本脚本
set -e
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
PREFIX=${CHROME_DEPS_PREFIX:-/tmp/chromedeps}
export LD_LIBRARY_PATH="$PREFIX/root/usr/lib/aarch64-linux-gnu:$PREFIX/root/lib/aarch64-linux-gnu"
if [ -d "$PREFIX/fontconfig" ]; then
  export FONTCONFIG_PATH="$PREFIX/fontconfig"
  export FONTCONFIG_FILE="$PREFIX/fontconfig/fonts.conf"
fi
cd "$ROOT"
node test/e2e/browser-walkthrough.mjs "$@"
