/* GitHub 中文口语解读 · 内容脚本
   职责：在仓库页注入「AI 解读」按钮 → 打开右侧抽屉 → 流式渲染解读卡
   无构建、无依赖，直接以 classic script 跑。 */

(() => {
  if (window.__ghCnCardLoaded) return;
  window.__ghCnCardLoaded = true;

  // 样式表和纯函数在 content-kit.js 里，manifest 里排在前面加载
  const { CSS, esc, timeAgo, inlineMd, renderBlocks, parseSections } = window.__ghCnKit;

  const HOST_ID = 'gh-cn-card-host';
  const BTN_CLASS = 'gh-cn-btn';

  const RESERVED = new Set([
    'settings', 'marketplace', 'explore', 'topics', 'trending', 'collections', 'events',
    'sponsors', 'notifications', 'new', 'organizations', 'users', 'login', 'join',
    'pricing', 'features', 'about', 'site', 'security', 'enterprise', 'codespaces',
    'apps', 'contact', 'dashboard', 'search', 'issues', 'pulls', 'stars', 'watching',
    'orgs', 'account', 'discussions', 'blog', 'customer-stories', 'education',
    'mobile', 'premium-support', 'releases', 'solutions', 'team', 'training', 'readme',
    'github-copilot', 'copilot', 'models', 'wiki', 'pages'
  ]);

  let current = null;
  let port = null;
  let drawerRepo = null;
  let pendingFeedback = null;
  let renderQueued = false;
  let minimized = false;

  const state = {
    md: '',
    facts: null,
    status: '',
    error: '',
    done: false,
    cachedAt: 0,
    ev: null,
    fbSent: false
  };

  /* ---------------- 基础工具 ---------------- */

  function parseRepo(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (RESERVED.has(owner.toLowerCase())) return null;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    if (repo.endsWith('.git')) return null;
    return { owner, repo, full: owner + '/' + repo };
  }

  function themeClass() {
    const de = document.documentElement;
    const mode = de.getAttribute('data-color-mode');
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* ---------------- 注入按钮 ---------------- */

  function injectButtonStyle() {
    if (document.getElementById('gh-cn-btn-style')) return;
    const style = document.createElement('style');
    style.id = 'gh-cn-btn-style';
    style.textContent = `
.${BTN_CLASS}{
  display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;margin-left:8px;
  font:500 12px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  border-radius:6px;cursor:pointer;vertical-align:middle;white-space:nowrap;
  border:1px solid var(--borderColor-default,#3d444d);
  background:var(--bgColor-muted,#21262d);
  color:var(--fgColor-default,#e6edf3);
}
.${BTN_CLASS}:hover{border-color:var(--borderColor-emphasis,#6e7681);}
.${BTN_CLASS}.fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;height:36px;padding:0 14px;
  box-shadow:0 3px 12px rgba(0,0,0,.35);margin:0;}
`;
    document.head.appendChild(style);
  }

  function findAnchor() {
    const title = document.querySelector('#repo-title-component');
    if (title) {
      const row = title.closest('.d-flex') || title.parentElement;
      if (row) return row;
    }
    const header = document.querySelector('#repository-container-header');
    if (header) return header.querySelector('div.d-flex') || header;
    return null;
  }

  function ensureEntry() {
    const repo = parseRepo(location.pathname);

    if (!repo) {
      document.querySelectorAll('.' + BTN_CLASS).forEach((b) => b.remove());
      current = null;
      return;
    }

    if (current && current.full !== repo.full) {
      closeDrawer();
      document.querySelectorAll('.' + BTN_CLASS).forEach((b) => b.remove());
    }
    current = repo;

    const existing = document.querySelector('.' + BTN_CLASS);
    if (existing && existing.dataset.repo === repo.full && existing.isConnected) return;
    if (existing) existing.remove();

    injectButtonStyle();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.dataset.repo = repo.full;
    btn.textContent = 'AI 解读';
    btn.title = '用中文口语讲清楚这个项目在干什么';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDrawer(repo);
    });

    const anchor = findAnchor();
    if (anchor) {
      anchor.appendChild(btn);
    } else {
      btn.classList.add('fab');
      document.body.appendChild(btn);
    }
  }

  /* ---------------- 抽屉骨架 ---------------- */


  let host = null;
  let shadow = null;
  let wrap = null;
  let el = {};

  function applyTheme() {
    const t = themeClass();
    if (host) host.className = t;
    if (wrap) wrap.className = 'wrap ' + t;
  }

  function mount() {
    if (host && host.isConnected) {
      applyTheme();
      return;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      height: '100vh',
      width: '420px',
      maxWidth: '96vw',
      zIndex: '2147483001',
      display: 'none',
      border: '0'
    });

    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrapEl = document.createElement('div');
    wrapEl.className = 'wrap ' + themeClass();
    wrap = wrapEl;
    wrap.innerHTML = `
<div class="panel">
  <div class="grip" data-el="grip" title="拖这里调宽窄"></div>
  <div class="hd">
    <div class="repo" data-el="repo"></div>
    <div class="hb">
      <button data-act="fav" title="收藏这个仓库">☆</button>
      <button data-act="discover" title="发现：用中文找仓库" style="font-size:11px;width:auto;padding:0 7px">发现</button>
      <button data-act="regen" title="重新生成">↻</button>
      <button data-act="settings" title="设置">⚙</button>
      <button data-act="min" title="缩成角标，先看 GitHub">—</button>
      <button data-act="close" title="关闭 (Esc)">✕</button>
    </div>
  </div>
  <div class="meta" data-el="meta"></div>
  <div class="body" data-el="body"></div>
  <div class="fbrow" data-el="fbrow">
    <input data-el="fbinput" placeholder="一句话原因，比如「跟我的项目没关系」，回车提交" />
    <button class="mini" data-act="fbsubmit">提交</button>
  </div>
  <div class="ft">
    <span data-el="verdict"></span>
    <span class="sp"></span>
    <div class="fb" data-el="fb">
      <button data-fb="useful">有用</button>
      <button data-fb="useless">没用</button>
      <button data-fb="irrelevant">跟我无关</button>
    </div>
  </div>
</div>
<div class="bubble" data-act="restore" title="点开继续看">读</div>`;
    shadow.appendChild(wrap);
    document.body.appendChild(host);

    el = {
      repo: shadow.querySelector('[data-el="repo"]'),
      meta: shadow.querySelector('[data-el="meta"]'),
      body: shadow.querySelector('[data-el="body"]'),
      verdict: shadow.querySelector('[data-el="verdict"]'),
      fb: shadow.querySelector('[data-el="fb"]'),
      fbrow: shadow.querySelector('[data-el="fbrow"]'),
      fbinput: shadow.querySelector('[data-el="fbinput"]'),
      panel: shadow.querySelector('.panel'),
      grip: shadow.querySelector('[data-el="grip"]'),
      bubble: shadow.querySelector('.bubble')
    };

    initResize();
    restoreWidth();

    shadow.addEventListener('click', onClick);
    shadow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === el.fbinput) submitFeedbackNote();
      e.stopPropagation();
    });
  }

  function onClick(e) {
    const fbBtn = e.target.closest('[data-fb]');
    if (fbBtn) {
      handleFeedback(fbBtn.dataset.fb);
      return;
    }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;

    switch (btn.dataset.act) {
      case 'min':
        minimizeDrawer();
        break;
      case 'restore':
        restoreDrawer();
        break;
      case 'close':
        closeDrawer();
        break;
      case 'regen':
        if (current) start(current, true);
        break;
      case 'settings':
        chrome.runtime.sendMessage({ type: 'openOptions' });
        break;
      case 'discover':
        chrome.runtime.sendMessage({ type: 'openDiscover' });
        break;
      case 'fav':
        toggleFav();
        break;
      case 'fbsubmit':
        submitFeedbackNote();
        break;
      case 'retry':
        if (current) start(current, true);
        break;
      case 'openkey':
        chrome.runtime.sendMessage({ type: 'openOptions' });
        break;
    }
  }

  /* ---------------- 抽屉宽度 / 最小化 ---------------- */

  function restoreWidth() {
    chrome.storage.local.get('drawerWidth', ({ drawerWidth }) => {
      if (drawerWidth) {
        const maxW = Math.min(920, window.innerWidth * 0.85);
        host.style.width = Math.max(320, Math.min(maxW, drawerWidth)) + 'px';
      }
    });
  }

  function initResize() {
    let sx = 0;
    let sw = 0;
    let dragging = false;

    el.grip.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX;
      sw = host.offsetWidth;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxW = Math.min(920, window.innerWidth * 0.85);
      const w = Math.max(320, Math.min(maxW, sw + (sx - e.clientX)));
      host.style.width = w + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({ drawerWidth: parseInt(host.style.width, 10) || 420 });
    });
  }

  function minimizeDrawer() {
    minimized = true;
    el.panel.style.display = 'none';
    if (el.bubble) el.bubble.style.display = 'flex';
  }

  function restoreDrawer() {
    minimized = false;
    el.panel.style.display = 'flex';
    if (el.bubble) el.bubble.style.display = 'none';
  }

  /* ---------------- 渲染 ---------------- */

  function verdictLevel() {
    const m = state.md.match(/\*\*\s*(值得尝试|值得关注|暂时不值得)\s*\*\*/);
    if (m) return m[1];
    const m2 = state.md.match(/(值得尝试|值得关注|暂时不值得)/);
    return m2 ? m2[1] : '';
  }

  function renderBody() {
    const b = el.body;
    const keep = b.scrollTop;

    if (state.error) {
      const isKey = state.error.indexOf('API Key') >= 0;
      b.innerHTML =
        '<div class="err">' + esc(state.error) +
        '<div class="act">' +
        (isKey
          ? '<button class="mini primary" data-act="openkey">去填 Key</button>'
          : '<button class="mini" data-act="retry">重试</button>') +
        '</div></div>';
      renderFoot();
      return;
    }

    if (!state.md) {
      b.innerHTML =
        '<div class="loading"><span class="spin"></span>' + esc(state.status || '准备中…') + '</div>';
      renderFoot();
      return;
    }

    const secs = parseSections(state.md);
    let html = '';

    for (const s of secs) {
      if (s.h === '__pre') continue;
      const cls =
        s.h === '一句话' ? 'hero' : s.h === '值不值得' ? 'verdict' : s.h === '我不确定的地方' ? 'unknown' : 'sec';
      html += '<section class="' + cls + '">';
      if (cls !== 'hero') html += '<div class="lab">' + esc(s.h) + '</div>';
      html += '<div class="txt">' + renderBlocks(s.body) + '</div></section>';
    }

    if (!state.done) html += '<span class="caret"></span>';
    if (state.cachedAt && state.done) {
      html += '<div class="tip" style="padding:10px 0 0">这份是 ' + timeAgo(state.cachedAt) + '的缓存，仓库没更新就直接用。想强制重读点右上角 ↻。</div>';
    }
    if (state.done && state.ev) html += renderEvidence(state.ev);

    b.innerHTML = html;
    b.scrollTop = keep;
    renderFoot();
  }

  // 「门槛」「局限」凭什么这么说？把依据摊在卡片最下面。
  // 三个数字都是程序从接口抓的，模型改不动——这样它没法用 README 的宣传语糊过去。
  function renderEvidence(ev) {
    const bits = [];
    if (ev.lastTag) {
      bits.push('最近发版 <b>' + esc(ev.lastTag) + '</b>' + (ev.lastAt ? '（' + esc(ev.lastAt) + '）' : ''));
    } else {
      bits.push('没有发版记录');
    }
    if (ev.issues) bits.push('看过 ' + ev.issues + ' 条未关 issue');
    if (ev.manifest) bits.push('翻了 ' + esc(ev.manifest));
    if (!bits.length) return '';

    const title = (ev.issueTitles || []).length
      ? ' issue 里有人提：' + ev.issueTitles.map((t) => '「' + t + '」').join(' ')
      : '';
    return (
      '<div class="tip" style="padding:12px 0 0" title="' +
      esc(title.trim()) +
      '">依据：' +
      bits.join(' · ') +
      '</div>'
    );
  }

  function renderMeta() {
    const f = state.facts;
    if (!f) {
      el.meta.innerHTML = '';
      return;
    }
    const chips = [];
    chips.push('<span class="chip">★ <b>' + f.stars.toLocaleString() + '</b></span>');
    if (f.language) chips.push('<span class="chip">' + esc(f.language) + '</span>');
    chips.push('<span class="chip">' + esc(f.license) + '</span>');
    chips.push('<span class="chip">最后提交 <b>' + esc(f.pushed_at || '未知') + '</b></span>');
    if (f.archived) chips.push('<span class="chip" style="color:#e5534b">已归档</span>');
    el.meta.innerHTML = chips.join('');
  }

  function renderFoot() {
    const level = verdictLevel();
    const cls = level === '值得尝试' ? 'ok' : level === '值得关注' ? 'warn' : 'mute';
    el.verdict.innerHTML = level ? '<span class="badge ' + cls + '">' + level + '</span>' : '';
    el.fb.style.display = state.done && state.md ? 'flex' : 'none';
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderBody();
    });
  }

  /* ---------------- 收藏 ---------------- */

  function repoFull() {
    return (state.facts && state.facts.full_name) || (current && current.full) || '';
  }

  async function refreshStar() {
    const btn = shadow && shadow.querySelector('[data-act="fav"]');
    if (!btn) return;
    const full = repoFull();
    if (!full) return;
    try {
      const { profile } = await chrome.storage.local.get('profile');
      const fav = ((profile && profile.favorites) || []).some((f) => f.full_name === full);
      btn.textContent = fav ? '★' : '☆';
      btn.style.color = fav ? '#d29922' : '';
    } catch (_) {}
  }

  function toggleFav() {
    const full = repoFull();
    if (!full) return;
    chrome.runtime.sendMessage(
      {
        type: 'fav',
        repo: full,
        md: state.md,
        level: verdictLevel(),
        one_line: (state.md.match(/##\s*一句话\s*\n+([^\n]+)/) || [])[1] || '',
        facts: state.facts
      },
      () => refreshStar()
    );
  }

  /* ---------------- 反馈回路 ---------------- */

  function handleFeedback(kind) {
    if (kind === 'useful') {
      sendFeedback('useful', '');
      return;
    }
    pendingFeedback = kind;
    el.fbrow.classList.add('on');
    el.fbinput.value = '';
    el.fbinput.placeholder =
      kind === 'useless' ? '为什么没用？比如「要 20G 显存」' : '为什么跟你无关？比如「跟前端无关」';
    el.fbinput.focus();
  }

  function submitFeedbackNote() {
    if (!pendingFeedback) return;
    sendFeedback(pendingFeedback, el.fbinput.value.trim());
    pendingFeedback = null;
    el.fbrow.classList.remove('on');
  }

  function sendFeedback(verdict, note) {
    const entry = {
      repo: (state.facts && state.facts.full_name) || (current && current.full) || '',
      verdict,
      note,
      level: verdictLevel()
    };
    chrome.runtime.sendMessage({ type: 'feedback', entry }, (res) => {
      if (res && res.ok) {
        state.fbSent = true;
        Array.from(el.fb.children).forEach((b) => (b.disabled = true));
        if (el.body) {
          const hint = document.createElement('div');
          hint.className = 'tip';
          hint.textContent = '记下了，下次判断会带上这条（累计 ' + res.count + ' 条）。';
          hint.style.padding = '10px 0 0';
          el.body.appendChild(hint);
        }
      }
    });
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function reset() {
    state.md = '';
    state.facts = null;
    state.status = '';
    state.error = '';
    state.done = false;
    state.cachedAt = 0;
    state.ev = null;
    state.fbSent = false;
    el.fbrow.classList.remove('on');
    Array.from(el.fb.children).forEach((b) => (b.disabled = false));
  }

  function openDrawer(repo) {
    mount();
    host.style.display = 'block';
    applyTheme();
    // 之前被缩成角标了：先还原，否则看起来"点了没反应"
    if (minimized) restoreDrawer();

    // 同一个仓库已经打开且没出错：不重复请求（正在生成时也不打断）
    if (drawerRepo === repo.full && !state.error) return;

    drawerRepo = repo.full;
    el.repo.textContent = repo.full;
    el.repo.title = repo.full;
    reset();
    renderMeta();
    renderBody();
    refreshStar();
    start(repo, false);
  }

  function closeDrawer() {
    if (port) {
      try {
        port.disconnect();
      } catch (_) {}
      port = null;
    }
    if (el.panel) restoreDrawer();
    if (host) host.style.display = 'none';
    drawerRepo = null;
  }

  function start(repo, force) {
    if (port) {
      try {
        port.disconnect();
      } catch (_) {}
      port = null;
    }

    reset();
    state.status = '连接中…';
    renderBody();

    try {
      port = chrome.runtime.connect({ name: 'gh-card' });
    } catch (_) {
      state.error = '扩展刚被更新过，刷新一下这个页面就好。';
      renderBody();
      return;
    }

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'status':
          state.status = msg.text;
          if (!state.md) renderBody();
          break;
        case 'facts':
          state.facts = msg.facts;
          renderMeta();
          refreshStar();
          break;
        case 'evidence':
          state.ev = msg.ev;
          break;
        case 'delta':
          if (!state.md) state.status = '';
          state.md += msg.text;
          scheduleRender();
          break;
        case 'cached':
          state.facts = msg.facts || state.facts;
          state.md = msg.markdown;
          state.cachedAt = msg.at;
          state.done = true;
          renderMeta();
          renderBody();
          break;
        case 'done':
          state.done = true;
          renderBody();
          break;
        case 'error':
          state.error = msg.message;
          renderBody();
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
    });

    port.postMessage({ type: 'start', owner: repo.owner, repo: repo.repo, force: !!force });
  }

  /* ---------------- 导航监听（GitHub 是 Turbo 局部刷新） ---------------- */

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !host || host.style.display !== 'block') return;
    if (wrap && wrap.classList.contains('min')) restoreDrawer();
    else closeDrawer();
  });

  let ticking = false;
  function tick() {
    if (ticking) return;
    ticking = true;
    setTimeout(() => {
      ticking = false;
      ensureEntry();
      if (host && host.style.display === 'block') applyTheme();
    }, 120);
  }

  const mo = new MutationObserver(tick);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('popstate', tick);
  document.addEventListener('turbo:load', tick);
  document.addEventListener('pjax:end', tick);
  setInterval(tick, 1200);

  ensureEntry();

  // 从发现页点「读这篇」过来：URL 带 #gh-cn-auto，自动开抽屉
  if (location.hash === '#gh-cn-auto') {
    const repo = parseRepo(location.pathname);
    if (repo) {
      current = repo;
      openDrawer(repo);
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
})();
