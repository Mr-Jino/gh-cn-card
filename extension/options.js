import { loadProfile, saveProfile, DEFAULT_PROFILE } from './lib/profile.js';

const $ = (id) => document.getElementById(id);
const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);

let profile = null;

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

function fill(p) {
  $('apiBase').value = p.apiBase;
  $('model').value = p.model;
  $('apiKey').value = p.apiKey;
  $('githubToken').value = p.githubToken;
  $('feishuWebhook').value = p.feishuWebhook || '';
  $('feishuSecret').value = p.feishuSecret || '';
  $('directions').value = p.directions.join('\n');
  $('backupDirections').value = p.backupDirections.join('\n');
  $('vetoes').value = p.vetoes.join('\n');

  const fb = p.feedback || [];
  if (!fb.length) {
    $('fbStats').textContent = '还没有记录。在解读卡底部点「有用 / 没用 / 跟我无关」，这里会累积，并回灌进下次判断。';
  } else {
    const useful = fb.filter((f) => f.verdict === 'useful').length;
    const useless = fb.filter((f) => f.verdict === 'useless').length;
    const irr = fb.filter((f) => f.verdict === 'irrelevant').length;
    const last = fb.slice(-5).map((f) => {
      const tag = f.verdict === 'useful' ? '有用' : f.verdict === 'useless' ? '没用' : '无关';
      return `${f.repo}（${tag}${f.note ? '：' + f.note : ''}）`;
    });
    $('fbStats').innerHTML =
      `共 ${fb.length} 条 · 有用 ${useful} / 没用 ${useless} / 无关 ${irr}<br><br>最近几条：<br>` +
      last.map((s) => '· ' + s).join('<br>');
  }
}

async function ensureHostPermission(apiBase) {
  let origin;
  try {
    origin = new URL(apiBase).origin + '/*';
  } catch (_) {
    throw new Error('接口地址格式不对，要像 https://api.deepseek.com/v1 这样');
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('你拒绝了访问 ' + origin + ' 的授权，这样连不上模型。重新点一次保存，选「允许」。');
  return true;
}

function collectFromForm() {
  return {
    ...profile,
    apiBase: $('apiBase').value.trim() || DEFAULT_PROFILE.apiBase,
    model: $('model').value.trim() || DEFAULT_PROFILE.model,
    apiKey: $('apiKey').value.trim(),
    githubToken: $('githubToken').value.trim(),
    feishuWebhook: $('feishuWebhook').value.trim(),
    feishuSecret: $('feishuSecret').value.trim(),
    directions: lines($('directions').value),
    backupDirections: lines($('backupDirections').value),
    vetoes: lines($('vetoes').value)
  };
}

async function onSave() {
  const next = collectFromForm();

  try {
    if (next.apiKey) await ensureHostPermission(next.apiBase);
    // 飞书机器人是另一个域名，同样得经过一次「允许」才能从后台发请求
    if (next.feishuWebhook) await ensureHostPermission(next.feishuWebhook);
  } catch (e) {
    setStatus(e.message, 'err');
    return;
  }

  await saveProfile(next);
  profile = next;
  setStatus('已保存。回 GitHub 页面刷新一下就能用。', 'ok');
}

/* 你在页面上打字，改动自动保存，不用再滚到最底下找保存按钮 */
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  setStatus('改动保存中…');
  autoSaveTimer = setTimeout(async () => {
    const next = collectFromForm();
    await saveProfile(next);
    profile = next;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setStatus('✓ 已自动保存 ' + t + '（接口授权仍要点一次「保存全部改动」）', 'ok');
  }, 900);
}

const AUTO_SAVE_FIELDS = ['directions', 'backupDirections', 'vetoes', 'githubToken'];
const MANUAL_SAVE_FIELDS = ['apiBase', 'model', 'apiKey', 'feishuWebhook', 'feishuSecret'];

async function onTest() {
  setStatus('正在连…');
  const next = {
    apiBase: $('apiBase').value.trim() || DEFAULT_PROFILE.apiBase,
    model: $('model').value.trim() || DEFAULT_PROFILE.model,
    apiKey: $('apiKey').value.trim()
  };
  if (!next.apiKey) {
    setStatus('先填 API Key', 'err');
    return;
  }
  try {
    await ensureHostPermission(next.apiBase);
  } catch (e) {
    setStatus(e.message, 'err');
    return;
  }
  await saveProfile({ ...profile, ...next });
  profile = { ...profile, ...next };

  chrome.runtime.sendMessage({ type: 'test' }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus('后台没响应，重新加载扩展试试', 'err');
      return;
    }
    if (res?.ok) setStatus('通了，模型回了：' + (res.reply || '（空）'), 'ok');
    else setStatus(res?.error || '连不上', 'err');
  });
}

function onClear() {
  chrome.runtime.sendMessage({ type: 'clearCache' }, (res) => {
    if (res?.ok) setStatus('清掉了 ' + res.removed + ' 份缓存', 'ok');
    else setStatus('清缓存失败', 'err');
  });
}

