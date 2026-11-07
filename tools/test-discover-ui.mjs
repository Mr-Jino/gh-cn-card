// 「发现」页的自动验证：不开浏览器，直接跑真实的 search.html + search.js。
// 重点盯的回归：搜完一轮刷新就全没了（用户报过的坑）；以及结果落盘后能不能接回来。
// 运行：node tools/test-discover-ui.mjs

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, 'extension', 'search.html');
const JS_URL = pathToFileURL(path.join(ROOT, 'extension', 'search.js')).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond && extra ? '  (' + extra + ')' : ''));
}

const store = {}; // 跨"重启"保留，模拟 chrome.storage.local

function makeChrome() {
  const ports = [];
  const sent = []; // 页面发给后台的所有消息，转发用例要从里面捞
  return {
    ports,
    sent,
    runtime: {
      id: 'test',
      connect(name) {
        const p = {
          name,
          sent: [],
          onMessage: { addListener(f) { p._onMsg = f; } },
          onDisconnect: { addListener(f) { p._onDis = f; } },
          postMessage(m) { p.sent.push(m); },
          disconnect() {}
        };
        ports.push(p);
        return p;
      },
      sendMessage(m, cb) {
        sent.push({ ...m });
        const p = store.profile || (store.profile = {});
        if (m && m.type === 'markRoundSeen') {
          p.lastRound = [];
        }
        if (m && m.type === 'feishuSend') {
          // 假它已配好机器人；没配的场景在后台测试里管
          if (cb) cb({ ok: true, sent: m.items.length });
          return;
        }
        // 收藏的增删在真实后台里是有的，这里照抄一份最小的，否则测不到界面重绘
        if (m && m.type === 'fav') {
          p.favorites = p.favorites || [];
          const i = p.favorites.findIndex((f) => f.full_name === m.repo);
          if (m.op === 'remove' || (m.op === 'toggle' && i >= 0)) {
            if (i >= 0) p.favorites.splice(i, 1);
          } else if (i < 0) {
            p.favorites.unshift({ full_name: m.repo, at: Date.now(), one_line: m.one_line || '', md: m.md || '' });
          }
        }
        if (cb) cb({ ok: true, count: 0 });
      },
      getURL: (p) => p,
      openOptionsPage() {}
    },
    tabs: { create() {} },
    storage: {
      local: {
        get: (k) => {
          if (k == null) return Promise.resolve({ ...store });
          if (typeof k === 'string') return Promise.resolve(k in store ? { [k]: store[k] } : {});
          const out = {};
          for (const key of [].concat(k)) if (key in store) out[key] = store[key];
          return Promise.resolve(out);
        },
        set: (o) => {
          Object.assign(store, o);
          return Promise.resolve();
        },
        remove: (k) => {
          for (const key of [].concat(k)) delete store[key];
          return Promise.resolve();
        }
      }
    }
  };
}

let bootN = 0;
async function boot() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/search.html', pretendToBeVisual: true });
  const chrome = makeChrome();

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.chrome = chrome;

  await import(JS_URL + '?boot=' + ++bootN);
  await sleep(60);

  const doc = dom.window.document;
  const $ = (id) => doc.getElementById(id);
  const click = (el) => {
    if (!el) throw new Error('点不到元素');
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  return { dom, doc, $, click, chrome, close: () => dom.window.close() };
}

const visible = (el) => !!el && !el.hidden && el.style.display !== 'none';

/* 造两条假结果，字段和 scoreBatch 的产出对齐 */
function fakeItem(full, name, extra = {}) {
  return {
    full_name: full,
    one_line: '把一堆表格一次读成结构化数据，本地跑不要联网。',
    match: 8,
    interest_id: 'i-doc',
    interest_name: name,
    caution: '',
    stars: 3200,
    language: 'Python',
    pushed_at: '2026-10-01',
    html_url: 'https://github.com/' + full,
    ...extra
  };
}

