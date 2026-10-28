/* ============================================================
   对局记录管理页 — 交互脚本（原生 JS，零依赖）
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT
   1) 主题：与主应用共用 themes.js 的令牌
   2) 汇总条：GET /api/games/summary
   3) 表格：GET /api/games?mode&is_over&order&limit&offset
   4) 详情：GET /api/games/<id>，点流水里一步看那一步的盘面
   5) 删除：POST /api/games/del
   屏幕的唯一问题：都有哪些对局记录？—— 所以表格是最大的块，
   详情是右边的固定 384px 栏，选中一行才填内容。
   ============================================================ */
(function () {
  'use strict';

  var T = (typeof LEN2048 !== 'undefined') ? LEN2048 : require('../themes.js');
  var $ = function (id) { return document.getElementById(id); };

  var PAGE_SIZE = 20;
  var page = { offset: 0, total: 0, pages: 1, current: 1 };
  var selected = null;      // 当前选中的 game id
  var detail = null;        // 该局的 {game, moves}
  var shownStep = null;     // 详情里正在看的那一步（null = 终局）

  // ---------------------------------------------------------------- 主题

  function applyTheme(key) {
    T.applyThemeTokens(T.THEMES[key] ? key : 'neon');
    T.syncSwatches(key);
    T.writeStored(key);
  }

  function initTheme() {
    T.buildThemePicker($('theme-swatches'), function (key) {
      applyTheme(key);
      renderBoardColors();
    });
    applyTheme(T.preferredTheme());
  }

  // ---------------------------------------------------------------- 工具

  function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }

  function fmtDuration(ms) {
    var s = Math.floor((ms || 0) / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    var pad = function (v) { return String(v).padStart(2, '0'); };
    if (h > 0) return h + ':' + pad(m % 60) + ':' + pad(s % 60);
    return pad(m) + ':' + pad(s % 60);
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    // 存的是本地 ISO（带偏移），直接切片成 "MM-DD HH:MM" 就好读
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
    if (!m) return iso;
    return m[2] + '-' + m[3] + ' ' + m[4];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 方块配色与主应用完全一致：主题色阶 + 亮度自适应前景
  function paintCell(el, v) {
    if (!v) { el.style.background = ''; el.style.color = ''; el.textContent = ''; return; }
    var bg = T.tileColor(currentTheme(), v);
    el.style.background = bg;
    el.style.color = T.readableFg(bg);
    el.textContent = v;
  }

  // 16 个格子只建一次，之后换主题/换步都只是重涂
  function buildDetailBoard() {
    var board = $('d-board');
    if (!board) return;
    board.innerHTML = '';
    for (var i = 0; i < 16; i++) {
      var c = document.createElement('div');
      c.className = 'p-cell';
      board.appendChild(c);
    }
  }

  function currentTheme() {
    var el = document.querySelector('.theme-swatch[aria-pressed="true"]');
    return (el && el.dataset.theme) || 'neon';
  }

  function renderBoardColors() {
    var board = $('d-board');
    if (!board) return;
    var cells = board.children;
    if (!cells.length) buildDetailBoard();
    cells = board.children;
    var matrix = shownMatrix();
    for (var i = 0; i < cells.length; i++) {
      paintCell(cells[i], matrix ? matrix[(i / 4) | 0][i % 4] : 0);
    }
  }

  function shownMatrix() {
    if (!detail) return null;
    if (shownStep == null) {
      try { return JSON.parse(detail.game.board); } catch (e) { return null; }
    }
    var mv = detail.moves.filter(function (m) { return m.step_no === shownStep; })[0];
    if (!mv) return null;
    try { return JSON.parse(mv.board_after); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- 汇总

  function loadSummary() {
    return fetch('/api/games/summary').then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || '汇总加载失败');
        var avg = d.games ? Math.round(d.total_score / d.games) : 0;
        $('k-games').textContent = fmtInt(d.games);
        $('k-over').textContent = fmtInt(d.over_games);
        $('k-best').textContent = d.best_score ? fmtInt(d.best_score) : '—';
        $('k-avg').textContent = d.games ? fmtInt(avg) : '—';
        $('k-tile').textContent = d.best_tile ? fmtInt(d.best_tile) : '—';
        $('k-moves').textContent = fmtInt(d.total_moves);
        $('subline').textContent = d.games
          ? '共 ' + fmtInt(d.games) + ' 局，其中死局 ' + fmtInt(d.over_games) +
            ' 局；着法流水 ' + fmtInt(d.moves) + ' 步，可逐步回放。'
          : '还没有对局记录。去助手模式或自由对战下几局，这里就会出现。';
      })
      .catch(function (e) { $('subline').textContent = '汇总加载失败：' + e.message; });
  }

  // ---------------------------------------------------------------- 表格

  function query() {
    var p = new URLSearchParams();
    var mode = $('f-mode').value;
    var over = $('f-over').value;
    var order = $('f-order').value;
    if (mode) p.set('mode', mode);
    if (over !== '') p.set('is_over', over);
    if (order) p.set('order', order);
    p.set('limit', PAGE_SIZE);
    p.set('offset', page.offset);
    return p.toString();
  }

  function loadGames() {
    var q = $('f-q').value.trim();
    return fetch('/api/games?' + query()).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || '列表加载失败');
        var rows = d.games;
        // 搜索是客户端过滤：按 ID 或备注，数据量小，不值得为此加接口参数
        if (q) {
          rows = rows.filter(function (g) {
            return String(g.id).indexOf(q) >= 0 ||
                   String(g.note || '').toLowerCase().indexOf(q.toLowerCase()) >= 0;
          });
        }
        page.total = d.total;
        page.pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
        page.current = Math.floor(page.offset / PAGE_SIZE) + 1;
        renderRows(rows);
        renderPager();
      })
      .catch(function (e) { showTableError(e.message); });
  }

  function renderRows(rows) {
    var tbody = $('rows');
    tbody.innerHTML = '';
    if (!rows.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 9;
      td.className = 'state-note';
      td.textContent = page.total === 0 ? '还没有对局记录。' : '这个筛选条件下没有记录。';
      tr.appendChild(td);
      tbody.appendChild(tr);
      $('count').textContent = page.total === 0 ? '0 局' : '筛选出 0 局（共 ' + fmtInt(page.total) + ' 局）';
      return;
    }
    var frag = document.createDocumentFragment();
    rows.forEach(function (g) {
      var tr = document.createElement('tr');
      if (g.id === selected) tr.className = 'is-sel';
      tr.dataset.id = g.id;
      tr.innerHTML =
        '<td class="num cell-id">' + g.id + '</td>' +
        '<td class="mode-tag">' + (g.mode === 'free' ? '自由对战' : '助手模式') + '</td>' +
        '<td class="num cell-score">' + fmtInt(g.score) + '</td>' +
        '<td class="num">' + (g.max_tile ? fmtInt(g.max_tile) : '—') + '</td>' +
        '<td class="num">' + fmtInt(g.moves) + '</td>' +
        '<td class="num">' + fmtDuration(g.elapsed_ms) + '</td>' +
        '<td><span class="pill ' + (g.is_over ? 'pill-over' : 'pill-live') + '">' +
          (g.is_over ? '死局' : '进行中') + '</span></td>' +
        '<td class="num" style="color:var(--faint)">' + esc(fmtTime(g.updated_at)) + '</td>' +
        '<td class="cell-actions"><button class="row-del" type="button" ' +
          'aria-label="删除第 ' + g.id + ' 局">删除</button></td>';
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    var from = page.offset + 1;
    $('count').textContent = '第 ' + from + '–' + (from + rows.length - 1) +
      ' 局，共 ' + fmtInt(page.total) + ' 局';
  }

  function renderPager() {
    $('p-prev').disabled = page.current <= 1;
    $('p-next').disabled = page.current >= page.pages;
    $('p-label').textContent = page.current + ' / ' + page.pages;
  }

  function showTableError(msg) {
    var tbody = $('rows');
    tbody.innerHTML = '';
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 9;
    td.className = 'state-note';
    td.textContent = '加载失败：' + msg;
    tr.appendChild(td);
    tbody.appendChild(tr);
    $('count').textContent = '加载失败';
  }

  // ---------------------------------------------------------------- 详情

  function loadDetail(id) {
    return fetch('/api/games/' + id).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || '加载失败');
        detail = d;
        shownStep = null;
        renderDetail();
      })
      .catch(function (e) {
        detail = null;
        $('detail-empty').classList.remove('hidden');
        $('detail-body').classList.add('hidden');
        $('detail-empty').innerHTML = '<p>加载失败：' + esc(e.message) + '</p>';
      });
  }

  function renderDetail() {
    if (!detail) return;
    var g = detail.game;
    selected = g.id;
    $('detail-empty').classList.add('hidden');
    $('detail-body').classList.remove('hidden');
    $('d-id').textContent = g.id;
    $('d-sub').textContent = (g.mode === 'free' ? '自由对战' : '助手模式') +
      ' · ' + fmtTime(g.created_at) + ' 开始 · ' +
      (g.is_over ? '已结束 ' + fmtTime(g.ended_at) : '进行中');
    $('d-move-count').textContent = detail.moves.length;
    // 没结束的局显示的是"当前盘面"，不是"终局盘面"
    $('d-board-title').textContent = shownStep != null
      ? '第 ' + shownStep + ' 步后'
      : (g.is_over ? '终局盘面' : '当前盘面');
    $('d-board-note').textContent = shownStep == null
      ? '点下面任意一步，看那一步走完后的盘面'
      : '正在看第 ' + shownStep + ' 步；点终局行可回到终局盘面';

    $('d-kv').innerHTML =
      kvRow('分数', fmtInt(g.score)) +
      kvRow('最大块', g.max_tile ? fmtInt(g.max_tile) : '—') +
      kvRow('步数', fmtInt(g.moves)) +
      kvRow('用时', fmtDuration(g.elapsed_ms)) +
      kvRow('状态', g.is_over
        ? '<span class="pill pill-over">死局</span>'
        : '<span class="pill pill-live">进行中</span>') +
      kvRow('创建', esc(fmtTime(g.created_at))) +
      kvRow('更新', esc(fmtTime(g.updated_at))) +
      (g.note ? kvRow('备注', esc(g.note)) : '');

    renderBoardColors();
    renderMoves();
    // 选中行跟着详情走
    var rows = $('rows').children;
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-sel', rows[i].dataset.id === String(g.id));
    }
  }

  function kvRow(k, v) {
    return '<div class="kv-row"><dt>' + k + '</dt><dd class="num">' + v + '</dd></div>';
  }

  function renderMoves() {
    var tbody = $('d-moves');
    tbody.innerHTML = '';
    if (!detail.moves.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'state-note';
      td.style.padding = '24px 10px';
      td.textContent = '这一局还没有着法流水。';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    var frag = document.createDocumentFragment();
    detail.moves.forEach(function (m) {
      var tr = document.createElement('tr');
      if (m.step_no === shownStep) tr.className = 'is-sel';
      tr.dataset.step = m.step_no;
      tr.innerHTML =
        '<td class="num" style="color:var(--faint)">' + m.step_no + '</td>' +
        '<td>' + esc(m.direction_name) + '</td>' +
        '<td class="num mv-gain">+' + fmtInt(m.gain) + '</td>' +
        '<td class="num">' + fmtInt(m.score_after) + '</td>';
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  // ---------------------------------------------------------------- 事件

  function bindEvents() {
    $('rows').addEventListener('click', function (e) {
      var del = e.target.closest ? e.target.closest('.row-del') : null;
      var tr = e.target.closest ? e.target.closest('tr[data-id]') : null;
      if (!tr) return;
      var id = +tr.dataset.id;
      if (del) {
        e.stopPropagation();
        if (!window.confirm('删除第 ' + id + ' 局？它的着法流水会一起删掉，不能恢复。')) return;
        fetch('/api/games/del', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { window.alert('删除失败：' + (d.error || '未知错误')); return; }
          if (selected === id) { selected = null; detail = null; }
          refresh();
        }).catch(function (err) { window.alert('删除失败：' + err.message); });
        return;
      }
      loadDetail(id);
    });

    $('d-moves').addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr[data-step]') : null;
      if (!tr) return;
      shownStep = +tr.dataset.step;
      renderDetail();
    });

    $('d-del').addEventListener('click', function () {
      if (!detail) return;
      var id = detail.game.id;
      if (!window.confirm('删除第 ' + id + ' 局？它的着法流水会一起删掉，不能恢复。')) return;
      fetch('/api/games/del', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { window.alert('删除失败：' + (d.error || '未知错误')); return; }
        selected = null; detail = null;
        $('detail-body').classList.add('hidden');
        $('detail-empty').classList.remove('hidden');
        $('detail-empty').innerHTML = '<p>选一行看这局的盘面和着法。</p>';
        refresh();
      }).catch(function (err) { window.alert('删除失败：' + err.message); });
    });

    ['f-mode', 'f-over', 'f-order'].forEach(function (id) {
      $(id).addEventListener('change', function () { page.offset = 0; refresh(); });
    });
    var qTimer = null;
    $('f-q').addEventListener('input', function () {
      clearTimeout(qTimer);
      qTimer = setTimeout(loadGames, 200);
    });
    $('f-refresh').addEventListener('click', refresh);

    $('p-prev').addEventListener('click', function () {
      if (page.current <= 1) return;
      page.offset -= PAGE_SIZE;
      refresh();
    });
    $('p-next').addEventListener('click', function () {
      if (page.current >= page.pages) return;
      page.offset += PAGE_SIZE;
      refresh();
    });
  }

  function refresh() {
    loadSummary();
    loadGames();
    if (selected != null) loadDetail(selected);
  }

  // ---------------------------------------------------------------- 启动

  initTheme();
  buildDetailBoard();
  bindEvents();
  refresh();
})();
