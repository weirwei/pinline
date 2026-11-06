// Commands offered to the Arc Cmdbar extension (chrome.runtime.onMessageExternal).
// Pure: the background builds a view of its state, this turns it into a command list.

/** The only extension allowed to list / run commands (fixed by the `key` in its manifest). */
export const CMDBAR_ID = 'khdmkbkpabdmhmhgekdebngpkndpfepc';
export const CMDBAR_PROTOCOL = 1;

/**
 * view = {
 *   tab:     { role: 'fav' | 'pin' | 'divider' | null, keepable, awayFromHome } | null  (the tab commands act on)
 *   spaces:  [{ id, name, current }]
 *   archive: [{ id, url, title, archivedAt }]
 * }
 * → [{ id, title, keywords, kind: 'command' | 'space' | 'archive', url?, at? }]
 */
export function cmdbarCommands({ tab, spaces = [], archive = [] }) {
  const out = [];
  const cmd = (id, title, keywords) => out.push({ id, title, keywords, kind: 'command' });
  const role = tab?.role ?? null;
  if (tab && role !== 'divider') {
    if (role === 'fav') cmd('toggle-fav', '取消 Fav', 'fav unfav favorite pinline quxiao shoucang');
    else if (tab.keepable) cmd('toggle-fav', '设为 Fav', 'fav favorite pinline shezhi shoucang');
    if (role === 'pin') cmd('toggle-pin', '取消 Pin', 'pin unpin pinline quxiao guding');
    else if (tab.keepable) cmd('toggle-pin', '设为 Pin', 'pin pinline shezhi guding');
    if (role && tab.awayFromHome) {
      cmd('reset-pin', '回到固定网址', 'reset home pin fav pinline chongzhi huidao guding wangzhi');
      if (tab.keepable) cmd('set-pin-home', '把当前网址设为固定网址', 'set home pin fav pinline sheweiguding wangzhi');
    }
    if (role) cmd('rename', `重命名 ${role === 'fav' ? 'Fav' : 'Pin'}…`, 'rename name pinline chongmingming');
  }
  if (spaces.length > 1) {
    cmd('next-space', '下一个 Space', 'next space pinline xiayige kongjian');
    cmd('prev-space', '上一个 Space', 'previous prev space pinline shangyige kongjian');
  }
  cmd('new-space', '新建 Space', 'new space create pinline xinjian kongjian');
  cmd('manage-spaces', '打开 Pinline 面板', 'pinline panel manage spaces settings mianban guanli');
  cmd('clear-unpinned', '归档分割线下方的所有标签', 'clear archive unpinned tabs pinline guidang qingkong');
  cmd('mru-back', '切到上一个最近使用的标签', 'recent mru back previous tab pinline zuijin shiyong');
  if (spaces.length > 1) {
    for (const s of spaces) {
      if (s.current) continue;
      out.push({ id: `space:${s.id}`, title: `切到 Space：${s.name}`, keywords: `space switch pinline qiehuan kongjian ${s.name}`, kind: 'space' });
    }
  }
  for (const e of archive) {
    out.push({ id: `archive:${e.id}`, title: e.title || e.url, url: e.url, at: e.archivedAt, keywords: 'archive pinline guidang', kind: 'archive' });
  }
  return out;
}

/** Validate a message from the command bar. Returns { type, id, tabId, windowId } or null. */
export function parseCmdbarMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type !== 'cmdbar:list' && msg.type !== 'cmdbar:run') return null;
  const tabId = Number.isInteger(msg.tabId) ? msg.tabId : undefined;
  const windowId = Number.isInteger(msg.windowId) ? msg.windowId : undefined;
  if (msg.type === 'cmdbar:run') {
    if (typeof msg.id !== 'string' || msg.id.length > 200) return null;
    return { type: msg.type, id: msg.id, tabId, windowId };
  }
  return { type: msg.type, tabId, windowId };
}
