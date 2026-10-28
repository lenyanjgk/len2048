'use strict';
/* ============================================================
   真实浏览器走查工具 — 通过 Chrome DevTools Protocol 驱动 headless Chrome
   作者：lenyanjgk（冷颜） · 2048 AI Web Assistant · MIT

   用法（先启动 python server.py）：
       node tools/nav-check.cjs  <输出目录> <宽> <高> [主题key]
       node tools/e2e-check.cjs  <输出目录> <宽> <高>

   环境变量：
       CHROME    Chrome 可执行文件路径（不给就按平台常见位置找）
       PORT      应用端口，默认 8765
       BASE_URL  完整基址，优先级高于 PORT

   这三个页面没有构建步骤，所以走查也直接用 Node + 原生 WebSocket，
   不引任何依赖（Node 18+ 自带全局 WebSocket / fetch）。
   ============================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE_URL = process.env.BASE_URL
  || ('http://127.0.0.1:' + (process.env.PORT || 8765));

// Chrome 在不同平台的位置不一样，逐个找；都不中就让用户用 CHROME 指定
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  var env = process.env;
  var candidates = [];
  if (process.platform === 'win32') {
    candidates = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
  } else if (process.platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
  }
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 起一个 headless Chrome 并连上 CDP，返回 { send, ev, shot, close }
async function launch(width, height) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error('找不到 Chrome。请设置环境变量 CHROME 指向 chrome.exe 的可执行文件。');
  }

  const port = 4900 + Math.floor(Math.random() * 900);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'len2048-ck-'));
  const args = [
    '--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--window-size=' + width + ',' + height,
    '--no-first-run', '--disable-extensions', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    // 容器 / 部分 Windows 环境下 Chrome 的默认沙箱起不来，CDP 就连不上；
    // 这里只是本地走查工具，加载的都是本项目自己的页面
    '--no-sandbox',
    'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.filter(x => x.type === 'page')[0];
    } catch (e) { /* 还没起来，继续等 */ }
  }
  if (!target) { try { proc.kill(); } catch (e) {} throw new Error('Chrome 没起来（80 次重试后仍无 CDP 目标）'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket 连不上')); });

  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
  });

  // 在页面里跑一段表达式并取回值；页面抛异常就报出来，不静默
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面里抛异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const shot = async () => {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    return Buffer.from(r.result.data, 'base64');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',
             { width: width, height: height, deviceScaleFactor: 1, mobile: width <= 480 });

  const close = () => { try { ws.close(); } catch (e) {} try { proc.kill(); } catch (e) {} };

  return { send: send, ev: ev, shot: shot, close: close, url: BASE_URL };
}

module.exports = { launch: launch, sleep: sleep, BASE_URL: BASE_URL, findChrome: findChrome };
