// 解读卡 markdown 的轻量解析，收藏/对比页共用

export function parseSections(md) {
  const secs = [];
  let cur = null;
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^\s*#{2,4}\s*(.+?)\s*$/);
    if (m) {
      cur = { h: m[1].replace(/[*`]/g, '').trim(), body: '' };
      secs.push(cur);
    } else if (cur) {
      cur.body += line + '\n';
    }
  }
  return secs;
}

export function getSection(md, name) {
  const s = parseSections(md).find((x) => x.h === name);
  return s ? s.body.trim() : '';
}

export function getLevel(md) {
  const m = String(md || '').match(/\*\*\s*(值得尝试|值得关注|暂时不值得)\s*\*\*/);
  if (m) return m[1];
  const m2 = String(md || '').match(/(值得尝试|值得关注|暂时不值得)/);
  return m2 ? m2[1] : '';
}

export function getOneLine(md) {
  const t = getSection(md, '一句话') || getSection(md, '它到底是什么');
  return t.split('\n')[0].replace(/[*`]/g, '').trim().slice(0, 60);
}

export function plain(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '· ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
