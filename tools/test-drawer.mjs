// 抽屉交互的自动验证：不开任何浏览器窗口，用 jsdom 跑一遍真实 content.js。
// 目的：像"最小化后角标消失"这类回归，必须在我交付前被拦住，而不是由用户截图报错。
// 运行：node tools/test-drawer.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = `<!DOCTYPE html><html data-color-mode="dark"><head></head><body>
<div id="repository-container-header">
  <div class="d-flex"><div id="repo-title-component"><strong><a href="/owner/repo">owner/repo</a></strong></div></div>
</div></body></html>`;

const dom = new JSDOM(HTML, {
  url: 'https://github.com/owner/repo',
  runScripts: 'dangerously',
  pretendToBeVisual: true
});
const { window } = dom;
const doc = window.document;

const store = {};
const port = {
  // 把监听器存下来，测试里可以像后台一样往里推消息
  onMessage: { addListener(f) { port._onMsg = f; } },
  onDisconnect: { addListener(f) { port._onDis = f; } },
  postMessage() {},
  disconnect() {}
};

window.chrome = {
  runtime: {
    id: 'test',
    connect: () => port,
    sendMessage: (m, cb) => cb && cb({ ok: true, count: 0 }),
    getURL: (p) => p
  },
  storage: {
    local: {
      get: (k, cb) => {
        const res = typeof k === 'string' ? (k in store ? { [k]: store[k] } : {}) : { ...store };
        if (cb) {
          cb(res);
          return;
        }
        return Promise.resolve(res);
      },
      set: (o, cb) => {
        Object.assign(store, o);
        if (cb) cb();
        return Promise.resolve();
      },
      remove: () => Promise.resolve()
    }
  }
};

// 按 manifest 里的顺序加载（kit 先，content 后），和浏览器行为一致
for (const f of ['extension/content-kit.js', 'extension/content.js']) {
  const script = doc.createElement('script');
  script.textContent = fs.readFileSync(f, 'utf8');
  doc.head.appendChild(script);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond && extra ? '  (' + extra + ')' : ''));
}

const host = () => doc.getElementById('gh-cn-card-host');
const sr = () => host() && host().shadowRoot;
const q = (sel) => sr() && sr().querySelector(sel);
const click = (elOrSel) => {
  const el = typeof elOrSel === 'string' ? q(elOrSel) : elOrSel;
  if (!el) throw new Error('点不到元素: ' + elOrSel);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
};

function visible(el) {
  if (!el) return false;
  // 逐级检查 display，模拟"眼睛能不能看到"
  let n = el;
  while (n && n.nodeType === 1) {
    const d = window.getComputedStyle(n).display;
    if (d === 'none') return false;
    n = n.parentNode;
  }
  return true;
}

(async () => {
  await sleep(60);

  const btn = doc.querySelector('.gh-cn-btn');
  check('按钮已注入仓库页', !!btn);

  click(btn);
  await sleep(80);
  check('点按钮后抽屉出现', host() && host().style.display === 'block');
  check('面板可见', visible(q('.panel')));

  click('[data-act="min"]');
  await sleep(60);
  check('最小化后面板隐藏', !visible(q('.panel')));
  check('最小化后角标可见', visible(q('.bubble')));

  // 关键回归：等自动重排（会重写 className）跑过一轮，角标不能消失
  await sleep(1500);
  check('1.5 秒后角标仍在（className 被重写也不受影响）', visible(q('.bubble')));

  click('.bubble');
  await sleep(60);
  check('点角标能还原面板', visible(q('.panel')));
  check('还原后角标隐藏', !visible(q('.bubble')));

  // 关键回归：最小化状态下再点「AI 解读」，必须能弹出来
  click('[data-act="min"]');
  await sleep(60);
  click(doc.querySelector('.gh-cn-btn'));
  await sleep(80);
  check('最小化后再点 AI 解读能正常打开', visible(q('.panel')));

  // 关闭 → 重新打开
  click('[data-act="close"]');
  await sleep(60);
  check('关闭后整体隐藏', host().style.display === 'none');
  click(doc.querySelector('.gh-cn-btn'));
  await sleep(80);
  check('关闭后重新点按钮能打开', visible(q('.panel')));

  // 拖宽：模拟 mousedown → mousemove → mouseup
  const grip = q('[data-el="grip"]');
  const before = host().offsetWidth;
  grip.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 1000 }));
  doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 900 }));
  doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(60);
  check('拖边框能改宽度', host().style.width !== '' && host().style.width !== before + 'px', host().style.width);
  check('宽度已存下来', typeof store.drawerWidth === 'number');

  /* ---------- 流式渲染 + 「依据」脚注 ---------- */
  click('[data-act="close"]');
  await sleep(50);
  click(doc.querySelector('.gh-cn-btn'));
  await sleep(60);

  port._onMsg({ type: 'facts', facts: { full_name: 'owner/repo', stars: 1234, language: 'Python', license: 'MIT', pushed_at: '2026-10-20', archived: false } });
  port._onMsg({ type: 'evidence', ev: { releases: 3, lastTag: 'v1.4.2', lastAt: '2026-08-12', issues: 6, issueTitles: ['merged cells break table detection'], manifest: 'requirements.txt' } });
  port._onMsg({ type: 'delta', text: '## 一句话\n把表格读成 Excel。\n\n## 门槛\n要会开命令行。\n' });
  await sleep(120);
  check('流式过程中先出已有章节', q('.body').textContent.includes('把表格读成 Excel'));
  check('还没写完时显示光标', !!q('.caret'));

  port._onMsg({ type: 'delta', text: '\n## 局限\n扫描件没做 OCR。\n' });
  port._onMsg({ type: 'done' });
  await sleep(120);
  check('写完光标消失', !q('.caret'));
  check('卡片底部给出「依据」', q('.body').textContent.includes('依据：'), q('.body').textContent.slice(-40));
  check('依据里有发版号', q('.body').textContent.includes('v1.4.2'));
  check('依据里提到看过的 issue 数', q('.body').textContent.includes('6 条未关 issue'));
  check('鼠标悬停能看到具体 issue 标题', (q('.tip').getAttribute('title') || '').includes('merged cells'));

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
  window.close();
})();
