/* 页面交互：维护泵/入流关键点，调用 FloodEngine 审计；任一编辑立即使旧结论失效。 */
(function () {
  'use strict';

  const MIN_POINTS = 2;
  const MAX_POINTS = 5;
  const MIN_PUMPS = 2;
  const MAX_PUMPS = 4;

  const SAMPLE = {
    initialVolume: 1500,
    capacity: 3000,
    intakeLimit: 120,
    inflow: [[0, 20], [30, 80], [60, 120], [90, 60], [120, 20]],
    pumps: [
      { name: '泵 1', points: [[0, 0], [30, 40], [90, 40], [120, 0]] },
      { name: '泵 2', points: [[0, 10], [60, 50], [120, 20]] },
      { name: '泵 3', points: [[0, 5], [120, 25]] },
    ],
  };

  const $ = (sel) => document.querySelector(sel);
  const pumpsEl = $('#pumps');
  const inflowBody = $('#inflow-body');
  const resultEl = $('#result');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmt(x) {
    if (!Number.isFinite(x)) return '—';
    return String(Math.round(x * 1000) / 1000);
  }

  /* ---------- 结构维护 ---------- */

  function makePointRow(t, q) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="number" class="pt-t" min="0" step="1"></td>' +
      '<td><input type="number" class="pt-q" min="0" step="any"></td>' +
      '<td><button type="button" class="mini danger del-point" title="删除关键点">×</button></td>';
    tr.querySelector('.pt-t').value = t;
    tr.querySelector('.pt-q').value = q;
    tr.querySelector('.del-point').addEventListener('click', () => {
      const tbody = tr.parentElement;
      if (tbody.querySelectorAll('tr').length > MIN_POINTS) {
        tr.remove();
        refreshAll();
        invalidate();
      }
    });
    return tr;
  }

  function suggestTime(tbody) {
    const rows = tbody.querySelectorAll('tr');
    if (!rows.length) return 0;
    const last = Number(rows[rows.length - 1].querySelector('.pt-t').value);
    return Number.isFinite(last) ? last + 10 : 0;
  }

  function addPointTo(tbody) {
    if (tbody.querySelectorAll('tr').length < MAX_POINTS) {
      tbody.appendChild(makePointRow(suggestTime(tbody), 0));
    }
  }

  function currentHorizon() {
    const tbody = pumpsEl.querySelector('.pump-card tbody');
    if (tbody) {
      const rows = tbody.querySelectorAll('tr');
      if (rows.length >= 2) {
        const t0 = Number(rows[0].querySelector('.pt-t').value);
        const t1 = Number(rows[rows.length - 1].querySelector('.pt-t').value);
        if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) return [t0, t1];
      }
    }
    return [0, 120];
  }

  function makePumpCard(name, points) {
    const card = document.createElement('div');
    card.className = 'pump-card';

    const head = document.createElement('div');
    head.className = 'pump-head';
    head.innerHTML =
      '<input type="text" class="pump-name" maxlength="12">' +
      '<button type="button" class="mini danger del-pump">删除泵</button>';
    head.querySelector('.pump-name').value = name;

    const table = document.createElement('table');
    table.className = 'points';
    table.innerHTML =
      '<thead><tr><th>时刻 (min)</th><th>流量 (m³/min)</th><th></th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    points.forEach(([t, q]) => tbody.appendChild(makePointRow(t, q)));

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'mini add-point';
    addBtn.textContent = '+ 添加关键点';
    addBtn.addEventListener('click', () => {
      addPointTo(tbody);
      refreshAll();
      invalidate();
    });

    head.querySelector('.del-pump').addEventListener('click', () => {
      if (pumpsEl.querySelectorAll('.pump-card').length > MIN_PUMPS) {
        card.remove();
        refreshAll();
        invalidate();
      }
    });

    card.appendChild(head);
    card.appendChild(table);
    card.appendChild(addBtn);
    return card;
  }

  function refreshCurve(tbody, addBtn) {
    const rows = tbody.querySelectorAll('tr').length;
    if (addBtn) addBtn.disabled = rows >= MAX_POINTS;
    tbody.querySelectorAll('.del-point').forEach((b) => {
      b.disabled = rows <= MIN_POINTS;
    });
  }

  function refreshAll() {
    const cards = pumpsEl.querySelectorAll('.pump-card');
    $('#pump-add').disabled = cards.length >= MAX_PUMPS;
    cards.forEach((card) => {
      card.querySelector('.del-pump').disabled = cards.length <= MIN_PUMPS;
      refreshCurve(card.querySelector('tbody'), card.querySelector('.add-point'));
    });
    refreshCurve(inflowBody, $('#inflow-add'));
  }

  /* ---------- 读取输入 ---------- */

  function readNumber(input) {
    const v = String(input.value).trim();
    return v === '' ? NaN : Number(v);
  }

  function readCurve(tbody) {
    return Array.from(tbody.querySelectorAll('tr')).map((tr) => ({
      t: readNumber(tr.querySelector('.pt-t')),
      q: readNumber(tr.querySelector('.pt-q')),
    }));
  }

  function readConfig() {
    const cards = Array.from(pumpsEl.querySelectorAll('.pump-card'));
    return {
      initialVolume: readNumber($('#initial-volume')),
      capacity: readNumber($('#capacity')),
      intakeLimit: readNumber($('#intake-limit')),
      inflow: readCurve(inflowBody),
      pumps: cards.map((card, i) => ({
        name: card.querySelector('.pump-name').value.trim() || `泵 ${i + 1}`,
        points: readCurve(card.querySelector('tbody')),
      })),
    };
  }

  /* ---------- 结果渲染与失效 ---------- */

  function invalidate() {
    if (resultEl.dataset.filled === '1' && !resultEl.classList.contains('stale')) {
      resultEl.classList.add('stale');
      const banner = document.createElement('div');
      banner.className = 'stale-banner';
      banner.textContent = '⚠ 输入已修改，以上结论已失效，请重新点击「审计」。';
      resultEl.prepend(banner);
    }
  }

  function renderResult(res) {
    resultEl.classList.remove('hidden', 'stale', 'ok', 'fail', 'invalid');
    if (res.inputErrors) {
      resultEl.classList.add('invalid');
      resultEl.innerHTML =
        '<h3>⚠ 输入有误，未执行审计</h3><ul>' +
        res.inputErrors.map((e) => `<li>${esc(e)}</li>`).join('') +
        '</ul>';
    } else if (res.ok) {
      resultEl.classList.add('ok');
      resultEl.innerHTML =
        '<h3>✅ 审计通过：全时段合规</h3><ul>' +
        `<li>最大总抽排：<b>${fmt(res.maxDrainage.value)}</b> m³/min，出现于 t = ${fmt(res.maxDrainage.time)} min（取水口上限 ${fmt(res.limit)}）</li>` +
        `<li>最大池量：<b>${fmt(res.maxVolume.value)}</b> m³，出现于 t = ${fmt(res.maxVolume.time)} min（池容 ${fmt(res.capacity)}）</li>` +
        `<li>最小池量：<b>${fmt(res.minVolume.value)}</b> m³，出现于 t = ${fmt(res.minVolume.time)} min</li>` +
        `<li>期末池量：${fmt(res.endVolume)} m³（t = ${fmt(res.endTime)} min）</li>` +
        '</ul>';
    } else {
      const f = res.failure;
      const pumps = f.pumps
        .map((p) => `<li>${esc(p.name)}：${fmt(p.flow)} m³/min${p.flow > 0 ? '' : '（当时未运行）'}</li>`)
        .join('');
      resultEl.classList.add('fail');
      resultEl.innerHTML =
        `<h3>❌ 审计未通过：${esc(f.typeLabel)}</h3><ul>` +
        `<li>最早超限时刻：<b>t = ${fmt(f.time)} min</b></li>` +
        `<li>当时池量：${fmt(f.volume)} m³（池容 ${fmt(f.capacity)}）</li>` +
        `<li>当时总抽排：${fmt(f.totalFlow)} m³/min（取水口上限 ${fmt(f.limit)}）</li>` +
        `</ul><div class="pump-list-title">相关泵（按当时流量降序）：</div><ul>${pumps}</ul>`;
    }
    resultEl.dataset.filled = '1';
  }

  /* ---------- 示例与事件 ---------- */

  function loadSample() {
    $('#initial-volume').value = SAMPLE.initialVolume;
    $('#capacity').value = SAMPLE.capacity;
    $('#intake-limit').value = SAMPLE.intakeLimit;
    inflowBody.innerHTML = '';
    SAMPLE.inflow.forEach(([t, q]) => inflowBody.appendChild(makePointRow(t, q)));
    pumpsEl.innerHTML = '';
    SAMPLE.pumps.forEach((p) => pumpsEl.appendChild(makePumpCard(p.name, p.points)));
    refreshAll();
    invalidate();
  }

  $('#audit').addEventListener('click', () => {
    renderResult(window.FloodEngine.audit(readConfig()));
  });
  $('#load-sample').addEventListener('click', loadSample);
  $('#pump-add').addEventListener('click', () => {
    if (pumpsEl.querySelectorAll('.pump-card').length < MAX_PUMPS) {
      const n = pumpsEl.querySelectorAll('.pump-card').length + 1;
      const [t0, t1] = currentHorizon();
      pumpsEl.appendChild(makePumpCard(`泵 ${n}`, [[t0, 0], [t1, 0]]));
      refreshAll();
      invalidate();
    }
  });
  $('#inflow-add').addEventListener('click', () => {
    addPointTo(inflowBody);
    refreshAll();
    invalidate();
  });
  // 任一编辑（数值、名称、增删点/泵）立即使旧结论失效
  $('#app').addEventListener('input', invalidate);

  loadSample();
})();
