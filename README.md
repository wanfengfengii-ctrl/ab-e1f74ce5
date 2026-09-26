# 调蓄池抽排曲线审计

城市防洪调度场景：暴雨前复核调蓄池各泵抽排曲线，避免各泵在关键时刻看似合规，
却在两段之间让**总抽排超过取水口上限**或使**池容漫溢**。

## 功能

- 维护 2~4 台泵，每台 2~5 个严格递增的整数分钟关键点及非负抽排流量；
- 录入同一时段 2~5 个降雨入流关键点、初始池量、池容、取水口上限；
- 所有曲线在相邻关键点间线性变化，且首末时刻一致（录入时校验）；
- 点击「审计」后按**全部关键点并集**切分时间轴，在每段内**连续解析**：
  - 总抽排为线性函数，取段端点极值并解析求越限穿越时刻；
  - 净流量积分得池量为二次函数，求段内驻点极值与漫溢穿越时刻；
  - 不按分钟步进、不抽样替代；
- 任一编辑立即使旧结论失效（界面提示重新审计）；
- 安全时展示最大抽排、最大/最小池量及其时刻；
- 失败时按最早时刻提示超限类型、相关泵（含当时流量）和当时池量。

## 运行（Docker Compose）

```bash
# 启动静态 Web（默认端口 8080，可用 WEB_PORT 覆盖）
WEB_PORT=8080 docker compose up --build web

# 健康检查
curl http://localhost:8080/healthz   # → ok
```

## 一次性校验服务 verify

`verify` 服务在构建后依次执行：代码测试（node:test 单元测试）→
业务计算冒烟 → HTTP 健康检查，然后以退出码结束（0=通过，非 0=失败）：

```bash
docker compose up --build --exit-code-from verify verify
echo $?   # 0 表示全部通过
```

它通过 `depends_on: service_healthy` 等待 web 健康后再发 HTTP 检查。

## 本地（无 Docker）运行测试

```bash
node --test test/audit.test.js   # 单元测试
node test/smoke.js               # 业务冒烟
```

## 目录结构

```
Dockerfile            # 多阶段：web（nginx 静态站点）+ verify（一次性校验）
docker-compose.yml    # web 服务（WEB_PORT 可配、健康检查）+ verify 服务
nginx/default.conf    # 静态站点 + /healthz
web/                  # 前端：index.html / styles.css / app.js / audit.js（核心计算，纯函数）
test/                 # audit.test.js（单元测试）、smoke.js（业务冒烟）、http-check.js、run-all.sh
```

## 计算方法

1. 取所有泵与降雨曲线关键点的并集，排序后切分时间轴；
2. 每段内各曲线为线性，故总抽排 `Q(τ)` 线性、净流量 `N(τ)` 线性、
   池量 `V(τ)=V₀+N₀τ+½Kτ²` 为二次函数；
3. 总抽排极值在段端点取得；池量极值在端点或驻点 `τ*=-N₀/K` 取得；
4. 越限时刻由线性/二次方程解析求解（穿越点可落在分钟之间），
   取所有段中最早的超限时刻报告。
