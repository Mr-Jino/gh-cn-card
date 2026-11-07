// 本地验证「发现」管线：中文关注点 → 英文搜索词 → 真实搜索 → 中文打分
// 用法：node tools/test-discover.mjs

import fs from 'node:fs';
import { planQueries, searchRepos, scoreBatch } from '../extension/lib/discover.js';
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
const profile = {
  ...DEFAULT_PROFILE,
  apiKey: env.DEEPSEEK_API_KEY,
  apiBase: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  model: env.DEEPSEEK_MODEL || 'deepseek-chat'
};

const interests = DEFAULT_PROFILE.interests.slice(0, 3);

console.log('=== 1. 中文意图 → GitHub 搜索词 ===');
const t0 = Date.now();
const plan = await planQueries(profile, interests);
console.log(`${Date.now() - t0}ms`);
for (const p of plan) console.log(`  [${p.name}]  ${p.q}`);

console.log('\n=== 2. 真实搜索 ===');
const pool = [];
for (const p of plan) {
  const items = await searchRepos(p.q, process.env.GITHUB_TOKEN || '');
  console.log(`  [${p.name}] ${items.length} 条`);
  for (const it of items) pool.push({ ...it, interest_id: p.id, interest_name: p.name });
}
const dedupe = [...new Map(pool.map((x) => [x.full_name, x])).values()];
console.log(`  去重后 ${dedupe.length} 条`);

console.log('\n=== 3. 批量中文化 + 打分（前 14 条） ===');
const t1 = Date.now();
const scored = await scoreBatch(profile, interests, dedupe.slice(0, 14));
console.log(`${Date.now() - t1}ms`);
scored
  .sort((a, b) => b.match - a.match)
  .forEach((s) => {
    console.log(`${String(s.match).padStart(2)} | ${s.full_name}  ★${s.stars}`);
    console.log(`     ${s.one_line}`);
    if (s.caution) console.log(`     ⚠ ${s.caution}`);
  });

const kept = scored.filter((s) => s.match >= 5).length;
console.log(`\n进入阈值(≥5) 的：${kept}/${scored.length}`);
