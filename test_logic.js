/* 前端 JS 移动逻辑 vs 后端 Python 引擎 对拍测试
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT */
'use strict';

// 1) 用 Python 引擎生成随机棋盘 + 期望结果
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 兼容 python3 / python 两种命令名
const PY = ['python3', 'python'].find(cmd => {
  try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return true; }
  catch { return false; }
});
if (!PY) {
  console.error('找不到 python/python3，无法生成对拍用例');
  process.exit(1);
}

const casesPath = path.join(__dirname, 'cases.json');
if (!fs.existsSync(casesPath)) {
  execSync(`${PY} gen_cases.py`, { cwd: __dirname, stdio: 'inherit' });
}
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

// 2) 加载前端纯逻辑
const logic = require(path.join(__dirname, 'static', 'app.js'));

let fail = 0;
for (const c of cases) {
  for (let d = 0; d < 4; d++) {
    const got = logic.moveMatrix(c.board, d);
    const expect = c.expected[d];
    const same = JSON.stringify(got) === JSON.stringify(expect);
    if (!same) {
      fail++;
      if (fail <= 3) {
        console.log('MISMATCH dir', d);
        console.log('  in    :', JSON.stringify(c.board));
        console.log('  expect:', JSON.stringify(expect));
        console.log('  got   :', JSON.stringify(got));
      }
    }
  }
  // hasMove 一致性
  const jsHas = logic.hasMove(c.board);
  if (jsHas !== c.has_move) {
    fail++;
    console.log('hasMove MISMATCH', JSON.stringify(c.board), jsHas, c.has_move);
  }
}

console.log(`JS vs Python: ${cases.length} 个棋盘 x 4 方向, 失败 ${fail} 处`);
if (fail > 0) process.exit(1);
console.log('PASS');
