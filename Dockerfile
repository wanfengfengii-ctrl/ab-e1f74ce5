# syntax=docker/dockerfile:1

# ---------- 运行时：静态 Web ----------
FROM nginx:1.27-alpine AS web
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

# ---------- verify：一次性校验服务 ----------
# 构建后执行：代码测试 → 业务计算冒烟 → HTTP 健康检查，以退出码结束。
FROM node:22-alpine AS verify
COPY web/ /web/
COPY test/ /test/
RUN chmod +x /test/run-all.sh
ENV WEB_URL=http://web:80
CMD ["/test/run-all.sh"]
