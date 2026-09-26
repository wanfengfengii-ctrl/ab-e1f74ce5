'use strict';
/* 引擎单元测试：输入校验 + 连续解析计算（node --test）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../app/engine.js');

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const pts = (arr) => arr.map(([t, q]) => ({ t, q }));
const zeroPump = (name, t1) => ({ name, points: pts([[0, 0], [t1, 0]]) });

function baseCfg(over = {}) {
  return {
    pumps: [zeroPump('P1', 60), zeroPump('P2', 60)],
    inflow: pts([[0, 0], [60, 0]]),
    initialVolume: 0,
    capacity: 1000,
    intakeLimit: 100,
    ...over,
  };
}

/* ---------------- 输入校验 ---------------- */

test('校验：泵数量须在 2 至 4 台', () => {
  let r = Engine.audit(baseCfg({ pumps: [zeroPump('P1', 60)] }));
  assert.ok(r.inputErrors.some((e) => e.includes('2 至 4')));
  const five = Array.from({ length: 5 }, (_, i) => zeroPump(`P${i}`, 60));
  r = Engine.audit(baseCfg({ pumps: five }));
  assert.ok(r.inputErrors.some((e) => e.includes('2 至 4')));
});

test('校验：关键点数量须在 2 至 5 个', () => {
  const r = Engine.audit(baseCfg({
    pumps: [
      { name: 'P1', points: pts([[0, 0]]) },
      zeroPump('P2', 60),
    ],
  }));
  assert.ok(r.inputErrors.some((e) => e.includes('2 至 5')));
  const six = pts([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0], [60, 0]]);
  const r2 = Engine.audit(baseCfg({ inflow: six }));
  assert.ok(r2.inputErrors.some((e) => e.includes('2 至 5')));
});

test('校验：时刻须为非负整数且严格递增', () => {
  let r = Engine.audit(baseCfg({ inflow: pts([[0, 0], [60.5, 0]]) }));
  assert.ok(r.inputErrors.some((e) => e.includes('整数')));
  r = Engine.audit(baseCfg({ inflow: pts([[0, 0], [0, 1]]) }));
  assert.ok(r.inputErrors.some((e) => e.includes('严格递增')));
  r = Engine.audit(baseCfg({ inflow: pts([[0, 0], [60, 1], [30, 0]]) }));
  assert.ok(r.inputErrors.some((e) => e.includes('严格递增')));
});

test('校验：流量须非负', () => {
  const r = Engine.audit(baseCfg({ inflow: pts([[0, -1], [60, 0]]) }));
  assert.ok(r.inputErrors.some((e) => e.includes('非负')));
});

test('校验：各曲线首末时刻须一致', () => {
  const r = Engine.audit(baseCfg({ inflow: pts([[0, 0], [120, 0]]) }));
  assert.ok(r.inputErrors.some((e) => e.includes('首末时刻')));
  const r2 = Engine.audit(baseCfg({ inflow: pts([[10, 0], [60, 0]]) }));
  assert.ok(r2.inputErrors.some((e) => e.includes('首末时刻')));
});

test('校验：全局参数与空配置不崩溃', () => {
  const r = Engine.audit({});
  assert.ok(Array.isArray(r.inputErrors) && r.inputErrors.length > 0);
  const r2 = Engine.audit(baseCfg({ initialVolume: -5 }));
  assert.ok(r2.inputErrors.some((e) => e.includes('初始池量')));
  const r3 = Engine.audit(baseCfg({ capacity: 0 }));
  assert.ok(r3.inputErrors.some((e) => e.includes('池容')));
});

test('求值：分段线性插值', () => {
  assert.equal(Engine.evalCurve(pts([[0, 0], [10, 100]]), 5), 50);
  assert.equal(Engine.evalCurve(pts([[0, 0], [10, 100], [20, 0]]), 15), 50);
});

/* ---------------- 安全场景 ---------------- */

const SAMPLE = {
  pumps: [
    { name: '泵 1', points: pts([[0, 0], [30, 40], [90, 40], [120, 0]]) },
    { name: '泵 2', points: pts([[0, 10], [60, 50], [120, 20]]) },
    { name: '泵 3', points: pts([[0, 5], [120, 25]]) },
  ],
  inflow: pts([[0, 20], [30, 80], [60, 120], [90, 60], [120, 20]]),
  initialVolume: 1500,
  capacity: 3000,
  intakeLimit: 120,
};

