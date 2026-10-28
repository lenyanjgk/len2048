/* ============================================================
   2048 AI 官网 — 交互脚本（零依赖）
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT
   1) no-js → js 类切换（reveal 初始态只在 JS 就绪后启用）
   2) IntersectionObserver 滚动 reveal
   3) 数字 count-up
   4) 导航当前区块高亮
   5) 主题：与游戏界面共用 themes.js 的四套配色
   6) HERO 演示板：用与前端一致的移动逻辑真实自玩
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  var reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1) 滚动 reveal ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  function revealAll() {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  if (reduced || !('IntersectionObserver' in window)) {
    revealAll();
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---------- 2) 数字 count-up ---------- */
  function fmtNum(n) {
    if (n >= 10000) return (n / 1000).toFixed(0) + 'k';
    return n.toLocaleString('en-US');
  }

  function countUp(el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    var suffix = el.getAttribute('data-suffix') || '';
    if (reduced || target === 0) {
      el.textContent = (target === 0 ? '0' : fmtNum(target)) + suffix;
      return;
    }
    var dur = 1400, start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      // easeOutExpo
      var eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      el.textContent = fmtNum(Math.round(target * eased)) + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var counters = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));
  if (!('IntersectionObserver' in window) || reduced) {
    counters.forEach(countUp);
  } else {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          countUp(entry.target);
          cio.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { cio.observe(el); });
  }

  /* ---------- 3) 导航滚动态 ---------- */
  // 顶栏是实色底，滚动态只用来标记"当前章节"，不再改背景
  var nav = document.getElementById('nav');
  var anchors = Array.prototype.slice.call(document.querySelectorAll('.anchors a[href^="#"]'));
  function onScroll() {
    if (!nav) return;
    var y = window.scrollY + 90;
    var cur = null;
    anchors.forEach(function (a) {
      var t = document.querySelector(a.getAttribute('href'));
      if (t && t.getBoundingClientRect().top + window.scrollY <= y) cur = a;
    });
    anchors.forEach(function (a) { a.classList.toggle('is-here', a === cur); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- 4) 主题：与游戏界面共用 themes.js 的四套配色 ---------- */
  // 官网自己的令牌在 site.css，data-theme 直接取应用侧的主题 key：
  //   neon 终端·暗 / classic 纸面·亮 / sakura 曙·亮 / forest 苔·暗
  // 两边读同一个 localStorage key，任一页切换另外两页都跟着变。
  var APP_KEY = 'len2048-theme';

  function readStore(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function writeStore(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ }
  }

  // 演示板当前用的是哪一套主题 —— paint() 据此取方块色
  var demoTheme = 'neon';

  // 方块色直接取 themes.js 里和游戏界面同一份色阶，四套主题自动都对；
  // 文字色按底色亮度自适应（深底白字、浅底深字），不用再维护第二张表
  function demoTile(v) {
    return window.LEN2048 ? window.LEN2048.tileColor(demoTheme, v) : '#3a3a3e';
  }
  function demoFg(v) {
    return window.LEN2048 ? window.LEN2048.readableFg(demoTile(v)) : '#ffffff';
  }

  function applySiteTheme(appKey) {
    if (!window.LEN2048 || !window.LEN2048.THEMES[appKey]) appKey = 'neon';
    demoTheme = appKey;
    document.documentElement.setAttribute('data-theme', appKey);
    // 色板的按下态也要跟着走，否则官网上永远看不出当前是哪一套
    if (window.LEN2048) window.LEN2048.syncSwatches(appKey);
    writeStore(APP_KEY, appKey);
    // 主题换了演示板要重画一遍（空格底色走 CSS 令牌，不用管）
    if (boardEl && demo && demo.cells.length) paint();
  }

  function initSiteTheme() {
    // 早期版本官网自己存过一份 light|dark，现在统一走 APP_KEY，把旧键清掉
    try { localStorage.removeItem('len2048-site-theme'); } catch (e) { /* 忽略 */ }
    // 有记录用记录，否则跟随系统深浅色偏好
    var key = readStore(APP_KEY);
    if (!key || !(window.LEN2048 && window.LEN2048.THEMES[key])) {
      var prefersDark = window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
      key = prefersDark ? 'neon' : 'classic';
    }
    // 先把色板建出来，再应用主题——顺序反了的话，按下态会落在还不存在的节点上
    if (window.LEN2048) {
      window.LEN2048.buildThemePicker(document.getElementById('theme-swatches'),
                                      applySiteTheme);
    }
    applySiteTheme(key);
    // 另一个标签页改了主题 → 跟着变
    window.addEventListener('storage', function (e) {
      if (e.key === APP_KEY && e.newValue && window.LEN2048 && window.LEN2048.THEMES[e.newValue]) {
        applySiteTheme(e.newValue);
      }
    });
  }

  /* ---------- 5) HERO 演示板：AI 真实自玩 ---------- */
  var boardEl = document.getElementById('demo-board');
  var scoreEl = document.getElementById('demo-score');
  var depthEl = document.getElementById('demo-depth');
  var nodesEl = document.getElementById('demo-nodes');

  function emptyBoard() {
    return [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  }
  function mergeLine(line) {
    var t = [], out = [], gain = 0;
    for (var i = 0; i < 4; i++) if (line[i]) t.push(line[i]);
    for (i = 0; i < t.length; i++) {
      if (i + 1 < t.length && t[i] === t[i + 1]) {
        var v = t[i] * 2; gain += v; out.push(v); i++;
      } else out.push(t[i]);
    }
    while (out.length < 4) out.push(0);
    return { line: out, gain: gain };
  }
  function moveMatrix(m, dir) {
    var out = emptyBoard(), gain = 0;
    for (var k = 0; k < 4; k++) {
      var line, res;
      if (dir === 0) { line = [m[0][k], m[1][k], m[2][k], m[3][k]]; res = mergeLine(line);
        for (var i = 0; i < 4; i++) out[i][k] = res.line[i]; }
      else if (dir === 1) { line = [m[3][k], m[2][k], m[1][k], m[0][k]]; res = mergeLine(line);
        for (i = 0; i < 4; i++) out[3 - i][k] = res.line[i]; }
      else if (dir === 2) { line = [m[k][0], m[k][1], m[k][2], m[k][3]]; res = mergeLine(line);
        for (i = 0; i < 4; i++) out[k][i] = res.line[i]; }
      else { line = [m[k][3], m[k][2], m[k][1], m[k][0]]; res = mergeLine(line);
        for (i = 0; i < 4; i++) out[k][3 - i] = res.line[i]; }
      gain += res.gain;
    }
    return { board: out, gain: gain };
  }
  function boardsEqual(a, b) {
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++)
      if (a[r][c] !== b[r][c]) return false;
    return true;
  }
  function hasMove(m) {
    for (var d = 0; d < 4; d++) if (!boardsEqual(m, moveMatrix(m, d).board)) return true;
    return false;
  }
  // 启发式：空格 + 可合并对 + 单调性（官网演示用简化版）
  function heur(m) {
    var empty = 0, merges = 0, mono = 0;
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        var v = m[r][c];
        if (!v) { empty++; continue; }
        if (c < 3 && m[r][c + 1] === v) merges++;
        if (r < 3 && m[r + 1][c] === v) merges++;
        if (c < 3) mono -= Math.abs(Math.log2(m[r][c + 1] || 1) - Math.log2(v));
        if (r < 3) mono -= Math.abs(Math.log2(m[r + 1][c] || 1) - Math.log2(v));
      }
    }
    return empty * 270 + merges * 700 + mono * 47;
  }
  // 演示用浅层 expectimax（深度 2~3），并统计节点数
  function bestMove(m, limit) {
    var nodes = 0;
    function tilechoose(b, d) {
      if (d >= limit) { nodes++; return heur(b); }
      var empties = [];
      for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) if (!b[r][c]) empties.push([r, c]);
      if (!empties.length) return heur(b);
      var sum = 0;
      for (var i = 0; i < empties.length; i++) {
        var nb = b.map(function (row) { return row.slice(); });
        nb[empties[i][0]][empties[i][1]] = 2;
        sum += moveNode(nb, d + 1);
      }
      return sum / empties.length;
    }
    function moveNode(b, d) {
      nodes++;
      var best = -Infinity;
      for (var dir = 0; dir < 4; dir++) {
        var res = moveMatrix(b, dir);
        if (boardsEqual(res.board, b)) continue;
        var v = tilechoose(res.board, d);
        if (v > best) best = v;
      }
      return best === -Infinity ? heur(b) : best;
    }
    var bestScore = -Infinity, bestDir = -1;
    for (var dir = 0; dir < 4; dir++) {
      var res = moveMatrix(m, dir);
      if (boardsEqual(res.board, m)) continue;
      var v = tilechoose(res.board, 1);
      if (v > bestScore) { bestScore = v; bestDir = dir; }
    }
    return { dir: bestDir, nodes: nodes };
  }

  var demo = { board: emptyBoard(), score: 0, cells: [], alive: false };

  function spawnTile() {
    var free = [];
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++)
      if (!demo.board[r][c]) free.push([r, c]);
    if (!free.length) return;
    var p = free[Math.floor(Math.random() * free.length)];
    demo.board[p[0]][p[1]] = Math.random() < 0.9 ? 2 : 4;
  }

  function buildCells() {
    boardEl.innerHTML = '';
    demo.cells = [];
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        var d = document.createElement('div');
        d.className = 'demo-cell';
        boardEl.appendChild(d);
        demo.cells.push(d);
      }
    }
  }

  function paint() {
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        var v = demo.board[r][c];
        var el = demo.cells[r * 4 + c];
        el.textContent = v || '';
        // 空格：清掉行内样式，回落到 CSS 里的 --demo-empty（随主题走）
        el.style.background = v ? demoTile(v) : '';
        el.style.color = v ? demoFg(v) : '';
      }
    }
    scoreEl.textContent = demo.score.toLocaleString('en-US');
  }

  function resetDemo() {
    demo.board = emptyBoard();
    demo.score = 0;
    spawnTile(); spawnTile();
    paint();
  }

  function step() {
    if (!demo.alive) return;
    if (!hasMove(demo.board)) {
      // 死局停顿后重开，保持页面一直有生命感
      setTimeout(function () { if (demo.alive) { resetDemo(); schedule(); } }, 1600);
      return;
    }
    // 局面越大给越深一点，展示"递进深度"
    var distinct = {};
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++)
      if (demo.board[r][c]) distinct[demo.board[r][c]] = 1;
    var kinds = Object.keys(distinct).length;
    var limit = Math.max(2, Math.min(3, kinds - 2));
    var res = bestMove(demo.board, limit);
    depthEl.textContent = String(limit);
    nodesEl.textContent = res.nodes.toLocaleString('en-US');
    if (res.dir < 0) { resetDemo(); schedule(); return; }
    var mv = moveMatrix(demo.board, res.dir);
    demo.board = mv.board;
    demo.score += mv.gain;
    spawnTile();
    paint();
    schedule();
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(step, reduced ? 1400 : 620);
  }

  // 仅当演示板在视口内才跑，省电
  function startDemo() {
    if (demo.alive) return;
    demo.alive = true;
    resetDemo();
    schedule();
  }
  function stopDemo() {
    demo.alive = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  initSiteTheme();

  if (boardEl) {
    buildCells();
    resetDemo();
    if ('IntersectionObserver' in window) {
      var dio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { e.isIntersecting ? startDemo() : stopDemo(); });
      }, { threshold: 0.15 });
      dio.observe(boardEl);
    } else {
      startDemo();
    }
    // 页面不可见时暂停
    document.addEventListener('visibilitychange', function () {
      document.hidden ? stopDemo() : startDemo();
    });
  }
})();
