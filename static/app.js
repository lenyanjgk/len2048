/* 2048 AI 助手 — 前端逻辑（原生 JS，无依赖）
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT
   主题令牌与色板在 themes.js，与管理页（/admin）、官网（/site/）共用同一套。 */
'use strict';

// 浏览器：themes.js 先加载并挂到 globalThis.LEN2048；Node：直接 require（测试用）
const T = (typeof LEN2048 !== 'undefined') ? LEN2048 : require('./themes.js');
const THEMES = T.THEMES;
const THEME_ORDER = T.THEME_ORDER;

// ---------- 状态
const state = {
  board: [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],
  score: 0,
  gameOver: false,
  lastSpawn: null,      // {r, c} 新块位置（动画用）
  autoTimer: null,
  busy: false,
  // 助手模式（真实对局辅助）：AI 只出推荐，棋子由用户走，新块由用户录入
  mode: 'assistant',    // 'assistant' | 'free'
  autoShift: true,      // 助手模式：推荐后是否自动把本地棋盘搬到推荐局面
  autoMoved: false,     // 本步是否由自动移位产生
  unlimitedBudget: false, // 思考预算不限时长（发 0 给后端）
  budgetCap: null,      // 非 null 时覆盖思考预算（自动演示用，防止无限时长卡死）
  abort: null,          // 进行中的 fetch 控制器（用于「停止」）
  awaitingBoard: true,  // 助手模式：等待用户输入初始棋盘
  pendingSpawn: false,  // 助手模式：等待用户录入本步新出现的方块
  lastRec: null,        // 最近一次推荐 {move, name, arrow}
  previewBoard: null,   // 预览面板里的局面（null = 已清空）
  gameId: null,         // 对局记录 id（db.games.id），null = 还没建
  // 计时器：从第一步开始走，死局/清空/切模式时归零
  startTime: null,      // 首次走棋的时间戳（null = 未开始）
  elapsedMs: 0,         // 已累计毫秒
  moveCount: 0,         // 本局走棋步数
  timerId: null,
  // 方块层：带唯一 id，滑动动画靠身份追踪
  tiles: [],
  theme: 'classic',
};

const $ = (id) => document.getElementById(id);
const boardEl = typeof document !== 'undefined' ? $('board') : null;
const logEl = typeof document !== 'undefined' ? $('log') : null;

// ---------------------------------------------------------------- 主题（令牌在 themes.js）

// 应用侧的编排：换令牌 → 重绘方块 → 重量格子 → 通知官网
function applyTheme(key) {
  const t = T.applyThemeTokens(THEMES[key] ? key : 'neon');
  state.theme = THEMES[key] ? key : 'neon';
  T.syncSwatches(state.theme);
  T.writeStored(state.theme);
  // 通知官网：深色系主题 → dark，浅色系 → light（官网监听 storage 事件）
  try {
    const isDark = (state.theme === 'neon' || state.theme === 'forest');
    localStorage.setItem('len2048-site-theme', isDark ? 'dark' : 'light');
  } catch (e) { /* 隐私模式忽略 */ }
  renderBoard();          // 方块颜色跟着主题走
  syncTileMetrics();      // 主题可能换字体，重新量一次格子尺寸
}

function initTheme() {
  T.buildThemePicker($('theme-swatches'), (key) => {
    applyTheme(key);
    log(`已切换到「${THEMES[key].name}」主题`);
  });
  applyTheme(T.preferredTheme());
  bindAppThemeSync();
}

// 与官网（/site/）同步主题：官网切浅/深 → 这里切 classic/neon，反之亦然
function bindAppThemeSync() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  window.addEventListener('storage', (e) => {
    if (e.key !== 'len2048-site-theme' || !e.newValue) return;
    // 官网 dark → neon；官网 light → classic
    const want = e.newValue === 'dark' ? 'neon' : 'classic';
    if (state.theme !== want) {
      applyTheme(want);
      log(`主题已同步为「${THEMES[want].name}」`);
    }
  });
}

// ---------- 日志
function log(msg) {
  if (!logEl) return;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = 'is-fresh';
  div.innerHTML = `<span class="t">${t}</span>${msg}`;
  logEl.prepend(div);
  setTimeout(() => div.classList.remove('is-fresh'), 280);
  while (logEl.children.length > 100) logEl.lastChild.remove();
}

// ---------- 棋盘基础
function emptyBoard() {
  return [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
}

function tileClass(v) {
  if (!v) return '';
  return v >= 4096 ? 'tv-big' : 'tv-' + v;
}

function buildBoardDOM() {
  boardEl.innerHTML = '';
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.autocomplete = 'off';
      input.placeholder = '';
      input.dataset.r = r;
      input.dataset.c = c;
      input.setAttribute('aria-label', `第 ${r + 1} 行第 ${c + 1} 列的数值`);
      input.addEventListener('input', onCellInput);
      input.addEventListener('blur', onCellBlur);
      input.addEventListener('keydown', onCellKeydown);
      cell.appendChild(input);
      boardEl.appendChild(cell);
    }
  }
  // 方块层必须由这里创建：上面 innerHTML='' 会清掉 HTML 里的静态节点，
  // 若依赖静态写法，renderTiles 会因取不到 layer 而静默返回，数字全部消失
  const layer = document.createElement('div');
  layer.id = 'tile-layer';
  layer.className = 'tile-layer';
  layer.setAttribute('aria-hidden', 'true');
  boardEl.appendChild(layer);
}
function onCellInput(e) {
  // 只允许数字
  e.target.value = e.target.value.replace(/[^\d]/g, '').slice(0, 5);
}

function onCellKeydown(e) {
  if (e.key === 'Enter') {
    e.target.blur();
    requestHint(false);
  }
}

