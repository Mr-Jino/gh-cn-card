// 后台逻辑的自动验证：在 Node 里直接跑真实的 background.js，网络全部打桩。
// 为什么必须有这个：出过两次严重 bug 的地方（把没读过的标成"看过"、去重把用户结果吃掉）
// 全在这层，而它此前一次自动验证都没有，全靠用户截图反馈。
// 运行：node tools/test-background.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond && extra ? '  (' + extra + ')' : ''));
}

/* ---------------- 假的 chrome ---------------- */

const store = {};
const L = { connect: [], message: [], installed: [] };

function normKeys(k) {
  if (k == null) return null;
  if (typeof k === 'string') return [k];
  if (Array.isArray(k)) return k;
  return Object.keys(k);
}

globalThis.chrome = {
  storage: {
    local: {
      get: (k) => {
        const keys = normKeys(k);
        if (!keys) return Promise.resolve({ ...store });
        const out = {};
        for (const key of keys) if (key in store) out[key] = store[key];
        return Promise.resolve(out);
      },
      set: (o) => {
        Object.assign(store, o);
        return Promise.resolve();
      },
      remove: (k) => {
        for (const key of normKeys(k) || []) delete store[key];
        return Promise.resolve();
      }
    }
  },
  runtime: {
    onConnect: { addListener: (f) => L.connect.push(f) },
    onMessage: { addListener: (f) => L.message.push(f) },
    onInstalled: { addListener: (f) => L.installed.push(f) },
    getURL: (p) => p,
    openOptionsPage() {}
  },
  action: { onClicked: { addListener() {} } },
  tabs: { create() {} }
};

/* ---------------- 打桩的网络 ---------------- */

const MD_ANSWER = [
  '## 一句话',
  '把 PDF 和 Word 里的表格读成 Excel，本地跑不联网。',
  '## 它到底是什么',
  '一个命令行工具加一个 Python 包。',
  '## 谁为什么做它',
  '作者每天要抄报表，烦了。',
  '## 能拿来干什么',
  '批量把合同、发票、报表转成结构化数据。',
  '## 它怎么跑起来',
  'pip 装完就能用，不需要显卡。',
  '## 怎么用',
  '一行命令指一个文件夹。',
  '## 门槛',
  '要会开命令行；不装 Python 的话得先装。',
  '## 优点',
  '离线、快、输出格式规矩。',
  '## 局限',
  '扫描件没做 OCR，图片里的字读不出来。',
  '## 值不值得',
  '值得尝试。手上有成堆表格的话，今天就能省下半天。',
  '## 我不确定的地方',
  '复杂合并单元格会不会错行，README 没说。'
].join('\n');

let repoStatus = 200;
let searchStatus = 200;
let searchItems = [];
let searchCalls = [];
let modelCalls = 0;
let lastCardBody = '';
let feishuResp = { code: 0, msg: 'success' };
const feishuCalls = [];
const evCalls = { releases: 0, issues: 0, contents: 0, raw: 0 };

const RELEASES = [{ tag_name: 'v1.4.2', published_at: '2026-08-12T00:00:00Z', draft: false }];
const ISSUES = [
  { title: 'merged cells break table detection', comments: 12, created_at: '2026-09-02T00:00:00Z' },
  { title: 'chore: bump deps', comments: 1, created_at: '2026-09-01T00:00:00Z', pull_request: { url: 'x' } }
];
const ROOT = [
  { name: 'README.md', type: 'file' },
  {
    name: 'requirements.txt',
    type: 'file',
    download_url: 'https://raw.githubusercontent.com/owner/repo/main/requirements.txt'
  }
];
const MANIFEST_TEXT = 'pdfplumber==0.10.0\npandas>=2.0\n';

const REPO_JSON = {
  full_name: 'owner/repo',
  description: 'Table extraction toolkit',
  language: 'Python',
  stargazers_count: 1234,
  forks_count: 88,
  license: { spdx_id: 'MIT' },
  pushed_at: '2026-10-20T10:00:00Z',
  created_at: '2024-01-02T10:00:00Z',
  archived: false,
  homepage: '',
  topics: ['pdf', 'table'],
  open_issues_count: 12,
  default_branch: 'main',
  html_url: 'https://github.com/owner/repo'
};

