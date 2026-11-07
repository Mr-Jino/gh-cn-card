import { loadProfile, saveProfile, pushFeedback } from './lib/profile.js';
import { fetchRepoFacts, fetchReadme, fetchEvidence } from './lib/github.js';
import { buildMessages } from './lib/prompt.js';
import { streamChat } from './lib/llm.js';
import { planQueries, searchRepos, scoreBatch } from './lib/discover.js';
import { sendToFeishu } from './lib/feishu.js';

const CACHE_PREFIX = 'c:';
const CACHE_MAX = 200;

function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch (_) {
    // 端口已关，用户关了抽屉，正常情况
  }
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const cards = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (cards.length <= CACHE_MAX) return;
  cards
    .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0))
    .slice(0, cards.length - CACHE_MAX)
    .forEach((k) => chrome.storage.local.remove(k));
}

/* 只把"依据"摘要递给卡片，别把整份 issue 列表塞进消息里 */
function summariseEvidence(ev) {
  if (!ev) return null;
  return {
    releases: (ev.releases || []).length,
    lastTag: (ev.releases || [])[0]?.tag || '',
    lastAt: (ev.releases || [])[0]?.at || '',
    issues: (ev.issues || []).length,
    issueTitles: (ev.issues || []).slice(0, 3).map((i) => i.title),
    manifest: (ev.manifest && ev.manifest.name) || ''
  };
}

async function run(port, msg, signal) {
  const profile = await loadProfile();

  if (!profile.apiKey) {
    post(port, {
      type: 'error',
      code: 'no-key',
      message: '还没填 API Key。点右上角齿轮，或者用仓库页那个按钮旁边的设置。填一次就行。'
    });
    return;
  }

  post(port, { type: 'status', text: '在读仓库信息…' });
  // 先只拿元数据：缓存键由它决定，命中就不再去抓 README 和证据，省额度
  const facts = await fetchRepoFacts(msg.owner, msg.repo, profile.githubToken);
  post(port, { type: 'facts', facts });

  const cacheKey = CACHE_PREFIX + facts.full_name + ':' + facts.pushed_at;

  if (!msg.force) {
    const hit = await chrome.storage.local.get(cacheKey);
    if (hit[cacheKey]) {
      // 缓存也得带上「依据」，否则二次打开时卡片底部那行会凭空消失
      post(port, { type: 'evidence', ev: hit[cacheKey].ev || null });
      post(port, {
        type: 'cached',
        markdown: hit[cacheKey].md,
        at: hit[cacheKey].at,
        facts
      });
      return;
    }
  }

  post(port, { type: 'status', text: '在读 README，顺便查发版、issue、依赖…' });
  const [readme, evidence] = await Promise.all([
    fetchReadme(msg.owner, msg.repo, profile.githubToken),
    fetchEvidence(msg.owner, msg.repo, profile.githubToken)
  ]);
  const bundle = { facts, readme, evidence };
  const ev = summariseEvidence(evidence);

  post(port, { type: 'evidence', ev });
  post(port, { type: 'status', text: 'AI 在读材料，先出第一句…' });

  const messages = buildMessages(bundle, profile);
  let full = '';

  await streamChat({
    apiBase: profile.apiBase,
    apiKey: profile.apiKey,
    model: profile.model,
    messages,
    signal,
    onDelta: (delta) => {
      full += delta;
      post(port, { type: 'delta', text: delta });
    }
  });

  if (full.trim()) {
    await chrome.storage.local.set({
      [cacheKey]: { md: full, at: Date.now(), facts, ev }
    });
    pruneCache();
  }

  post(port, { type: 'done', chars: full.length });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'gh-card') {
    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'start') {
        run(port, msg, controller.signal).catch((err) => {
          if (err.name === 'AbortError') return;
          post(port, { type: 'error', message: err.message || String(err) });
        });
      }
    });
    return;
  }

  if (port.name === 'gh-discover') {
    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'discover') {
        runDiscover(port, msg, controller.signal).catch((err) => {
          if (err.name === 'AbortError') return;
          post(port, { type: 'error', message: err.message || String(err) });
        });
      }
    });
  }
});