function normalizeValue(v) {
  // 归一化：0 / 2 的幂；非幂向下取最近的 2 的幂；上限 32768
  v = parseInt(v, 10);
  if (!v || v < 2) return 0;
  if (v > 32768) v = 32768;
  if ((v & (v - 1)) !== 0) {
    v = 1 << (31 - Math.clz32(v));   // 向下取 2 的幂
  }
  return v;
}

function onCellBlur(e) {
  const r = +e.target.dataset.r, c = +e.target.dataset.c;
  const v = normalizeValue(e.target.value);
  e.target.value = v === 0 ? '' : String(v);
  applyCellValue(r, c, v, `手动设置 (${r + 1},${c + 1}) = ${v || '空'}`);
}

// 写入格子（键盘输入与鼠标快捷输入共用同一套状态机）
function applyCellValue(r, c, v, logMsg) {
  if (state.board[r][c] === v) { renderBoard(); return; }

  // 助手模式 · 等待录入本步新方块：只允许填进空格
  if (state.mode === 'assistant' && state.pendingSpawn) {
    if (state.board[r][c] !== 0) {
      flashHint('只能把新方块填进空格，请点一个空位');
      return;
    }
    if (v === 0) { renderBoard(); return; }
    state.board[r][c] = v;
    state.pendingSpawn = false;
    state.autoMoved = false;
    state.lastSpawn = { r, c };
    log(`新方块已录入 (${r + 1},${c + 1}) = ${v}，可再次点击「AI 推荐」`);
    rebuildTiles();
    renderBoard();
    updateGameOver();
    updateFlowHint();
    return;
  }

  state.board[r][c] = v;
  log(logMsg);
  // 助手模式：局面录入完成即离开第①步
  if (state.mode === 'assistant' && state.awaitingBoard
      && hasMove(state.board)) {
    state.awaitingBoard = false;
    log('棋盘已录入，点击「AI 推荐」计算最优着法');
  }
  rebuildTiles();
  refreshMeta();
  updateFlowHint();
  scheduleSave();   // 连续编辑棋盘时防抖落库，别一个按键打一次库
}

// 引擎可表示的最大方块（rank 15），与后端 bitboard 上限一致
const MAX_TILE = 32768;
// 滑动动画时长（与 CSS --move-ms 对应），合并/新块在滑动落定后播放
const MOVE_SETTLE_MS = 140;
const BOARD_GAP = 12;   // 与 CSS .board 的 --gap 保持一致

// 量出棋盘真实像素，把 --cell-size 以 px 写进方块层。
// 必须用实测值：CSS 百分比会让 transform 的百分比相对元素自身解析，
// 与 .tile 自身宽度形成循环依赖，浏览器判定 transform 无效 → 方块堆回原点。
function syncTileMetrics() {
  const layer = $('tile-layer');
  if (!layer || !boardEl || !boardEl.clientWidth) return;
  const contentW = boardEl.clientWidth - BOARD_GAP * 2;   // 减去上下 padding
  if (contentW <= 0) return;
  const cell = (contentW - BOARD_GAP * 3) / 4;            // 4 格之间 3 个 gap
  layer.style.setProperty('--cell-size', `${cell}px`);
  layer.style.setProperty('--gap', `${BOARD_GAP}px`);
}

// 窗口尺寸变化时重新量（防抖）
let resizeTimer = null;
function bindTileMetrics() {
  syncTileMetrics();
  if (typeof window === 'undefined' || !window.addEventListener) return;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncTileMetrics, 120);
  });
  // 字体异步加载完后棋盘宽度可能变化，再量一次
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncTileMetrics).catch(() => {});
  }
}

// 鼠标快捷输入：左键 = 当前数值乘 2（空格 → 2 → 4 → … → 32768 → 2 循环），右键 = 清空
function quickCell(r, c) {
  // 先收拢可能还在输入中的格子，把它的值落定
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  const cur = state.board[r][c];
  let v;
  if (cur === 0) v = 2;
  else if (cur >= MAX_TILE) v = 2;   // 到顶后回到 2，避免卡死在最大值
  else v = cur * 2;
  applyCellValue(r, c, v, `快捷设置 (${r + 1},${c + 1}) = ${v}`);
  renderBoard();
}

function bindBoardMouse() {
  // 事件委托：左键循环 2/4/空，右键直接设 4，同时屏蔽系统右键菜单
  boardEl.addEventListener('mousedown', (e) => {
    const cell = e.target && e.target.closest ? e.target.closest('.cell') : null;
    if (!cell) return;
    e.preventDefault();
    const r = +cell.dataset.r, c = +cell.dataset.c;
    if (e.button === 2) {
      applyCellValue(r, c, 0, `右键清空 (${r + 1},${c + 1})`);
      renderBoard();
    } else if (e.button === 0) {
      quickCell(r, c);
    }
  });
  boardEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

function refreshMeta() {
  renderBoard();
  updateGameOver();
}

// 死局状态可逆：编辑棋盘后若又存在合法走法，自动解除
function updateGameOver() {
  if (hasMove(state.board)) {
    if (state.gameOver) log('局面已存在合法走法，死局解除');
    state.gameOver = false;
    hideOverlay();
  } else if (maxTile() > 0) {
    state.gameOver = true;
    // 死局即停表：把已走时间固化，不再继续累加
    if (state.startTime !== null) {
      state.elapsedMs += Date.now() - state.startTime;
      state.startTime = null;
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    }
    renderTimer();
    showOverlay('死局 · 按「新游戏」重开');
    saveGame();          // 死局落库：is_over = 1，管理页才筛得出来
    if (state.autoTimer) stopAuto();
  }
}

// ---------- 计时器
function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// 走一步棋时调用：首次走棋启动计时
function tickMove() {
  state.moveCount += 1;
  if (state.startTime === null) {
    state.startTime = Date.now();
    if (!state.timerId) state.timerId = setInterval(renderTimer, 500);
  }
  renderTimer();
}
function renderTimer() {
  let ms = state.elapsedMs;
  if (state.startTime !== null) ms += Date.now() - state.startTime;
  const timerEl = $('timer');
  if (timerEl) timerEl.textContent = fmtTime(ms);
  const movesEl = $('moves');
  if (movesEl) movesEl.textContent = String(state.moveCount);
}

function resetTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
  state.startTime = null;
  state.elapsedMs = 0;
  state.moveCount = 0;
  renderTimer();
}

