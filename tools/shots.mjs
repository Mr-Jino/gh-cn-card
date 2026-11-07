// 生成 README 用的截图。不是设计稿，也不是拼的：
// 无头 Edge 加载真扩展 → 真打开 github.com → 真点按钮 → 真调模型 → 截当前画面。
// 用法：node tools/shots.mjs
// 依赖：本机 Edge（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）+ 已部署的扩展目录
// 凭据来源：优先读环境变量 DEEPSEEK_API_KEY / GITHUB_TOKEN / FEISHU_WEBHOOK / FEISHU_SECRET，
//          没有时回退到 D:/FRONTIER/.env（开发者本机约定，普通用户用不到这个脚本）。
// 说明：解读卡是在 GitHub 页面上真实点击后由模型生成的；发现页那批条目的
//      star/语言/更新时间来自 GitHub API 实时抓取，一句话是人工写的真实摘要。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { fetchRepoBundle } from '../extension/lib/github.js';
import { buildMessages } from '../extension/lib/prompt.js';
import { streamChat } from '../extension/lib/llm.js';
import { DEFAULT_PROFILE } from '../extension/lib/profile.js';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = 'C:/Users/17704/AppData/Local/GhCnCardExt';
const OUT = path.resolve('docs/screenshots');
const CARD_CACHE = path.resolve('tools/cache');
const TMP_PROFILE = path.join(os.tmpdir(), 'ghcn-shots-' + Date.now());

fs.mkdirSync(OUT, { recursive: true });

/* ---------- 配置从 FRONTIER 的 .env 读，只在内存里用 ---------- */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
const env = readEnv('D:/FRONTIER/.env');
// 环境变量优先；没设的不要覆盖 .env 里的值
for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'GITHUB_TOKEN']) {
  if (process.env[k]) env[k] = process.env[k];
}

/* 真跑一遍解读管线，结果缓存在 tools/cache（7 天内复用，省钱省时间） */
function summarise(ev) {
  return {
    releases: (ev?.releases || []).length,
    lastTag: (ev?.releases || [])[0]?.tag || '',
    lastAt: (ev?.releases || [])[0]?.at || '',
    issues: (ev?.issues || []).length,
    issueTitles: (ev?.issues || []).slice(0, 3).map((i) => i.title),
    manifest: (ev?.manifest && ev.manifest.name) || ''
  };
}

async function genCard(owner, repo) {
  fs.mkdirSync(CARD_CACHE, { recursive: true });
  const cacheFile = path.join(CARD_CACHE, 'card-' + repo + '.md');
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 7 * 86400e3) {
    console.log('解读卡复用缓存：' + owner + '/' + repo + '（缓存里没有 facts，重新抓一次元数据）');
    const bundle = await fetchRepoBundle(owner, repo, env.GITHUB_TOKEN || '');
    return { md: fs.readFileSync(cacheFile, 'utf8'), facts: bundle.facts, ev: summarise(bundle.evidence) };
  }
  if (!env.DEEPSEEK_API_KEY) throw new Error('缺 DEEPSEEK_API_KEY（环境变量或 D:/FRONTIER/.env）');

  console.log('真跑一遍解读管线：' + owner + '/' + repo + ' …');
  const bundle = await fetchRepoBundle(owner, repo, env.GITHUB_TOKEN || '');
  const profile = { ...DEFAULT_PROFILE, apiKey: env.DEEPSEEK_API_KEY, apiBase: env.DEEPSEEK_BASE_URL || DEFAULT_PROFILE.apiBase, model: env.DEEPSEEK_MODEL || DEFAULT_PROFILE.model };
  let full = '';
  await streamChat({
    apiBase: profile.apiBase,
    apiKey: profile.apiKey,
    model: profile.model,
    messages: buildMessages(bundle, profile),
    onDelta: (d) => (full += d)
  });
  if ((full.match(/^## /gm) || []).length < 8) throw new Error('生成的解读卡小标题不足，检查模型输出');
  fs.writeFileSync(cacheFile, full, 'utf8');
  return { md: full, facts: bundle.facts, ev: summarise(bundle.evidence) };
}

/* ---------- 真实 GitHub 元数据（发现页那批条目） ---------- */
const PICKS = [
  ['microsoft/markitdown', '文档批处理', 9, '把 PDF、Word、Excel、PPT 批量转成 Markdown，可本地跑', '图片里的字要另配 OCR 插件'],
  ['PaddlePaddle/PaddleOCR', '文档批处理', 8, '本地 OCR，把图片和扫描版 PDF 转成结构化文字，支持中文', '要自己配环境调模型，表格还原需额外配置'],
  ['opendatalab/MinerU', '文档批处理', 9, '把复杂 PDF 和 Office 文档转成适合喂大模型的 Markdown/JSON', '依赖显卡，首次要下大模型'],
  ['docling-project/docling', '文档批处理', 8, 'IBM 出的文档解析器，PDF/Word 转 Markdown 并保留版面结构', '依赖较全，装一次要几百 MB'],
  ['langgenius/dify', 'Agent 工作流', 7, '拖拽搭 LLM 应用和工作流，自带知识库与调试台', '自建要 docker compose，配置项多'],
  ['shadcn-ui/ui', '前端 UI 可抄件', 8, '可以直接复制进项目的 React 组件源码，样式跟着你的 tailwind 走', '要 React + tailwind，不是拿来即用的成品站']
];

async function ghMeta(full) {
  try {
    const r = await fetch('https://api.github.com/repos/' + full, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000) // 网络挂起不能卡死整个截图流程
    });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      full_name: j.full_name,
      stars: j.stargazers_count,
      language: j.language || '',
      pushed_at: (j.pushed_at || '').slice(0, 10),
      html_url: j.html_url
    };
  } catch (_) {
    return null;
  }
}