function jsonRes(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function sseRes(text) {
  const enc = new TextEncoder();
  const parts = [];
  for (let i = 0; i < text.length; i += 50) {
    parts.push('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 50) } }] }) + '\n\n');
  }
  parts.push('data: [DONE]\n\n');
  const stream = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function pickModelReply(bodyStr) {
  if (bodyStr.includes('翻译成 GitHub 仓库搜索 query')) {
    return JSON.stringify([{ id: 'i-doc', q: 'pdf OR docx convert in:description' }]);
  }
  if (bodyStr.includes('你在替一个中文用户筛选 GitHub 搜索结果')) {
    return JSON.stringify(
      searchItems.map((r) => ({
        full_name: r.full_name,
        one_line: '把表格批量读成结构化数据',
        match: 8,
        interest_id: 'i-doc',
        interest_name: '文档批处理',
        caution: ''
      }))
    );
  }
  return MD_ANSWER;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('open.feishu.cn')) {
    feishuCalls.push({ url: u, body: JSON.parse(String(opts.body || '{}')) });
    return jsonRes(feishuResp);
  }

  if (u.includes('/chat/completions')) {
    modelCalls++;
    const body = String(opts.body || '');
    if (body.includes('【项目事实】')) lastCardBody = body;
    return sseRes(pickModelReply(body));
  }

  if (u.includes('raw.githubusercontent.com')) {
    evCalls.raw++;
    return new Response(MANIFEST_TEXT, { status: 200 });
  }

  if (u.includes('/releases?')) {
    evCalls.releases++;
    return jsonRes(RELEASES);
  }

  if (u.includes('/issues?')) {
    evCalls.issues++;
    return jsonRes(ISSUES);
  }

  if (/\/contents\/$/.test(u)) {
    evCalls.contents++;
    return jsonRes(ROOT);
  }

  if (u.includes('/search/repositories')) {
    searchCalls.push(decodeURIComponent(u.split('q=')[1].split('&')[0]));
    if (searchStatus !== 200) {
      return jsonRes({ message: 'rate limited' }, searchStatus, { 'x-ratelimit-remaining': '0' });
    }
    return jsonRes({
      items: searchItems.map((r) => ({
        full_name: r.full_name,
        description: r.description || 'a tool',
        language: r.language || 'Python',
        stargazers_count: r.stars ?? 500,
        pushed_at: '2026-09-01T00:00:00Z',
        topics: [],
        html_url: 'https://github.com/' + r.full_name,
        archived: false
      }))
    });
  }

  if (/\/repos\/[^/]+\/[^/]+\/readme$/.test(u)) {
    return new Response('# owner/repo\n\nTable extraction.\n\n## Install\n\n```\npip install x\n```\n', {
      status: 200
    });
  }

  if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
    if (repoStatus !== 200) return jsonRes({ message: 'Not Found' }, repoStatus);
    return jsonRes(REPO_JSON);
  }

  return new Response('not stubbed: ' + u, { status: 404 });
};

/* ---------------- 加载真实 background.js ---------------- */

const BG = pathToFileURL(path.join(process.cwd(), 'extension', 'background.js')).href;
await import(BG + '?t=' + Date.now());
await sleep(30);

function openPort(name) {
  const port = {
    name,
    msgs: [],
    postMessage(m) {
      port.msgs.push(m);
    },
    onMessage: { addListener: (f) => (port._msg = f) },
    onDisconnect: { addListener: (f) => (port._dis = f) },
    disconnect() {}
  };
  L.connect.forEach((f) => f(port));
  return port;
}

async function waitDone(port, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (port.msgs.some((m) => ['done', 'error', 'cached'].includes(m.type))) return;
    await sleep(20);
  }
}

const types = (port) => port.msgs.map((m) => m.type);
const firstOf = (port, type) => port.msgs.find((m) => m.type === type);

function sendMessage(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const ret = L.message[0](msg, {}, (r) => {
      settled = true;
      resolve(r);
    });
    setTimeout(() => {
      if (!settled) resolve(undefined);
    }, 2000);
  });
}

/* ---------------- 用例 ---------------- */

