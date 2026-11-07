// 发现层：中文意图 → GitHub 搜索 query → 结果中文化 + 匹配度打分
// 关键取舍：不让用户学 GitHub 搜索语法，也不让他啃英文描述。
// 两段漏斗：批量筛（便宜，只看元数据）→ 单条深读（贵，读 README，复用解读卡）。

import { streamChat } from './llm.js';

const API = 'https://api.github.com';

function ghHeaders(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

async function complete(profile, messages, signal, temperature = 0.2) {
  let out = '';
  await streamChat({
    apiBase: profile.apiBase,
    apiKey: profile.apiKey,
    model: profile.model,
    messages,
    signal,
    temperature,
    onDelta: (d) => (out += d)
  });
  return out;
}

export function parseJsonLoose(text) {
  const s = String(text).replace(/^\uFEFF/, '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('模型没有返回 JSON');
  const open = body[start];
  const close = open === '[' ? ']' : '}';
  const end = body.lastIndexOf(close);
  const slice = body.slice(start, end + 1);
  return JSON.parse(slice);
}

/* ---------- 第一步：把中文关注点翻译成搜索 query ---------- */

export async function planQueries(profile, interests, signal) {
  const list = interests
    .map((i) => `- id: ${i.id}\n  名称：${i.name}\n  想知道什么：${i.intent}`)
    .join('\n');

  const sys = `你把中文的"我想找什么样的开源工具"翻译成 GitHub 仓库搜索 query。

最关键的规则：GitHub 搜索是 AND 语义——空格隔开的词必须全部同时出现。所以：
1. 只写 2-3 组概念，组内用 OR 连接同义词，组之间用空格。
   正确：pdf OR docx OR xlsx convert OR extract in:description
   错误：pdf docx xlsx convert extract batch table tool（这样一条都搜不到）
2. 关键词一律英文，中文在 GitHub 上几乎搜不到。
3. 加限定符 in:name,description 提升精度；stars:>30 过滤玩具项目（别设太高，会把小众好项目筛掉）。
4. 不要限定 language，除非用户明确说了语言。
5. 不要用引号包住整句。

只输出 JSON 数组，不要解释，不要 markdown 代码块：
[{"id":"原样返回","q":"英文 query"}]`;

  const user = `关注点：\n${list}\n\n现在输出 JSON。`;
  const raw = await complete(profile, [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], signal, 0.1);

  let arr;
  try {
    arr = parseJsonLoose(raw);
  } catch (e) {
    throw new Error('搜索词生成失败：' + e.message);
  }
  if (!Array.isArray(arr)) throw new Error('搜索词生成失败：返回格式不对');

  const byId = new Map(interests.map((i) => [i.id, i]));
  return arr
    .filter((x) => x && x.q)
    .map((x) => {
      const it = byId.get(x.id) || interests[0];
      return { id: it ? it.id : x.id, name: it ? it.name : x.id, q: String(x.q).trim() };
    });
}

/* ---------- 第二步：真去 GitHub 搜 ---------- */

const SINCE = () => {
  const d = new Date(Date.now() - 1000 * 60 * 60 * 24 * 540);
  return d.toISOString().slice(0, 10);
};

export async function searchRepos(query, token, signal, perPage = 20) {
  const q = /pushed:/.test(query) ? query : query + ' pushed:>' + SINCE();
  let items = await once(q, token, signal, perPage);

  // 兜底：0 条说明词太窄（GitHub 是 AND 语义），退一步用前两个核心词重搜
  if (!items.length) {
    const bare = query
      .replace(/\b(in|stars|pushed|language|topic|size):\S+/gi, '')
      .trim();
    const words = bare.split(/\s+/).filter((w) => w && w.toUpperCase() !== 'OR');
    const simple = words.slice(0, 3).join(' ');
    if (simple && simple !== query) {
      items = await once(simple + ' pushed:>' + SINCE(), token, signal, perPage);
    }
  }

  return items;
}

async function once(q, token, signal, perPage) {
  const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, { headers: ghHeaders(token), signal });

  if (!res.ok) {
    if (res.status === 403 || res.status === 422) {
      const remain = res.headers.get('x-ratelimit-remaining');
      if (remain === '0') {
        throw new Error('GitHub 搜索接口限流了（没填 Token 只有 10 次/分钟）。去设置页填个只读 Token。');
      }
      throw new Error('GitHub 搜索被拒（' + res.status + '）：' + q);
    }
    if (res.status === 401) throw new Error('GitHub Token 无效，去设置页重填或清空。');
    throw new Error('GitHub 搜索返回 ' + res.status);
  }

  const j = await res.json();
  return (j.items || []).map((r) => ({
    full_name: r.full_name,
    description: r.description || '',
    language: r.language || '',
    stars: r.stargazers_count ?? 0,
    pushed_at: (r.pushed_at || '').slice(0, 10),
    topics: (r.topics || []).slice(0, 6),
    html_url: r.html_url,
    archived: !!r.archived
  }));
}

/* ---------- 第三步：批量中文化 + 打分 ---------- */

export async function scoreBatch(profile, interests, repos, signal) {
  const interestText = interests
    .map((i) => `- [${i.id}] ${i.name}：${i.intent}`)
    .join('\n');

  const cand = repos.map((r) => ({
    full_name: r.full_name,
    desc: r.description.slice(0, 220),
    lang: r.language,
    stars: r.stars,
    updated: r.pushed_at,
    topics: r.topics,
    archived: r.archived
  }));

  const sys = `你在替一个中文用户筛选 GitHub 搜索结果。他对英文不敏感，所以每条必须用中文讲明白。

打分标准（0-10）：
- 8-10：直接能落到他关注点的某个具体动作上，且看起来是真在用的项目
- 6-7：方向沾边，或不确定但值得点开看看
- 3-5：沾一点边，但更像别人的玩具/课程作业/大厂内部工具开源
- 0-2：只是关键词撞上了

降分情况：README 描述只有一句话、明显是 demo、两年没更新、archived、只支持某个他用不上的平台、必须付费订阅。

每条输出：
{"full_name":"原样","one_line":"30 字以内中文，说清它替人干什么，禁止照搬英文描述","match":0-10,"interest_id":"最匹配的关注点 id","interest_name":"对应名称","caution":"一句提醒：门槛/停维护/要钱/只是 demo；没有就空字符串"}

只输出 JSON 数组，不要解释，不要代码块包裹。`;

  const user = `关注点：\n${interestText}\n\n候选仓库：\n${JSON.stringify(cand, null, 1)}\n\n现在输出 JSON。`;
  const raw = await complete(profile, [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], signal, 0.3);

  let arr;
  try {
    arr = parseJsonLoose(raw);
  } catch (e) {
    return repos.map((r) => ({
      full_name: r.full_name,
      one_line: r.description.slice(0, 60) || '（无描述）',
      match: 5,
      interest_id: '',
      interest_name: '',
      caution: '模型解析失败，这条没翻译',
      stars: r.stars,
      language: r.language,
      pushed_at: r.pushed_at,
      html_url: r.html_url
    }));
  }

  const byName = new Map(repos.map((r) => [r.full_name, r]));
  return arr
    .filter((x) => x && x.full_name && byName.has(x.full_name))
    .map((x) => {
      const src = byName.get(x.full_name);
      return {
        full_name: x.full_name,
        one_line: String(x.one_line || '').slice(0, 80),
        match: Math.max(0, Math.min(10, Number(x.match) || 0)),
        interest_id: x.interest_id || '',
        interest_name: x.interest_name || '',
        caution: x.caution || '',
        stars: src.stars,
        language: src.language,
        pushed_at: src.pushed_at,
        html_url: src.html_url
      };
    });
}
