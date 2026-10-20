import { normalizeUrl, pickExisting } from './logic.js';

const FRESH_PREFIX = 'fresh_';
const RESOLVED_PREFIX = 'resolved_';
const NOTE_PREFIX = 'note_';

const freshIds = new Set();
const resolvedIds = new Set();
const recentCreates = [];
let burstGeneration = 0;
const evaluating = new Set();
const watchGates = new Map();
const pendingNotes = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('enabled');
  if (typeof current.enabled !== 'boolean') {
    await chrome.storage.local.set({ enabled: true });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null) return;
  const gate = watchTab(tab.id);
  watchGates.set(tab.id, gate);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') considerTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  freshIds.delete(tabId);
  resolvedIds.delete(tabId);
  watchGates.delete(tabId);
  pendingNotes.delete('reuse-' + tabId);
  chrome.storage.session.remove([
    FRESH_PREFIX + tabId,
    RESOLVED_PREFIX + tabId,
    NOTE_PREFIX + 'reuse-' + tabId,
  ]);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'reuse-decision') return;
  const newTabId = sender.tab?.id;
  if (newTabId == null) return;
  applyDecision({
    accept: message.accept === true,
    newTabId,
    existingId: message.existingId,
    key: message.key,
  }).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: String(error) })
  );
  return true;
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith('reuse-')) return;
  const payload = pendingNotes.get(notificationId) || null;
  pendingNotes.delete(notificationId);
  consumeNotification(notificationId, buttonIndex === 0, payload);
});

async function watchTab(tabId) {
  const now = Date.now();
  recentCreates.push(now);
  while (recentCreates.length && now - recentCreates[0] > 2000) recentCreates.shift();
  // 短时间一下子打开很多标签（例如刚启动时恢复旧标签）不当成重复打开。
  if (recentCreates.length >= 6) {
    burstGeneration += 1;
    const ids = [...freshIds];
    freshIds.clear();
    await Promise.all(ids.map((id) => chrome.storage.session.remove(FRESH_PREFIX + id)));
    return;
  }

  const generation = burstGeneration;
  freshIds.add(tabId);
  await chrome.storage.session.set({ [FRESH_PREFIX + tabId]: now });
  if (generation !== burstGeneration) {
    freshIds.delete(tabId);
    await chrome.storage.session.remove(FRESH_PREFIX + tabId);
  }
}

async function considerTab(tabId) {
  if (evaluating.has(tabId) || resolvedIds.has(tabId)) return;
  evaluating.add(tabId);
  try {
    const gate = watchGates.get(tabId);
    if (gate) await gate;
    if (resolvedIds.has(tabId)) return;

    const resolvedStored = await chrome.storage.session.get(RESOLVED_PREFIX + tabId);
    if (resolvedStored[RESOLVED_PREFIX + tabId]) {
      resolvedIds.add(tabId);
      return;
    }

    await rememberFreshFromSession();
    if (!freshIds.has(tabId)) return;

    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') return;
    const key = normalizeUrl(tab.url);
    if (!key) return;

    const { enabled } = await chrome.storage.local.get({ enabled: true });
    if (enabled === false) {
      await markResolved(tabId);
      return;
    }

    const tabs = await chrome.tabs.query({});
    const fresh = await loadFreshIds();
    const existing = pickExisting(tabs, fresh, tabId, key);
    await markResolved(tabId);
    if (!existing) return;
    if (fresh.has(existing.id)) await markResolved(existing.id);
    await showPrompt(tab, existing, key);
  } catch (error) {
    console.warn('重复打开时询问：检查标签失败', error);
  } finally {
    evaluating.delete(tabId);
  }
}

async function rememberFreshFromSession() {
  const all = await chrome.storage.session.get(null);
  const storedFresh = [];
  for (const [name, value] of Object.entries(all)) {
    if (!value) continue;
    if (name.startsWith(RESOLVED_PREFIX)) {
      resolvedIds.add(Number(name.slice(RESOLVED_PREFIX.length)));
    } else if (name.startsWith(FRESH_PREFIX)) {
      storedFresh.push(Number(name.slice(FRESH_PREFIX.length)));
    }
  }
  for (const id of storedFresh) {
    if (!resolvedIds.has(id)) freshIds.add(id);
  }
  for (const id of resolvedIds) freshIds.delete(id);
}

async function loadFreshIds() {
  await rememberFreshFromSession();
  return new Set(freshIds);
}

async function markResolved(tabId) {
  freshIds.delete(tabId);
  resolvedIds.add(tabId);
  await chrome.storage.session.remove(FRESH_PREFIX + tabId);
  await chrome.storage.session.set({ [RESOLVED_PREFIX + tabId]: Date.now() });
}