// ---------- 助手模式 / 自由模式

function setMode(mode) {
  stopAuto();
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach(b => {
    const on = b.id === (mode === 'assistant' ? 'mode-assistant' : 'mode-free');
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  // 自动演示只在自由模式可用：位置固定，只置灰（避免布局跳动）
  $('btn-auto').disabled = mode !== 'free';
  $('btn-auto').title = mode === 'free'
    ? '让 AI 从当前局面自动下到底'
    : '自动演示需要自由对战模式（自动出新块）';
  refreshControls();

  if (mode === 'assistant') {
    state.board = emptyBoard();
    state.score = 0;
    state.gameOver = false;
    resetTimer();
    state.lastSpawn = null;
    state.pendingSpawn = false;
    state.autoMoved = false;
    state.awaitingBoard = true;
    hideOverlay();
    clearRecommendation();
    resetGameRecord();
    rebuildTiles();   // 盘面已清空，方块层必须跟着清（否则上一局的块留在屏幕上）
    renderBoard();
    log('已进入助手模式：请输入真实对局中的当前棋盘');
  } else {
    state.pendingSpawn = false;
    state.awaitingBoard = false;
    newGame();
    log('已进入自由对战模式：方向键/WASD 手动下棋，或点「自动演示」');
  }
  updateFlowHint();
}

// 统一刷新按钮可用状态：位置永远固定，只用 disabled 表达不可用
function refreshControls() {
  // 「本步无新方块」只在助手模式等待录新块时可用
  $('btn-nospawn').disabled = !(state.mode === 'assistant' && state.pendingSpawn);
  // 「停止」只在计算中可用
  $('btn-cancel').disabled = !state.busy;
  // 「AI 推荐」助手模式下受流程门槛限制
  if (state.mode === 'assistant') {
    $('btn-hint').disabled = state.busy || state.awaitingBoard || state.pendingSpawn;
  } else {
    $('btn-hint').disabled = state.busy;
  }
}

// 标题行下的那一行：屏幕的 finding —— 现在进行到哪一步、该做什么
function updateFlowHint() {
  const el = $('flow-hint');
  refreshControls();
  if (!el) return;

  if (state.mode === 'free') {
    el.innerHTML = '自由对战：方向键 / WASD 手动下棋，或点「自动演示」让 AI 接管';
    return;
  }
  if (state.awaitingBoard) {
    el.innerHTML = '<b>① 输入棋盘</b> · 点击格子录入真实对局中的当前局面（左键乘 2，右键清空）';
  } else if (state.pendingSpawn) {
    const r = state.lastRec;
    if (state.autoMoved) {
      el.innerHTML = `<b>③ 已自动移位「${r ? r.arrow + ' ' + r.name : ''}」</b> · ` +
        '在真实游戏中走出同样方向，然后点击新出现方块的位置录入数值（通常是 2 或 4）';
    } else {
      el.innerHTML = `<b>③ 录入新方块</b> · 已在真实游戏中走出 <b>${r ? r.arrow + ' ' + r.name : ''}</b>？` +
        '请点击新出现方块的位置并输入数值（通常是 2 或 4）';
    }
  } else {
    el.innerHTML = state.autoShift
      ? '<b>② AI 推荐</b> · 点「AI 推荐」，算完会自动移位并提示你走哪个方向'
      : '<b>② AI 推荐</b> · 点「AI 推荐」算最优着法，然后用方向键在真实游戏中执行';
  }
}

let flashTimer = null;
function flashHint(msg) {
  const el = $('flow-hint');
  log(msg);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;  // 重启动画
  el.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('flash'), 420);
}

function clearHighlights() {
  document.querySelectorAll('.cell').forEach(c => c.classList.remove('best-target'));
}

function clearRecommendation() {
  state.lastRec = null;
  $('rec-arrow').textContent = '—';
  $('rec-dir').textContent = '等待计算';
  $('rec-expect').textContent = '—';
  document.querySelectorAll('.move').forEach(row => {
    row.classList.remove('is-best', 'is-illegal');
    row.querySelector('.bar').style.width = '0%';
    row.querySelector('.move-score').textContent = '—';
  });
  ['st-heur', 'st-actual', 'st-depth', 'st-nodes', 'st-hits', 'st-time']
    .forEach(id => { $(id).textContent = '—'; });
  clearPreview();
  clearHighlights();
}

function renderBoard() {
  const cells = boardEl.children;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = cells[r * 4 + c];
      const input = cell.firstChild;
      const v = state.board[r][c];
      cell.className = 'cell';
      const str = v === 0 ? '' : String(v);
      if (input.value !== str && document.activeElement !== input) {
        input.value = str;
      }
    }
  }
  const scoreEl = $('score');
  const scoreStr = state.score.toLocaleString();
  if (scoreEl.textContent !== scoreStr) {
    scoreEl.textContent = scoreStr;
    bumpScore();
  }
  const mx = maxTile();
  $('max-tile').textContent = mx ? mx.toLocaleString() : '—';
  renderTiles();
  renderTimer();
}

// 分数变化时给那一格一个短暂的放大反馈（ transform only ）
function bumpScore() {
  const box = $('kpi-score');
  if (!box || !box.classList) return;
  box.classList.remove('bump');
  void box.offsetWidth;
  box.classList.add('bump');
  setTimeout(() => box.classList.remove('bump'), 320);
}

