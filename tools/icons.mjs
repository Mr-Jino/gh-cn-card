// 生成扩展图标：用系统 Edge 无头渲染一个 SVG，导出 16/32/48/128 四个尺寸。
// 用法：node tools/icons.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('extension/icons');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
});
if (!EDGE) throw new Error('没找到 Edge，改一下 EDGE 常量');

const svg = () => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b4b8a"/>
      <stop offset="0.55" stop-color="#3b3f6b"/>
      <stop offset="1" stop-color="#24292f"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="128" height="128" rx="28" fill="url(#g)"/>
  <path d="M34 22h60a12 12 0 0 1 12 12v44a12 12 0 0 1-12 12H62l-16 14v-14h-12a12 12 0 0 1-12-12V34a12 12 0 0 1 12-12z"
        fill="#ffffff" fill-opacity="0.94"/>
  <text x="64" y="72" text-anchor="middle" dominant-baseline="middle"
        font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
        font-size="46" font-weight="700" fill="#24292f">中</text>
  <circle cx="96" cy="96" r="14" fill="#e8590c"/>
  <path d="M90 96l4.4 4.4L103 92" stroke="#fff" stroke-width="3.4" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const sizes = [16, 32, 48, 128];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setContent(
  `<html><body style="margin:0;background:transparent">${svg()}</body></html>`,
  { waitUntil: 'load' }
);
const el = await page.locator('svg').first();
for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.addStyleTag({ content: `svg{width:${size}px;height:${size}px;display:block}` });
  const buf = await el.screenshot({ omitBackground: true });
  writeFileSync(path.join(OUT, `icon${size}.png`), buf);
  console.log(`icon${size}.png  ${buf.length} bytes`);
}
await browser.close();
