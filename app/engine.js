/*
 * 调蓄池抽排曲线审计引擎。
 * 纯函数实现，不依赖 DOM：浏览器（window.FloodEngine）与 Node（require）共用。
 *
 * 模型：所有曲线在相邻关键点间线性变化，且各曲线首末时刻一致。
 * 审计：取全部曲线关键点的并集切分时间轴；在每一段上
 *   - 总抽排为线性函数，段内上限在端点处取得；
 *   - 净流量（入流 - 抽排）为线性函数，池量为其积分（二次函数），
 *     段内极值在端点或净流量过零点处取得；
 *   - 越界时刻由线性/二次方程解析求根得到。
 * 全程连续解析求解，不按分钟或抽样替代。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FloodEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  const TYPE_LABELS = {
    drainage: '总抽排超过取水口上限',
    overflow: '池容漫溢',
    dry: '池量低于 0（抽空）',
  };
  // 同一时刻多类超限并存时的报告优先级
  const TYPE_PRIORITY = { overflow: 0, dry: 1, drainage: 2 };

  function tol(scale) {
    return EPS * Math.max(1, Math.abs(scale));
  }

  function isFiniteNumber(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  /* ---------------- 输入校验 ---------------- */

  function validateCurve(points, label, errors) {
    if (!Array.isArray(points) || points.length < 2 || points.length > 5) {
      errors.push(`${label}：关键点数量须在 2 至 5 个之间`);
      return;
    }
    let prev = null;
    points.forEach((p, i) => {
      const t = p && p.t;
      const q = p && p.q;
      if (!isFiniteNumber(t) || !Number.isInteger(t) || t < 0) {
        errors.push(`${label}：第 ${i + 1} 个关键点的时刻须为非负整数分钟`);
      }
      if (!isFiniteNumber(q) || q < 0) {
        errors.push(`${label}：第 ${i + 1} 个关键点的流量须为非负数值`);
      }
      if (isFiniteNumber(t)) {
        if (prev !== null && t <= prev) {
          errors.push(`${label}：关键时刻须严格递增（第 ${i + 1} 个点）`);
        }
        prev = t;
      }
    });
  }

  function validate(cfg) {
    cfg = cfg || {};
    const errors = [];
    const pumps = Array.isArray(cfg.pumps) ? cfg.pumps : [];
    if (pumps.length < 2 || pumps.length > 4) {
      errors.push('泵数量须在 2 至 4 台之间');
    }
    pumps.forEach((p, i) => {
      validateCurve(p && p.points, (p && p.name) || `泵 ${i + 1}`, errors);
    });
    validateCurve(cfg.inflow, '降雨入流', errors);

    if (!isFiniteNumber(cfg.initialVolume) || cfg.initialVolume < 0) {
      errors.push('初始池量须为非负数值');
    }
    if (!isFiniteNumber(cfg.capacity) || cfg.capacity <= 0) {
      errors.push('池容须为正数');
    }
    if (!isFiniteNumber(cfg.intakeLimit) || cfg.intakeLimit < 0) {
      errors.push('取水口上限须为非负数值');
    }

    // 各曲线首末时刻须一致
    const curves = pumps
      .filter((p) => p && Array.isArray(p.points) && p.points.length >= 2)
      .map((p, i) => ({ label: p.name || `泵 ${i + 1}`, points: p.points }));
    if (Array.isArray(cfg.inflow) && cfg.inflow.length >= 2) {
      curves.push({ label: '降雨入流', points: cfg.inflow });
    }
    if (curves.length > 1) {
      const first = curves[0].points[0].t;
      const last = curves[0].points[curves[0].points.length - 1].t;
      curves.forEach((c) => {
        const cFirst = c.points[0].t;
        const cLast = c.points[c.points.length - 1].t;
        if (cFirst !== first || cLast !== last) {
          errors.push(
            `各曲线首末时刻须一致：${c.label} 为 ${cFirst} ~ ${cLast} min，应为 ${first} ~ ${last} min`
          );
        }
      });
    }
    return errors;
  }

  /* ---------------- 曲线求值 ---------------- */

  // 分段线性曲线在时刻 t 的取值
  function evalCurve(points, t) {
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      if (t <= p1.t || i === points.length - 2) {
        const span = p1.t - p0.t;
        const f = span === 0 ? 0 : (t - p0.t) / span;
        return p0.q + f * (p1.q - p0.q);
      }
    }
    return points[points.length - 1].q;
  }

  /* ---------------- 审计 ---------------- */

  // 解 A·s² + Na·s + (Va - target) = 0 在 s ∈ [0, dt] 内的全部根（升序、去重）
  function solveRoots(Va, Na, A, target, dt) {
    const c = Va - target;
    const scale = Math.max(1, Math.abs(A), Math.abs(Na), Math.abs(c));
    const win = EPS * Math.max(1, dt);
    const roots = [];
    const push = (s) => {
      if (s >= -win && s <= dt + win) roots.push(Math.min(Math.max(s, 0), dt));
    };
    if (Math.abs(A) <= EPS * scale) {
      if (Math.abs(Na) > EPS * scale) push(-c / Na);
      else if (Math.abs(c) <= EPS * scale) push(0);
    } else {
      let disc = Na * Na - 4 * A * c;
      if (disc < 0 && disc > -EPS * scale * scale) disc = 0;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        push((-Na + sq) / (2 * A));
        push((-Na - sq) / (2 * A));
      }
    }
    roots.sort((x, y) => x - y);
    return roots.filter((s, i) => i === 0 || s - roots[i - 1] > win);
  }

  // 段内首次“穿越”目标线的时刻：dir=+1 向上穿越（漫溢），dir=-1 向下穿越（抽空）。
  // 仅触及（切点）而未穿越不计；起点已在目标线上且继续越界则时刻为段起点。
  function firstCrossing(Va, Na, A, target, dt, dir) {
    const roots = solveRoots(Va, Na, A, target, dt);
    for (const s of roots) {
      const deriv = Na + 2 * A * s;
      const scale = Math.max(1, Math.abs(Na), Math.abs(2 * A * s));
      if (dir * deriv > EPS * scale) return s;
      if (Math.abs(deriv) <= EPS * scale && dir * A > 0) return s; // 切点且继续越界
    }
    return null;
  }

  function betterMax(cur, value, time) {
    if (!cur) return { value, time };
    if (value > cur.value + tol(value)) return { value, time };
    if (value >= cur.value - tol(value) && time < cur.time) return { value: cur.value, time };
    return cur;
  }

  function betterMin(cur, value, time) {
    if (!cur) return { value, time };
    if (value < cur.value - tol(value)) return { value, time };
    if (value <= cur.value + tol(value) && time < cur.time) return { value: cur.value, time };
    return cur;
  }

  function audit(cfg) {
    const inputErrors = validate(cfg);
    if (inputErrors.length) return { ok: false, inputErrors };

    const pumps = cfg.pumps.map((p, i) => ({
      name: (p.name && String(p.name)) || `泵 ${i + 1}`,
      points: p.points,
    }));
    const inflow = cfg.inflow;
    const limit = cfg.intakeLimit;
    const capacity = cfg.capacity;

    // 全部关键点并集（递增）
    const timeSet = new Set();
    pumps.forEach((p) => p.points.forEach((pt) => timeSet.add(pt.t)));
    inflow.forEach((pt) => timeSet.add(pt.t));
    const times = Array.from(timeSet).sort((a, b) => a - b);

    // 各曲线在并集时刻的取值
    const pumpVals = pumps.map((p) => times.map((t) => evalCurve(p.points, t)));
    const inflowVals = times.map((t) => evalCurve(inflow, t));

    const failures = [];
    const nodeVolumes = [cfg.initialVolume];
    let maxDrainage = null;
    let maxVolume = betterMax(null, cfg.initialVolume, times[0]);
    let minVolume = betterMin(null, cfg.initialVolume, times[0]);
    let V = cfg.initialVolume;

    for (let i = 0; i < times.length - 1; i++) {
      const a = times[i];
      const b = times[i + 1];
      const dt = b - a;

      let Qa = 0;
      let Qb = 0;
      for (let k = 0; k < pumps.length; k++) {
        Qa += pumpVals[k][i];
        Qb += pumpVals[k][i + 1];
      }
      const Ia = inflowVals[i];
      const Ib = inflowVals[i + 1];

      // 总抽排线性：段内上限在端点处取得
      maxDrainage = betterMax(maxDrainage, Math.max(Qa, Qb), Qa >= Qb ? a : b);
      if (Math.max(Qa, Qb) > limit + tol(limit)) {
        let tc;
        if (Qa > limit + tol(limit)) {
          tc = a;
        } else {
          tc = a + ((limit - Qa) / (Qb - Qa)) * dt;
          tc = Math.min(Math.max(tc, a), b);
        }
        failures.push({ time: tc, type: 'drainage', seg: i });
      }

      // 净流量线性，池量二次：V(a+s) = Va + Na·s + A·s²
      const Na = Ia - Qa;
      const Nb = Ib - Qb;
      const Va = V;
      const A = (Nb - Na) / (2 * dt);
      const Vb = Va + ((Na + Nb) / 2) * dt;

      let segVmax = Math.max(Va, Vb);
      let segVmaxT = Va >= Vb ? a : b;
      let segVmin = Math.min(Va, Vb);
      let segVminT = Va <= Vb ? a : b;
      if (Na * Nb < 0) {
        // 净流量过零点：池量段内驻点
        const s = (Na * dt) / (Na - Nb);
        if (s > 0 && s < dt) {
          const Vx = Va + Na * s + A * s * s;
          if (Vx > segVmax) {
            segVmax = Vx;
            segVmaxT = a + s;
          }
          if (Vx < segVmin) {
            segVmin = Vx;
            segVminT = a + s;
          }
        }
      }
      maxVolume = betterMax(maxVolume, segVmax, segVmaxT);
      minVolume = betterMin(minVolume, segVmin, segVminT);

      // 漫溢：段内首次向上穿越池容
      if (segVmax > capacity + tol(capacity)) {
        let s = 0;
        if (Va <= capacity + tol(capacity)) {
          const hit = firstCrossing(Va, Na, A, capacity, dt, +1);
          s = hit === null ? 0 : hit;
        }
        failures.push({ time: a + s, type: 'overflow', seg: i });
      }
      // 抽空：段内首次向下穿越 0
      if (segVmin < -tol(capacity)) {
        let s = 0;
        if (Va >= -tol(capacity)) {
          const hit = firstCrossing(Va, Na, A, 0, dt, -1);
          s = hit === null ? 0 : hit;
        }
        failures.push({ time: a + s, type: 'dry', seg: i });
      }

      V = Vb;
      nodeVolumes.push(Vb);
    }

    if (failures.length) {
      failures.sort((x, y) => x.time - y.time || TYPE_PRIORITY[x.type] - TYPE_PRIORITY[y.type]);
      const f = failures[0];
      const tf = f.time;
      const i = f.seg;
      const a = times[i];
      const dt = times[i + 1] - a;
      let Qa = 0;
      let Qb = 0;
      for (let k = 0; k < pumps.length; k++) {
        Qa += pumpVals[k][i];
        Qb += pumpVals[k][i + 1];
      }
      const Na = inflowVals[i] - Qa;
      const Nb = inflowVals[i + 1] - Qb;
      const A = (Nb - Na) / (2 * dt);
      const s = tf - a;
      const volume = nodeVolumes[i] + Na * s + A * s * s;
      const totalFlow = Qa + ((Qb - Qa) * s) / dt;
      const pumpFlows = pumps
        .map((p) => ({ name: p.name, flow: evalCurve(p.points, tf) }))
        .sort((x, y) => y.flow - x.flow);
      return {
        ok: false,
        failure: {
          time: tf,
          type: f.type,
          typeLabel: TYPE_LABELS[f.type],
          volume,
          totalFlow,
          limit,
          capacity,
          pumps: pumpFlows,
        },
      };
    }

    return {
      ok: true,
      startTime: times[0],
      endTime: times[times.length - 1],
      limit,
      capacity,
      maxDrainage,
      maxVolume,
      minVolume,
      endVolume: V,
    };
  }

  return { audit, validate, evalCurve, TYPE_LABELS };
});