// ---------- 方块层（视觉 + 动画）

let tileSeq = 0;

function tileEl(t) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = t.id;
  el.style.setProperty('--col', t.c);
  el.style.setProperty('--row', t.r);
  const inner = document.createElement('div');
  inner.className = 'tile-inner ' + tileVarClass(t.v);
  inner.textContent = t.v;
  el.appendChild(inner);
  return el;
}

// 方块背景色类名：直接内联取主题变量，避免 12 级 × 4 主题的规则爆炸
function tileVarClass(v) {
  if (!v) return '';
  return v >= 4096 ? 'tv-big' : 'tv-' + v;
}

function tileColor(v) {
  return T.tileColor(state.theme, v);
}
const readableFg = T.readableFg;

// 依据 state.tiles 全量重绘方块层（编辑棋盘 / 换主题 / 重置时用）
function renderTiles() {
  const layer = $('tile-layer');
  if (!layer) return;
  const theme = THEMES[state.theme] || THEMES.classic;
  layer.innerHTML = '';
  for (const t of state.tiles) {
    if (!t.v) continue;
    const el = tileEl(t);
    const inner = el.firstChild;
    inner.style.background = tileColor(t.v);
    inner.style.color = readableFg(tileColor(t.v));
    layer.appendChild(el);
  }
}

// 从盘面重建方块列表（无动画）——用于编辑、重置、换主题
function rebuildTiles() {
  flushPendingSettle();   // 先把上一次的合并/新块结算掉，再按盘面重建
  state.tiles = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = state.board[r][c];
      if (v) state.tiles.push({ id: ++tileSeq, r, c, v });
    }
  }
  renderTiles();
}

// 上一次滑动动画还没落定（合并/新块未结算）。
// 自动演示节奏快于 MOVE_SETTLE_MS 时会连着走棋，此时必须把上一次立刻结算掉，
// 而不是扔掉——否则堆在同一格的方块永远不合并，合并后的数字就一直不更新。
let settleTimer = null;
let pendingSettle = null;
function flushPendingSettle() {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  if (pendingSettle) { const fn = pendingSettle; pendingSettle = null; fn(); }
}
// 兼容旧名：真正要"取消"的场景不存在，落定必须发生
function cancelPendingSettle() { flushPendingSettle(); }

// 走棋后更新方块：先滑动（transform 过渡），再落定合并/新块
function animateMove(detail, spawnedCell) {
  const layer = $('tile-layer');
  if (!layer) { rebuildTiles(); return; }
  flushPendingSettle();

  // 1) 应用滑动目标位置 → CSS transition 自动补间
  for (const s of detail.slides) {
    const t = state.tiles.find(t => t.r === s.fr && t.c === s.fc);
    if (t) { t.r = s.tr; t.c = s.tc; }
  }
  renderTiles();

  // 2) 同一格堆了多个方块 = 合并点：滑动结束后只留一个并升级
  const mergeAt = new Map(detail.merges.map(m => [`${m.r},${m.c}`, m]));
  const reduced = prefersReducedMotion();
  // 新块数值由 spawnRandomTile 直接给出；兜底再读一次盘面
  const spawnValue = spawnedCell
    ? (spawnedCell.v || (state.board[spawnedCell.r] || [])[spawnedCell.c]) : 0;

  const settle = () => {
    const byPos = new Map();
    for (const t of state.tiles) {
      const key = `${t.r},${t.c}`;
      if (!byPos.has(key)) byPos.set(key, []);
      byPos.get(key).push(t);
    }
    const kept = [];
    for (const [key, arr] of byPos) {
      if (arr.length === 1) { kept.push(arr[0]); continue; }
      const mg = mergeAt.get(key);
      const win = arr[arr.length - 1];
      if (mg) win.v = mg.v;
      kept.push(win);
    }
    state.tiles = kept;
    // 新块（数值取快照；取不到则放弃，等下次 rebuildTiles 兜底）
    if (spawnedCell && spawnValue) {
      state.tiles.push({ id: ++tileSeq, r: spawnedCell.r, c: spawnedCell.c,
                         v: spawnValue, isNew: true });
    }
    renderTiles();
    // 合并脉冲 + 新块弹入
    for (const m of detail.merges) {
      const t = state.tiles.find(t => t.r === m.r && t.c === m.c);
      if (!t) continue;
      const el = layer.querySelector(`.tile[data-id="${t.id}"]`);
      if (el) {
        el.classList.add('is-merged');
        setTimeout(() => el.classList.remove('is-merged'), 260);
      }
    }
    const nt = state.tiles.find(t => t.isNew);
    if (nt) {
      const el = layer.querySelector(`.tile[data-id="${nt.id}"]`);
      if (el) {
        el.classList.add('is-new');
        setTimeout(() => el.classList.remove('is-new'), 220);
      }
      nt.isNew = false;
    }
  };

  if (reduced) { pendingSettle = null; settle(); }
  else {
    pendingSettle = settle;
    settleTimer = setTimeout(() => { settleTimer = null; pendingSettle = null; settle(); },
                             MOVE_SETTLE_MS);
  }
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function refreshMeta() {
  renderBoard();
  updateGameOver();
}

function maxTile() {
  let m = 0;
  for (const row of state.board) for (const v of row) m = Math.max(m, v);
  return m;
}

// ---------- 2048 行逻辑（JS 侧，用于手动/自动落子与预览）
function mergeLine(line) {
  const tiles = line.filter(v => v !== 0);
  const out = [];
  let gain = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const v = tiles[i] * 2;
      gain += v;
      out.push(v);
      i++;
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < 4) out.push(0);
  return { line: out, gain };
}