/* ---------------- 发现：中文意图 → 搜索结果中文化 ---------------- */

async function runDiscover(port, msg, signal) {
  const profile = await loadProfile();

  if (!profile.apiKey) {
    post(port, { type: 'error', code: 'no-key', message: '还没填 API Key，去设置页填一下。' });
    return;
  }

  const interests = (msg.interests || profile.interests || []).filter((i) => i.enabled !== false && i.intent);
  if (!interests.length) {
    post(port, { type: 'error', message: '至少打开一个关注点，不然不知道搜什么。' });
    return;
  }

  // 搜索接口限额很紧：没填 Token 只有 10 次/分钟，这轮最多搜 3 个关注点
  const noToken = !profile.githubToken;
  const capped = noToken ? interests.slice(0, 3) : interests;
  if (noToken && interests.length > 3) {
    post(port, { type: 'stage', text: '没填 GitHub Token，这轮只搜前 3 个关注点（避免撞限流）…' });
  }

  post(port, { type: 'stage', text: '把你的关注点翻译成 GitHub 搜索词…' });
  let plan;
  try {
    plan = await planQueries(profile, capped, signal);
  } catch (e) {
    post(port, { type: 'error', message: e.message });
    return;
  }
  if (!plan.length) {
    post(port, { type: 'error', message: '搜索词没生成出来，重试一次。' });
    return;
  }
  post(port, { type: 'plan', plan });

  const seen = msg.force ? {} : profile.seen || {};
  const cut = Date.now() - 1000 * 60 * 60 * 24 * 14;
  const seenNames = new Set(
    Object.entries(seen)
      .filter(([, t]) => t > cut)
      .map(([k]) => k)
  );
  // 已收藏的不再重复推荐
  const favNames = new Set((profile.favorites || []).map((f) => f.full_name));

  const pool = [];
  const got = new Set();

  for (const p of plan) {
    post(port, { type: 'stage', text: `搜「${p.name}」：${p.q}` });
    try {
      const items = await searchRepos(p.q, profile.githubToken, signal);
      post(port, { type: 'searched', id: p.id, q: p.q, count: items.length });
      for (const it of items) {
        if (got.has(it.full_name)) continue;
        if (seenNames.has(it.full_name)) continue;
        if (favNames.has(it.full_name)) continue;
        got.add(it.full_name);
        pool.push({ ...it, interest_id: p.id, interest_name: p.name });
      }
    } catch (e) {
      post(port, { type: 'searched', id: p.id, q: p.q, count: 0, error: e.message });
    }
    if (pool.length >= 64) break;
    if (noToken) await new Promise((r) => setTimeout(r, 1500));
  }

  if (!pool.length) {
    post(port, {
      type: 'done',
      stats: { total: 0, kept: 0, note: '这一轮没有新仓库——都在"看过的"或收藏里。想全部捞出来，点「把看过的也捞出来重搜」。' }
    });
    return;
  }

  post(port, { type: 'stage', text: `筛 ${pool.length} 个结果，翻成中文…` });

  const CHUNK = 14;
  let kept = 0;

  for (let i = 0; i < pool.length; i += CHUNK) {
    const chunk = pool.slice(i, i + CHUNK);
    let scored = [];
    try {
      scored = await scoreBatch(profile, capped, chunk, signal);
    } catch (e) {
      post(port, { type: 'error', message: '筛选这一步失败了：' + e.message });
      return;
    }
    const good = scored.filter((x) => x.match >= 5);
    kept += good.length;
    post(port, { type: 'batch', items: good, done: Math.min(i + CHUNK, pool.length), total: pool.length });
  }

  // 注意：搜出来 ≠ 看过。只有你点了「不感兴趣」、收藏、或打开读过，才会进"看过的"。
  const p2 = await loadProfile();
  p2.lastRound = pool.map((x) => x.full_name);
  await saveProfile(p2);

  post(port, {
    type: 'done',
    stats: { total: pool.length, kept, note: kept ? '' : '这一轮没有够格的，换个说法或放宽关注点试试。' }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'feedback') {
    pushFeedback(msg.entry)
      .then((n) => sendResponse({ ok: true, count: n }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === 'clearCache') {
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
      chrome.storage.local.remove(keys).then(() => sendResponse({ ok: true, removed: keys.length }));
    });
    return true;
  }

  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'openDiscover') {
    chrome.tabs.create({ url: chrome.runtime.getURL('search.html') });
    sendResponse({ ok: true });
    return false;
  }

  // 清空"看过"记录（之前有 bug 把没读过的也标了，用这个一键找回）
  if (msg?.type === 'clearSeen') {
    (async () => {
      const p = await loadProfile();
      const n = Object.keys(p.seen || {}).length;
      p.seen = {};
      p.lastRound = [];
      await saveProfile(p);
      sendResponse({ ok: true, cleared: n });
    })();
    return true;
  }

  // 标记某个仓库"我看过了"（点开读过 → 14 天内不再推）
  if (msg?.type === 'markSeen') {
    (async () => {
      const p = await loadProfile();
      p.seen = { ...(p.seen || {}), [msg.repo]: Date.now() };
      await saveProfile(p);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // 一轮刷完了，把这一轮的所有条目标成"看过"（14 天内不再推）
  if (msg?.type === 'markRoundSeen') {
    (async () => {
      const p = await loadProfile();
      const names = p.lastRound || [];
      const now = Date.now();
      p.seen = { ...(p.seen || {}) };
      names.forEach((n) => (p.seen[n] = now));
      await saveProfile(p);
      sendResponse({ ok: true, count: names.length });
    })();
    return true;
  }

  // 收藏：op = toggle | add | remove
  if (msg?.type === 'fav') {
    (async () => {
      const p = await loadProfile();
      const full = msg.repo;
      if (!full) {
        sendResponse({ ok: false, error: '没有仓库名' });
        return;
      }
      const i = p.favorites.findIndex((f) => f.full_name === full);
      const op = msg.op || 'toggle';

      if (op === 'remove' || (op === 'toggle' && i >= 0)) {
        if (i >= 0) p.favorites.splice(i, 1);
        await saveProfile(p);
        sendResponse({ ok: true, saved: false, count: p.favorites.length });
        return;
      }

      const entry = {
        full_name: full,
        at: Date.now(),
        level: msg.level || '',
        one_line: msg.one_line || '',
        md: msg.md || '',
        facts: msg.facts || null
      };
      if (i >= 0) {
        const old = p.favorites[i];
        p.favorites[i] = {
          ...old,
          ...entry,
          md: entry.md || old.md,
          one_line: entry.one_line || old.one_line,
          level: entry.level || old.level
        };
      } else {
        p.favorites.unshift(entry);
      }
      await saveProfile(p);
      sendResponse({ ok: true, saved: true, count: p.favorites.length });
    })();
    return true;
  }

  // 转发到飞书情报群（勾选的发现结果 / 收藏条目）
  if (msg?.type === 'feishuSend') {
    (async () => {
      const p = await loadProfile();
      const res = await sendToFeishu({
        webhook: p.feishuWebhook,
        secret: p.feishuSecret,
        items: msg.items || [],
        source: msg.source || 'discover'
      });
      sendResponse(res);
    })().catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }

  // 设置页的「测一条」：往群里发一句话，确认机器人和加签都对
  if (msg?.type === 'feishuTest') {
    (async () => {
      const p = await loadProfile();
      const res = await sendToFeishu({
        webhook: p.feishuWebhook,
        secret: p.feishuSecret,
        title: '测试：通道通了',
        markdown: '浏览器扩展「GitHub 中文口语解读」配好了。以后你在发现页勾中的仓库，会像这样推到这个群。',
        items: [],
        source: 'test'
      });
      sendResponse(res);
    })().catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }

  if (msg?.type === 'test') {
    loadProfile()
      .then(async (profile) => {
        if (!profile.apiKey) throw new Error('还没填 API Key');
        let got = '';
        await streamChat({
          apiBase: profile.apiBase,
          apiKey: profile.apiKey,
          model: profile.model,
          messages: [{ role: 'user', content: '只回复两个字：通了' }],
          onDelta: (d) => (got += d)
        });
        sendResponse({ ok: true, reply: got.trim().slice(0, 40) });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('search.html') });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
