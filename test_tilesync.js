/* 方块层 ↔ 棋盘 同步回归测试（作者：lenyanjgk / 冷颜，MIT）：
   自由对战（含自动演示）连续走棋后，方块层渲染出的 (位置, 数值) 必须和 state.board 完全一致。
   历史上坏过一次：applyAiMove / manualMove 先 randomEmptyCell() 记位置、再 spawnRandomTile()
   自己另挑一个空格落块，两者对不上 → settle 里取到 0 → 新块不进 state.tiles → 新出的 2/4 不显示；
   更糟的是缺一个方块后，下一步合并时该格只剩一个 tile，win.v = mg.v 不触发 → 合并后的数字也不更新。 */
'use strict';

function makeEl() {
  const el = {
    id: '', _children: [], dataset: {},
    style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); },
             getPropertyValue(k) { return this._props[k] || ''; } },
    _classes: new Set(), _html: '', textContent: '', value: '', checked: false,
    disabled: false, placeholder: '', type: '',
    addEventListener() {}, appendChild(c) { this._children.push(c); return c; },
    prepend(c) { this._children.unshift(c); }, remove() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    get firstChild() { return this._children[0]; },
    get children() { return this._children; },
    get lastChild() { return this._children[this._children.length - 1]; },
    get offsetWidth() { return 100; },
    setAttribute() {}, getAttribute() { return null; },
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

const docRoots = [];
function dfsFind(el, id) {
  if (el.id === id) return el;
  for (const c of el._children) { const r = dfsFind(c, id); if (r) return r; }
  return null;
}
global.document = {
  getElementById: (id) => {
    for (const root of docRoots) { const f = dfsFind(root, id); if (f) return f; }
    const el = makeEl(); el.id = id; docRoots.push(el); return el;
  },
  createElement: () => { const el = makeEl(); docRoots.push(el); return el; },
  querySelectorAll: () => [], addEventListener() {}, activeElement: null,
};

const app = require('./static/app.js');

global.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body).board;
  const valid = [];
  for (let d = 0; d < 4; d++) if (!app.boardsEqual(b, app.moveMatrix(b, d))) valid.push(d);
  if (!valid.length) return { json: async () => ({ ok: true, game_over: true, message: '死局' }) };
  const best = valid[0];
  return { json: async () => ({
    ok: true, game_over: false, best, arrow: '←', scores: [100, 200, 300, 400],
    valid_moves: valid, board_after: app.moveMatrix(b, best), heur: 1, actual_score: 2,
    stats: { depth: 3, nodes: 10, cache_hits: 0, elapsed_ms: 5, timed_out: false, target_depth: 5 },
  }) };
};

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  [PASS]', msg);
  else { failed++; console.log('  [FAIL]', msg); }
}

// 方块层应该画出的局面：位置 → 数值
function tilesAsMap() {
  const m = new Map();
  for (const t of app.state.tiles) {
    const k = `${t.r},${t.c}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function boardAsMap() {
  const m = new Map();
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const v = app.state.board[r][c];
    if (v) m.set(`${r},${c}`, (m.get(`${r},${c}`) || 0) + 1);
  }
  return m;
}
function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
// 数值多重集（不关心位置）
function bag(m) {
  const out = [];
  for (const [k, n] of m) for (let i = 0; i < n; i++) out.push(k);
  return out.sort().join('|');
}

const STEPS = 14;

(async () => {
  console.log('== 自由对战：连续走棋后方块层必须和棋盘一致 ==');
  app.setMode('free');
  let worstBag = '';
  for (let i = 0; i < STEPS; i++) {
    const before = app.state.board.flat().filter(v => v).length;
    await app.requestHint(true);
    await new Promise(r => setTimeout(r, 220));   // 等 settle 落定
    const tm = tilesAsMap(), bm = boardAsMap();
    const okPos = sameMap(tm, bm);
    const okVal = bag(tm) === bag(bm);
    if (!okVal) worstBag = `第${i + 1}步 棋盘[${[...bm.keys()].sort()}] vs 方块[${[...tm.keys()].sort()}]`;
    check(okPos && okVal, `第 ${i + 1} 步：方块层与棋盘一致（棋盘 ${before} 块 → ${app.state.board.flat().filter(v => v).length} 块）`);
    if (!okPos || !okVal) break;
  }

  console.log('== 自由对战：手动走棋（方向键）同样必须一致 ==');
  app.setMode('free');
  for (let i = 0; i < 6; i++) {
    const dirs = [0, 1, 2, 3];
    for (const d of dirs) {
      const snapshot = JSON.stringify(app.state.board);
      app.manualMove(d);
      if (JSON.stringify(app.state.board) === snapshot) continue;   // 不可走
      await new Promise(r => setTimeout(r, 220));
      check(sameMap(tilesAsMap(), boardAsMap()),
            `手动 ${['上', '下', '左', '右'][d]} 后方块层与棋盘一致`);
      break;
    }
  }

  console.log('== 助手模式：自动移位后不应该多出块 ==');
  app.setMode('assistant');
  app.applyCellValue(0, 0, 2, 't');
  app.applyCellValue(0, 1, 2, 't');
  await app.requestHint();
  await new Promise(r => setTimeout(r, 220));
  check(sameMap(tilesAsMap(), boardAsMap()), '助手模式自动移位后方块层与棋盘一致');

  console.log('== 模式来回切换：棋盘空了，方块层也必须空 ==');
  app.setMode('free');
  for (let i = 0; i < 3; i++) { await app.requestHint(true); await new Promise(r => setTimeout(r, 200)); }
  check(app.state.tiles.length > 0, '自由模式下确实有方块');
  app.setMode('assistant');
  check(app.state.tiles.length === 0, '切回助手模式后方块层已清空');
  check(sameMap(tilesAsMap(), boardAsMap()), '切回助手模式后两者一致（都是空）');

  console.log(failed === 0 ? '\nALL TILE-SYNC TESTS PASSED' : `\n${failed} 处失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