// dir: 0上 1下 2左 3右（与后端一致）
function moveMatrix(m, dir) {
  return moveMatrixDetailed(m, dir).board;
}

// 带滑动/合并明细的着法计算，供方块动画使用
// 返回 { board, gain, moved, slides:[{fr,fc,tr,tc,v}], merges:[{r,c,v}] }
function moveMatrixDetailed(m, dir) {
  const out = emptyBoard();
  const slides = [];
  const merges = [];
  let gain = 0;

  // 把一行/列的下标 i 映射回棋盘坐标 (r,c)
  const toRC = (k, i) => {
    if (dir === 0) return { r: i, c: k };
    if (dir === 1) return { r: 3 - i, c: k };
    if (dir === 2) return { r: k, c: i };
    return { r: k, c: 3 - i };
  };

  for (let k = 0; k < 4; k++) {
    let line;
    if (dir === 0) line = [m[0][k], m[1][k], m[2][k], m[3][k]];
    else if (dir === 1) line = [m[3][k], m[2][k], m[1][k], m[0][k]];
    else if (dir === 2) line = [m[k][0], m[k][1], m[k][2], m[k][3]];
    else line = [m[k][3], m[k][2], m[k][1], m[k][0]];

    const det = mergeLineDetailed(line);
    gain += det.gain;
    det.out.forEach((entry, to) => {
      const rc = toRC(k, to);
      out[rc.r][rc.c] = entry.v;
      entry.from.forEach(from => {
        const f = toRC(k, from);
        slides.push({ fr: f.r, fc: f.c, tr: rc.r, tc: rc.c, v: entry.v });
      });
      if (entry.merged) merges.push({ r: rc.r, c: rc.c, v: entry.v });
    });
  }

  const moved = !boardsEqual(out, m);
  return { board: out, gain, moved, slides, merges };
}

// 单行合并，附带每个结果格的来源下标（用于追踪方块身份）
function mergeLineDetailed(line) {
  const tiles = [];
  for (let i = 0; i < 4; i++) if (line[i] !== 0) tiles.push({ v: line[i], from: i });

  const out = [];
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i].v === tiles[i + 1].v) {
      out.push({ v: tiles[i].v * 2, from: [tiles[i].from, tiles[i + 1].from], merged: true });
      i++;
    } else {
      out.push({ v: tiles[i].v, from: [tiles[i].from], merged: false });
    }
  }

  const result = [0, 0, 0, 0];
  out.forEach((entry, to) => { result[to] = entry.v; });
  return { out, gain: out.reduce((s, e) => s + (e.merged ? e.v : 0), 0) };
}

function boardsEqual(a, b) {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (a[r][c] !== b[r][c]) return false;
  return true;
}

function hasMove(m) {
  for (let d = 0; d < 4; d++) if (!boardsEqual(m, moveMatrix(m, d))) return true;
  return false;
}

function randomEmptyCell() {
  const cells = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!state.board[r][c]) cells.push([r, c]);
  if (!cells.length) return null;
  return cells[Math.floor(Math.random() * cells.length)];
}

function spawnRandomTile() {
  const pos = randomEmptyCell();
  if (!pos) return null;
  const v = Math.random() < 0.9 ? 2 : 4;
  state.board[pos[0]][pos[1]] = v;
  state.lastSpawn = { r: pos[0], c: pos[1] };
  // 必须把真正落块的位置返回给调用方：动画要靠它把新块加进方块层。
  // 早先这里是先 randomEmptyCell() 记位置、再让本函数另挑一个空格，两者对不上，
  // 新块就永远不进 state.tiles —— 屏幕上看不到新出的 2/4，下一步合并也不会升级。
  return { r: pos[0], c: pos[1], v };
}

// ---------- 参数收集
// budgetCap: 非 null 时强制覆盖思考预算（自动演示用，防止无限时长卡死）
function params(extra = {}) {
  let budget = state.unlimitedBudget ? 0 : +$('budget').value;
  if (state.budgetCap !== null && state.budgetCap !== undefined) budget = state.budgetCap;
  return Object.assign({
    board: state.board.map(row => row.slice()),
    depth_mode: $('depth-mode').value,
    fixed_depth: +$('fixed-depth').value,
    max_depth: +$('max-depth').value,
    time_budget_ms: budget,
  }, extra);
}

// 思考预算：勾选「不限时长」后发 0，后端视为没有死线，一直搜到目标深度
function toggleUnlimited() {
  state.unlimitedBudget = !!$('budget-unlimited').checked;
  $('budget').disabled = state.unlimitedBudget;
  $('budget-val').textContent = state.unlimitedBudget ? '无限' : $('budget').value;
  log(state.unlimitedBudget
    ? '思考预算已设为「不限时长」：会一直搜到目标深度，可能等待数分钟（可点「停止」取消）'
    : `思考预算已设为 ${$('budget').value} ms`);
}