const roundItems = [];
for (const [full, interest, match, oneLine, caution] of PICKS) {
  const m = await ghMeta(full);
  if (!m) continue;
  roundItems.push({ ...m, interest_id: '', interest_name: interest, match, one_line: oneLine, caution });
}
console.log('发现页条目：' + roundItems.length + ' 条真实元数据');

/* ---------- GitHub 页上的解读卡：真跑管线拿结果，灌进扩展缓存，页面点开即时渲染 ---------- */
const cardMark = await genCard('microsoft', 'markitdown');
const cardDoc = await genCard('docling-project', 'docling');

const PROFILE = {
  apiBase: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  model: env.DEEPSEEK_MODEL || 'deepseek-chat',
  apiKey: env.DEEPSEEK_API_KEY || '',
  githubToken: env.GITHUB_TOKEN || '',
  feishuWebhook: env.FEISHU_WEBHOOK || '',
  feishuSecret: env.FEISHU_SECRET || '',
  drawerWidth: 560,
  favorites: [
    {
      full_name: 'microsoft/markitdown',
      at: Date.now() - 1000 * 60 * 30,
      level: '值得尝试',
      one_line: '把 PDF、Word、Excel、PPT 批量转成 Markdown，可本地跑',
      md: cardMark.md,
      facts: { stars: cardMark.facts.stars, language: cardMark.facts.language, pushed_at: cardMark.facts.pushed_at }
    },
    {
      full_name: 'docling-project/docling',
      at: Date.now() - 1000 * 60 * 90,
      level: '值得尝试',
      one_line: 'IBM 出的文档解析器，PDF/Word 转 Markdown 并保留版面结构',
      md: cardDoc.md,
      facts: { stars: cardDoc.facts.stars, language: cardDoc.facts.language, pushed_at: cardDoc.facts.pushed_at }
    }
  ],
  cacheSeed: {
    key: 'c:' + cardMark.facts.full_name + ':' + cardMark.facts.pushed_at,
    value: { md: cardMark.md, at: Date.now() - 1000 * 60 * 5, facts: cardMark.facts, ev: cardMark.ev }
  }
};

/* ---------- 启动 ---------- */
const ctx = await chromium.launchPersistentContext(TMP_PROFILE, {
  executablePath: EDGE,
  headless: true,
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars'
  ]
});

const shot = async (page, name, opts = {}) => {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, ...opts });
  console.log('  ✓ ' + name);
};

const page = ctx.pages()[0] || (await ctx.newPage());

