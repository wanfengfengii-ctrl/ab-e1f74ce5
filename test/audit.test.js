'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Audit = require('../web/audit.js');

const approx = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

/** 构造合法输入的便捷函数，可按需覆盖字段 */
function baseSpec(overrides = {}) {
  return Object.assign(
    {
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 10 }, { t: 60, v: 40 }, { t: 120, v: 10 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 30, v: 25 }, { t: 90, v: 25 }, { t: 120, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 20 }, { t: 30, v: 80 }, { t: 60, v: 50 }, { t: 120, v: 5 }],
      initialVolume: 500,
      capacity: 3000,
      intakeLimit: 80,
    },
    overrides
  );
}

// ---------- 输入校验 ----------

test('校验：泵数量须为 2~4 台', () => {
  const one = baseSpec({ pumps: [{ name: '泵1', points: [{ t: 0, v: 0 }, { t: 120, v: 0 }] }] });
  assert.ok(Audit.validateSpec(one).some((e) => e.includes('泵数量')));
  const five = baseSpec({
    pumps: Array.from({ length: 5 }, (_, i) => ({
      name: `泵${i + 1}`,
      points: [{ t: 0, v: 0 }, { t: 120, v: 0 }],
    })),
  });
  assert.ok(Audit.validateSpec(five).some((e) => e.includes('泵数量')));
});

test('校验：关键点数量限制（泵 2~5、降雨 2~5）', () => {
  const fewPump = baseSpec({
    pumps: [
      { name: '泵1', points: [{ t: 0, v: 1 }] },
      { name: '泵2', points: [{ t: 0, v: 0 }, { t: 120, v: 0 }] },
    ],
  });
  assert.ok(Audit.validateSpec(fewPump).some((e) => e.includes('关键点数量')));
  const manyRain = baseSpec({
    rainfall: Array.from({ length: 6 }, (_, i) => ({ t: i * 24, v: 0 })),
  });
  assert.ok(Audit.validateSpec(manyRain).some((e) => e.includes('降雨入流') && e.includes('关键点数量')));
});

test('校验：时刻须为严格递增的非负整数分钟', () => {
  const frac = baseSpec();
  frac.pumps[0].points[1].t = 60.5;
  assert.ok(Audit.validateSpec(frac).some((e) => e.includes('非负整数')));
  const neg = baseSpec();
  neg.pumps[0].points[0].t = -1;
  assert.ok(Audit.validateSpec(neg).some((e) => e.includes('非负整数')));
  const dup = baseSpec();
  dup.pumps[0].points[1].t = 0;
  assert.ok(Audit.validateSpec(dup).some((e) => e.includes('严格递增')));
});

test('校验：流量须为非负数值', () => {
  const negFlow = baseSpec();
  negFlow.pumps[1].points[1].v = -5;
  assert.ok(Audit.validateSpec(negFlow).some((e) => e.includes('非负数值')));
  const nanFlow = baseSpec();
  nanFlow.rainfall[0].v = NaN;
  assert.ok(Audit.validateSpec(nanFlow).some((e) => e.includes('非负数值')));
});

test('校验：所有曲线首末时刻须一致', () => {
  const spec = baseSpec();
  spec.rainfall[spec.rainfall.length - 1].t = 100;
  const errors = Audit.validateSpec(spec);
  assert.ok(errors.some((e) => e.includes('首末时刻')));
});

test('校验：全局参数（初始池量、池容、取水口上限）', () => {
  assert.ok(Audit.validateSpec(baseSpec({ initialVolume: -1 })).some((e) => e.includes('初始池量')));
  assert.ok(Audit.validateSpec(baseSpec({ capacity: 0 })).some((e) => e.includes('池容')));
  assert.ok(Audit.validateSpec(baseSpec({ intakeLimit: -5 })).some((e) => e.includes('取水口上限')));
});

// ---------- 安全场景：连续解析求极值 ----------

test('安全场景：最大抽排、最大/最小池量及时刻', () => {
  const r = Audit.audit(baseSpec());
  assert.equal(r.valid, true);
  assert.equal(r.ok, true);
  approx(r.maxDrainage.value, 65);
  assert.equal(r.maxDrainage.time, 60);
  approx(r.maxVolume.value, 1400);
  assert.equal(r.maxVolume.time, 50);
  approx(r.minVolume.value, 350);
  assert.equal(r.minVolume.time, 120);
});

test('并集切分：在彼此关键点上联合求值（非各自曲线单独检查）', () => {
  const r = Audit.audit(
    baseSpec({
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 0 }, { t: 50, v: 80 }, { t: 100, v: 0 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 70 }, { t: 100, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 0 }, { t: 100, v: 0 }],
      initialVolume: 10000,
      capacity: 1e9,
      intakeLimit: 1e9,
    })
  );
  assert.equal(r.ok, true);
  approx(r.maxDrainage.value, 80 + (70 * 50) / 60); // t=50 处两泵叠加
  assert.equal(r.maxDrainage.time, 50);
});