// ---------- API
async function postJSON(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  if (!data.ok && data.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------- 对局记录落库
// 每开一局建一条 games 记录，之后每走一步往 moves 追加一行并更新主表。
// 全部静默失败：数据库不可用也绝不能影响下棋，所以一律 try/catch + 不弹窗。
// Node 测试环境没有 window，这里直接跳过（测试用 fetch 桩，不该被写库干扰）。

let saveTimer = null;

function persistEnabled() {
  // 只有真实浏览器里才落库；测试桩环境下 window 不存在
  return typeof window !== 'undefined' && typeof fetch === 'function';
}

// 开一局 / 重开一局 / 换模式 / 载入示例：丢掉旧的 gameId，下次保存时建新记录
function resetGameRecord() {
  state.gameId = null;
  clearTimeout(saveTimer);
  saveTimer = null;
}

async function ensureGame() {
  if (!persistEnabled() || state.gameId != null) return state.gameId;
  try {
    const d = await postJSON('/api/games', {
      mode: state.mode,
      board: state.board,
      score: state.score,
      moves: state.moveCount,
      elapsed_ms: state.elapsedMs + (state.startTime !== null ? Date.now() - state.startTime : 0),
    });
    state.gameId = d.id;
    log(`已建立对局记录 #${d.id}（管理页 /admin 可查）`);
    return state.gameId;
  } catch (e) {
    return null;   // 建不出来就不建，后面重试
  }
}

function elapsedNow() {
  let ms = state.elapsedMs;
  if (state.startTime !== null) ms += Date.now() - state.startTime;
  return ms;
}

async function saveGame(extra) {
  if (!persistEnabled()) return;
  const id = await ensureGame();
  if (id == null) return;
  try {
    await postJSON('/api/games/upd', Object.assign({
      id,
      board: state.board,
      score: state.score,
      moves: state.moveCount,
      elapsed_ms: elapsedNow(),
      is_over: state.gameOver,
    }, extra || {}));
  } catch (e) { /* 静默 */ }
}

// 走一步：往着法流水追加一行，同时把主表的分数/步数/盘面/用时对齐
async function logMove(direction, gain, boardAfter, source) {
  if (!persistEnabled()) return;
  const id = await ensureGame();
  if (id == null) return;
  try {
    await postJSON('/api/games/move', {
      id,
      direction,
      gain,
      score_after: state.score,
      elapsed_ms: elapsedNow(),   // 每走一步都把钟读进去，管理页的"用时"才不会一直是 00:00
      board_after: boardAfter,
      source,
    });
  } catch (e) { /* 静默 */ }
}

// 连续编辑棋盘时防抖落库，避免每个按键都打一次库
function scheduleSave(delay) {
  if (!persistEnabled()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveGame(); }, delay || 700);
}

// 离开页面前把最后状态写掉（keepalive 保证请求发得出去）
function flushSave() {
  if (!persistEnabled() || state.gameId == null) return;
  try {
    fetch('/api/games/upd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        id: state.gameId,
        board: state.board,
        score: state.score,
        moves: state.moveCount,
        elapsed_ms: elapsedNow(),
        is_over: state.gameOver,
      }),
    });
  } catch (e) { /* 静默 */ }
}

function bindPersistence() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSave();
  });
}

// 取消正在进行的计算（前端立即响应；服务端线程仍会算完，但结果被丢弃）
function cancelCompute() {
  if (state.abort) {
    state.abort.abort();
    log('已发送停止请求…');
  }
}

// ---------- 推荐
async function requestHint(applyMove = false) {
  if (state.busy) return;
  // 助手模式的流程门槛
  if (state.mode === 'assistant') {
    if (state.awaitingBoard) { flashHint('请先输入棋盘局面（①）'); return; }
    if (state.pendingSpawn) { flashHint('请先录入上一步新出现的方块（③）'); return; }
  }
  state.busy = true;
  setBusy(true);
  state.abort = new AbortController();
  try {
    const data = await postJSON('/api/best_move', params(), state.abort.signal);
    if (data.game_over) {
      state.gameOver = true;
      showOverlay(data.message && data.message.includes('空') ? '棋盘为空 · 请先输入数值' : '死局 · 无合法走法');
      log(data.message || '当前局面无合法走法');
      return;
    }
    hideOverlay();
    renderRecommendation(data);
    if (state.mode === 'assistant' && state.autoShift) {
      // 助手模式 · 自动移位：算完直接把本地棋盘搬到推荐后的局面
      applyRecommendedMove(data);
    } else if (applyMove) {
      applyAiMove(data);
    }
  } catch (e) {
    if (e.name === 'AbortError') { log('已停止计算'); return; }
    log(`推荐失败: ${e.message}`);
  } finally {
    state.busy = false;
    setBusy(false);
    state.abort = null;
  }
}

  // 助手模式 · 自动移位：算完直接把本地棋盘搬到推荐后的局面
function applyRecommendedMove(data) {
  const det = moveMatrixDetailed(state.board, data.best);
  state.board = data.board_after.map(row => row.slice());
  state.score = data.actual_score;
  state.lastSpawn = null;
  state.autoMoved = true;
  state.pendingSpawn = true;
  clearHighlights();
  tickMove();
  renderBoard();
  animateMove(det, null);
  updateGameOver();
  updatePreviewNote();
  logMove(data.best, det.gain, state.board, "autoshift");
  log(`已自动移位「${data.arrow} ${MOVE_LABEL[data.best]}」，请在真实游戏中走出同样方向`);
  updateFlowHint();
}

function renderRecommendation(data) {
  $('rec-arrow').textContent = data.arrow;
  $('rec-dir').textContent = MOVE_LABEL[data.best];
  $('rec-expect').textContent = fmt(data.scores[data.best]);

  // 四个方向：标签 + 2px 量条 + 右对齐等宽数字
  const maxScore = Math.max(...data.scores.filter(s => s > 0), 1);
  document.querySelectorAll('.move').forEach(row => {
    const m = +row.dataset.move;
    const legal = data.valid_moves.includes(m);
    row.classList.toggle('is-illegal', !legal);
    row.classList.toggle('is-best', m === data.best);
    const bar = row.querySelector('.bar');
    const scoreEl = row.querySelector('.move-score');
    if (legal) {
      bar.style.width = `${Math.max(2, (data.scores[m] / maxScore) * 100)}%`;
      scoreEl.textContent = fmt(data.scores[m]);
    } else {
      bar.style.width = '0%';
      scoreEl.textContent = '不可走';
    }
  });

  // 统计
  $('st-heur').textContent = fmt(data.heur);
  $('st-actual').textContent = data.actual_score.toLocaleString();
  const cut = data.stats.timed_out ? ' <span class="unit">截断</span>' : '';
  $('st-depth').innerHTML = `${data.stats.depth} / ${data.stats.target_depth}${cut}`;
  $('st-nodes').textContent = data.stats.nodes.toLocaleString();
  $('st-hits').textContent = data.stats.cache_hits.toLocaleString();
  $('st-time').innerHTML = `${data.stats.elapsed_ms}<span class="unit">ms</span>`;

  // 预览棋盘
  renderPreview(data.board_after);

  // 主棋盘高亮：会变的格子
  clearHighlights();
  document.querySelectorAll('.cell').forEach(cell => {
    const r = +cell.dataset.r, c = +cell.dataset.c;
    cell.classList.toggle('best-target', state.board[r][c] !== data.board_after[r][c]);
  });

  state.lastRec = { move: data.best, name: MOVE_LABEL[data.best], arrow: data.arrow };
  updateFlowHint();
  log(`推荐 <b>${data.arrow} ${MOVE_LABEL[data.best]}</b> 深度${data.stats.depth} ` +
      `${data.stats.nodes.toLocaleString()}节点 ${data.stats.elapsed_ms}ms`);
}

