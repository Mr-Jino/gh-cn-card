/* 抽屉的样式表 + 纯函数（无状态、无副作用）。
   拆出来的原因：这些占了 content.js 近两百行，而且从不参与状态流转。
   混在七百多行里找一处样式要翻半天，改错一层就出过「最小化后角标消失」那类事故。 */

window.__ghCnKit = (() => {
  const CSS = `:host{all:initial;}
*{box-sizing:border-box;margin:0;padding:0;}
.wrap{position:absolute;inset:0;display:flex;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
.panel{position:relative;width:100%;display:flex;flex-direction:column;background:var(--bg);color:var(--t1);
  border-left:1px solid var(--line);overflow:hidden;}
.grip{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:5;}
.grip:hover{background:var(--accent);opacity:.45;}
.bubble{position:absolute;right:18px;bottom:18px;width:46px;height:46px;border-radius:50%;background:#1f6feb;color:#fff;
  display:none;align-items:center;justify-content:center;font-size:17px;font-weight:500;cursor:pointer;
  box-shadow:0 4px 16px rgba(0,0,0,.5);user-select:none;z-index:6;}
.bubble:hover{transform:scale(1.07);}
.dark{--bg:#0d1117;--panel:#161b22;--line:#30363d;--t1:#e6edf3;--t2:#9198a1;--t3:#6e7681;
  --accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--mute:#8b949e;--chip:#21262d;--sel:#1f6feb22;}
.light{--bg:#ffffff;--panel:#f6f8fa;--line:#d0d7de;--t1:#1f2328;--t2:#59636e;--t3:#6e7781;
  --accent:#0969da;--ok:#1a7f37;--warn:#9a6700;--mute:#59636e;--chip:#eff2f5;--sel:#0969da11;}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel);}
.repo{flex:1;min-width:0;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hb{display:flex;gap:2px;}
.hb button{width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--t2);
  cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;}
.hb button:hover{background:var(--chip);color:var(--t1);}
.meta{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--line);}
.chip{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--chip);color:var(--t2);white-space:nowrap;}
.chip b{color:var(--t1);font-weight:500;}
.body{flex:1;overflow-y:auto;padding:14px 16px 24px;scrollbar-width:thin;}
.body::-webkit-scrollbar{width:8px;}
.body::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px;}
.loading{display:flex;align-items:center;gap:8px;color:var(--t2);font-size:13px;padding:12px 0;}
.spin{width:12px;height:12px;border:1.5px solid var(--line);border-top-color:var(--accent);border-radius:50%;
  animation:sp .8s linear infinite;flex:none;}
@keyframes sp{to{transform:rotate(360deg)}}
.sec{margin-bottom:16px;}
.lab{font-size:11px;letter-spacing:.06em;color:var(--t3);margin-bottom:5px;font-weight:500;}
.txt{font-size:13px;line-height:1.72;color:var(--t1);}
.txt p+p{margin-top:6px;}
.txt ul{margin:4px 0 0;padding-left:16px;}
.txt li{margin:3px 0;}
.txt b{font-weight:500;color:var(--t1);}
.txt code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--chip);padding:1px 4px;border-radius:4px;}
.txt a{color:var(--accent);text-decoration:none;}
.txt a:hover{text-decoration:underline;}
.hero{margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--line);}
.hero .txt{font-size:16px;line-height:1.6;font-weight:500;letter-spacing:.01em;}
.verdict{background:var(--sel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:16px;}
.verdict .txt{font-size:13px;}
.badge{display:inline-block;font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px;margin-right:6px;
  border:1px solid currentColor;}
.badge.ok{color:var(--ok);}
.badge.warn{color:var(--warn);}
.badge.mute{color:var(--mute);}
.unknown{opacity:.72;}
.unknown .txt{font-size:12px;color:var(--t2);}
.caret{display:inline-block;width:6px;height:14px;background:var(--accent);vertical-align:-2px;animation:bl .9s steps(1) infinite;}
@keyframes bl{50%{opacity:0}}
.err{border:1px solid var(--line);border-left:3px solid #e5534b;border-radius:6px;padding:10px 12px;
  font-size:12.5px;line-height:1.7;color:var(--t1);background:var(--panel);}
.err .act{margin-top:8px;display:flex;gap:8px;}
.mini{font:500 12px/1 inherit;padding:6px 10px;border-radius:6px;cursor:pointer;
  border:1px solid var(--line);background:var(--chip);color:var(--t1);}
.mini.primary{border-color:var(--accent);color:var(--accent);}
.ft{border-top:1px solid var(--line);padding:8px 12px;display:flex;align-items:center;gap:6px;background:var(--panel);}
.ft .sp{flex:1;}
.fb{display:flex;gap:4px;}
.fb button{font:400 11px/1 inherit;padding:4px 7px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:transparent;color:var(--t2);}
.fb button:hover{color:var(--t1);border-color:var(--mute);}
.fb button[disabled]{opacity:.4;cursor:default;}
.fbrow{display:none;gap:6px;padding:0 12px 8px;background:var(--panel);}
.fbrow.on{display:flex;}
.fbrow input{flex:1;font:400 12px/1 inherit;padding:6px 8px;border-radius:6px;
  border:1px solid var(--line);background:var(--bg);color:var(--t1);outline:none;}
.fbrow input:focus{border-color:var(--accent);}
.tip{font-size:11px;color:var(--t3);padding:0 12px 8px;background:var(--panel);}`;

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function timeAgo(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return '刚才';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }

  function inlineMd(s) {
    return esc(s)
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function renderBlocks(text) {
    const lines = String(text).split('\n');
    let out = '';
    let list = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (list) {
          out += '</ul>';
          list = false;
        }
        continue;
      }
      const li = line.match(/^(?:[-*]|\d+[.、)])\s+(.*)$/);
      if (li) {
        if (!list) {
          out += '<ul>';
          list = true;
        }
        out += '<li>' + inlineMd(li[1]) + '</li>';
        continue;
      }
      if (list) {
        out += '</ul>';
        list = false;
      }
      out += '<p>' + inlineMd(line) + '</p>';
    }
    if (list) out += '</ul>';
    return out;
  }

  function parseSections(md) {
    const secs = [];
    let cur = null;
    for (const line of md.split('\n')) {
      const m = line.match(/^\s*#{2,4}\s*(.+?)\s*$/);
      if (m) {
        cur = { h: m[1].replace(/[*`]/g, '').trim(), body: '' };
        secs.push(cur);
      } else if (cur) {
        cur.body += line + '\n';
      } else if (line.trim()) {
        cur = { h: '__pre', body: '' };
        secs.push(cur);
        cur.body += line + '\n';
      }
    }
    return secs;
  }

  return { CSS, esc, timeAgo, inlineMd, renderBlocks, parseSections };
})();