// ---------- 失败场景：最早时刻、类型、相关泵、当时池量 ----------

test('抽排超限：段内线性穿越，穿越时刻非关键点', () => {
  const r = Audit.audit(
    baseSpec({
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 0 }, { t: 60, v: 200 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 0 }, { t: 60, v: 0 }],
      initialVolume: 100000,
      capacity: 200000,
      intakeLimit: 100,
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  const v = r.violations[0];
  assert.equal(v.type, 'drainage');
  approx(r.time, 30); // 线性 0→200 在 t=30 穿越上限 100
  approx(v.volume, 98500); // 当时池量 = 100000 - ∫0..30 (10/3)t dt
  approx(v.drainage, 100);
  approx(v.pumps[0].flow, 100); // 相关泵：泵1 当时流量
  approx(v.pumps[1].flow, 0);
  approx(v.segmentPeak.value, 200);
  assert.equal(v.segmentPeak.time, 60);
});

test('漫溢：二次池量曲线在非整数时刻穿越池容（抽样无法替代）', () => {
  const r = Audit.audit(
    baseSpec({
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 0 }, { t: 30, v: 100 }, { t: 60, v: 0 }],
      initialVolume: 0,
      capacity: 1000,
      intakeLimit: 10000,
    })
  );
  assert.equal(r.ok, false);
  const v = r.violations[0];
  assert.equal(v.type, 'overflow');
  approx(r.time, Math.sqrt(600)); // V=(5/3)t² = 1000 → t=√600 ≈ 24.4949，非整数
  assert.ok(Math.abs(r.time - Math.round(r.time)) > 1e-3, '穿越时刻应落在分钟之间');
  approx(v.volume, 1000, 1e-6);
});

test('初始池量超过池容：t0 即漫溢', () => {
  const r = Audit.audit(
    baseSpec({
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 0 }, { t: 10, v: 0 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 10, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 0 }, { t: 10, v: 0 }],
      initialVolume: 5000,
      capacity: 3000,
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'overflow');
  assert.equal(r.time, 0);
  approx(r.violations[0].volume, 5000);
});

test('失败按最早时刻报告：漫溢早于抽排超限', () => {
  const r = Audit.audit(
    baseSpec({
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 0 }, { t: 60, v: 120 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 100 }, { t: 60, v: 100 }],
      initialVolume: 0,
      capacity: 300,
      intakeLimit: 100,
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'overflow');
  // V(t)=100t-t²=300 → t=(100-√8800)/2 ≈ 3.0958，早于抽排穿越时刻 t=50
  approx(r.time, (100 - Math.sqrt(8800)) / 2);
});

test('同一最早时刻的多种超限一并报告', () => {
  const r = Audit.audit(
    baseSpec({
      pumps: [
        { name: '泵1', points: [{ t: 0, v: 200 }, { t: 60, v: 200 }] },
        { name: '泵2', points: [{ t: 0, v: 0 }, { t: 60, v: 0 }] },
      ],
      rainfall: [{ t: 0, v: 0 }, { t: 60, v: 0 }],
      initialVolume: 5000,
      capacity: 3000,
      intakeLimit: 100,
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.time, 0);
  const types = r.violations.map((v) => v.type).sort();
  assert.deepEqual(types, ['drainage', 'overflow']);
});

// ---------- 底层函数 ----------

test('evalCurve：分段线性插值', () => {
  const c = Audit.makeCurve([{ t: 0, v: 0 }, { t: 30, v: 60 }, { t: 60, v: 0 }]);
  assert.equal(Audit.evalCurve(c, 0), 0);
  assert.equal(Audit.evalCurve(c, 15), 30);
  assert.equal(Audit.evalCurve(c, 45), 30);
  assert.equal(Audit.evalCurve(c, 60), 0);
});

test('firstExceedTime：线性与二次穿越', () => {
  // 线性：f=10τ 在 [0,10] 上超 50 → τ=5
  approx(Audit.firstExceedTime(0, 10, 0, 50, 10), 5);
  // 线性不超限
  assert.equal(Audit.firstExceedTime(0, 10, 0, 500, 10), null);
  // 起点已超限
  assert.equal(Audit.firstExceedTime(60, 0, 0, 50, 10), 0);
  // 二次开口向下：f=100τ-τ² 在 [0,60] 上超 300 → τ=(100-√8800)/2
  approx(Audit.firstExceedTime(0, 100, -1, 300, 60), (100 - Math.sqrt(8800)) / 2);
});