(async () => {
  /* 1. 没填 Key 时给的是人话，不是报错栈 */
  store.profile = { apiKey: '', model: 'm', apiBase: 'https://x/v1' };
  let p = openPort('gh-card');
  p._msg({ type: 'start', owner: 'owner', repo: 'repo' });
  await waitDone(p);
  const e1 = firstOf(p, 'error');
  check('没填 Key 时提示去填 Key', e1 && e1.code === 'no-key' && /API Key/.test(e1.message), e1 && e1.message.slice(0, 20));

  /* 2. 正常解读：事实 → 流式 → 缓存 */
  store.profile = { apiKey: 'sk-test', model: 'm', apiBase: 'https://x/v1' };
  p = openPort('gh-card');
  p._msg({ type: 'start', owner: 'owner', repo: 'repo' });
  await waitDone(p);

  check('先发事实再流式', types(p)[0] === 'status' && types(p).includes('facts'));
  const facts = firstOf(p, 'facts');
  check('事实来自接口不是模型编的', facts && facts.facts.stars === 1234 && facts.facts.license === 'MIT');
  check('正文分多段流式推过来', p.msgs.filter((m) => m.type === 'delta').length > 3);
  check('最后以 done 收尾', !!firstOf(p, 'done'));
  const fullText = p.msgs.filter((m) => m.type === 'delta').map((m) => m.text).join('');
  check('11 个小标题一个不少', (fullText.match(/^## /gm) || []).length === 11);

  const cacheKey = Object.keys(store).find((k) => k.startsWith('c:owner/repo:'));
  check('结果按 pushed_at 存了缓存', !!cacheKey);

  /* 2.5 硬事实真的进了提示词（否则抓了也白抓） */
  check('真 issue 标题进了提示词（局限有出处）', lastCardBody.includes('merged cells break table detection'));
  check('PR 没被当成用户抱怨混进去', !lastCardBody.includes('bump deps'));
  check('发版记录进了提示词', lastCardBody.includes('v1.4.2'));
  check('依赖文件内容进了提示词（门槛有出处）', lastCardBody.includes('requirements.txt') && lastCardBody.includes('pdfplumber'));

  const evMsg = firstOf(p, 'evidence');
  check(
    '卡片拿得到"依据"摘要（发版/issue/依赖）',
    evMsg && evMsg.ev.lastTag === 'v1.4.2' && evMsg.ev.issues >= 1 && evMsg.ev.manifest === 'requirements.txt',
    evMsg && JSON.stringify(evMsg.ev)
  );

  /* 3. 再打开走缓存，不再烧钱 */
  const before = modelCalls;
  const evBefore = { ...evCalls };
  p = openPort('gh-card');
  p._msg({ type: 'start', owner: 'owner', repo: 'repo' });
  await waitDone(p);
  check('同一次推送内再打开走缓存', !!firstOf(p, 'cached') && modelCalls === before);
  check(
    '缓存命中时不去重复抓发版/issue/依赖（省额度）',
    evCalls.releases === evBefore.releases && evCalls.contents === evBefore.contents,
    JSON.stringify(evCalls)
  );

  /* 4. 强制重读 */
  p = openPort('gh-card');
  p._msg({ type: 'start', owner: 'owner', repo: 'repo', force: true });
  await waitDone(p);
  check('点「重新解读」会绕过缓存', !!firstOf(p, 'done') && modelCalls > before);

  /* 5. 私有库 / 不存在的库：话说清楚 */
  repoStatus = 404;
  p = openPort('gh-card');
  p._msg({ type: 'start', owner: 'owner', repo: 'private-one' });
  await waitDone(p);
  check('404 时说清"不存在或私有"', /私有/.test(firstOf(p, 'error')?.message || ''));
  repoStatus = 200;

  /* 6. 「看过」记录只能由用户动作写入 —— 这是踩过的坑 */
  store.profile.seen = {};
  await sendMessage({ type: 'markSeen', repo: 'a/read-me' });
  const seenAt = store.profile.seen['a/read-me'];
  check('点开读过 → 记入"看过"', seenAt > Date.now() - 5000);

  await sendMessage({ type: 'fav', op: 'add', repo: 'b/saved', one_line: '一句话', md: MD_ANSWER });
  check('收藏成功并带上解读正文', store.profile.favorites.length === 1 && !!store.profile.favorites[0].md);
  await sendMessage({ type: 'fav', op: 'toggle', repo: 'b/saved' });
  check('再点一次取消收藏', store.profile.favorites.length === 0);

  /* 7. 发现：看过的不推、收藏的不推、force 才捞回看过的 */
  searchItems = [
    { full_name: 'x/one', description: 'pdf table' },
    { full_name: 'x/two', description: 'pdf table' },
    { full_name: 'x/three', description: 'pdf table' }
  ];
  store.profile.seen = { 'x/one': Date.now() };
  store.profile.favorites = [{ full_name: 'x/two', at: Date.now() }];
  store.profile.interests = [{ id: 'i-doc', name: '文档批处理', intent: '把表格读成数据', enabled: true }];
  store.profile.lastRound = [];

  p = openPort('gh-discover');
  p._msg({ type: 'discover', interests: store.profile.interests, force: false });
  await waitDone(p);
  const got = () => p.msgs.filter((m) => m.type === 'batch').flatMap((m) => m.items.map((i) => i.full_name));
  check('搜到 3 个：看过的和收藏的都被挡掉', got().length === 1 && got()[0] === 'x/three', got().join(','));
  check('结果已翻成中文再给你（不是英文描述）', /[\u4e00-\u9fa5]/.test(firstOf(p, 'batch')?.items[0]?.one_line || ''));

  /* 8. 关键回归：搜过 ≠ 看过。搜完不能自己往"看过"里写东西 */
  check(
    '一轮搜完不会把结果偷偷标成"看过"',
    Object.keys(store.profile.seen).length === 1 && store.profile.seen['x/one'] !== undefined,
    JSON.stringify(store.profile.seen)
  );
  check(
    '这一轮的候选记在 lastRound 里（供"这轮都看完了"用）',
    (store.profile.lastRound || []).length === 1 && store.profile.lastRound[0] === 'x/three',
    JSON.stringify(store.profile.lastRound)
  );

  /* 9. force：看过的要捞回来，收藏的仍然不推 */
  p = openPort('gh-discover');
  p._msg({ type: 'discover', interests: store.profile.interests, force: true });
  await waitDone(p);
  const g2 = p.msgs.filter((m) => m.type === 'batch').flatMap((m) => m.items.map((i) => i.full_name));
  check('force 能捞回看过的', g2.includes('x/one') && g2.includes('x/three'), g2.join(','));
  check('force 也不会重复推已收藏的', !g2.includes('x/two'));

  /* 10. 搜索限流：说人话，不静默失败 */
  searchStatus = 403;
  searchCalls = [];
  p = openPort('gh-discover');
  p._msg({ type: 'discover', interests: store.profile.interests, force: false });
  await waitDone(p);
  const searched = firstOf(p, 'searched');
  check('限流时报出原因', searched && /限流|Token/.test(searched.error || ''), searched && searched.error);
  check('限流不会假装"这轮没结果"', !firstOf(p, 'done') || firstOf(p, 'done').stats.total === 0);
  searchStatus = 200;

  /* 11. 清空看过记录 */
  await sendMessage({ type: 'clearSeen' });
  check('清空后看过记录归零', Object.keys(store.profile.seen).length === 0);

  /* 12. 转发到飞书情报群（和 FRONTIER 同一个机器人） */
  const FWD_ITEM = {
    full_name: 'x/three',
    one_line: '把表格批量读成结构化数据',
    caution: '老版本要自己编译',
    match: 8,
    stars: 900,
    language: 'Python',
    pushed_at: '2026-09-01',
    html_url: 'https://github.com/x/three'
  };

  store.profile.feishuWebhook = '';
  store.profile.feishuSecret = '';
  const r0 = await sendMessage({ type: 'feishuSend', items: [FWD_ITEM], source: 'discover' });
  check('没配机器人时告知去选 .env，不静默失败', r0.ok === false && r0.code === 'no-webhook' && /\.env/.test(r0.error));

  store.profile.feishuWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook';
  store.profile.feishuSecret = 'sec-test';
  const r1 = await sendMessage({ type: 'feishuSend', items: [FWD_ITEM], source: 'discover' });
  check('转发成功并报了条数', r1.ok === true && r1.sent === 1);
  const fb1 = feishuCalls[feishuCalls.length - 1].body;
  check('用的是 FRONTIER 同款卡片格式（interactive + markdown）', fb1.msg_type === 'interactive' && fb1.card?.elements?.[0]?.tag === 'markdown');
  check('标题写明来自发现页', fb1.card.header.title.content.includes('发现页'));
  check('正文有仓库名、中文一句话、提醒和链接', (() => {
    const c = fb1.card.elements[0].content;
    return c.includes('x/three') && c.includes('把表格批量读成结构化数据') && c.includes('老版本要自己编译') && c.includes('https://github.com/x/three');
  })());
  check('开了加签就带 timestamp + base64 sign（和 frontier.py 同一套）', /^\d{10}$/.test(fb1.timestamp || '') && /^[A-Za-z0-9+/=]{20,}$/.test(fb1.sign || ''));

  // 收藏来源：带 md 的条目要把「结论」「门槛」也带上
  const r2 = await sendMessage({
    type: 'feishuSend',
    items: [{ ...FWD_ITEM, match: null, stars: null, md: MD_ANSWER, level: '值得尝试' }],
    source: 'fav'
  });
  const fb2 = feishuCalls[feishuCalls.length - 1].body;
  check('收藏来源标题写明收藏夹', r2.ok === true && fb2.card.header.title.content.includes('收藏夹'));
  check('收藏条目把结论和门槛一并发出去', fb2.card.elements[0].content.includes('值得尝试') && fb2.card.elements[0].content.includes('门槛'));

  // 飞书拒收：说人话，特别是签名错误
  feishuResp = { code: 9000018, msg: 'sign match fail' };
  const r3 = await sendMessage({ type: 'feishuSend', items: [FWD_ITEM], source: 'discover' });
  check('签名不对时指到密钥上，不报错误码完事', r3.ok === false && /签名|密钥/.test(r3.error), r3.error);
  feishuResp = { code: 0, msg: 'success' };

  // 设置页「测一条」
  const r4 = await sendMessage({ type: 'feishuTest' });
  check('「测一条」走同一个机器人', r4.ok === true && feishuCalls[feishuCalls.length - 1].body.card.header.title.content.includes('测试'));

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
})();
