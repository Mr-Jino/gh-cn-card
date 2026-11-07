// 探针：确认「无头 Edge + 未打包扩展」这条路能不能走通，能走通才去截真图。
// 只做一件事：打开一个真实仓库页，看扩展的「AI 解读」按钮有没有被注入。
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const EXT = path.resolve('C:/Users/17704/AppData/Local/GhCnCardExt');

const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'ghcn-probe-' + Date.now()), {
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--no-first-run',
    '--no-default-browser-check',
    '--proxy-bypass-list=*'
  ]
});

try {
  const pages = ctx.pages();
  console.log('启动页数：', pages.length);
  // 找到扩展 id：访问扩展自己的页面
  const p = pages[0] || (await ctx.newPage());
  await p.goto('https://github.com/microsoft/markitdown', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(3000);
  const hasBtn = await p.evaluate(() => !!document.querySelector('.gh-cn-btn'));
  console.log('按钮注入：', hasBtn);
  console.log('页面标题：', await p.title());
  // 顺便看扩展 id（background service worker 的 url）
  const cdp = await ctx.newCDPSession(p);
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  const ext = targets.filter((t) => (t.url || '').startsWith('chrome-extension://'));
  console.log('扩展目标：', ext.map((t) => t.url.slice(0, 60)));
} finally {
  await ctx.close();
}