/* 扩展 id：从 service worker 上取，别写死 */
let extId = '';
for (let i = 0; i < 40 && !extId; i++) {
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (sw) extId = new URL(sw.url()).host;
  else await page.waitForTimeout(250);
}
if (!extId) throw new Error('没找到扩展 service worker，确认扩展已部署到 ' + EXT);
console.log('扩展 id：' + extId);

/* 先把 storage 灌好（只在真扩展页面上能写 chrome.storage） */
await page.goto(`chrome-extension://${extId}/search.html`);
await page.evaluate(
  async ({ profile, items }) => {
    const { cacheSeed, ...p } = profile;
    const data = { profile: p, drawerWidth: 560 };
    if (cacheSeed) data[cacheSeed.key] = cacheSeed.value;
    data['disc:last'] = {
      at: Date.now() - 1000 * 60 * 6,
      plan: [
        { id: 'i-doc', name: '文档批处理', q: '(pdf OR docx) (convert OR extract) in:description pushed:>2025-05-16' }
      ],
      items,
      errors: [],
      stats: { total: 27, kept: items.length }
    };
    await chrome.storage.local.set(data);
  },
  { profile: PROFILE, items: roundItems }
);

/* ---------- 1. 仓库页上的入口按钮 ---------- */
console.log('截图中…');
await page.goto('https://github.com/microsoft/markitdown', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gh-cn-btn', { timeout: 30000 });
await page.waitForTimeout(800);
await shot(page, '01-entry-button.png', { clip: { x: 0, y: 130, width: 1440, height: 340 } });

/* ---------- 2. 点开 → 渲染解读卡（缓存命中即时出，未命中真调模型） ---------- */
await page.click('.gh-cn-btn');
/* 注意 waitForFunction 的第三个参数才是 options（第二个是传给页内函数的 arg） */
const cardState = () =>
  page.waitForFunction(
    () => {
      const host = document.getElementById('gh-cn-card-host');
      const sr = host && host.shadowRoot;
      if (!sr) return false;
      const body = sr.querySelector('[data-el="body"]');
      if (!body) return false;
      if (body.textContent.includes('值不值得') && !sr.querySelector('.caret')) return 'done';
      if (sr.querySelector('.err')) return 'error';
      return false;
    },
    undefined,
    { timeout: 120000, polling: 500 }
  );
if ((await cardState()) === 'error') {
  const msg = await page.evaluate(() => {
    const sr = document.getElementById('gh-cn-card-host').shadowRoot;
    return sr.querySelector('[data-el="body"]').textContent.slice(0, 300);
  });
  throw new Error('卡片进入错误态：' + msg);
}
await page.waitForTimeout(600);
await shot(page, '02-card-top.png');

/* 滚到卡片底部：值不值得 + 依据 + 反馈 */
await page.evaluate(() => {
  const sr = document.getElementById('gh-cn-card-host').shadowRoot;
  const body = sr.querySelector('[data-el="body"]');
  body.scrollTop = body.scrollHeight;
});
await page.waitForTimeout(400);
await shot(page, '03-card-verdict.png', { clip: { x: 880, y: 0, width: 560, height: 960 } });

/* ---------- 4. 发现页 ---------- */
await page.goto(`chrome-extension://${extId}/search.html`);
await page.waitForSelector('#results .item', { timeout: 15000 });
await page.waitForTimeout(500);
// 勾两个「发群」，让转发能力出现在同一张图里
const boxes = page.locator('#results [data-fwd]');
await boxes.nth(0).check();
await boxes.nth(2).check();
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
await shot(page, '04-discover.png');

/* ---------- 5. 收藏 + 对比 ---------- */
await page.click('[data-tab="fav"]');
await page.waitForTimeout(600);
const favBoxes = page.locator('#favList input[type=checkbox]');
await favBoxes.nth(0).check();
await favBoxes.nth(1).check();
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('cmpInline').scrollIntoView({ block: 'start' }));
await page.waitForTimeout(400);
await shot(page, '05-compare.png');

/* ---------- 6. 设置页 ---------- */
await page.goto(`chrome-extension://${extId}/options.html`);
await page.waitForTimeout(600);
await shot(page, '06-options.png', { clip: { x: 0, y: 0, width: 1440, height: 960 } });

await ctx.close();
console.log('\n完成，输出目录：' + OUT);
