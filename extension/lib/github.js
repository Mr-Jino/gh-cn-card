// 取数层：元数据走 GitHub API，README 走 /readme 接口拿纯文本
// 原则：能由程序确认的事实，绝不让模型猜。

const API = 'https://api.github.com';

function ghHeaders(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

function friendlyError(status, headers) {
  if (status === 404) {
    return '这个仓库不存在，或者它是私有的（私有库要在设置里填 GitHub Token）';
  }
  if (status === 403 || status === 429) {
    const remain = headers.get('x-ratelimit-remaining');
    if (remain === '0') {
      return 'GitHub 接口限流了（没登录每小时只有 60 次）。去设置里填一个只读 Token，能提到 5000 次/小时。';
    }
    return 'GitHub 拒绝了这次请求（' + status + '），可能是 Token 权限不够。';
  }
  return 'GitHub 接口返回 ' + status;
}

function cleanReadme(md) {
  return md
    .replace(/\r\n/g, '\n')
    // 徽章、图片、超长 HTML 对理解毫无帮助，纯烧 token
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<a [^>]*>\s*<\/a>/gi, '')
    .replace(/<[^>]{100,}>/g, '')
    .replace(/^\s*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// README 超长时：留开头 + 抽安装/用法相关章节，砍到 ~18k 字符
function trimReadme(md) {
  const LIMIT = 18000;
  if (md.length <= LIMIT) return md;

  const head = md.slice(0, 11000);
  const kw = /(install|quick ?start|getting started|usage|setup|deploy|配置|用法|安装|快速开始|使用|部署|上手)/i;

  const lines = md.split('\n');
  const picked = [];
  let keep = false;
  let budget = 7000;

  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) keep = kw.test(line);
    if (keep && budget > 0) {
      picked.push(line);
      budget -= line.length + 1;
    }
  }

  const tail = picked.length ? '\n\n……（中间省略）……\n\n' + picked.join('\n') : '';
  return head + tail;
}

export async function fetchReadme(owner, repo, token) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/readme`, {
    headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw' }
  });
  if (!res.ok) return '';
  const text = await res.text();
  return trimReadme(cleanReadme(text));
}

/* ---------------- 硬事实：发版节奏 / 真实 issue / 依赖清单 ----------------
   为什么加这一层：只读 README 的话，「门槛」和「局限」两节永远在复读作者的宣传语——
   README 不会告诉你"这个项目两年没发版"、"合并单元格会错行"、"其实要装 4G 的依赖"。
   这些都能从接口里查到，让模型引用事实，比让它猜强一个量级。 */

const MANIFESTS = [
  'requirements.txt',
  'pyproject.toml',
  'package.json',
  'environment.yml',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'setup.py',
  'Dockerfile',
  'docker-compose.yml',
  'pom.xml',
  'build.gradle'
];

async function getJson(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

// raw.githubusercontent 不占 API 额度，所以内容尽量从这里取
async function getText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    return await res.text();
  } catch (_) {
    return '';
  }
}

export async function fetchEvidence(owner, repo, token) {
  const base = `${API}/repos/${owner}/${repo}`;
  const h = ghHeaders(token);

  const [releases, issues, root] = await Promise.all([
    getJson(`${base}/releases?per_page=4`, h),
    getJson(`${base}/issues?state=open&sort=comments&direction=desc&per_page=10`, h),
    getJson(`${base}/contents/`, h)
  ]);

  const ev = {
    releases: (releases || [])
      .filter((r) => r && r.tag_name && !r.draft)
      .slice(0, 3)
      .map((r) => ({
        tag: r.tag_name,
        at: (r.published_at || r.created_at || '').slice(0, 10)
      })),

    // issues 接口会把 PR 也混进来，必须排掉，否则「局限」会拿 PR 标题当用户抱怨
    issues: (issues || [])
      .filter((i) => i && !i.pull_request && i.title)
      .slice(0, 6)
      .map((i) => ({
        title: String(i.title).slice(0, 140),
        comments: i.comments || 0,
        at: (i.created_at || '').slice(0, 10)
      })),

    manifest: null
  };

  // 根目录清单 → 找依赖/运行文件 → 取前 1200 字（raw 不占额度）
  if (Array.isArray(root)) {
    const names = root.filter((f) => f && f.type === 'file').map((f) => f.name);
    const hit = MANIFESTS.find((m) => names.includes(m));
    if (hit) {
      const file = root.find((f) => f.name === hit);
      const url = file && file.download_url;
      const text = url ? await getText(url) : '';
      if (text.trim()) {
        ev.manifest = { name: hit, sample: text.slice(0, 1200) };
      } else {
        ev.manifest = { name: hit, sample: '' };
      }
    }
    ev.rootFiles = names.slice(0, 40);
  }

  return ev;
}

export async function fetchRepoFacts(owner, repo, token) {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(friendlyError(res.status, res.headers));

  const j = await res.json();

  return {
    full_name: j.full_name,
    description: j.description || '',
    language: j.language || '',
    stars: j.stargazers_count ?? 0,
    forks: j.forks_count ?? 0,
    license: j.license?.spdx_id || '未标注',
    pushed_at: (j.pushed_at || '').slice(0, 10),
    created_at: (j.created_at || '').slice(0, 10),
    archived: !!j.archived,
    homepage: j.homepage || '',
    topics: (j.topics || []).slice(0, 8).join(', '),
    open_issues: j.open_issues_count ?? 0,
    default_branch: j.default_branch || 'main',
    html_url: j.html_url
  };
}

export async function fetchRepoBundle(owner, repo, token) {
  const facts = await fetchRepoFacts(owner, repo, token);
  const [readme, evidence] = await Promise.all([
    fetchReadme(owner, repo, token),
    fetchEvidence(owner, repo, token)
  ]);
  return { facts, readme, evidence };
}
