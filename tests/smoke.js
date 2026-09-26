'use strict';
/*
 * 业务计算冒烟：跑通一个典型安全场景与一个典型失败场景，
 * 校验关键指标（解析极值、最早超限时刻、当时池量），失败即以非零码退出。
 */
const Engine = require('../app/engine.js');

const pts = (arr) => arr.map(([t, q]) => ({ t, q }));
const approx = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('场景一：安全调度');
const safe = Engine.audit({
  pumps: [
    { name: '泵 1', points: pts([[0, 0], [30, 40], [90, 40], [120, 0]]) },
    { name: '泵 2', points: pts([[0, 10], [60, 50], [120, 20]]) },
    { name: '泵 3', points: pts([[0, 5], [120, 25]]) },
  ],
  inflow: pts([[0, 20], [30, 80], [60, 120], [90, 60], [120, 20]]),
  initialVolume: 1500,
  capacity: 3000,
  intakeLimit: 120,
});
check('判定为安全', safe.ok === true, JSON.stringify(safe));
if (safe.ok) {
  check('最大总抽排 105 @ t=60', approx(safe.maxDrainage.value, 105) && approx(safe.maxDrainage.time, 60),
    JSON.stringify(safe.maxDrainage));
  check('最大池量 1867.5 @ t=69', approx(safe.maxVolume.value, 1867.5) && approx(safe.maxVolume.time, 69),
    JSON.stringify(safe.maxVolume));
  check('最小池量 600 @ t=120', approx(safe.minVolume.value, 600) && approx(safe.minVolume.time, 120),
    JSON.stringify(safe.minVolume));
  check('期末池量 600', approx(safe.endVolume, 600), String(safe.endVolume));
}

console.log('场景二：池容漫溢');
const over = Engine.audit({
  pumps: [
    { name: '泵 1', points: pts([[0, 0], [60, 0]]) },
    { name: '泵 2', points: pts([[0, 0], [60, 0]]) },
  ],
  inflow: pts([[0, 10], [60, 10]]),
  initialVolume: 0,
  capacity: 300,
  intakeLimit: 1000,
});
check('判定为失败', over.ok === false, JSON.stringify(over));
if (!over.ok && over.failure) {
  check('超限类型为池容漫溢', over.failure.type === 'overflow', over.failure.type);
  check('最早超限时刻 t=30', approx(over.failure.time, 30), String(over.failure.time));
  check('当时池量 300', approx(over.failure.volume, 300), String(over.failure.volume));
  check('携带相关泵信息', Array.isArray(over.failure.pumps) && over.failure.pumps.length === 2);
}

if (failed) {
  console.error(`SMOKE FAILED：${failed} 项未通过`);
  process.exit(1);
}
console.log('SMOKE OK');
