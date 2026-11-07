// 推送到飞书群自定义机器人。复用 D:\FRONTIER 那个机器人：同一个群、同一个加签方式，
// 这样「早报」和你手动转发的仓库出现在同一个地方，不用再建机器人。
// 加签算法照抄 frontier.py：timestamp+"\n"+secret 当 HMAC-SHA256 的密钥，消息为空，结果 base64。

import { getSection, getLevel, getOneLine, plain } from './cardmd.js';

const MAX_ITEMS = 20;

function kfmt(n) {
  if (n == null) return '';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/* 把任意来源的条目归一成一行：先是一句话，再是提醒 */
function itemLines(it) {
  const out = [];
  const line = it.one_line || (it.md ? plain(getOneLine(it.md)) : '');
  if (line) out.push(plain(line));
  if (it.caution) out.push('⚠ ' + plain(it.caution));
  const md = it.md;
  if (md) {
    const level = it.level || getLevel(md);
    if (level) out.push('结论：**' + level + '** —— ' + plain(getSection(md, '值不值得')).replace(/^(值得尝试|值得关注|暂时不值得)\s*/, '').slice(0, 80));
    const gate = plain(getSection(md, '门槛'));
    if (gate) out.push('门槛：' + gate.slice(0, 80));
  }
  return out;
}

export function buildCard(items, source) {
  const list = (items || []).slice(0, MAX_ITEMS);
  const where = source === 'fav' ? '收藏夹' : '发现页';
  const title = `GitHub 情报 · ${list.length} 个（${where}挑的）`;

  const parts = [];
  for (const it of list) {
    const meta = [it.language, it.pushed_at ? (it.pushed_at + ' 更新') : '']
      .filter(Boolean)
      .join(' · ');
    const head = [
      `**${it.full_name}**`,
      it.match != null ? `匹配 ${it.match}/10` : '',
      it.stars != null ? `★ ${kfmt(it.stars)}` : '',
      meta
    ]
      .filter(Boolean)
      .join('　');
    parts.push(head);
    parts.push(...itemLines(it));
    parts.push(`[打开仓库](${it.html_url || 'https://github.com/' + it.full_name})`);
    parts.push('');
  }
  parts.push(`> 由浏览器扩展「GitHub 中文口语解读」转发，来自${where}。`);

  return { title, markdown: parts.join('\n') };
}

async function sign(secret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(ts + '\n' + secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(0));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return { timestamp: ts, sign: btoa(bin) };
}

/* items 的字段随来源不同，背景层收上来前已归一；这里只管发 */
export async function sendToFeishu({ webhook, secret, items, source, title, markdown }) {
  if (!webhook) {
    return { ok: false, code: 'no-webhook', error: '还没配飞书机器人。去设置页第三步，把 D:\\FRONTIER\\.env 选进来就行。' };
  }

  const card = title || markdown ? { title, markdown } : buildCard(items, source);
  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: card.title }, template: 'green' },
      elements: [{ tag: 'markdown', content: card.markdown }]
    }
  };
  if (secret) Object.assign(payload, await sign(secret));

  let res;
  try {
    res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return { ok: false, error: '连不上飞书（检查网络，或保存设置时有没有允许访问 open.feishu.cn）' };
  }

  let j = {};
  try {
    j = await res.json();
  } catch (_) {}

  if (!res.ok || (j.code && j.code !== 0)) {
    const msg = j.msg || ('HTTP ' + res.status);
    if (/sign|签名/i.test(msg)) {
      return { ok: false, error: '飞书说签名不对：机器人开了加签，但密钥没填对。把 .env 里的 FEISHU_SECRET 重新填一下。' };
    }
    return { ok: false, error: '飞书拒收：' + msg };
  }

  return { ok: true, sent: (items || []).length || 1 };
}
