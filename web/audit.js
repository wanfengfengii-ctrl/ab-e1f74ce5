/*
 * 调蓄池抽排曲线审计 —— 核心计算模块（纯函数，无 DOM 依赖）。
 *
 * 方法：所有曲线均为分段线性。取全部曲线关键点的并集切分时间轴，
 * 每个小区间内：总抽排为线性函数，净流量为线性函数，池量为二次函数。
 * 对每段连续解析地求极值与越限穿越时刻，不按分钟步进、不抽样替代。
 *
 * 浏览器端挂载为 window.Audit；Node 端通过 require 使用（测试与冒烟复用同一实现）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Audit = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const EPS = 1e-9;

  const LIMITS = {
    pumpCount: { min: 2, max: 4 },
    pumpPoints: { min: 2, max: 5 },
    rainfallPoints: { min: 2, max: 5 },
  };

  function isNonNegNumber(x) {
    return typeof x === 'number' && Number.isFinite(x) && x >= 0;
  }

  function validatePoints(points, label, min, max) {
    const errors = [];
    if (!Array.isArray(points) || points.length < min || points.length > max) {
      errors.push(`${label}：关键点数量须为 ${min}~${max} 个`);
      return errors;
    }
    points.forEach((p, i) => {
      const tag = `${label}第 ${i + 1} 点`;
      if (!p || typeof p !== 'object') {
        errors.push(`${tag}：数据缺失`);
        return;
      }
      if (typeof p.t !== 'number' || !Number.isInteger(p.t) || p.t < 0) {
        errors.push(`${tag}：时刻须为非负整数分钟`);
      }
      if (!isNonNegNumber(p.v)) {
        errors.push(`${tag}：流量须为非负数值`);
      }
      if (
        i > 0 &&
        typeof p.t === 'number' &&
        typeof points[i - 1].t === 'number' &&
        p.t <= points[i - 1].t
      ) {
        errors.push(`${label}：关键时刻须严格递增（第 ${i}、${i + 1} 点）`);
      }
    });
    return errors;
  }

  /**
   * 校验输入规格：
   * { pumps: [{name, points:[{t,v}]}], rainfall: [{t,v}],
   *   initialVolume, capacity, intakeLimit }
   * 返回错误信息数组（空数组表示通过）。
   */
  function validateSpec(spec) {
    const errors = [];
    if (!spec || typeof spec !== 'object') return ['输入缺失'];

    const pumps = spec.pumps;
    if (
      !Array.isArray(pumps) ||
      pumps.length < LIMITS.pumpCount.min ||
      pumps.length > LIMITS.pumpCount.max
    ) {
      errors.push(`泵数量须为 ${LIMITS.pumpCount.min}~${LIMITS.pumpCount.max} 台`);
    } else {
      pumps.forEach((pump, i) => {
        const label = `泵${(pump && pump.name) || i + 1}`;
        errors.push(
          ...validatePoints(pump && pump.points, label, LIMITS.pumpPoints.min, LIMITS.pumpPoints.max)
        );
      });
    }
    errors.push(
      ...validatePoints(spec.rainfall, '降雨入流', LIMITS.rainfallPoints.min, LIMITS.rainfallPoints.max)
    );

    if (!isNonNegNumber(spec.initialVolume)) errors.push('初始池量须为非负数值');
    if (!(typeof spec.capacity === 'number' && Number.isFinite(spec.capacity) && spec.capacity > 0)) {
      errors.push('池容须为正值');
    }
    if (!isNonNegNumber(spec.intakeLimit)) errors.push('取水口上限须为非负数值');

    // 所有曲线首末时刻一致（仅在前述校验通过后比较，避免对非法数据取点）
    if (errors.length === 0) {
      const curves = pumps.map((p) => p.points).concat([spec.rainfall]);
      const names = pumps.map((p, i) => `泵${p.name || i + 1}`).concat(['降雨入流']);
      const t0 = curves[0][0].t;
      const t1 = curves[0][curves[0].length - 1].t;
      curves.forEach((pts, idx) => {
        if (pts[0].t !== t0 || pts[pts.length - 1].t !== t1) {
          errors.push(`${names[idx]}：首末时刻须与其他曲线一致（应为 ${t0} ~ ${t1} 分钟）`);
        }
      });
    }
    return errors;
  }

  /** 由关键点构造分段线性曲线：每段 {t0, t1, v0, k}，k 为斜率。 */
  function makeCurve(points) {
    const segs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      segs.push({ t0: a.t, t1: b.t, v0: a.v, k: (b.v - a.v) / (b.t - a.t) });
    }
    return { points, segs };
  }

  /** 曲线在时刻 t 所处（t 右侧）的段；t 为末时刻时取最后一段。 */
  function segmentAt(curve, t) {
    for (const s of curve.segs) {
      if (t >= s.t0 && t < s.t1) return s;
    }
    return curve.segs[curve.segs.length - 1];
  }

  /** 分段线性曲线求值（t 须位于首末时刻之间）。 */
  function evalCurve(curve, t) {
    const pts = curve.points;
    if (t <= pts[0].t) return pts[0].v;
    for (const s of curve.segs) {
      if (t <= s.t1) return s.v0 + s.k * (t - s.t0);
    }
    return pts[pts.length - 1].v;
  }

  /**
   * 在 τ∈[0,len] 上求 f(τ)=c0+c1·τ+c2·τ² 首次严格超过 level 的时刻（取下确界，
   * 即“从该时刻起超限”的穿越点）。前提 f(0) <= level + EPS。不超限返回 null。
   */
  function firstExceedTime(c0, c1, c2, level, len) {
    if (c0 > level + EPS) return 0;
    if (Math.abs(c2) < EPS) {
      // 线性
      if (c1 > EPS && c0 + c1 * len > level + EPS) {
        const tau = (level - c0) / c1;
        return Math.min(Math.max(tau, 0), len);
      }
      return null;
    }
    const disc = c1 * c1 - 4 * c2 * (c0 - level);
    if (disc < -EPS) return null;
    const sq = Math.sqrt(Math.max(disc, 0));
    const r1 = (-c1 - sq) / (2 * c2);
    const r2 = (-c1 + sq) / (2 * c2);
    const lo = Math.min(r1, r2);
    const hi = Math.max(r1, r2);
    if (c2 > 0) {
      // 开口向上：因 f(0)<=level，只可能在较大根之后超限
      if (hi < len - EPS) return Math.max(hi, 0);
      return null;
    }
    // 开口向下：在 (lo, hi) 之间超限
    const start = Math.max(lo, 0);
    const end = Math.min(hi, len);
    if (start < end - EPS) return start;
    return null;
  }

  /**
   * 审计主入口。返回：
   *  - { valid:false, ok:false, errors:[...] }                输入非法
   *  - { valid:true, ok:true, maxDrainage, maxVolume, minVolume, endVolume, ... }  安全
   *  - { valid:true, ok:false, time, violations:[...], ... }  失败（按最早时刻）
   */
  function audit(spec) {
    const errors = validateSpec(spec);
    if (errors.length > 0) {
      return { valid: false, ok: false, errors };
    }

    const pumpCurves = spec.pumps.map((p, i) => ({
      name: p.name || `泵${i + 1}`,
      curve: makeCurve(p.points),
    }));
    const rainCurve = makeCurve(spec.rainfall);
    const { initialVolume, capacity, intakeLimit } = spec;

    // 全部关键点并集切分时间轴
    const timeSet = new Set();
    for (const p of spec.pumps) for (const pt of p.points) timeSet.add(pt.t);
    for (const pt of spec.rainfall) timeSet.add(pt.t);
    const timeline = Array.from(timeSet).sort((a, b) => a - b);

    let maxDrainage = { value: -Infinity, time: timeline[0] };
    let maxVolume = { value: -Infinity, time: timeline[0] };
    let minVolume = { value: Infinity, time: timeline[0] };
    const noteDrainage = (v, t) => {
      if (v > maxDrainage.value + EPS) maxDrainage = { value: v, time: t };
    };
    const noteVolume = (v, t) => {
      if (v > maxVolume.value + EPS) maxVolume = { value: v, time: t };
      if (v < minVolume.value - EPS) minVolume = { value: v, time: t };
    };

    const violations = [];
    let volume = initialVolume;

    for (let i = 0; i < timeline.length - 1; i++) {
      const a = timeline[i];
      const b = timeline[i + 1];
      const len = b - a;

      // 各曲线在段首的值与段内斜率
      let Q0 = 0;
      let Kq = 0;
      const pumpState = pumpCurves.map((pc) => {
        const s = segmentAt(pc.curve, a);
        const v0 = s.v0 + s.k * (a - s.t0);
        Q0 += v0;
        Kq += s.k;
        return { name: pc.name, v0, k: s.k };
      });
      const rs = segmentAt(rainCurve, a);
      const R0 = rs.v0 + rs.k * (a - rs.t0);
      const Kr = rs.k;

      // 净流量 N(τ)=N0+Kn·τ，池量 V(τ)=Va+N0·τ+Kn·τ²/2，τ=t-a
      const N0 = R0 - Q0;
      const Kn = Kr - Kq;
      const Va = volume;
      const Vb = Va + N0 * len + 0.5 * Kn * len * len;

      // 段内极值：线性总抽排在端点取极值；二次池量还可能在内部驻点取极值
      noteDrainage(Q0, a);
      noteDrainage(Q0 + Kq * len, b);
      noteVolume(Va, a);
      noteVolume(Vb, b);
      if (Math.abs(Kn) > EPS) {
        const tauStar = -N0 / Kn;
        if (tauStar > EPS && tauStar < len - EPS) {
          noteVolume(Va + N0 * tauStar + 0.5 * Kn * tauStar * tauStar, a + tauStar);
        }
      }

      // 连续越限检测（解析求穿越时刻，不抽样）
      const stateAt = (tau) => {
        const pumps = pumpState.map((ps) => ({ name: ps.name, flow: ps.v0 + ps.k * tau }));
        const drainage = pumps.reduce((s, p) => s + p.flow, 0);
        return {
          pumps,
          drainage,
          rainfall: R0 + Kr * tau,
          volume: Va + N0 * tau + 0.5 * Kn * tau * tau,
        };
      };
      const push = (type, tau, extra) => {
        if (tau === null) return;
        violations.push(Object.assign({ type, time: a + tau }, stateAt(tau), extra));
      };
      push('drainage', firstExceedTime(Q0, Kq, 0, intakeLimit, len), {
        limit: intakeLimit,
        segmentPeak:
          Kq > 0 ? { value: Q0 + Kq * len, time: b } : { value: Q0, time: a },
      });
      push('overflow', firstExceedTime(Va, N0, 0.5 * Kn, capacity, len), { limit: capacity });

      volume = Vb;
    }

    if (violations.length > 0) {
      const tMin = Math.min.apply(null, violations.map((v) => v.time));
      const first = violations.filter((v) => v.time <= tMin + EPS);
      return { valid: true, ok: false, time: tMin, violations: first, capacity, intakeLimit };
    }

    return {
      valid: true,
      ok: true,
      maxDrainage,
      maxVolume,
      minVolume,
      endVolume: volume,
      capacity,
      intakeLimit,
    };
  }

  return { LIMITS, EPS, validateSpec, audit, makeCurve, evalCurve, firstExceedTime };
});
