// Minimal in-memory model of the chrome.* APIs Pinline uses. Events fire asynchronously like the real browser.

const tick = () => new Promise((r) => setImmediate(r));

const allEvents = new Set();
function event() {
  const listeners = [];
  allEvents.add(listeners);
  return {
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => setImmediate(() => listeners.forEach((fn) => fn(...args))),
  };
}

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get: async (keys) =>
      Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (obj) => Object.assign(data, structuredClone(obj)),
    clear: () => Object.keys(data).forEach((k) => delete data[k]),
  };
}

/** In-memory chrome.bookmarks: root(0) → bookmarks bar(1), other bookmarks(2). */
function fakeBookmarks() {
  let next = 100;
  const mk = (id, parentId, title, extra = {}) => ({ id, parentId, title, children: [], ...extra });
  const root = mk('0', undefined, '');
  const bar = mk('1', '0', 'Bookmarks bar', { folderType: 'bookmarks-bar' });
  const other = mk('2', '0', 'Other bookmarks', { folderType: 'other' });
  root.children.push(bar, other);
  const byId = new Map([['0', root], ['1', bar], ['2', other]]);
  const ev = Object.fromEntries(['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded'].map((n) => [n, event()]));
  const node = (id) => {
    const n = byId.get(String(id));
    if (!n) throw new Error(`Can't find bookmark for id: ${id}`);
    return n;
  };
  const view = (n, deep = true) => {
    const parent = byId.get(n.parentId);
    const v = { id: n.id, title: n.title };
    if (n.parentId !== undefined) v.parentId = n.parentId;
    if (parent) v.index = parent.children.indexOf(n);
    if (n.folderType) v.folderType = n.folderType;
    if (n.url !== undefined) v.url = n.url;
    else if (deep) v.children = n.children.map((c) => view(c));
    return v;
  };
  const drop = (n) => {
    byId.delete(n.id);
    (n.children ?? []).forEach(drop);
  };
  const api = {
    ...ev,
    getTree: async () => [view(root)],
    getSubTree: async (id) => [view(node(id))],
    getChildren: async (id) => node(id).children.map((c) => view(c, false)),
    get: async (id) => [view(node(id), false)],
    create: async ({ parentId = '2', index, title = '', url }) => {
      const parent = node(parentId);
      const n = url === undefined ? mk(String(next++), parent.id, title) : { id: String(next++), parentId: parent.id, title, url };
      byId.set(n.id, n);
      parent.children.splice(index ?? parent.children.length, 0, n);
      ev.onCreated.emit(n.id, view(n));
      return view(n);
    },
    update: async (id, { title, url }) => {
      const n = node(id);
      if (title !== undefined) n.title = title;
      if (url !== undefined) n.url = url;
      ev.onChanged.emit(n.id, { title: n.title, url: n.url });
      return view(n);
    },
    move: async (id, { parentId, index }) => {
      const n = node(id);
      const from = node(n.parentId);
      const to = parentId === undefined ? from : node(parentId);
      from.children.splice(from.children.indexOf(n), 1);
      n.parentId = to.id;
      to.children.splice(Math.min(index ?? to.children.length, to.children.length), 0, n);
      ev.onMoved.emit(n.id, { parentId: to.id, index: to.children.indexOf(n) });
      return view(n);
    },
    removeTree: async (id) => {
      const n = node(id);
      const parent = node(n.parentId);
      parent.children.splice(parent.children.indexOf(n), 1);
      drop(n);
      ev.onRemoved.emit(n.id, { parentId: parent.id });
    },
  };
  api.remove = api.removeTree;
  /** Test helper: node at a path of titles under "Other bookmarks", e.g. find('Pinline', '⭐ Fav'). */
  api.find = (...titles) => titles.reduce((n, t) => n?.children?.find((c) => c.title === t), other);
  api.titles = (...path) => (api.find(...path)?.children ?? []).map((c) => c.title);
  api.urls = (...path) => (api.find(...path)?.children ?? []).map((c) => c.url);
  return api;
}