function renderPreview(matrix) {
  const el = $('preview');
  if (!el) return;
  state.previewBoard = matrix;
  el.innerHTML = '';
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = matrix[r][c];
      const cell = document.createElement('div');
      cell.className = 'p-cell';
      cell.textContent = v || '';
      if (v) {
        cell.style.background = tileColor(v);
        cell.style.color = readableFg(tileColor(v));
      }
      el.appendChild(cell);
    }
  }
  updatePreviewNote();
}

// 预览面板只说它自己是什么：是上次推荐的落点，还是已经落定的当前棋盘
function updatePreviewNote() {
  const el = $('preview-note');
  if (!el) return;
  if (!state.previewBoard) { el.textContent = '推荐后显示落点'; return; }
  el.textContent = boardsEqual(state.previewBoard, state.board)
    ? '已应用到当前棋盘'
    : '执行推荐着法后，不含新块';
}

// 棋盘变了但推荐已过期 → 预览必须跟着清空，不能留着一张旧局面
function clearPreview() {
  state.previewBoard = null;
  const el = $('preview');
  if (el) el.innerHTML = '';
  updatePreviewNote();
}

function applyAiMove(data) {
  const det = moveMatrixDetailed(state.board, data.best);   // 动画用：来源→去往
  state.board = data.board_after.map(row => row.slice());
  state.score = data.actual_score;
  state.lastSpawn = null;
  const spawn = spawnRandomTile();                          // 真正落块的那一格
  tickMove();
  renderBoard();
  animateMove(det, spawn);
  updateGameOver();
  clearHighlights();
  logMove(data.best, det.gain, state.board, "ai");
}

// ---------- 手动下棋
function toggleAutoShift() {
  state.autoShift = !state.autoShift;
  const btn = $('btn-autoshift');
  btn.classList.toggle('is-on', state.autoShift);
  btn.setAttribute('aria-pressed', String(state.autoShift));
  log(state.autoShift
    ? '已开启「推荐后自动移位」：点 AI 推荐后本地棋盘会自动搬到推荐局面'
    : '已关闭「推荐后自动移位」：推荐后需自己按方向键走棋');
  updateFlowHint();
}

function manualMove(dir) {
  if (state.busy) return;
  if (state.mode === 'assistant') {
    if (state.awaitingBoard) { flashHint('请先输入棋盘局面（①）'); return; }
    if (state.pendingSpawn) { flashHint('请先录入上一步新出现的方块（③）'); return; }
  } else if (state.autoTimer) {
    return;
  }
  const det = moveMatrixDetailed(state.board, dir);
  if (!det.moved) { log(`「${MOVE_LABEL[dir]}」方向不可走`); return; }
  state.board = det.board;
  state.score += det.gain;
  state.lastSpawn = null;
  clearHighlights();
  clearPreview();      // 棋盘已变，上一次推荐的落点预览作废
  tickMove();

  if (state.mode === 'assistant') {
    // 助手模式：不自动出新块，等用户在真实游戏中看到新块后回来录入
    state.pendingSpawn = true;
    renderBoard();
    animateMove(det, null);
    logMove(dir, det.gain, state.board, "manual");
    log(`已执行「${MOVE_LABEL[dir]}」，本地合并 +${det.gain} 分`);
    updateFlowHint();
  } else {
    const spawn = spawnRandomTile();
    renderBoard();
    animateMove(det, spawn);
    updateGameOver();
    logMove(dir, det.gain, state.board, "manual");
  }
}

// ---------- 自动演示（逐步请求推荐）
function toggleAuto() {
  if (state.autoTimer) {
    stopAuto();
  } else {
    startAuto();
  }
}

function startAuto() {
  if (state.gameOver) { log('已是死局，请新游戏或清空棋盘'); return; }
  // 自动演示若遇到「不限时长」会永远走不完，封顶到 1 秒/步
  state.budgetCap = state.unlimitedBudget ? 1000 : null;
  $('btn-auto').classList.add('is-on');
  $('btn-auto').textContent = '停止演示';
  log('自动演示开始');
  const step = async () => {
    if (!state.autoTimer) return;
    if (state.gameOver) { stopAuto(); return; }
    await requestHint(true);
    if (state.autoTimer) state.autoTimer = setTimeout(step, 120);
  };
  state.autoTimer = setTimeout(step, 50);
}

function stopAuto() {
  if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
  state.budgetCap = null;
  $('btn-auto').classList.remove('is-on');
  $('btn-auto').textContent = '自动演示';
  log('自动演示停止');
}

