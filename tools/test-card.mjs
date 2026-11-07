// 本地跑一遍真实管线，验证提示词是否守格式、语气对不对。
// 用法：node tools/test-card.mjs owner/repo
// 读 D:\FRONTIER\.env 里已有的 DeepSeek 配置，不落盘、不打印 key。

import fs from 'node:fs';
import path from 'node:path';
import { fetchRepoBundle } from '../extension/lib/github.js';
import { buildMessages, HEADINGS } from '../extension/lib/prompt.js';
import { streamChat } from '../extension/lib/llm.js';
import { DEFAULT_PROFILE } from '../extension/lib/profile.js';

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnv('D:/FRONTIER/.env');
const apiKey = env.DEEPSEEK_API_KEY;
const apiBase = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const model = env.DEEPSEEK_MODEL || 'deepseek-chat';

if (!apiKey) {
  console.error('没有找到 DEEPSEEK_API_KEY');
  process.exit(1);
}

const target = process.argv[2] || 'langchain-ai/langgraph';
const [owner, repo] = target.split('/');

console.log(`\n=== 取数：${owner}/${repo} ===`);
const t0 = Date.now();
const bundle = await fetchRepoBundle(owner, repo, process.env.GITHUB_TOKEN || '');
console.log('事实：', JSON.stringify(bundle.facts, null, 2));
console.log(`README 长度：${bundle.readme.length} 字符，取数耗时 ${Date.now() - t0}ms`);

const ev = bundle.evidence || {};
console.log('\n硬事实（新加的，用来给「门槛」「局限」找出处）：');
console.log('  发版：', (ev.releases || []).map((r) => `${r.tag}(${r.at})`).join('、') || '（一个都没有）');
console.log('  未关 issue：', (ev.issues || []).length, '条');
(ev.issues || []).slice(0, 3).forEach((i) => console.log(`    · ${i.title}（${i.comments} 回复）`));
console.log('  依赖文件：', ev.manifest ? ev.manifest.name + '（' + (ev.manifest.sample || '').length + ' 字）' : '（没找到）');
console.log('  根目录：', (ev.rootFiles || []).slice(0, 12).join(' '));

const messages = buildMessages(bundle, DEFAULT_PROFILE);
const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
console.log(`提示词总长：${promptChars} 字符（约 ${Math.round(promptChars / 1.6)} token）`);

console.log('\n=== 模型输出 ===\n');
let full = '';
let firstCharAt = 0;
const t1 = Date.now();
await streamChat({
  apiBase,
  apiKey,
  model,
  messages,
  onDelta: (d) => {
    if (!firstCharAt) firstCharAt = Date.now() - t1;
    full += d;
    process.stdout.write(d);
  }
});

const total = Date.now() - t1;
console.log(`\n\n=== 校验 ===`);
console.log(`首字延迟：${firstCharAt}ms，全文耗时：${total}ms，输出 ${full.length} 字`);

const found = [...full.matchAll(/^\s*##\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/[*`]/g, '').trim());
const missing = HEADINGS.filter((h) => !found.includes(h));
const extra = found.filter((h) => !HEADINGS.includes(h));
console.log('标题命中：', found.length + '/' + HEADINGS.length);
if (missing.length) console.log('缺失：', missing.join('、'));
if (extra.length) console.log('多余：', extra.join('、'));

const verdict = full.match(/\*\*\s*(值得尝试|值得关注|暂时不值得)\s*\*\*/);
console.log('判断：', verdict ? verdict[1] : '没解析到三档');
console.log('禁用词检查：', /该项目|旨在|赋能|生态|开箱即用|一站式/.test(full) ? '出现了，要修' : '干净');

fs.writeFileSync(path.resolve('tools/last-output.md'), full, 'utf8');
console.log('\n输出已存 tools/last-output.md');
