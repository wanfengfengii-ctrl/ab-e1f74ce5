# 调蓄池抽排曲线审计

暴雨前复核调蓄池抽排方案的静态 Web 应用：在浏览器中维护 **2–4 台泵**（各 2–5 个严格递增的整数分钟关键点、非负流量）与同一时段的 **2–5 个降雨入流关键点**，录入初始池量、池容与取水口上限后点击「审计」。

## 计算模型

- 所有曲线在相邻关键点间线性变化，且各曲线首末时刻一致（录入时校验）。
- 审计时取**全部曲线关键点的并集**切分时间轴，在每一段上连续解析求解，**不按分钟或抽样替代**：
  - 总抽排为线性函数，段内上限在端点处取得；
  - 净流量（入流 − 抽排）为线性函数，池量为其积分（二次函数），段内极值在端点或净流量过零点处取得；
  - 越界时刻由线性/二次方程解析求根得到，多类超限并存时按**最早时刻**报告。
- 任一编辑（改数、改名、增删关键点/泵）立即使旧结论失效，需重新审计。

## 结果展示

- **安全**：最大总抽排、最大/最小池量及其出现时刻、期末池量。
- **失败**：最早超限时刻、超限类型（总抽排超取水口上限 / 池容漫溢 / 池量抽空）、当时池量、当时总抽排及相关泵（按当时流量降序）。

## 运行（Docker / Docker Compose）

```bash
docker compose up --build web          # 默认端口 8080
WEB_PORT=9000 docker compose up --build web
# 打开 http://localhost:9000
```

- 端口通过环境变量 `WEB_PORT` 配置（缺省 8080）。
- 健康检查：`GET /healthz` 返回 `ok`（容器自身亦配置 healthcheck）。

## 一次性验证（verify 服务）

```bash
docker compose up --build --exit-code-from verify
```

`verify` 在 `web` 构建并就绪后依次执行，任一失败即以非零码退出：

1. **代码测试**：`node --test tests/engine.test.js`（引擎单元测试）；
2. **业务计算冒烟**：`node tests/smoke.js`（典型安全/失败场景的关键指标）；
3. **HTTP 健康检查**：探测 `http://web/healthz`。

全部通过时输出 `VERIFY OK` 并以退出码 0 结束。

## 本地开发（无需 Docker）

```bash
node --test tests/engine.test.js   # 单元测试
node tests/smoke.js                # 业务冒烟
# 直接用任意静态服务器打开 app/index.html，如：
npx serve app
```

## 目录结构

```
app/            静态站点（index.html / styles.css / app.js / engine.js）
  engine.js     审计引擎：纯函数，浏览器与 Node 共用
tests/          引擎单元测试与业务冒烟脚本
scripts/        verify 服务入口 run-verify.sh
Dockerfile      静态 Web 镜像（nginx）
Dockerfile.verify  verify 一次性服务镜像
docker-compose.yml web + verify 编排，WEB_PORT 可配置
nginx.conf      含 /healthz 健康检查端点
```