function onExportFb() {
  const fb = profile.feedback || [];
  const status = $('fbExportStatus');
  if (!fb.length) {
    status.textContent = '还没有记录，先去仓库卡上点几下。';
    return;
  }
  const tag = { useful: '有用', useless: '没用', irrelevant: '跟我无关' };
  const lines = [
    '# GitHub 中文口语解读 · 反馈记录',
    '',
    '导出时间：' + new Date().toLocaleString('zh-CN'),
    '共 ' + fb.length + ' 条。有用 ' + fb.filter((f) => f.verdict === 'useful').length +
      ' / 没用 ' + fb.filter((f) => f.verdict === 'useless').length +
      ' / 跟我无关 ' + fb.filter((f) => f.verdict === 'irrelevant').length,
    '',
    '| 时间 | 仓库 | 判定 | 我的判断 | 原因 |',
    '|---|---|---|---|---|'
  ];
  for (const f of [...fb].reverse()) {
    const t = new Date(f.at).toLocaleDateString('zh-CN');
    lines.push('| ' + t + ' | ' + f.repo + ' | ' + (tag[f.verdict] || f.verdict) + ' | ' + (f.level || '-') + ' | ' + (f.note || '') + ' |');
  }
  download('gh-card-feedback.md', lines.join('\n'));
  status.textContent = '已下载到你的下载文件夹。';
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 和 FRONTIER 打通 ---------------- */

async function onImportFiles(files) {
  const st = $('syncStatus');
  if (!files || !files.length) return;
  st.textContent = '读取中…';

  let dirsMain = null;
  let dirsBackup = null;
  const newVeto = [];

  for (const f of files) {
    const text = await f.text();
    if (f.name.toLowerCase().endsWith('.env')) {
      const env = parseEnv(text);
      if (env.FEISHU_WEBHOOK) $('feishuWebhook').value = env.FEISHU_WEBHOOK;
      if (env.FEISHU_SECRET) $('feishuSecret').value = env.FEISHU_SECRET;
      continue;
    }
    if (f.name.toLowerCase().endsWith('.json')) {
      try {
        const j = JSON.parse(text);
        if (j.directions && Array.isArray(j.directions.main)) dirsMain = j.directions.main;
        if (j.directions && Array.isArray(j.directions.backup)) dirsBackup = j.directions.backup;
      } catch (e) {
        st.textContent = 'config.json 解析失败：' + e.message;
        return;
      }
    } else {
      for (const raw of text.split('\n')) {
        const s = raw.trim();
        if (!s.startsWith('-') || s.length < 4) continue;
        newVeto.push(s.replace(/^-\s*/, ''));
      }
    }
  }

  if (dirsMain) $('directions').value = dirsMain.join('\n');
  if (dirsBackup) $('backupDirections').value = dirsBackup.join('\n');

  if (newVeto.length) {
    const exist = lines($('vetoes').value);
    const merged = [...exist];
    for (const v of newVeto) if (!merged.includes(v)) merged.push(v);
    $('vetoes').value = merged.join('\n');
  }

  await onSave();
  st.textContent =
    '导入完成：主方向 ' + (dirsMain ? dirsMain.length : '未变') +
    ' 条，否决规则合并后 ' + lines($('vetoes').value).length + ' 条' +
    ($('feishuWebhook').value ? '，飞书机器人已配好' : '') + '。';
}

function onExportFrontier() {
  const st = $('syncStatus');
  const fb = (profile.feedback || []).filter((f) => f.verdict !== 'useful');
  const lines = [];
  for (const f of fb) {
    const why = f.note ? f.note : '已判定没用（扩展里标记）';
    lines.push('- ' + f.repo + ' — ' + why);
  }
  if (!lines.length) {
    st.textContent = '还没有"没用/无关"的记录可导出。';
    return;
  }
  download('frontier-feedback.txt', lines.join('\n') + '\n');
  st.textContent = '已下载 frontier-feedback.txt（' + lines.length + ' 行），追加到 D:\\FRONTIER\\feedback.txt 末尾即可。';
}

/* .env 里只认 FEISHU_ 开头的两行，别的读进来也不碰 */
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(FEISHU_[A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function onFeishuTest() {
  const st = $('feishuStatus');
  st.textContent = '正在发…';

  const next = collectFromForm();
  if (!next.feishuWebhook) {
    st.textContent = '先填机器人 Webhook，或者把 D:\\FRONTIER\\.env 选进来。';
    return;
  }

  saveProfile(next)
    .then(() => ensureHostPermission(next.feishuWebhook))
    .then(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'feishuTest' }, (res) => {
            if (chrome.runtime.lastError) {
              st.textContent = '后台没响应，去 edge://extensions 点一次「重新加载」。';
            } else if (res?.ok) {
              st.textContent = '发出去了。去飞书群看一眼，收到就说明机器人和加签都配对了。';
            } else {
              st.textContent = res?.error || '发送失败';
            }
            resolve();
          });
        })
    )
    .catch((e) => {
      st.textContent = e.message;
    });
}

(async function init() {
  profile = await loadProfile();
  fill(profile);

  $('save').addEventListener('click', onSave);
  $('test').addEventListener('click', onTest);
  $('clear').addEventListener('click', onClear);
  $('exportFb').addEventListener('click', onExportFb);
  $('exportFrontier').addEventListener('click', onExportFrontier);
  $('importFiles').addEventListener('change', (e) => onImportFiles(e.target.files));
  $('feishuTest').addEventListener('click', onFeishuTest);

  // 口味、Token 这类改动自动保存；接口地址和 Key 涉及授权，仍走「保存全部改动」
  AUTO_SAVE_FIELDS.forEach((id) => $(id).addEventListener('input', scheduleAutoSave));
  MANUAL_SAVE_FIELDS.forEach((id) => $(id).addEventListener('input', () => setStatus('改完点下面的「保存全部改动」才会生效')));
})();
