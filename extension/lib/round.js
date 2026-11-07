// 「发现」页最近一轮的结果要能活过一次刷新。
// 之前只存在内存里：手一抖刷新、或者随手关了标签，刚筛出来的几十个仓库全没了，
// 还得重新花额度搜一遍——这是设计缺陷，不是"用户操作不当"。

const KEY = 'disc:last';
const MAX_ITEMS = 200;

export async function saveRound({ plan, items, errors, stats }) {
  const round = {
    at: Date.now(),
    plan: Array.isArray(plan) ? plan : [],
    items: Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [],
    errors: Array.isArray(errors) ? errors : [],
    stats: stats || null
  };
  await chrome.storage.local.set({ [KEY]: round });
  return round;
}

export async function loadRound() {
  const got = await chrome.storage.local.get(KEY);
  const r = got && got[KEY];
  if (!r || !Array.isArray(r.items) || !r.items.length) return null;
  return {
    at: r.at || 0,
    plan: Array.isArray(r.plan) ? r.plan : [],
    items: r.items,
    errors: Array.isArray(r.errors) ? r.errors : [],
    stats: r.stats || null
  };
}

export async function clearRound() {
  await chrome.storage.local.remove(KEY);
}

export function roundAge(at) {
  if (!at) return '';
  const d = Date.now() - at;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.round(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
  return Math.round(d / 86400e3) + ' 天前';
}
