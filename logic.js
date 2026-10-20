/**
 * 把地址收成可比较的键。
 * 忽略锚点：同一篇文档的不同 # 位置仍算同一个页面。
 * 忽略路径末尾多余的斜杠。查询参数保留，避免把不同结果页并成一个。
 */
export function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
    return null;
  }
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  return url.href;
}

/**
 * 在其他标签里找已经开着的同一地址。
 * 优先选「不是这次新开的」标签；如果两份都是刚开的，保留更早的那个。
 */
export function pickExisting(tabs, freshIds, currentId, key) {
  const others = tabs.filter((tab) => tab.id !== currentId && normalizeUrl(tab.url) === key);
  if (!others.length) return null;

  const settled = others.filter((tab) => !freshIds.has(tab.id));
  const pool = settled.length ? settled : others.filter((tab) => tab.id < currentId);
  if (!pool.length) return null;

  return pool.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}
