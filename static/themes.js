/* ============================================================
   共享主题系统 —— 主应用（/）、管理页（/admin）、官网（/site/）共用。
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT
   每个主题 = 一套语义令牌 + 11 级方块色阶。
   方块色阶只走单一色相：低值安静、中段落到 accent、高值提亮、2048 给纯白。
   这样整屏只有一种彩色，且只出现在数据上（棋盘），界面其余部分全是灰阶。
   浏览器里挂到 globalThis.LEN2048；Node 下走 module.exports（供测试引用）。
   ============================================================ */
(function (root) {
  'use strict';

  var THEMES = {
    // 暗色终端：data-terminal，默认
    neon: {
      name: '终端', tip: '终端 · 暗色（默认）',
      dots: ['#1f3a58', '#4a8ad6', '#9cc0ee'],
      bg: '#171719', surface: '#131217', raised: '#212023',
      board: '#101013', cell: '#1b1b1e',
      text: '#ffffff', muted: '#b4b4b4', faint: '#8a8c92',
      border: '#222224', rule: '#1b1a1f', control: '#3a3a3e',
      accent: '#4a8ad6',
      positive: '#44a282', negative: '#e5566f',
      tiles: { 2: '#20232a', 4: '#232a36', 8: '#1f3a58', 16: '#1e4c7d', 32: '#2263a3',
               64: '#2f7cc4', 128: '#4a8ad6', 256: '#6ea6e2', 512: '#9cc0ee',
               1024: '#c6dbf7', 2048: '#ffffff' },
      big: '#ffffff',
    },
    // 浅色纸面：achromatic-ledger，铬级无彩色，蓝只上数据
    classic: {
      name: '纸面', tip: '纸面 · 浅色',
      dots: ['#dee5f1', '#1d5fbf', '#123a75'],
      bg: '#f9fafb', surface: '#ffffff', raised: '#f4f5f7',
      board: '#ebeef3', cell: '#dde1e9',
      text: '#111111', muted: '#5f6368', faint: '#6b6b6b',
      border: '#e8e8e8', rule: '#f2f2f2', control: '#d1d5db',
      accent: '#1d5fbf',
      positive: '#247b50', negative: '#c4242a',
      tiles: { 2: '#f7f8fa', 4: '#eef1f6', 8: '#e0e7f3', 16: '#c9d6ec', 32: '#a9c0e2',
               64: '#7fa2d3', 128: '#4f80c2', 256: '#2a66b4', 512: '#1d5fbf',
               1024: '#17509f', 2048: '#123a75' },
      big: '#0c2a55',
    },
    sakura: {
      name: '曙', tip: '曙色 · 浅色玫瑰',
      dots: ['#f6dde8', '#9c2f5d', '#6a1c3e'],
      bg: '#fbf8f9', surface: '#ffffff', raised: '#f6f1f3',
      board: '#f0e8ec', cell: '#e6d8de',
      text: '#1f1420', muted: '#6b5560', faint: '#7a626d',
      border: '#ece2e6', rule: '#f4eef1', control: '#d8c8cf',
      accent: '#9c2f5d',
      positive: '#247b50', negative: '#c4242a',
      tiles: { 2: '#fdfafb', 4: '#f9eff3', 8: '#f4dce7', 16: '#eec4d6', 32: '#e3a2bd',
               64: '#d2799f', 128: '#bf517f', 256: '#ab3c6d', 512: '#9a2e5b',
               1024: '#82254c', 2048: '#681b3c' },
      big: '#4d142c',
    },
    forest: {
      name: '苔', tip: '苔色 · 暗色绿',
      dots: ['#1d3a2a', '#3f9d6d', '#bde5cd'],
      bg: '#101312', surface: '#0e1211', raised: '#1a201d',
      board: '#0d1210', cell: '#182019',
      text: '#ffffff', muted: '#b6c2ba', faint: '#8a9a90',
      border: '#1e2421', rule: '#171c19', control: '#33403a',
      accent: '#3f9d6d',
      positive: '#44a282', negative: '#e5566f',
      tiles: { 2: '#1e2320', 4: '#212824', 8: '#1d3a2a', 16: '#1d4c34', 32: '#226343',
               64: '#2b7f57', 128: '#3f9d6d', 256: '#5cb587', 512: '#8ecfa8',
               1024: '#bde5cd', 2048: '#ffffff' },
      big: '#ffffff',
    },
  };

  var THEME_ORDER = ['neon', 'classic', 'sakura', 'forest'];
  var TILE_LEVELS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
  var STORE_KEY = 'len2048-theme';

  // 依据背景色亮度选黑/白前景色，保证方块数字可读（对比度自适应）
  function readableFg(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return '#ffffff';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#2b2520' : '#ffffff';
  }

  function tileColor(themeKey, v) {
    var t = THEMES[themeKey] || THEMES.neon;
    return (v >= 4096 ? t.big : t.tiles[v]) || t.cell;
  }

  // 把一套主题的语义令牌写进 :root 的 CSS 自定义属性
  function applyThemeTokens(themeKey) {
    var t = THEMES[themeKey] || THEMES.neon;
    var root = document.documentElement;
    if (!root || !root.style) return t;
    var set = function (name, val) { root.style.setProperty(name, val); };
    set('--bg', t.bg);
    set('--surface', t.surface);
    set('--raised', t.raised);
    set('--board', t.board);
    set('--cell', t.cell);
    set('--text', t.text);
    set('--muted', t.muted);
    set('--faint', t.faint);
    set('--border', t.border);
    set('--rule', t.rule);
    set('--control', t.control);
    set('--accent', t.accent);
    set('--positive', t.positive);
    set('--negative', t.negative);
    for (var i = 0; i < TILE_LEVELS.length; i++) {
      set('--t' + TILE_LEVELS[i], t.tiles[TILE_LEVELS[i]]);
    }
    set('--tbig', t.big);
    return t;
  }

  function syncSwatches(themeKey) {
    if (typeof document === 'undefined') return;
    var nodes = document.querySelectorAll('.theme-swatch');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('aria-pressed', String(nodes[i].dataset.theme === themeKey));
    }
  }

  function readStored() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function writeStored(key) {
    try { localStorage.setItem(STORE_KEY, key); } catch (e) { /* 隐私模式忽略 */ }
  }

  // 首次打开：有记录用记录，否则跟随系统深浅色偏好
  function preferredTheme() {
    var key = readStored();
    if (key && THEMES[key]) return key;
    var prefersDark = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'neon' : 'classic';
  }

  // 在容器里渲染色板；onPick(key) 由调用方决定切换后还要做什么
  function buildThemePicker(container, onPick) {
    if (!container) return;
    container.innerHTML = '';
    THEME_ORDER.forEach(function (key) {
      var t = THEMES[key];
      var btn = document.createElement('button');
      btn.className = 'theme-swatch';
      btn.dataset.theme = key;
      btn.type = 'button';
      btn.title = t.tip;
      btn.setAttribute('aria-label', '切换到' + t.name + '主题');
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = t.dots.map(function (c) {
        return '<i style="background:' + c + '"></i>';
      }).join('');
      btn.addEventListener('click', function () { onPick(key); });
      container.appendChild(btn);
    });
  }

  var api = {
    THEMES: THEMES,
    THEME_ORDER: THEME_ORDER,
    TILE_LEVELS: TILE_LEVELS,
    STORE_KEY: STORE_KEY,
    readableFg: readableFg,
    tileColor: tileColor,
    applyThemeTokens: applyThemeTokens,
    syncSwatches: syncSwatches,
    readStored: readStored,
    writeStored: writeStored,
    preferredTheme: preferredTheme,
    buildThemePicker: buildThemePicker,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LEN2048 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
