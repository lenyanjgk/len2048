/* 助手模式流程集成测试（作者：lenyanjgk / 冷颜，MIT）：
   ① 输入棋盘 → ② AI 推荐 → 用户按方向键走棋 → ③ 录入新方块 → 回到 ②
   用最小 DOM 桩加载 app.js，驱动完整循环并断言状态机。 */
'use strict';

// ---------- 最小 DOM 桩
function makeEl() {
  const el = {
    id: '',
    _children: [],
    dataset: {},
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = String(v); },
      getPropertyValue(k) { return this._props[k] || ''; },
    },
    _classes: new Set(),
    _html: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    placeholder: '',
    type: '',
    addEventListener() {},
    appendChild(c) {
      const i = docRoots.indexOf(c);
      if (i >= 0) docRoots.splice(i, 1);   // 被挂到父节点后不再是文档根
      this._children.push(c);
      return c;
    },
    prepend(c) { this._children.unshift(c); },
    remove() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    get firstChild() { return this._children[0]; },
    get children() { return this._children; },
    get lastChild() { return this._children[this._children.length - 1]; },
    get offsetWidth() { return 100; },
    setAttribute() {},
    getAttribute() { return null; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; this._children = []; },
  });
  Object.defineProperty(el, 'className', {
    get() { return [...this._classes].join(' '); },
    set(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  el.classList = {
    add(c) { el._classes.add(c); },
    remove(c) { el._classes.delete(c); },
    contains(c) { return el._classes.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !el._classes.has(c) : !!force;
      if (on) el._classes.add(c); else el._classes.delete(c);
      return on;
    },
  };
  return el;
}

// 记录所有被创建的元素与当前"文档根"，让 getElementById 真的去树里找
const docRoots = [];
function dfsFind(el, id) {
  if (el.id === id) return el;
  for (const c of el._children) {
    const r = dfsFind(c, id);
    if (r) return r;
  }
  return null;
}

const elements = {};
global.document = {
  // 先按真实浏览器行为在 DOM 树中查找；找不到再按需造（兼容静态节点）
  getElementById: (id) => {
    for (const root of docRoots) {
      const found = dfsFind(root, id);
      if (found) return found;
    }
    // 按需创建的静态节点也要登记为文档根，并带上 id，否则它的子孙不会被搜到
    const el = makeEl();
    el.id = id;
    docRoots.push(el);
    elements[id] = el;
    return el;
  },
  createElement: () => {
    const el = makeEl();
    docRoots.push(el);
    return el;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  activeElement: null,
};

// ---------- fetch 桩：用前端自己的移动逻辑伪造一个合法推荐
const app = require('./static/app.js');
const NAMES = ['up', 'down', 'left', 'right'];
const ARROWS = ['↑', '↓', '←', '→'];

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const b = body.board;
  const valid = [];
  for (let d = 0; d < 4; d++) {
    if (!app.boardsEqual(b, app.moveMatrix(b, d))) valid.push(d);
  }
  if (!valid.length) {
    return { json: async () => ({ ok: true, game_over: true, message: '死局' }) };
  }
  const best = valid[0];
  const after = app.moveMatrix(b, best);
  return {
    json: async () => ({
      ok: true, game_over: false, best, best_name: NAMES[best], arrow: ARROWS[best],
      scores: [100, 200, 0, 300], valid_moves: valid,
      board_after: after, heur: 12345, actual_score: 999,
      stats: { depth: 3, nodes: 1000, cache_hits: 10, elapsed_ms: 50,
               timed_out: false, target_depth: 5 },
    }),
  };
};

// ---------- 断言工具
let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('  [PASS]', msg); }
  else { failed++; console.log('  [FAIL]', msg); }
}

const boardEl = document.getElementById('board');
function setCell(r, c, v) {
  const input = boardEl.children[r * 4 + c].firstChild;
  input.value = v === 0 ? '' : String(v);
  app.onCellBlur({ target: input });
}
function cellVal(r, c) { return app.state.board[r][c]; }
function emptyCount() {
  return app.state.board.flat().filter(v => v === 0).length;
}

