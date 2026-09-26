'use strict';

/*
 * 业务计算冒烟：用与页面一致的核心模块跑两个典型场景，
 * 验证安全结论与最早超限结论的关键数值，任何不符即以非零退出。
 */
const assert = require('node:assert/strict');
const Audit = require('../web/audit.js');

const approx = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

// 场景一：安全 —— 手算基准：总抽排峰值 65@60，池量峰值 1400@50，谷值 350@120
{
  const r = Audit.audit({
    pumps: [
      { name: '泵1', points: [{ t: 0, v: 10 }, { t: 60, v: 40 }, { t: 120, v: 10 }] },
      { name: '泵2', points: [{ t: 0, v: 0 }, { t: 30, v: 25 }, { t: 90, v: 25 }, { t: 120, v: 0 }] },
    ],
    rainfall: [{ t: 0, v: 20 }, { t: 30, v: 80 }, { t: 60, v: 50 }, { t: 120, v: 5 }],
    initialVolume: 500,
    capacity: 3000,
    intakeLimit: 80,
  });
  assert.equal(r.ok, true, '场景一应为安全');
  approx(r.maxDrainage.value, 65);
  assert.equal(r.maxDrainage.time, 60);
  approx(r.maxVolume.value, 1400);
  assert.equal(r.maxVolume.time, 50);
  approx(r.minVolume.value, 350);
  assert.equal(r.minVolume.time, 120);
  console.log('[smoke] 场景一（安全）通过：maxQ=65@60, maxV=1400@50, minV=350@120');
}

// 场景二：漫溢 —— 降雨入流三角波，池量 V=(5/3)t² 在 t=√600≈24.49 触及池容 1000
{
  const r = Audit.audit({
    pumps: [
      { name: '泵1', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
      { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
    ],
    rainfall: [{ t: 0, v: 0 }, { t: 30, v: 100 }, { t: 60, v: 0 }],
    initialVolume: 0,
    capacity: 1000,
    intakeLimit: 10000,
  });
  assert.equal(r.ok, false, '场景二应为失败');
  assert.equal(r.violations[0].type, 'overflow');
  approx(r.time, Math.sqrt(600));
  approx(r.violations[0].volume, 1000, 1e-6);
  console.log(`[smoke] 场景二（漫溢）通过：最早超限 t≈${r.time.toFixed(4)} min，当时池量≈${r.violations[0].volume.toFixed(2)} m³`);
}

// 场景三：抽排超限 —— 线性爬坡在 t=30 穿越取水口上限 100
{
  const r = Audit.audit({
    pumps: [
      { name: '泵1', points: [{ t: 0, v: 0 }, { t: 60, v: 200 }] },
      { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
    ],
    rainfall: [{ t: 0, v: 0 }, { t: 60, v: 0 }],
    initialVolume: 100000,
    capacity: 200000,
    intakeLimit: 100,
  });
  assert.equal(r.ok, false, '场景三应为失败');
  assert.equal(r.violations[0].type, 'drainage');
  approx(r.time, 30);
  assert.equal(r.violations[0].pumps[0].name, '泵1');
  approx(r.violations[0].pumps[0].flow, 100);
  console.log('[smoke] 场景三（抽排超限）通过：最早超限 t=30 min，相关泵=泵1');
}

console.log('[smoke] 业务计算冒烟全部通过');
