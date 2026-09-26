#!/bin/sh
# verify 一次性服务入口：代码测试 → 业务计算冒烟 → HTTP 健康检查。
# 任一步骤失败即以非零码退出；全部通过输出 VERIFY OK 并以 0 退出。
set -eu

echo "== [1/3] 引擎单元测试（node --test）=="
node --test tests/engine.test.js

echo "== [2/3] 业务计算冒烟 =="
node tests/smoke.js

echo "== [3/3] HTTP 健康检查 =="
url="http://${WEB_HOST:-web}/healthz"
body=""
for i in 1 2 3 4 5; do
  body=$(wget -q -O- "$url" 2>/dev/null || true)
  [ "$body" = "ok" ] && break
  sleep 1
done
echo "$url -> ${body:-<无响应>}"
[ "$body" = "ok" ]

echo "VERIFY OK"
