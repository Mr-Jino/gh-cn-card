import { loadProfile, saveProfile } from './lib/profile.js';
import { getSection, getLevel, getOneLine, plain } from './lib/cardmd.js';
import { saveRound, loadRound, clearRound, roundAge } from './lib/round.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let profile = null;
let port = null;
let items = [];
let plan = {}; // 搜索词映射 id → q，只用于 chip 上显示
let planList = []; // 同一份，数组形式，落盘用
let selected = new Set();
let searchErrors = [];
let lastStats = null;
let roundAt = 0; // 当前这批结果产生的时间，0 表示还没落过盘
const fwdSel = new Set(); // 勾了「发群」的仓库，等「转发到飞书群」一键送走

/* ---------------- 结果落盘 ---------------- */
// 页面上任何让列表变动的操作都要写回 storage，但连点「不感兴趣」不该写十次，
// 所以推迟 400ms 合并。真实场景里这一下足够快，用户感觉不到。

let saveTimer = null;
function persistRound() {
  if (!items.length) return;
  roundAt = Date.now(); // 先落下时间戳，提示条才能立刻显示"刚刚"
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveRound({ plan: planList, items, errors: searchErrors, stats: lastStats });
  }, 400);
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

/* 就地提示：任何动作都在屏幕底部给一句反馈，不用到处找 */
let toastEl = null;
let toastTimer = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1f6feb;color:#fff;padding:9px 16px;border-radius:999px;font-size:12.5px;z-index:99999;transition:opacity .25s;box-shadow:0 4px 14px rgba(0,0,0,.4);';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.style.opacity = '0'), 2400);
}

/* ---------------- 关注点 ---------------- */

function renderChips() {
  const box = $('chips');
  box.innerHTML = profile.interests
    .map((i) => {
      const q = plan[i.id] ? `<span class="q" title="${esc(plan[i.id])}">← ${esc(plan[i.id].slice(0, 26))}</span>` : '';
      return `<span class="chip ${i.enabled !== false ? 'on' : ''}" data-id="${esc(i.id)}">
        <span class="dot"></span><span class="nm">${esc(i.name)}</span>
        <span class="x" data-del="${esc(i.id)}" title="删掉">✕</span>${q}
      </span>`;
    })
    .join('');
}

async function toggleInterest(id) {
  const it = profile.interests.find((x) => x.id === id);
  if (!it) return;
  it.enabled = it.enabled === false;
  await saveProfile(profile);
  renderChips();
}

async function delInterest(id) {
  profile.interests = profile.interests.filter((x) => x.id !== id);
  await saveProfile(profile);
  renderChips();
}

async function addInterest() {
  const name = $('newName').value.trim();
  const intent = $('newIntent').value.trim();
  if (!name || !intent) {
    setStatus('名字和"想找什么样的"都要填', 'err');
    return;
  }
  profile.interests.push({ id: 'i-' + Date.now().toString(36), name, intent, enabled: true });
  await saveProfile(profile);
  $('newName').value = '';
  $('newIntent').value = '';
  renderChips();
  setStatus('加了。点「搜一轮」就开始找。', 'ok');
}

/* ---------------- 结果渲染 ---------------- */

function scoreClass(m) {
  return m >= 8 ? 's8' : m >= 6 ? 's6' : 's5';
}

// 点开读过（但不收藏）的仓库还留在列表里，标一下，免得下次又点一遍。
// skipRepo 写的是未来 60 天的时间戳（拉黑），那种不会落到这里。
function wasRead(full) {
  const t = (profile.seen || {})[full];
  return !!t && t - Date.now() < 86400e3;
}

/* 每个关注点一个固定颜色，结果上一眼就能看出它属于哪类 */
const TAG_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#ff7b72', '#39c5cf', '#f778ba', '#7ee787'];
function tagColor(name) {
  const list = profile.interests || [];
  let i = list.findIndex((x) => x.name === name);
  if (i < 0) i = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return TAG_COLORS[i % TAG_COLORS.length];
}