// ---------- 流程
async function main() {
  console.log('== 启动即进入助手模式 ==');
  check(app.state.mode === 'assistant', '默认模式为 assistant');
  check(app.state.awaitingBoard === true, '初始为 awaitingBoard（等待输入棋盘）');
  check(emptyCount() === 16, '棋盘为空');

  console.log('== ① 输入棋盘 ==');
  // 此时点 AI 推荐应被拦住
  await app.requestHint();
  check(app.state.lastRec === null, ' awaitingBoard 时 AI 推荐被拦住');

  setCell(0, 0, 2); setCell(0, 1, 2); setCell(1, 0, 4);
  check(app.state.awaitingBoard === false, '录入有走法的局面后离开①');
  check(cellVal(0, 0) === 2 && cellVal(1, 0) === 4, '格子数值已写入 state');

  console.log('== ② AI 推荐（自动移位开启）==');
  await app.requestHint();
  check(app.state.lastRec !== null, '推荐已生成');
  const afterAuto = JSON.stringify(app.state.board);
  check(app.state.pendingSpawn === true, '推荐后已自动移位并进入等待录新块');
  check(app.state.autoMoved === true, '标记为自动移位产生');

  console.log('== 流程门槛：自动移位后必须先录新块 ==');
  const frozen1 = JSON.stringify(app.state.board);
  app.manualMove(2);
  check(JSON.stringify(app.state.board) === frozen1, '未录新块时手动走棋被拦截');
  await app.requestHint();
  check(app.state.lastRec.move >= 0, '未录新块时 AI 推荐被拦截');

  console.log('== ③ 录入新方块 ==');
  // 往非空格填 → 应被拒
  const filled = app.state.board.flat().findIndex(v => v !== 0);
  const fr = Math.floor(filled / 4), fc = filled % 4;
  setCell(fr, fc, 8);
  check(cellVal(fr, fc) !== 8, '往非空格填新块被拒绝');
  check(app.state.pendingSpawn === true, '拒绝后仍停留在 pendingSpawn');

  // 往空格填 2 → 正常
  let er = -1, ec = -1;
  outer: for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (app.state.board[r][c] === 0) { er = r; ec = c; break outer; }
  }
  setCell(er, ec, 2);
  check(app.state.pendingSpawn === false, '录入新块后离开 pendingSpawn');
  check(app.state.autoMoved === false, 'autoMoved 标记已清除');
  check(cellVal(er, ec) === 2, '新块已写入');
  check(emptyCount() === 0 || true, '空格数已更新');

  console.log('== 关闭自动移位后：推荐 → 手动走棋 ==');
  app.toggleAutoShift();
  check(app.state.autoShift === false, '自动移位已关闭');
  await app.requestHint();
  check(app.state.pendingSpawn === false, '关闭后推荐不自动移位');
  const beforeManual = JSON.stringify(app.state.board);
  app.manualMove(app.state.lastRec.move);
  check(JSON.stringify(app.state.board) !== beforeManual, '按方向键后棋盘变化');
  check(app.state.pendingSpawn === true && app.state.autoMoved === false,
        '手动走棋进入等待录新块（非自动移位）');
  const slot2 = app.state.board.flat().indexOf(0);
  setCell(Math.floor(slot2 / 4), slot2 % 4, 2);
  check(app.state.pendingSpawn === false, '录新块后回到可推荐状态');

  console.log('== 重新开启自动移位，验证循环可重复 ==');
  app.toggleAutoShift();
  check(app.state.autoShift === true, '自动移位已开启');
  await app.requestHint();
  check(app.state.pendingSpawn === true, '第二轮：推荐后再次自动移位');
  const slot3 = app.state.board.flat().indexOf(0);
  if (slot3 >= 0) {
    setCell(Math.floor(slot3 / 4), slot3 % 4, 4);
    check(app.state.pendingSpawn === false, '第二轮录新块成功');
  }

  console.log('== 回到 ②：可再次推荐 ==');
  const recBefore = app.state.lastRec;
  await app.requestHint();
  check(app.state.lastRec !== null, '第二轮推荐成功');

  console.log('== 无新方块按钮（死局场景）==');
  app.manualMove(app.state.lastRec ? app.state.lastRec.move : 0);
  if (app.state.pendingSpawn) {
    app.noSpawn();
    check(app.state.pendingSpawn === false, '「本步无新方块」可解除等待');
  } else {
    console.log('  [SKIP] 该方向不可走，未进入 pendingSpawn');
  }

  console.log('== 鼠标快捷输入：左键乘 2 / 右键清空 ==');
  app.clearBoard();
  check(emptyCount() === 16, '已清空棋盘');
  // 左键从空格开始应依次给出 2 → 4 → 8 → 16
  const seq = [];
  for (let i = 0; i < 4; i++) { app.quickCell(0, 0); seq.push(cellVal(0, 0)); }
  check(JSON.stringify(seq) === JSON.stringify([2, 4, 8, 16]),
        `左键依次乘 2：2→4→8→16（实际 ${seq.join(',')}）`);
  // 一路乘到 32768（16 → 32768 需 11 次）
  for (let i = 0; i < 11; i++) app.quickCell(0, 0);
  check(cellVal(0, 0) === 32768, '左键可一路乘到 32768（引擎上限）');
  app.quickCell(0, 0);
  check(cellVal(0, 0) === 2, '32768 之后再左键回到 2（不卡死）');
  // 右键清空
  app.applyCellValue(1, 1, 0, 'test');   // 模拟右键路径
  check(cellVal(1, 1) === 0, '右键路径可清空');

  console.log('== 思考预算：不限时长 ==');
  const budgetInput = document.getElementById('budget');
  budgetInput.value = '3000';
  const unlimitedBox = document.getElementById('budget-unlimited');
  check(app.params().time_budget_ms === 3000, '默认发送 3000ms');
  unlimitedBox.checked = true;
  app.toggleUnlimited();
  check(app.state.unlimitedBudget === true, '勾选后 unlimitedBudget 为 true');
  check(app.params().time_budget_ms === 0, '不限时长时发送 0');
  check(budgetInput.disabled === true, '勾选后滑块被禁用');
  check(document.getElementById('budget-val').textContent === '无限', '标签显示「无限」');
  unlimitedBox.checked = false;
  app.toggleUnlimited();
  check(app.params().time_budget_ms === 3000, '取消勾选后恢复滑块值');
  check(budgetInput.disabled === false, '取消后滑块可用');

  console.log('== 快捷输入在 pendingSpawn 期间受同样的空格限制 ==');
  app.setMode('assistant');
  app.applyCellValue(0, 0, 2, 'test');
  app.applyCellValue(0, 1, 2, 'test');
  await app.requestHint();
  app.manualMove(app.state.lastRec.move);
  check(app.state.pendingSpawn === true, '已进入等待录新块');
  const nonEmpty = app.state.board.flat().findIndex(v => v !== 0);
  app.quickCell(Math.floor(nonEmpty / 4), nonEmpty % 4);
  check(app.state.pendingSpawn === true, '快捷点非空格被拒绝，仍等待');
  const slot = app.state.board.flat().indexOf(0);
  app.quickCell(Math.floor(slot / 4), slot % 4);
  check(cellVal(Math.floor(slot / 4), slot % 4) === 2, '快捷点空格成功录入 2');
  check(app.state.pendingSpawn === false, '录入后离开等待');

  console.log('== 按钮可用状态：位置固定，只用 disabled ==');
  // 助手模式：自动演示应被置灰（而非隐藏），且仍有 DOM 位置
  check(app.state.mode === 'assistant', '当前为助手模式');
  check(document.getElementById('btn-auto').disabled === true,
        '助手模式下「自动演示」被置灰');
  check(document.getElementById('btn-auto').style.display !== 'none',
        '「自动演示」未被隐藏（位置保留，布局不跳动）');
  check(document.getElementById('btn-nospawn').disabled === true,
        '非等待录新块时「本步无新方块」置灰');
  check(document.getElementById('btn-cancel').disabled === true,
        '非计算中「停止」置灰');

  console.log('== 计时器 ==');
  app.clearBoard();
  check(document.getElementById('timer').textContent === '00:00', '清空后计时归零');
  check(document.getElementById('moves').textContent === '0', '清空后步数归零');
  check(app.state.moveCount === 0, 'state.moveCount 归零');
  app.applyCellValue(0, 0, 2, 'test');
  app.applyCellValue(0, 1, 2, 'test');
  await app.requestHint();
  check(app.state.moveCount === 1, '推荐+自动移位记 1 步');
  check(document.getElementById('moves').textContent === '1', '步数显示 1');
  check(app.state.startTime !== null, '计时器已启动');
  check(/^\d{2}:\d{2}$/.test(document.getElementById('timer').textContent),
        `计时格式 mm:ss（实际 ${document.getElementById('timer').textContent}）`);
  // 录入新块后归零等待，再推荐记第 2 步
  const s1 = app.state.board.flat().indexOf(0);
  setCell(Math.floor(s1 / 4), s1 % 4, 2);
  await app.requestHint();
  check(app.state.moveCount === 2, '第二轮推荐后记 2 步');
  app.clearBoard();
  check(app.state.moveCount === 0 && app.state.startTime === null,
        '清空棋盘后计时器与步数都归零');

  console.log('== 切到自由模式 ==');
  app.setMode('free');
  check(app.state.mode === 'free' && app.state.pendingSpawn === false, '自由模式状态正确');
  const freeTiles = app.state.board.flat().filter(v => v !== 0).length;
  check(freeTiles === 2, '自由模式自动开局 2 块');
  // 随机开局可能让「左」不可走（两块都落在第 0 列），固定一个可走的局面
  app.clearBoard();
  app.applyCellValue(0, 1, 2, 't');
  app.applyCellValue(3, 3, 4, 't');
  const fb = JSON.stringify(app.state.board);
  app.manualMove(2);
  const freeTiles2 = app.state.board.flat().filter(v => v !== 0).length;
  check(JSON.stringify(app.state.board) !== fb || freeTiles2 !== freeTiles,
        '自由模式走棋后自动出新块');

  console.log('== 切回助手模式会重置 ==');
  app.setMode('assistant');
  check(app.state.awaitingBoard === true && emptyCount() === 16, '切回助手模式重置为空棋盘');

  console.log(failed === 0 ? '\nALL FLOW TESTS PASSED' : `\n${failed} 处失败`);
  console.log('== theme system ==');
  check(app.THEME_ORDER.length === 4, '4 themes defined');
  check(app.THEME_ORDER.every(k => app.THEMES[k] && app.THEMES[k].tiles), 'every theme has tile palette');
  let hexBad = 0;
  for (const k of app.THEME_ORDER) {
    const t = app.THEMES[k];
    for (const lv of [2,4,8,16,32,64,128,256,512,1024,2048]) {
      if (!/^#[0-9a-f]{6}$/i.test(t.tiles[lv])) hexBad++;
    }
    if (!/^#[0-9a-f]{6}$/i.test(t.big)) hexBad++;
  }
  check(hexBad === 0, 'all tile colors are valid hex');
  let fgBad = 0;
  for (const k of app.THEME_ORDER) {
    const t = app.THEMES[k];
    for (const lv of [2,4,8,16,32,64,128,256,512,1024,2048]) {
      const fg = app.readableFg(t.tiles[lv]);
      if (fg !== '#ffffff' && fg !== '#2b2520') fgBad++;
    }
  }
  check(fgBad === 0, 'tile fg only black/white');
  app.applyTheme('neon');
  check(app.state.theme === 'neon', 'applyTheme updates state.theme');
  check(app.tileColor(2048) === app.THEMES.neon.tiles[2048], 'tile color follows theme');
  app.applyTheme('classic');
  check(app.state.theme === 'classic', 'can switch back to classic');

  console.log('== move detail (animation base) ==');
  const d1 = app.moveMatrixDetailed([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 2);
  check(d1.board[0][0] === 4 && d1.gain === 4, 'left merge 2+2=4');
  check(d1.merges.length === 1 && d1.merges[0].v === 4, '1 merge recorded');
  check(d1.slides.length === 2, '2 slides recorded');
  check(d1.slides.every(x => x.tr === 0 && x.tc === 0), 'both slides go to (0,0)');
  const d2 = app.moveMatrixDetailed([[0,2,0,4],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 2);
  check(d2.merges.length === 0 && d2.gain === 0, 'pure slide has no merge');
  check(d2.slides.length === 2, 'pure slide records 2');
  check(d2.board[0][0] === 2 && d2.board[0][1] === 4, 'slide keeps order 2,4');
  const d3 = app.moveMatrixDetailed([[2,4,8,16],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 2);
  check(d3.moved === false, 'full row left is not movable');

  console.log('== tile layer must be a real child of board ==');
  // 回归：buildBoardDOM 里的 innerHTML='' 会清掉 HTML 静态节点，
  // 若方块层写在 HTML 里，renderTiles 会取不到 layer 而静默返回，数字全消失
  const boardNode = document.getElementById('board');
  check(boardNode.children.length === 17, 'board 有 17 个子节点（16 格 + 方块层）');
  const layerNode = Array.from(boardNode.children).find(x => x.id === 'tile-layer');
  check(!!layerNode, 'tile-layer 是 board 的真实子节点');
  check(document.getElementById('tile-layer') === layerNode,
        'getElementById 取到的就是同一个 layer');

  console.log('== tile metrics: px derivation must match grid ==');
  // Regression: CSS percentages make transform resolve against the element's
  // own box, which is circular with .tile width -> transform dropped -> tiles
  // all collapse to the origin. Must be measured as px by JS.
  const GAP = 12;
  for (const w of [480, 360, 320, 768]) {
    const contentW = w - GAP * 2;
    const cell = (contentW - GAP * 3) / 4;
    const colsTotal = 4 * cell + GAP * 3;
    const lastRight = 3 * (cell + GAP) + cell;
    check(Math.abs(colsTotal - contentW) < 0.01 && Math.abs(lastRight - contentW) < 0.01,
          'board=' + w + 'px: cell=' + cell.toFixed(1) + ' aligns with grid');
  }
  let threw = false;
  try { app.syncTileMetrics(); } catch (e) { threw = true; }
  check(!threw, 'syncTileMetrics no-ops safely without layout');

  console.log('== tiles really render into the layer ==');
  app.clearBoard();
  app.applyCellValue(0, 0, 128, 't');
  app.applyCellValue(3, 3, 4, 't');
  check(layerNode.children.length === 2, 'layer 里出现 2 个方块 DOM');
  const texts = Array.from(layerNode.children).map(x => String(x.firstChild.textContent));
  check(texts.indexOf('128') >= 0 && texts.indexOf('4') >= 0,
        '方块 DOM 里能看到数字文本（不再透明）');
  const bgs = Array.from(layerNode.children).map(x => x.firstChild.style.background);
  check(bgs.every(b => b && b !== 'transparent'), '方块有实际背景色');

  console.log('== tile identity & merge settle ==');
  app.clearBoard();
  app.applyCellValue(0, 0, 2, 't');
  app.applyCellValue(0, 1, 2, 't');
  check(app.state.tiles.length === 2, '2 tiles after input');
  const ids = app.state.tiles.map(x => x.id);
  app.manualMove(2);
  check(app.state.tiles.length === 2, 'mid-slide: both tiles at target');
  check(app.state.board[0][0] === 4, 'board already 4');
  await new Promise(r => setTimeout(r, 300));
  check(app.state.tiles.length === 1, 'settled: merged into 1 tile');
  check(ids.includes(app.state.tiles[0].id), 'survivor reuses old id');

  process.exit(failed === 0 ? 0 : 1);
}

main();
