'use strict';
/* ============================================================
   顶栏走查 — 三个页面 × 指定视口，核对共享顶栏是否一致
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT

       node tools/nav-check.cjs  <输出目录> <宽> <高> [主题key]

   检查项：h1 在、跨页导航三项 + 当前页标记、四个色板且当前项正确高亮、
   吸顶、无背景模糊、无横向溢出、顶栏高度；最后验一遍主题跨页联动。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp.cjs');

const OUT = process.argv[2] || 'nav-out';
const W = +process.argv[3] || 1440;
const H = +process.argv[4] || 900;
const THEME = process.argv[5] || 'neon';

(async () => {
  const b = await launch(W, H);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    console.log('视口 ' + W + ' / 主题 ' + THEME + ' / ' + b.url);

    const probe = "(function(){"
      + "var bar=document.querySelector('.topbar');"
      + "var links=[].map.call(document.querySelectorAll('.pagenav a'),function(a){"
      + "  return a.textContent.trim()+(a.classList.contains('is-here')?'*':'')});"
      + "var h1=document.querySelector('h1');"
      + "return {sticky:getComputedStyle(bar).position,"
      + " bg:getComputedStyle(bar).backgroundColor,"
      + " blur:getComputedStyle(bar).backdropFilter,"
      + " links:links.join(' '),"
      + " here:document.querySelector('.pagenav a.is-here')"
      + "   ?document.querySelector('.pagenav a.is-here').textContent.trim():null,"
      + " swatches:document.querySelectorAll('.theme-swatch').length,"
      + " swatchOn:document.querySelector('.theme-swatch[aria-pressed=\"true\"]')"
      + "   ?document.querySelector('.theme-swatch[aria-pressed=\"true\"]').dataset.theme:null,"
      + " h1:h1?h1.textContent.trim():null,"
      + " overflow:document.documentElement.scrollWidth>" + W + ","
      + " barH:Math.round(bar.getBoundingClientRect().height)};})()";

    for (const [url, here] of [['/', '助手'], ['/admin', '对局记录'], ['/site/', '官网']]) {
      await b.send('Page.navigate', { url: b.url + url });
      await sleep(url === '/site/' ? 2000 : 1500);
      await b.ev("localStorage.setItem('len2048-theme','" + THEME + "')");
      await b.send('Page.navigate', { url: b.url + url });
      await sleep(url === '/site/' ? 2200 : 1600);

      const info = await b.ev(probe);
      console.log('  ' + url.padEnd(9)
        + ' h1=' + JSON.stringify(info.h1)
        + ' | 导航=' + info.links + ' | 当前=' + info.here
        + ' | 色板=' + info.swatches + '(' + info.swatchOn + ')'
        + ' | sticky=' + info.sticky + ' blur=' + info.blur
        + ' | 高=' + info.barH + ' | 溢出=' + info.overflow);

      const bad = [];
      if (info.here !== here) bad.push('当前页标记应为「' + here + '」');
      if (info.swatches !== 4) bad.push('色板应有 4 个');
      if (info.swatchOn !== THEME) bad.push('色板高亮应为 ' + THEME);
      if (info.sticky !== 'sticky') bad.push('顶栏未吸顶');
      if (info.blur !== 'none') bad.push('顶栏有背景模糊');
      if (info.overflow) bad.push('页面横向溢出');
      if (bad.length) console.log('      !! ' + bad.join('；'));

      fs.writeFileSync(path.join(OUT, url.replace(/\//g, '_') + '.jpg'), await b.shot());
    }

    // 主题联动：应用页切一个主题，官网应立刻换成同一套
    await b.send('Page.navigate', { url: b.url + '/' }); await sleep(1500);
    await b.ev("document.querySelector('.theme-swatch[data-theme=\"sakura\"]').click()");
    await sleep(700);
    await b.send('Page.navigate', { url: b.url + '/site/' }); await sleep(2200);
    const siteTheme = await b.ev("document.documentElement.getAttribute('data-theme')");
    const siteSwatch = await b.ev(
      "document.querySelector('.theme-swatch[aria-pressed=\"true\"]').dataset.theme");
    const demoTile = await b.ev(
      "(function(){var c=document.querySelectorAll('.demo-cell');"
      + "for(var i=0;i<c.length;i++){if(c[i].textContent){return c[i].style.background;}}"
      + "return '(暂无方块)';})()");
    console.log('  应用切「曙」→ 官网 data-theme =', siteTheme, '| 官网色板 =', siteSwatch,
                '| 演示板方块底色 =', demoTile);
    if (siteTheme !== 'sakura' || siteSwatch !== 'sakura') console.log('      !! 官网主题没跟上');
    fs.writeFileSync(path.join(OUT, 'site-after-sync.jpg'), await b.shot());
  } finally {
    b.close();
  }
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
