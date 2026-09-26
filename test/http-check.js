'use strict';

/*
 * HTTP 健康检查：等待 Web 服务就绪后，校验健康端点与页面、静态资源可访问。
 * 目标地址由 WEB_URL 环境变量指定（compose 内为 http://web:80）。
 */
const BASE = (process.env.WEB_URL || 'http://web:80').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  return { status: res.status, text };
}

(async () => {
  let lastErr = '未连接';
  for (let i = 0; i < 30; i++) {
    try {
      const health = await get('/healthz');
      if (health.status !== 200) {
        lastErr = `/healthz 返回 ${health.status}`;
      } else {
        const index = await get('/');
        const js = await get('/audit.js');
        if (index.status === 200 && index.text.includes('调蓄池') && js.status === 200) {
          console.log(`[http] 健康检查通过：GET ${BASE}/healthz → 200，/ → 200，/audit.js → 200`);
          process.exit(0);
        }
        lastErr = `首页或静态资源异常（/ → ${index.status}，/audit.js → ${js.status}）`;
      }
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(1000);
  }
  console.error(`[http] 健康检查失败：${lastErr}`);
  process.exit(1);
})();