// ---------- 新游戏 / 清空 / 示例
function newGame() {
  stopAuto();
  if (state.mode === 'assistant') {
    // 助手模式没有"自动开局"，回到①等待录入
    state.board = emptyBoard();
    state.score = 0;
    state.gameOver = false;
    resetTimer();
    state.lastSpawn = null;
    state.pendingSpawn = false;
    state.awaitingBoard = true;
    hideOverlay();
    clearRecommendation();
    resetGameRecord();
    rebuildTiles();
    renderBoard();
    updateFlowHint();
    log('已重置，请输入当前棋盘局面');
    return;
  }
  state.board = emptyBoard();
  state.score = 0;
  state.gameOver = false;
  resetTimer();
  state.lastSpawn = null;
  resetGameRecord();
  spawnRandomTile();
  spawnRandomTile();
  hideOverlay();
  rebuildTiles();
  renderBoard();
  log('新游戏开始');
}

function clearBoard() {
  stopAuto();
  state.board = emptyBoard();
  state.score = 0;
  state.gameOver = false;
  resetTimer();
  state.lastSpawn = null;
  state.pendingSpawn = false;
  state.autoMoved = false;
  if (state.mode === 'assistant') state.awaitingBoard = true;
  hideOverlay();
  resetGameRecord();
  rebuildTiles();
  renderBoard();
  clearHighlights();
  updateFlowHint();
  log('棋盘已清空，可手动输入任意局面');
}

const SAMPLE = [
  [1024, 512, 256, 0],
  [64, 32, 16, 8],
  [4, 8, 16, 0],
  [2, 4, 0, 0],
];

function loadSample() {
  stopAuto();
  state.board = SAMPLE.map(row => row.slice());
  state.score = 0;
  state.gameOver = false;
  state.lastSpawn = null;
  state.pendingSpawn = false;
  state.autoMoved = false;
  state.awaitingBoard = false;
  resetTimer();
  rebuildTiles();
  resetGameRecord();   // 换了一个全新局面，旧记录不该被接着改
  clearPreview();
  hideOverlay();
  renderBoard();
  updateFlowHint();
  log('已载入示例局面（可直接点 AI 推荐）');
}

// 助手模式：本步没有新方块（死局或特殊规则）
function noSpawn() {
  state.pendingSpawn = false;
  state.autoMoved = false;
  log('已标记本步无新方块');
  updateGameOver();
  updateFlowHint();
}

// ---------- 死局 / 覆盖层
function showOverlay(text) { $('overlay').textContent = text; $('overlay').classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ---------- 忙碌状态
function setBusy(b) {
  state.busy = b;
  $('rec-arrow').classList.toggle('thinking', b);
  ['btn-new', 'btn-clear', 'btn-sample'].forEach(id => $(id).disabled = b);
  refreshControls();
}

// ---------- 工具
const MOVE_LABEL = { 0: '上', 1: '下', 2: '左', 3: '右' };
function fmt(v) { return Math.round(v).toLocaleString(); }

// ---------- 事件绑定
function bindEvents() {
  $('btn-hint').addEventListener('click', () => requestHint(false));
  $('btn-autoshift').addEventListener('click', toggleAutoShift);
  $('btn-cancel').addEventListener('click', cancelCompute);
  $('budget-unlimited').addEventListener('change', toggleUnlimited);
  $('btn-auto').addEventListener('click', toggleAuto);
  $('btn-new').addEventListener('click', newGame);
  $('btn-clear').addEventListener('click', clearBoard);
  $('btn-sample').addEventListener('click', loadSample);
  $('btn-nospawn').addEventListener('click', noSpawn);
  $('mode-assistant').addEventListener('click', () => setMode('assistant'));
  $('mode-free').addEventListener('click', () => setMode('free'));
  bindBoardMouse();

  const bindSlider = (id, valId) => {
    const el = $(id);
    el.addEventListener('input', () => { $(valId).textContent = el.value; });
  };
  bindSlider('fixed-depth', 'fixed-depth-val');
  bindSlider('max-depth', 'max-depth-val');
  bindSlider('budget', 'budget-val');

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'text' && e.key !== 'Escape') return;
    const keyMap = {
      ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3,
      w: 0, s: 1, a: 2, d: 3, W: 0, S: 1, A: 2, D: 3,
    };
    if (e.key in keyMap) {
      e.preventDefault();
      manualMove(keyMap[e.key]);
    } else if (e.key === ' ') {
      e.preventDefault();
      requestHint(false);
    } else if (e.key === 'Escape') {
      e.target.blur && e.target.blur();
    }
  });
}

// ---------- 启动（浏览器环境才初始化 DOM；Node 下仅供单元测试导出）
if (typeof document !== 'undefined') {
  buildBoardDOM();
  bindEvents();
  bindTileMetrics();     // 必须先量出 --cell-size，否则方块定位失效堆叠
  bindPersistence();     // 离开页面前把最后状态写库
  initTheme();
  setMode('assistant');   // 默认进入助手模式：输入棋盘 → 推荐 → 走棋 → 录新块
  log('就绪：按标题下的步骤操作（① 输入棋盘 → ② AI 推荐 → ③ 录入新方块）');
}

// Node 环境导出纯逻辑与流程函数，便于与后端 Python 引擎对拍（test_logic.js）
// 及助手模式流程测试（test_flow.js）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeLine, moveMatrix, boardsEqual, hasMove, normalizeValue, emptyBoard,
    setMode, requestHint, manualMove, onCellBlur, noSpawn, newGame,
    clearBoard, loadSample, quickCell, applyCellValue, toggleAutoShift,
    toggleUnlimited, cancelCompute, params, state,
    THEMES, THEME_ORDER, applyTheme, readableFg, tileColor,
    rebuildTiles, renderTiles, moveMatrixDetailed, animateMove,
    syncTileMetrics, buildBoardDOM, tileEl,
    // 主题系统来自 themes.js，这里转手出去，测试不用改引用
    themes: T,
  };
}
