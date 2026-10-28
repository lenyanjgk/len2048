'use strict';
/* ============================================================
   端到端走查 — 在真实浏览器里下一局 → 落库 → 打开管理页核对
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT

       node tools/e2e-check.cjs  <输出目录> <宽> <高>

   注意：会往 games.db 里真的写一局（先启动 python server.py）。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp.cjs');

const OUT = process.argv[2] || 'e2e-out';
const W = +process.argv[3] || 1440;
const H = +process.argv[4] || 900;

(async () => {
  const b = await launch(W, H);
  const { ev, send } = b;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await send('Page.navigate', { url: b.url + '/' }); await sleep(1400);
    await ev("localStorage.setItem('len2048-theme','neon')");
    await send('Page.navigate', { url: b.url + '/' }); await sleep(1400);

    console.log('== 1. 助手模式：载入示例 → AI 推荐（自动移位记一步） ==');
    await ev("document.getElementById('btn-sample').click()"); await sleep(400);
    await ev("document.getElementById('btn-hint').click()");
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      if (await ev("document.getElementById('st-depth').textContent!=='—'")) break;
    }
    await sleep(700);
    console.log('  gameId =', await ev("state.gameId"));
    console.log('  日志首行:', await ev("document.querySelector('#log div').textContent"));

    console.log('== 2. 自由模式：方向键走 5 步 ==');
    await ev("document.getElementById('mode-free').click()"); await sleep(700);
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft']) {
      await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'" + k + "',bubbles:true}))");
      await sleep(500);
    }
    await sleep(900);
    console.log('  gameId =', await ev("state.gameId"),
                '| 分数', await ev("document.getElementById('score').textContent"),
                '| 步数', await ev("document.getElementById('moves').textContent"));

    console.log('== 3. 直接查库 ==');
    const sum = await (await fetch(b.url + '/api/games/summary')).json();
    console.log('  汇总:', JSON.stringify(sum));
    const list = await (await fetch(b.url + '/api/games?limit=10')).json();
    console.log('  列表:', list.games.map(g =>
      '#' + g.id + ' ' + (g.mode === 'free' ? '自由' : '助手') + ' ' + g.score + '分/' +
      g.moves + '步/' + (g.is_over ? '死局' : '进行中')).join('  |  '));
    const gid = list.games[0].id;
    const det = await (await fetch(b.url + '/api/games/' + gid)).json();
    console.log('  详情 #' + gid + ':', det.moves.length, '步流水，首行盘面 =',
                JSON.stringify(JSON.parse(det.game.board)[0]));

    console.log('== 4. 管理页 ==');
    await send('Page.navigate', { url: b.url + '/admin' }); await sleep(1800);
    console.log('  h1:', await ev("document.querySelector('h1').textContent"));
    console.log('  KPI:', await ev("[...document.querySelectorAll('.kpi')].map(k=>k.querySelector('.kpi-label').textContent+'='+k.querySelector('.kpi-val').textContent).join('  ')"));
    console.log('  表格行数:', await ev("document.querySelectorAll('#rows tr').length"));
    console.log('  行内容:', await ev("[...document.querySelectorAll('#rows tr')].map(tr=>[...tr.children].slice(0,7).map(td=>td.textContent.trim()).join('|')).join('   /   ')"));
    console.log('  计数:', await ev("document.getElementById('count').textContent"),
                '| 分页:', await ev("document.getElementById('p-label').textContent"));
    await ev("window.scrollTo(0,0)"); await sleep(400);
    let r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    fs.writeFileSync(path.join(OUT, 'admin-top.jpg'), Buffer.from(r.result.data, 'base64'));

    await ev("document.querySelector('#rows tr').click()"); await sleep(1000);
    console.log('  详情标题:', await ev("document.querySelector('.detail-head h2').textContent"));
    console.log('  kv 行数:', await ev("document.querySelectorAll('#d-kv .kv-row').length"),
                '| 盘面非空格:', await ev("[...document.querySelectorAll('#d-board .p-cell')].filter(c=>c.textContent).length"),
                '| 流水行数:', await ev("document.querySelectorAll('#d-moves tr').length"));
    await ev("document.querySelectorAll('#d-moves tr')[1].click()"); await sleep(600);
    console.log('  点第2步 → 盘面标题:', await ev("document.getElementById('d-board-title').textContent"),
                '| 非空格:', await ev("[...document.querySelectorAll('#d-board .p-cell')].filter(c=>c.textContent).length"));
    r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    fs.writeFileSync(path.join(OUT, 'admin-detail.jpg'), Buffer.from(r.result.data, 'base64'));
    console.log('  saved admin-top.jpg + admin-detail.jpg');
  } finally {
    b.close();
  }
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
