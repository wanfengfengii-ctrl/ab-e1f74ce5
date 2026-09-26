/* 调蓄池抽排曲线审计 —— 页面交互（核心计算在 audit.js，复用同一实现） */
(function () {
  'use strict';

  const LIMITS = Audit.LIMITS;

  // 默认示例：一段完整暴雨过程，审计结果为安全
  const DEFAULTS = {
    initialVolume: 500,
    capacity: 3000,
    intakeLimit: 80,
    rainfall: [
      { t: 0, v: 20 },
      { t: 30, v: 80 },
      { t: 60, v: 50 },
      { t: 120, v: 5 },
    ],
    pumps: [
      {
        name: '泵1',
        points: [
          { t: 0, v: 10 },
          { t: 60, v: 40 },
          { t: 120, v: 10 },
        ],
      },
      {
        name: '泵2',
        points: [
          { t: 0, v: 0 },
          { t: 30, v: 25 },
          { t: 90, v: 25 },
          { t: 120, v: 0 },
        ],
      },
    ],
  };

  const TYPE_LABELS = {
    drainage: '总抽排超过取水口上限',
    overflow: '池量超过池容（漫溢）',
  };

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const pumpsEl = $('#pumps');
  const rainBody = $('#rainfall-body');
  const resultEl = $('#result');
  let resultState = 'idle'; // idle | shown | stale

  // ---------- 工具 ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function fmtNum(v) {
    if (!Number.isFinite(v)) return '—';
    const r = Math.round(v * 100) / 100;
    return String(Object.is(r, -0) ? 0 : r);
  }

  function fmtTime(t) {
    const r = Math.round(t);
    if (Math.abs(t - r) < 1e-6) return String(r);
    return '约 ' + Math.round(t * 100) / 100;
  }

  function parseNum(input) {
    const raw = String(input.value).trim();
    if (raw === '') return NaN;
    return Number(raw);
  }

  // ---------- 动态表格 ----------
  function makeRow(t, v) {
    const tr = document.createElement('tr');

    const tdT = document.createElement('td');
    const inT = document.createElement('input');
    inT.type = 'number';
    inT.className = 'in-t';
    inT.step = '1';
    inT.min = '0';
    inT.value = t;
    tdT.appendChild(inT);

    const tdV = document.createElement('td');
    const inV = document.createElement('input');
    inV.type = 'number';
    inV.className = 'in-v';
    inV.step = 'any';
    inV.min = '0';
    inV.value = v;
    tdV.appendChild(inV);

    const tdX = document.createElement('td');
    const btn = el('button', 'btn-icon', '×');
    btn.type = 'button';
    btn.title = '删除该关键点';
    btn.addEventListener('click', () => {
      tr.remove();
      refreshConstraints();
      invalidate();
    });
    tdX.appendChild(btn);

    tr.append(tdT, tdV, tdX);
    return tr;
  }

  function makePumpCard(name, points) {
    const card = el('div', 'pump-card');

    const head = el('div', 'pump-head');
    const nameInput = document.createElement('input');
    nameInput.className = 'pump-name';
    nameInput.value = name;
    nameInput.maxLength = 20;
    nameInput.setAttribute('aria-label', '泵名称');
    const removeBtn = el('button', 'btn-danger btn-remove-pump', '删除泵');
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
      card.remove();
      refreshConstraints();
      invalidate();
    });
    head.append(nameInput, removeBtn);

    const table = document.createElement('table');
    table.className = 'points';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>时刻 (min)</th><th>抽排流量 (m³/min)</th><th></th></tr>';
    const tbody = document.createElement('tbody');
    points.forEach((p) => tbody.appendChild(makeRow(p.t, p.v)));
    table.append(thead, tbody);

    const addBtn = el('button', 'btn-ghost btn-add-row', '+ 关键点');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      tbody.appendChild(makeRow('', ''));
      refreshConstraints();
      invalidate();
    });

    card.append(head, table, addBtn);
    return card;
  }

  function refreshConstraints() {
    const cards = $$('.pump-card', pumpsEl);
    $('#pump-add').disabled = cards.length >= LIMITS.pumpCount.max;
    cards.forEach((card) => {
      $('.btn-remove-pump', card).disabled = cards.length <= LIMITS.pumpCount.min;
      const rows = $$('tbody tr', card);
      $$('.btn-icon', card).forEach((b) => {
        b.disabled = rows.length <= LIMITS.pumpPoints.min;
      });
      $('.btn-add-row', card).disabled = rows.length >= LIMITS.pumpPoints.max;
    });
    const rainRows = $$('tr', rainBody);
    $$('.btn-icon', rainBody).forEach((b) => {
      b.disabled = rainRows.length <= LIMITS.rainfallPoints.min;
    });
    $('#rain-add').disabled = rainRows.length >= LIMITS.rainfallPoints.max;
  }

  // ---------- 读取表单 ----------
  function readSpec() {
    const pumps = $$('.pump-card', pumpsEl).map((card, i) => ({
      name: ($('.pump-name', card).value || '').trim() || `泵${i + 1}`,
      points: $$('tbody tr', card).map((tr) => ({
        t: parseNum($('.in-t', tr)),
        v: parseNum($('.in-v', tr)),
      })),
    }));
    return {
      pumps,
      rainfall: $$('tr', rainBody).map((tr) => ({
        t: parseNum($('.in-t', tr)),
        v: parseNum($('.in-v', tr)),
      })),
      initialVolume: parseNum($('#initial-volume')),
      capacity: parseNum($('#capacity')),
      intakeLimit: parseNum($('#intake-limit')),
    };
  }

  // ---------- 结果渲染 ----------
  function stat(label, value, unit, time) {
    return (
      `<div class="stat"><span class="stat-label">${label}</span>` +
      `<span class="stat-value">${value}</span><span class="stat-unit">${unit}</span>` +
      `<span class="stat-time">时刻：${time} min</span></div>`
    );
  }

  function renderResult(result) {
    resultState = 'shown';
    resultEl.classList.remove('hidden');

    if (!result.valid) {
      resultEl.className = 'panel result error';
      resultEl.innerHTML =
        '<h2>输入校验未通过</h2><ul>' +
        result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('') +
        '</ul>';
      return;
    }

    if (result.ok) {
      resultEl.className = 'panel result safe';
      resultEl.innerHTML =
        '<h2>✔ 审计通过：全程安全</h2><div class="stats">' +
        stat('最大抽排', fmtNum(result.maxDrainage.value), 'm³/min', fmtTime(result.maxDrainage.time)) +
        stat('最大池量', fmtNum(result.maxVolume.value), 'm³', fmtTime(result.maxVolume.time)) +
        stat('最小池量', fmtNum(result.minVolume.value), 'm³', fmtTime(result.minVolume.time)) +
        '</div><p class="note">按全部关键点并集切分时间轴，每段连续解析求值（非抽样）。</p>';
      return;
    }

    const blocks = result.violations
      .map((v) => {
        const pumps = v.pumps
          .map((p) => `<li><strong>${escapeHtml(p.name)}</strong>：${fmtNum(p.flow)} m³/min</li>`)
          .join('');
        const peak =
          v.type === 'drainage' && v.segmentPeak
            ? `<p>段内峰值抽排：${fmtNum(v.segmentPeak.value)} m³/min（时刻：${fmtTime(v.segmentPeak.time)} min）</p>`
            : '';
        return (
          `<div class="violation"><h3>${TYPE_LABELS[v.type]}</h3>` +
          `<p>当时池量：<strong>${fmtNum(v.volume)}</strong> m³（池容 ${fmtNum(result.capacity)} m³）</p>` +
          `<p>当时总抽排：${fmtNum(v.drainage)} m³/min（取水口上限 ${fmtNum(result.intakeLimit)} m³/min）</p>` +
          peak +
          `<p>相关泵：</p><ul class="pump-list">${pumps}</ul></div>`
        );
      })
      .join('');
    resultEl.className = 'panel result fail';
    resultEl.innerHTML =
      `<h2>✘ 审计未通过</h2><p class="fail-time">最早超限时刻：<strong>${fmtTime(result.time)}</strong> min，` +
      `自该时刻起出现以下超限：</p>${blocks}`;
  }

  // 任一编辑立即使旧结论失效
  function invalidate() {
    if (resultState !== 'shown') return;
    resultState = 'stale';
    resultEl.className = 'panel result stale';
    resultEl.innerHTML = '<p>⚠ 输入已修改，此前结论已失效，请重新点击「审计」。</p>';
  }

  // ---------- 初始化 ----------
  function init() {
    $('#initial-volume').value = DEFAULTS.initialVolume;
    $('#capacity').value = DEFAULTS.capacity;
    $('#intake-limit').value = DEFAULTS.intakeLimit;
    DEFAULTS.rainfall.forEach((p) => rainBody.appendChild(makeRow(p.t, p.v)));
    DEFAULTS.pumps.forEach((p) => pumpsEl.appendChild(makePumpCard(p.name, p.points)));

    $('#rain-add').addEventListener('click', () => {
      rainBody.appendChild(makeRow('', ''));
      refreshConstraints();
      invalidate();
    });
    $('#pump-add').addEventListener('click', () => {
      const n = $$('.pump-card', pumpsEl).length + 1;
      const rows = $$('tr', rainBody);
      const t0 = rows.length ? $('.in-t', rows[0]).value : '';
      const t1 = rows.length ? $('.in-t', rows[rows.length - 1]).value : '';
      pumpsEl.appendChild(
        makePumpCard(`泵${n}`, [
          { t: t0, v: 0 },
          { t: t1, v: 0 },
        ])
      );
      refreshConstraints();
      invalidate();
    });
    $('#audit-btn').addEventListener('click', () => renderResult(Audit.audit(readSpec())));
    $('main').addEventListener('input', invalidate);

    refreshConstraints();
  }

  init();
})();