(async () => {
  /* ---------- 第一次打开：空状态 ---------- */
  let app = await boot();
  check('初次打开没有结果', app.doc.querySelectorAll('#results .item').length === 0);
  check('初次打开不显示"这批结果"提示条', !visible(app.$('roundNote')));

  /* ---------- 搜一轮 ---------- */
  app.click(app.$('runBtn'));
  await sleep(30);
  const port = app.chrome.ports[0];
  check('点「搜一轮」向后台开了通道', !!port && port.sent[0]?.type === 'discover');

  port._onMsg({ type: 'plan', plan: [{ id: 'i-doc', name: '文档批处理', q: 'pdf OR docx convert' }] });
  await sleep(20);
  check('chip 上显示了翻好的搜索词', app.$('chips').textContent.includes('pdf OR docx'));

  port._onMsg({
    type: 'batch',
    items: [fakeItem('a/table-reader', '文档批处理'), fakeItem('b/pdf-kit', '文档批处理', { match: 6 })],
    done: 2,
    total: 2
  });
  await sleep(30);
  check('结果渲染出 2 条', app.doc.querySelectorAll('#results .item').length === 2);

  port._onMsg({ type: 'done', stats: { total: 2, kept: 2, note: '' } });
  await sleep(600);
  check('这一轮已落盘', store['disc:last'] && store['disc:last'].items.length === 2);
  check('落盘里带上了搜索词', store['disc:last'].plan.length === 1);
  check('完成后显示"这批结果"提示条', visible(app.$('roundNote')));

  /* ---------- 不感兴趣 → 列表和落盘都要减一 ---------- */
  app.click(app.doc.querySelector('[data-skip="b/pdf-kit"]'));
  await sleep(600);
  check('「不感兴趣」后列表剩 1 条', app.doc.querySelectorAll('#results .item').length === 1);
  check('「不感兴趣」也写回了落盘', store['disc:last'].items.length === 1);

  app.close();

  /* ---------- 关掉再开：结果必须还在 ---------- */
  app = await boot();
  check('重开后结果还在（这就是原来丢的项目）', app.doc.querySelectorAll('#results .item').length === 1);
  check('重开后显示"这批结果"提示条', visible(app.$('roundNote')));
  check('重开后没有冒充新一轮搜索', app.$('status').textContent.includes('接上'));
  check('重开后收藏/不感兴趣按钮仍在', !!app.doc.querySelector('[data-fav="a/table-reader"]'));

  /* ---------- 点「清掉这批」 ---------- */
  app.click(app.$('clearRoundBtn'));
  await sleep(60);
  check('「清掉这批」后列表清空', app.doc.querySelectorAll('#results .item').length === 0);
  check('「清掉这批」后提示条隐藏', !visible(app.$('roundNote')));
  check('「清掉这批」后落盘也删了', !('disc:last' in store));
  app.close();

  /* ---------- 读过的条目要标出来 ---------- */
  store['disc:last'] = {
    at: Date.now() - 3600e3,
    plan: [{ id: 'i-doc', name: '文档批处理', q: 'x' }],
    items: [fakeItem('c/read-already', '文档批处理')],
    errors: [],
    stats: null
  };
  store.profile = { ...(store.profile || {}), seen: { 'c/read-already': Date.now() } };
  app = await boot();
  check('读过的条目带「读过」标记', app.doc.querySelector('#results .item').textContent.includes('读过'));
  check('一小时前的批次显示"1 小时前"', app.$('roundNote').textContent.includes('1 小时前'));

  // 再搜一轮，结果为空 → 旧的那批要一起丢掉，不能刷新后又冒出来装作有新发现
  app.click(app.$('runBtn'));
  await sleep(30);
  const p2 = app.chrome.ports[0];
  p2._onMsg({ type: 'plan', plan: [{ id: 'i-doc', name: '文档批处理', q: 'y' }] });
  p2._onMsg({ type: 'done', stats: { total: 0, kept: 0, note: '这一轮没有新仓库' } });
  await sleep(500);
  check('这轮 0 条时旧批次一并清掉（刷新不会假装有结果）', !('disc:last' in store));
  check('0 条时提示条不出现', !visible(app.$('roundNote')));
  app.close();

  /* ---------- 转发到飞书：勾选 → 按钮亮 → 一键发后台 ---------- */
  app = await boot();
  app.click(app.$('runBtn'));
  await sleep(30);
  const fp = app.chrome.ports[0];
  fp._onMsg({ type: 'plan', plan: [{ id: 'i-doc', name: '文档批处理', q: 'x' }] });
  fp._onMsg({
    type: 'batch',
    items: [fakeItem('f/one', '文档批处理'), fakeItem('f/two', '文档批处理', { match: 6 })],
    done: 2,
    total: 2
  });
  fp._onMsg({ type: 'done', stats: { total: 2, kept: 2, note: '' } });
  await sleep(30);

  check('没勾时转发按钮是灰的', app.$('fwdBtn').disabled);
  const cb1 = app.doc.querySelector('[data-fwd="f/one"]');
  cb1.checked = true;
  cb1.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('勾一个后按钮亮起并显示数量', !app.$('fwdBtn').disabled && app.$('fwdBtn').textContent.includes('1 个'));

  app.click(app.$('fwdBtn'));
  await sleep(40);
  const fwd = app.chrome.sent.filter((m) => m.type === 'feishuSend');
  check('点转发把勾选的仓库原样交给后台', fwd.length === 1 && fwd[0].items.length === 1 && fwd[0].items[0].full_name === 'f/one');
  check('转发带上中文一句话和仓库链接', String(fwd[0]?.items[0]?.one_line).includes('表格') && String(fwd[0]?.items[0]?.html_url).includes('/f/one'));
  check('发完勾选自动清掉，按钮回到灰的', app.$('fwdBtn').disabled);

  // 收藏里的单发按钮
  store.profile.favorites = [{ full_name: 'f/three', at: Date.now(), one_line: '把 OCR 做成本地服务', md: '' }];
  app = await boot();
  app.click(app.doc.querySelector('[data-tab="fav"]'));
  await sleep(120);
  const b1 = app.doc.querySelector('[data-fwd1="f/three"]');
  check('收藏条目上有「发群」按钮', !!b1);
  b1.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const fwd2 = app.chrome.sent.filter((m) => m.type === 'feishuSend');
  check('收藏单发走的是收藏来源', fwd2.length === 1 && fwd2[0].source === 'fav' && fwd2[0].items[0].full_name === 'f/three');
  app.close();

  /* ---------- 收藏 + 对比表 ---------- */
  const MD_A = [
    '## 一句话',
    '把 PDF 表格读成 Excel。',
    '## 值不值得',
    '值得尝试。手上有报表就能省半天。',
    '## 能拿来干什么',
    '批量转合同和发票。',
    '## 怎么用',
    '一行命令指一个文件夹。',
    '## 门槛',
    '要会开命令行。',
    '## 优点',
    '离线、快。',
    '## 局限',
    '扫描件没做 OCR。',
    '## 我不确定的地方',
    '合并单元格会不会错行没说。'
  ].join('\n');
  const MD_B = MD_A.replace('把 PDF 表格读成 Excel。', '把 Markdown 转成任何格式。').replace(
    '值得尝试。手上有报表就能省半天。',
    '值得关注。方向对但还在早期。'
  );

  store.profile = {
    ...(store.profile || {}),
    favorites: [
      { full_name: 'm/table-reader', at: Date.now(), level: '值得尝试', one_line: '把 PDF 表格读成 Excel。', md: MD_A },
      { full_name: 'n/md-convert', at: Date.now() - 1000, level: '值得关注', one_line: '把 Markdown 转成任何格式。', md: MD_B }
    ]
  };

  app = await boot();
  app.click(app.doc.querySelector('[data-tab="fav"]'));
  await sleep(120);
  check('收藏标签列出 2 个', app.doc.querySelectorAll('#favList .fav').length === 2);
  check('收藏项显示了"值不值得"的结论', app.$('favList').textContent.includes('值得尝试'));
  check('没勾满两个时对比表是提示语', app.$('cmpInline').textContent.includes('勾满两个'));

  const boxes = app.doc.querySelectorAll('#favList input[type=checkbox]');
  for (const b of boxes) {
    b.checked = true;
    b.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  }
  await sleep(60);
  const cmp = app.$('cmpInline');
  check('勾两个直接出对比表（不用再点别的）', !!cmp.querySelector('table.cmp'));
  const heads = [...cmp.querySelectorAll('tr:first-child th')].map((t) => t.textContent);
  check('表头是仓库名', heads.length === 3 && heads[1].includes('m/table-reader'), heads.join('|'));
  const rows = [...cmp.querySelectorAll('tr th:first-child')].map((t) => t.textContent);
  check('对比维度覆盖门槛/局限/不确定', ['门槛', '局限', '不确定'].every((k) => rows.includes(k)), rows.join(','));
  const firstCell = cmp.querySelectorAll('tr')[3].querySelectorAll('td')[0].textContent;
  check('对比表里填的是真解读内容', firstCell.includes('批量转合同'), firstCell.slice(0, 20));

  // 已经勾了两个，第三个勾不上
  const third = app.doc.querySelectorAll('#favList input[type=checkbox]')[0];
  third.checked = true;
  third.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  await sleep(30);
  check('已经两个了会拦住第三个', app.$('favStatus').textContent.includes('最多勾两个'));

  app.click(app.doc.querySelector('[data-unfav="m/table-reader"]'));
  await sleep(120);
  check('移除收藏后列表剩 1 个', app.doc.querySelectorAll('#favList .fav').length === 1);
  app.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
})();