export function createFakeChrome({ tabs: initialTabs = [], local = {}, sync = {} } = {}) {
  let nextId = 1000;
  let nextWindowId = 2;
  const windows = [{ id: 1, type: 'normal', focused: true, incognito: false }];
  const order = { 1: [] }; // windowId -> [tab]
  const winEv = { onCreated: event(), onRemoved: event() };

  const snapshot = (t) => ({ ...t, index: order[t.windowId].indexOf(t) });
  const all = () => Object.values(order).flat();
  const find = (id) => all().find((t) => t.id === id);
  const pinnedCount = (w) => order[w].filter((t) => t.pinned).length;

  function place(tab, index) {
    const list = order[tab.windowId];
    const at = list.indexOf(tab);
    if (at >= 0) list.splice(at, 1);
    const lo = tab.pinned ? 0 : pinnedCount(tab.windowId);
    const hi = tab.pinned ? pinnedCount(tab.windowId) : list.length;
    const at2 = index === undefined || index === -1 ? hi : index; // -1 = end, like Chrome
    list.splice(Math.min(Math.max(at2, lo), hi), 0, tab);
  }

  function activate(tab) {
    if (tab.active) return;
    order[tab.windowId].forEach((t) => (t.active = t === tab));
    ev.onActivated.emit({ tabId: tab.id, windowId: tab.windowId });
  }

  for (const t of initialTabs) {
    const tab = { windowId: 1, pinned: false, active: false, discarded: false, groupId: -1, title: t.url, ...t };
    if (!order[tab.windowId]) {
      windows.push({ id: tab.windowId, type: 'normal', focused: false, incognito: false });
      order[tab.windowId] = [];
      nextWindowId = Math.max(nextWindowId, tab.windowId + 1);
    }
    order[tab.windowId].push(tab);
  }
  for (const list of Object.values(order)) list.sort((a, b) => Number(b.pinned) - Number(a.pinned));

  // ---- tab groups ----
  let nextGroupId = 500;
  const groupsById = new Map();
  const groupEv = { onUpdated: event(), onRemoved: event(), onCreated: event(), onMoved: event() };
  function setGroup(tab, gid) {
    if (tab.groupId === gid) return;
    const old = tab.groupId;
    tab.groupId = gid;
    ev.onUpdated.emit(tab.id, { groupId: gid }, snapshot(tab));
    if (old > -1 && !all().some((t) => t.groupId === old)) {
      const g = groupsById.get(old);
      groupsById.delete(old);
      groupEv.onRemoved.emit({ ...g });
    }
  }
  /** Keep each group's tabs together, at the position of its first tab (Chrome does this). */
  function compact(windowId) {
    const list = order[windowId];
    const out = [];
    for (const t of list) {
      if (out.includes(t)) continue;
      if (t.groupId > -1) out.push(...list.filter((x) => x.groupId === t.groupId));
      else out.push(t);
    }
    list.splice(0, list.length, ...out);
  }

  const ev = {
    onCreated: event(),
    onUpdated: event(),
    onRemoved: event(),
    onReplaced: event(),
    onMoved: event(),
    onActivated: event(),
    onAttached: event(),
    onDetached: event(),
  };

  const chrome = {
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      id: 'fakeid',
      lastError: undefined,
      getURL: (path) => `chrome-extension://fakeid/${path.replace(/^\//, '')}`,
    },
    storage: { local: storageArea(local), sync: storageArea(sync), session: storageArea() },
    bookmarks: fakeBookmarks(),
    tabGroups: {
      ...groupEv,
      get: (id) => {
        if (!Number.isInteger(id) || id < 0) throw new TypeError("Error at parameter 'groupId': Value must be at least 0.");
        return (async () => {
        const g = groupsById.get(id);
        if (!g) throw new Error(`No group with id: ${id}`);
        return { ...g };
        })();
      },
      query: async () => [...groupsById.values()].map((g) => ({ ...g })),
      update: async (id, props) => {
        const g = groupsById.get(id);
        Object.assign(g, props);
        groupEv.onUpdated.emit({ ...g });
        return { ...g };
      },
      move: async (id, { index }) => {
        const g = groupsById.get(id);
        const list = order[g.windowId];
        const members = list.filter((t) => t.groupId === id);
        for (const t of members) list.splice(list.indexOf(t), 1);
        list.splice(Math.min(index, list.length), 0, ...members);
        return { ...g };
      },
    },
    action: { onClicked: event() },
    commands: { onCommand: event() },
    contextMenus: {
      onClicked: event(),
      removeAll: (cb) => cb?.(),
      create: (_props, cb) => cb?.(),
    },
    windows: {
      ...winEv,
      getLastFocused: async () => ({ ...windows[0] }),
      update: async (id, props = {}) => {
        const w = windows.find((w) => w.id === id);
        Object.assign(w, props.state ? { state: props.state } : {});
        return { ...w };
      },
      get: async (id) => {
        const w = windows.find((w) => w.id === id);
        if (!w) throw new Error(`No window with id: ${id}`);
        return { ...w };
      },
      getAll: async () => windows.map((w) => ({ ...w })),
      remove: async (id) => {
        for (const tab of [...order[id]]) {
          order[id].splice(order[id].indexOf(tab), 1);
          ev.onRemoved.emit(tab.id, { windowId: id, isWindowClosing: true });
        }
        windows.splice(windows.findIndex((w) => w.id === id), 1);
        delete order[id];
        winEv.onRemoved.emit(id);
      },
      create: async ({ url = 'chrome://newtab/', type = 'normal' } = {}) => {
        const win = { id: nextWindowId++, type, focused: true, incognito: false, state: 'normal' };
        windows.push(win);
        order[win.id] = [];
        winEv.onCreated.emit({ ...win });
        await chrome.tabs.create({ windowId: win.id, url, active: true });
        return { ...win };
      },
    },
    tabs: {
      ...ev,
      query: async (q = {}) =>
        all()
          .filter((t) => q.windowId === undefined || t.windowId === q.windowId)
          .filter((t) => q.pinned === undefined || t.pinned === q.pinned)
          .filter((t) => q.active === undefined || t.active === q.active)
          .map(snapshot),
      get: async (id) => {
        const t = find(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return snapshot(t);
      },
      create: async ({ windowId = 1, url, pinned = false, active = true, index, openerTabId }) => {
        if (index !== undefined && index < 0) throw new TypeError("Error at property 'index': Value must be at least 0.");
        const tab = { id: nextId++, windowId, url, title: url, pinned, active: false, discarded: false, groupId: -1, openerTabId };
        place(tab, index);
        if (active) activate(tab);
        ev.onCreated.emit(snapshot(tab));
        ev.onUpdated.emit(tab.id, { status: 'complete' }, snapshot(tab));
        // Our placeholder page sets the site's favicon after it renders.
        if (url.includes('/src/sleep.html')) ev.onUpdated.emit(tab.id, { favIconUrl: 'data:,' }, snapshot(tab));
        return snapshot(tab);
      },
      update: async (id, props) => {
        const tab = find(id);
        if ('pinned' in props && props.pinned !== tab.pinned) {
          tab.pinned = props.pinned;
          place(tab, props.pinned ? undefined : pinnedCount(tab.windowId));
          ev.onUpdated.emit(id, { pinned: tab.pinned }, snapshot(tab));
        }
        if (props.url) {
          tab.url = props.url;
          tab.discarded = false;
          ev.onUpdated.emit(id, { status: 'complete', url: tab.url }, snapshot(tab));
        }
        if (props.active) activate(tab);
        return snapshot(tab);
      },
      move: async (ids, { index, windowId }) => {
        const list = [ids].flat();
        const out = [];
        for (const [i, id] of list.entries()) {
          const tab = find(id);
          const at = index === -1 || index === undefined ? -1 : index + i;
          if (windowId !== undefined && windowId !== tab.windowId) {
            const old = tab.windowId;
            order[old].splice(order[old].indexOf(tab), 1);
            tab.windowId = windowId;
            tab.active = false;
            place(tab, at);
            ev.onDetached.emit(id, { oldWindowId: old, oldPosition: 0 });
            ev.onAttached.emit(id, { newWindowId: windowId, newPosition: snapshot(tab).index });
          } else {
            const from = snapshot(tab).index;
            place(tab, at);
            const to = snapshot(tab).index;
            if (from !== to) ev.onMoved.emit(id, { windowId: tab.windowId, fromIndex: from, toIndex: to });
          }
          out.push(snapshot(tab));
        }
        return Array.isArray(ids) ? out : out[0];
      },
      remove: async (ids) => {
        if (Array.isArray(ids)) {
          for (const id of ids) await chrome.tabs.remove(id);
          return;
        }
        const id = ids;
        const tab = find(id);
        if (!tab) return;
        // Real Chrome: closing a pinned tab fires onUpdated {pinned:false} first, then onRemoved.
        if (tab.pinned) ev.onUpdated.emit(id, { pinned: false }, { ...snapshot(tab), pinned: false });
        order[tab.windowId].splice(order[tab.windowId].indexOf(tab), 1);
        ev.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false });
        if (tab.groupId > -1 && !all().some((t) => t.groupId === tab.groupId)) {
          const g = groupsById.get(tab.groupId);
          groupsById.delete(tab.groupId);
          if (g) groupEv.onRemoved.emit({ ...g });
        }
      },
      ungroup: async (ids) => {
        for (const id of [ids].flat()) setGroup(find(id), -1);
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const list = [tabIds].flat().map(find);
        let gid = groupId;
        if (gid === undefined) {
          gid = nextGroupId++;
          groupsById.set(gid, { id: gid, windowId: createProperties?.windowId ?? list[0].windowId, title: '', color: 'grey', collapsed: false });
        }
        const g = groupsById.get(gid);
        const anchor = order[g.windowId].find((t) => t.groupId === gid) ?? list[0];
        let at = order[g.windowId].indexOf(anchor);
        for (const t of list) {
          setGroup(t, gid);
          const cur = order[t.windowId].indexOf(t);
          order[t.windowId].splice(cur, 1);
          if (cur < at) at--;
          order[t.windowId].splice(++at > order[t.windowId].length ? order[t.windowId].length : at, 0, t);
        }
        compact(g.windowId);
        return gid;
      },
      discard: async (id) => {
        const tab = find(id);
        tab.discarded = true;
        return snapshot(tab);
      },
    },
  };

  /** Let pending events and the extension's task queue drain. */
  async function settle(bg) {
    for (let i = 0; i < 40; i++) {
      await tick();
      await bg.__test.ready();
    }
  }

  /** Reload the extension: Chrome closes its own pages (no events) and its old listeners go away. */
  function reloadExtension() {
    for (const list of Object.values(order)) {
      for (const t of [...list]) if (t.url.startsWith('chrome-extension://fakeid/')) list.splice(list.indexOf(t), 1);
    }
    for (const listeners of allEvents) listeners.length = 0;
    chrome.storage.session.clear();
    revokers.splice(0).forEach((revoke) => revoke()); // the old service worker is gone for good
  }
  const revokers = [];

  return { chrome, settle, reloadExtension, revokers, tabs: () => all().map(snapshot) };
}

let importCounter = 0;
/** Load a fresh copy of the service worker against a fake chrome. */
export async function loadBackground(fake) {
  // Each loaded copy talks to the browser through its own handle, cut off when it is "reloaded".
  const { proxy, revoke } = Proxy.revocable(fake.chrome, {});
  fake.revokers?.push(revoke);
  globalThis.chrome = proxy;
  const bg = await import(`../src/background.js?instance=${importCounter++}`);
  await fake.settle(bg);
  return bg;
}