test('安全场景：解析极值与其时刻', () => {
  const r = Engine.audit(SAMPLE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(approx(r.maxDrainage.value, 105));
  assert.ok(approx(r.maxDrainage.time, 60));
  assert.ok(approx(r.maxVolume.value, 1867.5));
  assert.ok(approx(r.maxVolume.time, 69));
  assert.ok(approx(r.minVolume.value, 600));
  assert.ok(approx(r.minVolume.time, 120));
  assert.ok(approx(r.endVolume, 600));
});

test('连续极值：驻点落在非整数时刻（抽样无法替代）', () => {
  const r = Engine.audit({
    pumps: [
      { name: 'P1', points: pts([[0, 45.5], [100, 45.5]]) },
      zeroPump('P2', 100),
    ],
    inflow: pts([[0, 100], [100, 0]]),
    initialVolume: 0,
    capacity: 1e9,
    intakeLimit: 1e9,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  // 净流量 54.5 - t，池量峰值在 t = 54.5，峰值 54.5²/2
  assert.ok(approx(r.maxVolume.value, 1485.125));
  assert.ok(approx(r.maxVolume.time, 54.5));
  assert.ok(approx(r.maxDrainage.value, 45.5));
  assert.ok(approx(r.maxDrainage.time, 0)); // 恒定流量，并列取最早
});

test('并集切分：各曲线关键点不对齐时积分仍精确', () => {
  const r = Engine.audit({
    pumps: [
      { name: 'P1', points: pts([[0, 0], [30, 60], [100, 60]]) },
      { name: 'P2', points: pts([[0, 10], [100, 10]]) },
    ],
    inflow: pts([[0, 0], [70, 140], [100, 0]]),
    initialVolume: 1000,
    capacity: 1e9,
    intakeLimit: 1e9,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(approx(r.maxDrainage.value, 70));
  assert.ok(approx(r.maxDrainage.time, 30));
  // [70,100] 段净流量 70→-70，t=85 处池量驻点 1900+525=2425
  assert.ok(approx(r.maxVolume.value, 2425));
  assert.ok(approx(r.maxVolume.time, 85));
  // [30,70] 段净流量 -10→70，t=35 处池量谷值 675
  assert.ok(approx(r.minVolume.value, 675));
  assert.ok(approx(r.minVolume.time, 35));
  assert.ok(approx(r.endVolume, 1900));
});

/* ---------------- 失败场景 ---------------- */

test('失败：总抽排超取水口上限（精确穿越时刻）', () => {
  const r = Engine.audit({
    pumps: [
      { name: 'P1', points: pts([[0, 0], [60, 100]]) },
      zeroPump('P2', 60),
    ],
    inflow: pts([[0, 0], [60, 0]]),
    initialVolume: 10000,
    capacity: 100000,
    intakeLimit: 50,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure.type, 'drainage');
  assert.ok(approx(r.failure.time, 30));
  assert.ok(approx(r.failure.totalFlow, 50));
  assert.ok(approx(r.failure.volume, 9250)); // 10000 - ∫0..30 (5t/3) dt
  const p1 = r.failure.pumps.find((p) => p.name === 'P1');
  assert.ok(approx(p1.flow, 50));
  const p2 = r.failure.pumps.find((p) => p.name === 'P2');
  assert.ok(approx(p2.flow, 0));
});

test('失败：池容漫溢（精确时刻与当时池量）', () => {
  const r = Engine.audit({
    pumps: [zeroPump('P1', 60), zeroPump('P2', 60)],
    inflow: pts([[0, 10], [60, 10]]),
    initialVolume: 0,
    capacity: 300,
    intakeLimit: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure.type, 'overflow');
  assert.ok(approx(r.failure.time, 30));
  assert.ok(approx(r.failure.volume, 300));
});

test('失败：池量抽空', () => {
  const r = Engine.audit({
    pumps: [
      { name: 'P1', points: pts([[0, 10], [60, 10]]) },
      zeroPump('P2', 60),
    ],
    inflow: pts([[0, 0], [60, 0]]),
    initialVolume: 100,
    capacity: 1000,
    intakeLimit: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure.type, 'dry');
  assert.ok(approx(r.failure.time, 10));
  assert.ok(approx(r.failure.volume, 0));
});

test('失败：多类超限并存时按最早时刻报告', () => {
  // 漫溢在 t = 30 - √300 ≈ 12.6795，抽排超限在 t = 50，抽空在 t = 60
  const r = Engine.audit({
    pumps: [
      { name: 'P1', points: pts([[0, 0], [120, 120]]) },
      zeroPump('P2', 120),
    ],
    inflow: pts([[0, 30], [120, 30]]),
    initialVolume: 0,
    capacity: 300,
    intakeLimit: 50,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure.type, 'overflow');
  assert.ok(approx(r.failure.time, 30 - Math.sqrt(300)));
  assert.ok(approx(r.failure.volume, 300));
});

test('边界：起点池量恰为 0 且先升后降，不误报抽空', () => {
  // 净流量 30 - t，V(t) = 30t - t²/2 在 [0,60] 上非负，t=0 与 t=60 处恰为 0
  const r = Engine.audit({
    pumps: [
      { name: 'P1', points: pts([[0, 0], [60, 60]]) },
      zeroPump('P2', 60),
    ],
    inflow: pts([[0, 30], [60, 30]]),
    initialVolume: 0,
    capacity: 1e9,
    intakeLimit: 1e9,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(approx(r.minVolume.value, 0));
  assert.ok(approx(r.maxVolume.value, 450));
  assert.ok(approx(r.maxVolume.time, 30));
});

test('边界：初始池量即超池容，失败时刻为起点', () => {
  const r = Engine.audit(baseCfg({ initialVolume: 2000, capacity: 1000 }));
  assert.equal(r.ok, false);
  assert.equal(r.failure.type, 'overflow');
  assert.ok(approx(r.failure.time, 0));
  assert.ok(approx(r.failure.volume, 2000));
});
