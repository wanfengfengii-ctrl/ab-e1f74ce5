#!/bin/sh
# verify 一次性服务入口：代码测试 → 业务计算冒烟 → HTTP 健康检查。
# 任一步骤失败即非零退出；全部通过以 0 退出。
set -eu

echo '== [1/3] 代码测试（单元测试） =='
node --test /test/audit.test.js

echo '== [2/3] 业务计算冒烟 =='
node /test/smoke.js

echo '== [3/3] HTTP 健康检查 =='
node /test/http-check.js

echo '== verify 全部通过 =='