async function showPrompt(tab, existing, key) {
  const payload = {
    existingId: existing.id,
    key,
    title: existing.title || '',
    url: existing.url || '',
  };
  let shown = false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: mountDialog,
      args: [payload],
    });
    shown = result?.result === true;
  } catch (error) {
    console.warn('重复打开时询问：页面里打不开确认框', error?.message || error);
  }
  if (!shown) await showNotification(tab.id, payload);
}

async function showNotification(newTabId, payload) {
  const notificationId = 'reuse-' + newTabId;
  const note = {
    newTabId,
    existingId: payload.existingId,
    key: payload.key,
  };
  pendingNotes.set(notificationId, note);
  await chrome.storage.session.set({ [NOTE_PREFIX + notificationId]: note });
  await chrome.notifications.clear(notificationId);
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title: '这个页面已经打开了',
    message: '相同地址已经在另一个标签里。要关掉这个新标签，回到原来的页面并刷新吗？',
    buttons: [
      { title: '回到原页面并刷新' },
      { title: '保留这个新标签' },
    ],
    requireInteraction: true,
    priority: 2,
  });
}

async function consumeNotification(notificationId, accept, payload) {
  if (!payload) {
    const stored = await chrome.storage.session.get(NOTE_PREFIX + notificationId);
    payload = stored[NOTE_PREFIX + notificationId];
  }
  pendingNotes.delete(notificationId);
  await chrome.storage.session.remove(NOTE_PREFIX + notificationId);
  await chrome.notifications.clear(notificationId);
  if (!payload || !accept) return;
  await applyDecision({ accept: true, ...payload });
}

async function applyDecision({ accept, newTabId, existingId, key }) {
  if (!accept) return;

  let existing;
  try {
    existing = await chrome.tabs.get(existingId);
  } catch {
    return;
  }
  if (normalizeUrl(existing.url) !== key) return;

  try {
    await chrome.tabs.remove(newTabId);
  } catch {
    // 新标签可能已经被关掉。
  }
  try {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existingId, { active: true });
    await chrome.tabs.reload(existingId, { bypassCache: true });
  } catch (error) {
    console.warn('重复打开时询问：切回原标签失败', error);
  }
}

function mountDialog(payload) {
  const hostId = '__reuse_open_tab__';
  try {
    if (!document.documentElement || document.getElementById(hostId)) return true;

    const host = document.createElement('div');
    host.id = hostId;
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('pointer-events', 'auto', 'important');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: light; }
      .backdrop {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        box-sizing: border-box;
        background: rgba(32, 33, 36, 0.46);
        font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      .card {
        width: min(420px, 100%);
        box-sizing: border-box;
        padding: 22px 22px 18px;
        border-radius: 14px;
        background: #fff;
        color: #1f1f1f;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
      }
      h2 {
        margin: 0 0 8px;
        font-size: 18px;
        line-height: 1.4;
        font-weight: 650;
      }
      p { margin: 0; font-size: 14px; line-height: 1.55; color: #3c4043; }
      .meta {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: #f6f7f9;
      }
      .name, .url {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .name { font-size: 13px; font-weight: 600; color: #1f1f1f; }
      .url { margin-top: 2px; font-size: 12px; color: #5f6368; }
      .hint { margin-top: 10px; font-size: 12px; color: #5f6368; }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
      }
      button {
        height: 36px;
        padding: 0 14px;
        border: 0;
        border-radius: 8px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .keep { background: #eef0f3; color: #1f1f1f; }
      .keep:hover { background: #e4e7eb; }
      .go { background: #0b57d0; color: #fff; }
      .go:hover { background: #0842a0; }
      button:focus-visible { outline: 2px solid #0b57d0; outline-offset: 2px; }
    `;

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'reuse-open-tab-title');

    const title = document.createElement('h2');
    title.id = 'reuse-open-tab-title';
    title.textContent = '这个页面已经打开了';

    const body = document.createElement('p');
    body.textContent = '相同地址已经在另一个标签里打开。要关掉现在这个新标签，回到原来的页面并刷新吗？';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = payload.title || '已打开的标签';
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = payload.url || '';
    meta.append(name, url);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '确认后会刷新原页面。原页面上还没保存的内容会被清掉。';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'keep';
    keep.textContent = '保留这个新标签';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.textContent = '回到原页面并刷新';
    actions.append(keep, go);

    card.append(title, body, meta, hint, actions);
    backdrop.append(card);
    shadow.append(style, backdrop);
    document.documentElement.appendChild(host);

    const choose = (accept) => {
      host.remove();
      chrome.runtime.sendMessage({
        type: 'reuse-decision',
        accept,
        existingId: payload.existingId,
        key: payload.key,
      }, () => void chrome.runtime.lastError);
    };

    keep.addEventListener('click', () => choose(false));
    go.addEventListener('click', () => choose(true));
    backdrop.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      choose(false);
    });
    go.focus();
    return true;
  } catch {
    return false;
  }
}