function renderResults() {
  const box = $('results');
  if (!items.length) {
    box.innerHTML = '';
    return;
  }
  const groups = new Map();
  for (const it of items) {
    const key = it.interest_name || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  let html = '';
  for (const [name, list] of groups) {
    list.sort((a, b) => b.match - a.match);
    html += `<div class="group"><div class="gtitle"><b>${esc(name)}</b> · ${list.length} 个</div>`;
    for (const it of list) {
      const star = it.stars >= 1000 ? (it.stars / 1000).toFixed(1) + 'k' : String(it.stars);
      const isFav = (profile.favorites || []).some((f) => f.full_name === it.full_name);
      const tc = tagColor(it.interest_name || '');
      const readTag = wasRead(it.full_name)
        ? '<span class="meta" style="color:var(--ok)">读过</span>'
        : '';
      html += `<div class="item" data-full="${esc(it.full_name)}">
        <div class="itop">
          <span class="name">${esc(it.full_name)}</span>
          <span class="tag" style="color:${tc};border-color:${tc};background:${tc}1f">${esc(it.interest_name || '其他')}</span>
          <span class="score ${scoreClass(it.match)}">${it.match}</span>${readTag}
          <span class="meta"><span>★ ${star}</span>${it.language ? '<span>' + esc(it.language) + '</span>' : ''}<span>${esc(it.pushed_at)}</span></span>
        </div>
        <div class="line">${esc(it.one_line)}</div>
        ${it.caution ? '<div class="caution">' + esc(it.caution) + '</div>' : ''}
        <div class="acts">
          <button data-read="${esc(it.html_url)}">读这篇</button>
          <button data-fav="${esc(it.full_name)}" ${isFav ? 'disabled' : ''}>${isFav ? '已收藏' : '收藏'}</button>
          <button data-skip="${esc(it.full_name)}">不感兴趣</button>
          <label class="fwd ${fwdSel.has(it.full_name) ? 'on' : ''}">
            <input type="checkbox" data-fwd="${esc(it.full_name)}" ${fwdSel.has(it.full_name) ? 'checked' : ''} />发群
          </label>
        </div>
      </div>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

/* 这批结果是什么时候的、要不要清掉——直接写在列表上方，不用猜 */
function renderRoundNote() {
  const box = $('roundNote');
  if (!box) return;
  if (!items.length || !roundAt) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML =
    '<span>这 ' +
    items.length +
    ' 条是 <b>' +
    esc(roundAge(roundAt)) +
    '</b> 搜的，刷新或关掉标签都还在。</span>' +
    '<button id="clearRoundBtn">清掉这批</button>';
}

/* ---------------- 搜索 ---------------- */

function renderSearchErrors() {
  const box = $('searchErrors');
  if (!searchErrors.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = searchErrors
    .map((e) => '<div class="caution">「' + esc(e.name) + '」搜索失败：' + esc(e.msg) + '</div>')
    .join('');
}

function startDiscover(force) {
  if (port) {
    try {
      port.disconnect();
    } catch (_) {}
    port = null;
  }

  const active = profile.interests.filter((i) => i.enabled !== false);
  if (!active.length) {
    setStatus('至少开一个关注点', 'err');
    return;
  }

  // 旧结果先在内存里清掉，但 storage 里那一份留着——万一这一轮立刻失败（没 Key、断网），
  // 刷新一下还能看回上一批，不至于白丢。
  items = [];
  plan = {};
  planList = [];
  searchErrors = [];
  lastStats = null;
  fwdSel.clear();
  renderSearchErrors();
  renderResults();
  renderRoundNote();
  updateFwdBtn();
  $('runBtn').disabled = true;
  $('forceBtn').disabled = true;
  $('roundDone').disabled = true;
  setStatus('开始…');

  port = chrome.runtime.connect({ name: 'gh-discover' });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'stage':
        setStatus(msg.text);
        break;
      case 'plan':
        planList = msg.plan || [];
        for (const p of planList) plan[p.id] = p.q;
        renderChips();
        break;
      case 'searched':
        if (msg.error) {
          searchErrors.push({ name: plan[msg.id] || msg.id, msg: msg.error });
          renderSearchErrors();
        }
        break;
      case 'batch':
        items = items.concat(msg.items || []);
        renderResults();
        persistRound();
        renderRoundNote();
        setStatus(`已筛 ${msg.done}/${msg.total}，合格的 ${items.length} 个`, '');
        break;
      case 'done':
        lastStats = msg.stats;
        setStatus(
          msg.stats.kept ? `这轮留下 ${msg.stats.kept} 个（共筛 ${msg.stats.total} 个）` : msg.stats.note || '这轮没有结果',
          msg.stats.kept ? 'ok' : ''
        );
        $('roundDone').disabled = !msg.stats.total;
        if (items.length) {
          persistRound();
        } else {
          // 这轮真的一条都没有：把旧的那批也丢掉，不然刷新一下又冒出来，看着像搜到了
          roundAt = 0;
          clearRound();
        }
        renderRoundNote();
        finish();
        break;
      case 'error':
        setStatus(msg.message, 'err');
        finish();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });

  port.postMessage({ type: 'discover', interests: active, force: !!force });
}

function finish() {
  $('runBtn').disabled = false;
  $('forceBtn').disabled = false;
  if (port) {
    try {
      port.disconnect();
    } catch (_) {}
    port = null;
  }
}

/* ---------------- 转发到飞书群 ---------------- */

function updateFwdBtn() {
  const b = $('fwdBtn');
  if (!b) return;
  b.disabled = !fwdSel.size;
  b.textContent = fwdSel.size ? `转发 ${fwdSel.size} 个到飞书群` : '转发到飞书群';
}

function toFwdItem(it) {
  return {
    full_name: it.full_name,
    one_line: it.one_line || '',
    caution: it.caution || '',
    match: it.match,
    stars: it.stars,
    language: it.language,
    pushed_at: it.pushed_at,
    html_url: it.html_url,
    md: it.md || ''
  };
}

function sendFwd(list, source) {
  if (!list.length) return;
  chrome.runtime.sendMessage({ type: 'feishuSend', items: list, source }, (res) => {
    if (chrome.runtime.lastError) {
      toast('后台没响应，先去扩展页点一次「重新加载」');
      return;
    }
    if (res && res.ok) {
      toast(`已推 ${res.sent} 个到飞书群，去群里看`);
    } else {
      toast((res && res.error) || '推送失败');
    }
  });
}

/* ---------------- 收藏 / 对比 ---------------- */

function favItem(full) {
  return (profile.favorites || []).find((f) => f.full_name === full);
}

function refreshFavCount() {
  $('favCount').textContent = (profile.favorites || []).length || '';
}

function renderFavs() {
  const list = profile.favorites || [];
  refreshFavCount();

  if (!list.length) {
    $('favList').innerHTML = '<div class="empty">还没有收藏。在解读卡右上角点 ☆，或在发现结果上点「收藏」。</div>';
    return;
  }

  $('favList').innerHTML = list
    .map((f) => {
      const lv = f.level || (f.md ? getLevel(f.md) : '');
      const cls = lv === '值得尝试' ? 's8' : lv === '值得关注' ? 's6' : 's5';
      const line = f.one_line || (f.md ? getOneLine(f.md) : '');
      return `<div class="fav">
        <input type="checkbox" data-sel="${esc(f.full_name)}" ${selected.has(f.full_name) ? 'checked' : ''} />
        <div class="fb1">
          <div class="nm2">${esc(f.full_name)}
            ${lv ? `<span class="score ${cls}" style="margin-left:6px">${lv}</span>` : ''}
            ${f.md ? '' : '<span class="meta" style="margin-left:6px">未解读</span>'}
          </div>
          ${line ? `<div class="ln">${esc(plain(line))}</div>` : ''}
          <div class="bt">
            <button data-read="https://github.com/${esc(f.full_name)}#gh-cn-auto">读这篇</button>
            <button data-fwd1="${esc(f.full_name)}">发群</button>
            <button data-unfav="${esc(f.full_name)}">移除</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function renderCompare() {
  const box = $('cmpInline');
  const picked = [...selected].map(favItem).filter(Boolean);

  if (picked.length < 2) {
    box.innerHTML = '<div class="empty">勾满两个，这里直接出对比表。</div>';
    return;
  }

  const rows = [
    ['一句话', (f) => plain(getSection(f.md, '一句话'))],
    ['值不值得', (f) => {
      const lv = f.level || getLevel(f.md);
      const body = plain(getSection(f.md, '值不值得')).replace(/^(值得尝试|值得关注|暂时不值得)\s*/, '');
      return (lv ? '【' + lv + '】' : '') + body;
    }],
    ['能拿来干什么', (f) => plain(getSection(f.md, '能拿来干什么'))],
    ['怎么用', (f) => plain(getSection(f.md, '怎么用'))],
    ['门槛', (f) => plain(getSection(f.md, '门槛'))],
    ['优点', (f) => plain(getSection(f.md, '优点'))],
    ['局限', (f) => plain(getSection(f.md, '局限'))],
    ['不确定', (f) => plain(getSection(f.md, '我不确定的地方'))]
  ];

  let html = '<table class="cmp" style="margin-top:16px">';
  html += '<tr><th>维度</th>' + picked.map((f) => `<th style="width:auto"><a href="https://github.com/${esc(f.full_name)}" target="_blank">${esc(f.full_name)}</a></th>`).join('') + '</tr>';
  for (const [label, fn] of rows) {
    html += '<tr><th>' + label + '</th>';
    for (const f of picked) {
      const v = f.md ? fn(f) : '（还没解读过，点「读这篇」读一遍再收藏）';
      html += '<td>' + esc(v || '—') + '</td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  box.innerHTML = html;
}

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  for (const t of ['discover', 'fav']) {
    $('tab-' + t).hidden = t !== name;
  }
  if (name === 'fav') {
    loadProfile().then((p) => {
      profile = p;
      renderFavs();
      renderCompare();
    });
  }
}

async function addFav(full) {
  const it = items.find((x) => x.full_name === full);
  await new Promise((res) =>
    chrome.runtime.sendMessage(
      {
        type: 'fav',
        op: 'add',
        repo: full,
        one_line: it ? it.one_line : '',
        level: '',
        facts: it ? { stars: it.stars, language: it.language, pushed_at: it.pushed_at } : null
      },
      res
    )
  );
  profile = await loadProfile();
  refreshFavCount();
  renderResults();
  toast('已收藏 ✓ 在「收藏」标签里能找到');
}

async function removeFav(full) {
  await new Promise((res) => chrome.runtime.sendMessage({ type: 'fav', op: 'remove', repo: full }, res));
  selected.delete(full);
  profile = await loadProfile();
  renderFavs();
  renderResults();
}

/* ---------------- 交互 ---------------- */

async function skipRepo(full) {
  const entry = { repo: full, verdict: 'irrelevant', note: '发现页标记不感兴趣', level: '' };
  chrome.runtime.sendMessage({ type: 'feedback', entry }, (res) => {
    if (res && res.ok) toast('记下了，AI 下次判断会带上这条');
  });
  items = items.filter((i) => i.full_name !== full);
  fwdSel.delete(full);
  renderResults();
  persistRound();
  renderRoundNote();
  // 顺手拉黑，60 天内不再出现
  profile.seen = { ...(profile.seen || {}), [full]: Date.now() + 1000 * 60 * 60 * 24 * 60 };
  await saveProfile(profile);
}

function normalizeRepoUrl(raw) {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (m) return 'https://github.com/' + m[1] + '/' + m[2].replace(/\.git$/, '') + '#gh-cn-auto';
  const m2 = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m2) return 'https://github.com/' + m2[1] + '/' + m2[2] + '#gh-cn-auto';
  return null;
}

(async function init() {
  profile = await loadProfile();
  renderChips();

  // 把上一轮的结果接回来。这一条是用户明确骂过的坑：刷新一下就全没了。
  const round = await loadRound();
  if (round) {
    items = round.items;
    planList = round.plan;
    for (const p of planList) plan[p.id] = p.q;
    searchErrors = round.errors;
    lastStats = round.stats;
    roundAt = round.at;
    renderChips();
    renderSearchErrors();
    renderResults();
    renderRoundNote();
    updateFwdBtn();
    $('roundDone').disabled = false;
    setStatus(`接上了 ${roundAge(round.at)}那一轮的 ${items.length} 个结果`, '');
  }

  // 「清掉这批」按钮是渲染时现造的，只能挂在 document 上代理
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('#clearRoundBtn');
    if (!b) return;
    await clearRound();
    items = [];
    roundAt = 0;
    renderResults();
    renderRoundNote();
    setStatus('这批清掉了，点「搜一轮」重新搜。', '');
    toast('已清掉这批结果');
  });

  if (!profile.githubToken) {
    const note = document.createElement('div');
    note.className = 'note';
    note.style.color = 'var(--warn)';
    note.innerHTML =
      '没填 GitHub Token：一轮只搜前 3 个关注点，还可能撞限流。去设置页补一个只读 Token（不需要任何权限），能到 30 次/分钟。';
    document.querySelector('.card').appendChild(note);
  }

  $('chips').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      delInterest(del.dataset.del);
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) toggleInterest(chip.dataset.id);
  });

  $('addBtn').addEventListener('click', addInterest);
  $('runBtn').addEventListener('click', () => startDiscover(false));
  $('forceBtn').addEventListener('click', () => startDiscover(true));

  $('results').addEventListener('click', (e) => {
    const read = e.target.closest('[data-read]');
    if (read) {
      chrome.tabs.create({ url: read.dataset.read });
      // 点开读过 = 看过了，14 天内不再推（30 分钟内重复打开不重复计）
      const item = e.target.closest('.item');
      if (item && item.dataset.full) {
        chrome.runtime.sendMessage({ type: 'markSeen', repo: item.dataset.full });
        toast('已记为"读过"，14 天内不再推');
      }
      return;
    }
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      addFav(fav.dataset.fav);
      return;
    }
    const skip = e.target.closest('[data-skip]');
    if (skip) skipRepo(skip.dataset.skip);
  });

  // 勾「发群」→ 顶部按钮亮起来；全不勾就回到灰的
  $('results').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-fwd]');
    if (!cb) return;
    if (cb.checked) fwdSel.add(cb.dataset.fwd);
    else fwdSel.delete(cb.dataset.fwd);
    cb.closest('.fwd').classList.toggle('on', cb.checked);
    updateFwdBtn();
  });

  $('fwdBtn').addEventListener('click', () => {
    const list = items.filter((i) => fwdSel.has(i.full_name)).map(toFwdItem);
    if (!list.length) return;
    sendFwd(list, 'discover');
    // 发完清勾选，下一批从头勾
    fwdSel.clear();
    document.querySelectorAll('#results [data-fwd]').forEach((cb) => {
      cb.checked = false;
      cb.closest('.fwd').classList.remove('on');
    });
    updateFwdBtn();
  });

  $('roundDone').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'markRoundSeen' }, (res) => {
      if (res && res.ok) {
        toast('记下了，这轮 ' + res.count + ' 个 14 天内不再出现');
        $('roundDone').disabled = true;
      }
    });
  });

  $('clearSeenBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'clearSeen' }, (res) => {
      if (res && res.ok) {
        toast('已清空 ' + res.cleared + ' 条"看过"记录，点「搜一轮」全部重新出现');
        setStatus('看过记录已清零（' + res.cleared + ' 条）。点「搜一轮」全量重搜。', 'ok');
      }
    });
  });

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  $('favList').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-sel]');
    if (!cb) return;
    const full = cb.dataset.sel;
    if (cb.checked) {
      if (selected.size >= 2) {
        cb.checked = false;
        $('favStatus').textContent = '最多勾两个，先取消一个。';
        return;
      }
      selected.add(full);
    } else {
      selected.delete(full);
    }
    $('favStatus').textContent = selected.size
      ? selected.size === 2
        ? '两个齐了，对比表在下面 ↓'
        : '已选 1/2，再勾一个就出对比'
      : '';
    renderCompare();
    if (selected.size === 2) {
      setTimeout(() => $('cmpInline').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }), 100);
    }
  });

  $('favList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-unfav]');
    if (rm) {
      removeFav(rm.dataset.unfav);
      toast('已移出收藏');
      return;
    }
    const fwd1 = e.target.closest('[data-fwd1]');
    if (fwd1) {
      const f = favItem(fwd1.dataset.fwd1);
      if (f) sendFwd([toFwdItem(f)], 'fav');
      return;
    }
    const read = e.target.closest('[data-read]');
    if (read) chrome.tabs.create({ url: read.dataset.read });
  });

  refreshFavCount();

  $('pasteGo').addEventListener('click', () => {
    const url = normalizeRepoUrl($('pasteUrl').value);
    if (!url) {
      setStatus('链接格式不对，贴 github.com/owner/repo 就行', 'err');
      return;
    }
    chrome.tabs.create({ url });
    $('pasteUrl').value = '';
  });
  $('pasteUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('pasteGo').click();
  });
})();
