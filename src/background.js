// Pinline service worker.
//
// Every normal window is laid out as:
//
//     [ Fav ][ Fav ][ Fav ]       ← Chrome's native pinned tabs (icon tiles), same set in every window
//     Pin  GitHub                 ← ordinary full-row tabs kept above the divider
//     Pin  Docs
//     ────────────                ← divider tab
//     everything else
//
// Favs and Pins are persistent: closing one re-creates it asleep at its home URL, in its slot.
// - right-click → Pin (native) makes a tab a Fav; right-click → Unpin removes the Fav everywhere;
// - dragging a tab above the divider makes it a Pin, dragging a Pin below the divider unpins it;
// - Favs and Pins survive restarts (chrome.storage.local) and sync across devices via bookmarks.

import {
  DIVIDER_PAGE,
  SLEEP_PAGE,
  cycleSpace,
  spaceIdFromUrl,
  insertIndexFor,
  isPinnableUrl,
  isWakeableUrl,
  makePin as makeItem,
  matchPinsToTabs,
  normalizeUrl,
  parseSleepUrl,
  sleepUrl,
  displayOrder,
  isOpenableUrl,
  uniqueOrder,
  ARCHIVE_CHOICES,
  ageOutSaved,
  isStale,
  pushArchive,
  touchMru,
} from './core.js';
import { ROOT_TITLE, mergeFromBookmarks, mirrorToBookmarks, snapshot } from './bookmarks.js';

// Bind the API object once: timers that fire late keep talking to the browser they started with.
const chrome = globalThis.chrome;


const state = {
  spaces: [], // ordered [{ id, name }]
  favs: [], // ordered [{ id, url, title }], shared by all Spaces
  pins: [], // ordered [{ id, url, title, space, group? }]
  groups: [], // Pin groups [{ id, space, title, color, collapsed }], shown as Chrome tab groups above the divider
  groupMap: {}, // Chrome tab group id -> Pin group id
  tabToFav: {}, // tabId -> favId (one tab per fav per window)
  tabToPin: {}, // tabId -> pinId (one tab per pin)
  windowSpace: {}, // windowId -> Space shown in it (also tagged on the window's divider URL)
  sleepers: {}, // tabId -> { w, url, title }: normal tabs we opened asleep (to re-open if Chrome closes them)
  bm: {}, // bookmark ids of the Pinline folder and its ⭐ Fav folder
  bmTrash: [], // bookmark ids of things removed in Pinline, to delete from bookmarks on next sync
  spaceTabs: {}, // spaceId -> [{ url, title }] tabs of a hidden Space (closed, re-opened asleep on switch)
  spaceActive: {}, // spaceId -> what was selected: { pin: pinId } | { tab: index into spaceTabs }
  lastSeen: {}, // tabId -> when the tab was last selected (ms), for auto-archive
  archive: [], // archived tabs, newest first [{ id, url, title, favIconUrl?, spaceId, archivedAt }]
  settings: { archiveAfterHours: 0, collapseGroupsOnSwitch: true }, // 0 = auto-archive off
  mru: {}, // windowId -> tab ids, most recently used first (storage.session)
  ready: false, // set once this browser session has been reconciled; until then never create tabs
};
const selfPinOps = new Set(); // tab ids whose native `pinned` flag we are flipping ourselves
const selfCreated = new Set(); // tabs we opened ourselves
const pendingDiscard = new Set(); // tabs we re-created; discard as soon as Chrome allows
const pendingUnpin = new Set(); // native unpins waiting to see whether the tab is actually closing
const lastActive = {}; // windowId -> last active non-divider tab id

// Closing a pinned tab makes Chrome fire onUpdated {pinned:false} right before onRemoved,
// so a native unpin only counts if the tab is still alive a moment later.
const UNPIN_CONFIRM_MS = 500;
// A new window is populated (by the user or by session restore) right after it is created.
const WINDOW_SETTLE_MS = 800;
// Tab activations right after a Space switch are Chrome's doing, not a click on the divider.
const SWITCH_GRACE_MS = 800;
let switchingUntil = 0;

// All handlers run one at a time so state never interleaves.
let queue = loadState();
function run(task) {
  queue = queue.then(task).catch((err) => console.error('[pinline]', err));
  return queue;
}

// ---------- storage ----------

let lastSaved = '';
let lastTabs = '';
let bmBase = { nodes: {}, order: {} }; // snapshot of what we last wrote to bookmarks
let bmSyncing = false;
async function loadState() {
  const keys = ['spaces', 'favs', 'pins', 'groups'];
  const local = await chrome.storage.local.get([...keys, 'spaceTabs', 'spaceActive', 'bm', 'bmTrash', 'bmBase', 'archive', 'settings']);
  state.archive = local.archive ?? [];
  state.settings = { ...state.settings, ...local.settings };
  state.bm = local.bm ?? {};
  state.bmTrash = local.bmTrash ?? [];
  bmBase = local.bmBase ?? { nodes: {}, order: {} };
  state.spaceTabs = local.spaceTabs ?? {};
  state.spaceActive = local.spaceActive ?? {};
  const sync = local.pins || local.favs ? {} : await chrome.storage.sync.get(keys);
  const session = await chrome.storage.session.get(['ready', 'mru']);
  state.mru = session.mru ?? {};
  // Tab bindings live in storage.local so they survive reloading the extension (tab ids stay valid
  // until the browser restarts; onStartup clears them).
  const tabs = (await chrome.storage.local.get('tabs')).tabs ?? {};
  for (const k of keys) state[k] = local[k] ?? sync[k] ?? [];
  state.tabToFav = tabs.tabToFav ?? {};
  state.tabToPin = tabs.tabToPin ?? {};
  state.windowSpace = tabs.windowSpace ?? {};
  state.sleepers = tabs.sleepers ?? {};
  state.groupMap = tabs.groupMap ?? {};
  state.lastSeen = tabs.lastSeen ?? {};
  lastTabs = JSON.stringify(tabs);
  state.ready = session.ready ?? false;
  ensureSpaces();
  lastSaved = JSON.stringify([state.spaces, state.favs, state.pins, state.groups, state.bm, state.bmTrash]);
}

async function persist() {
  await chrome.storage.session.set({ ready: state.ready });
  const { tabToFav, tabToPin, windowSpace, sleepers, groupMap, lastSeen } = state;
  const tabs = JSON.stringify({ tabToFav, tabToPin, windowSpace, sleepers, groupMap, lastSeen });
  if (tabs !== lastTabs) {
    lastTabs = tabs;
    await chrome.storage.local.set({ tabs: { tabToFav, tabToPin, windowSpace, sleepers, groupMap, lastSeen } });
  }
  const lists = JSON.stringify([state.spaces, state.favs, state.pins, state.groups, state.bm, state.bmTrash]);
  if (lists === lastSaved) return; // layout runs often; only write real changes
  lastSaved = lists;
  const { spaces, favs, pins, groups, bm, bmTrash } = state;
  await chrome.storage.local.set({ spaces, favs, pins, groups, bm, bmTrash });
  // Syncing across devices goes through bookmarks (Chrome Sync), see syncBookmarks().
  if (!bmSyncing) scheduleBookmarkSync();
}

// ---------- helpers ----------

const favIdOf = (tabId) => state.tabToFav[tabId];
const pinIdOf = (tabId) => state.tabToPin[tabId];
const favById = (id) => state.favs.find((f) => f.id === id);
const pinById = (id) => state.pins.find((p) => p.id === id);
const tabsIn = (map, id) =>
  Object.keys(map)
    .filter((k) => map[k] === id)
    .map(Number);

let sleepBaseUrl;
const sleepBase = () => (sleepBaseUrl ??= chrome.runtime.getURL(SLEEP_PAGE));
let dividerBaseUrl;
const dividerUrl = () => (dividerBaseUrl ??= chrome.runtime.getURL(DIVIDER_PAGE));
const rawUrl = (tab) => tab.url || tab.pendingUrl || '';
/** The page a tab stands for: a sleeping placeholder counts as the site it will wake up to. */
const tabUrl = (tab) => parseSleepUrl(sleepBase(), rawUrl(tab)) ?? rawUrl(tab);
const isPlaceholder = (tab) => parseSleepUrl(sleepBase(), rawUrl(tab)) !== null;
const isDivider = (tab) => rawUrl(tab).startsWith(dividerUrl());
const spaceById = (id) => state.spaces.find((s) => s.id === id);
const dividerSpace = (tab) => spaceIdFromUrl(dividerUrl(), rawUrl(tab));
/** Divider URL for a Space; the name is only shown once there is more than one Space. */
function dividerFor(space) {
  const u = new URL(dividerUrl());
  u.searchParams.set('space', space.id);
  if (state.spaces.length > 1) u.searchParams.set('name', space.name);
  return u.href;
}
/** There is always at least one Space; pins from older versions belong to the first one. */
function ensureSpaces() {
  if (!state.spaces.length) state.spaces.push({ id: crypto.randomUUID(), name: 'Space 1' });
  for (const pin of state.pins) if (!spaceById(pin.space)) pin.space = state.spaces[0].id;
}
/** Space shown in a window: its divider's tag, else what we remembered, else the first Space. */
function spaceOfWindow(windowId, tabs) {
  const tagged = tabs.map(dividerSpace).find((id) => spaceById(id));
  return tagged ?? (spaceById(state.windowSpace[windowId]) ? state.windowSpace[windowId] : state.spaces[0].id);
}
const isAsleep = (tab) => tab.discarded || isPlaceholder(tab);
const canKeep = (tab) => !isDivider(tab) && isPinnableUrl(tabUrl(tab));
/** URL to open for a sleeping copy: web pages get a placeholder, others the real URL (discarded on load). */
/** What a Fav / Pin is called: the user's name for it, else the page title. */
const displayTitle = (item) => item.name || item.title || item.url;
const sleepingUrl = (item) => (isWakeableUrl(item.url) ? sleepUrl(sleepBase(), { url: item.url, title: displayTitle(item) }) : item.url);

const getTab = (id) => chrome.tabs.get(id).catch(() => null);
const windowTabs = async (windowId) =>
  (await chrome.tabs.query({ windowId }).catch(() => [])).sort((a, b) => a.index - b.index);

/** A window the user browses in (not a popup, not incognito). */
async function isNormalWindow(windowId) {
  const w = await chrome.windows.get(windowId).catch(() => null);
  return !!w && w.type === 'normal' && !w.incognito;
}
async function normalWindowIds() {
  const all = await chrome.windows.getAll().catch(() => []);
  return all.filter((w) => w.type === 'normal' && !w.incognito).map((w) => w.id);
}

async function createSelf(props) {
  const tab = await chrome.tabs.create(props);
  selfCreated.add(tab.id);
  return tab;
}

async function setPinned(tab, pinned) {
  if (tab.pinned === pinned) return;
  selfPinOps.add(tab.id);
  await chrome.tabs.update(tab.id, { pinned });
}

function addPin(tab, space) {
  const pin = { ...makeItem(crypto.randomUUID(), { ...tab, url: tabUrl(tab) }), space };
  state.pins.push(pin);
  state.tabToPin[tab.id] = pin.id;
  return pin;
}

/** @param trash also delete its bookmark (false when the bookmark is already gone) */
function forgetPin(pinId, trash = true) {
  const pin = pinById(pinId);
  if (pin?.bm && trash) state.bmTrash.push(pin.bm);
  state.pins = state.pins.filter((p) => p.id !== pinId);
  for (const tabId of tabsIn(state.tabToPin, pinId)) delete state.tabToPin[tabId];
}

/**
 * Bind a tab to the Fav with the same URL, or create a new Fav. There is one Fav per URL: if the
 * window already has a copy, layoutFavs() keeps the live one and closes a sleeping duplicate.
 */
async function bindOrAddFav(tab) {
  const want = normalizeUrl(tabUrl(tab));
  const same = state.favs.find((f) => normalizeUrl(f.url) === want);
  if (same) {
    state.tabToFav[tab.id] = same.id;
    return same;
  }
  const fav = makeItem(crypto.randomUUID(), { ...tab, url: tabUrl(tab) });
  state.favs.push(fav);
  state.tabToFav[tab.id] = fav.id;
  return fav;
}

/** Drop a Fav everywhere: sleeping copies are closed, live copies become normal tabs (except keepTabId). */
async function removeFav(favId, keepTabId, trash = true) {
  const fav = favById(favId);
  if (fav?.bm && trash) state.bmTrash.push(fav.bm);
  state.favs = state.favs.filter((f) => f.id !== favId);
  for (const tabId of tabsIn(state.tabToFav, favId)) {
    delete state.tabToFav[tabId];
    if (tabId === keepTabId) continue;
    const t = await getTab(tabId);
    if (!t) continue;
    if (isAsleep(t)) await chrome.tabs.remove(tabId).catch(() => {});
    else await setPinned(t, false);
  }
}

function remapTab(oldId, newId) {
  for (const map of [state.tabToFav, state.tabToPin, state.sleepers, state.lastSeen]) {
    if (map[oldId] === undefined) continue;
    map[newId] = map[oldId];
    delete map[oldId];
  }
  for (const w of Object.keys(state.mru)) state.mru[w] = state.mru[w].map((id) => (id === oldId ? newId : id));
}

/** Move a tab just below the divider (or leave it where it is if the window has none). */
async function moveBelowDivider(tabId, windowId) {
  const tabs = await windowTabs(windowId);
  const divider = tabs.find(isDivider);
  const cur = tabs.find((t) => t.id === tabId);
  if (divider && cur && cur.index < divider.index) await chrome.tabs.move(tabId, { index: divider.index });
}

// ---------- layout ----------

/** One tab per Fav in this window, as native pinned tabs, in Fav order. Missing Favs open asleep. */
async function layoutFavs(windowId) {
  const tabs = await windowTabs(windowId);
  const byFav = new Map();
  for (const t of tabs.filter((t) => t.pinned && favIdOf(t.id))) {
    const favId = favIdOf(t.id);
    const keep = byFav.get(favId);
    if (!keep) {
      byFav.set(favId, t);
      continue;
    }
    // Two copies of the same Fav in one window (e.g. a Fav dragged in from another window): keep the live one.
    const drop = isAsleep(t) || !isAsleep(keep) ? t : keep;
    if (drop === keep) byFav.set(favId, t);
    delete state.tabToFav[drop.id];
    if (isAsleep(drop)) await chrome.tabs.remove(drop.id).catch(() => {});
    else await setPinned(drop, false);
  }

  if (state.ready) {
    for (const fav of state.favs) {
      if (byFav.has(fav.id)) continue;
      const tab = await createSelf({ windowId, url: sleepingUrl(fav), pinned: true, active: false, index: 0 });
      state.tabToFav[tab.id] = fav.id;
      pendingDiscard.add(tab.id);
      byFav.set(fav.id, tab);
    }
  }

  let slot = 0;
  for (const fav of state.favs) {
    const t = byFav.get(fav.id);
    if (!t) continue;
    const cur = await getTab(t.id);
    if (cur && cur.index !== slot) await chrome.tabs.move(cur.id, { index: slot });
    slot++;
  }
}

/** Merge Favs with the same URL (left over from older versions / a restart race). */
function mergeDuplicateFavs() {
  const seen = new Map();
  for (const f of [...state.favs]) {
    const key = normalizeUrl(f.url);
    const keep = seen.get(key);
    if (!keep) {
      seen.set(key, f);
      continue;
    }
    if (f.name && !keep.name) keep.name = f.name;
    if (f.bm) state.bmTrash.push(f.bm);
    state.favs = state.favs.filter((x) => x !== f);
    for (const tabId of tabsIn(state.tabToFav, f.id)) state.tabToFav[tabId] = keep.id;
  }
}

// ---------- Pin groups ----------

const groupById = (id) => state.groups.find((g) => g.id === id);
/** chrome.tabGroups.get, but null for a missing / invalid id (Chrome throws synchronously on -1). */
async function getChromeGroup(id) {
  if (!Number.isInteger(id) || id < 0) return null;
  try {
    return await chrome.tabGroups.get(id);
  } catch {
    return null;
  }
}
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** A Chrome tab group the user made above the divider becomes a Pin group. */
async function adoptChromeGroup(chromeGroupId, spaceId) {
  const g = await getChromeGroup(chromeGroupId);
  const group = {
    id: crypto.randomUUID(),
    space: spaceId,
    title: g?.title ?? '',
    color: GROUP_COLORS.includes(g?.color) ? g.color : 'grey',
    collapsed: !!g?.collapsed,
  };
  state.groups.push(group);
  state.groupMap[chromeGroupId] = group.id;
  return group.id;
}

const usedGroups = () => new Set(state.pins.map((p) => p.group).filter(Boolean));
/** Groups that just lost their last pin are gone (the user ungrouped / unpinned everything in them). */
function dropEmptyGroups(before) {
  const used = usedGroups();
  const gone = state.groups.filter((g) => before.has(g.id) && !used.has(g.id));
  for (const g of gone) {
    if (g.bm) state.bmTrash.push(g.bm);
    for (const k of Object.keys(state.groupMap)) if (state.groupMap[k] === g.id) delete state.groupMap[k];
  }
  state.groups = state.groups.filter((g) => !gone.includes(g));
  for (const p of state.pins) if (p.group && !groupById(p.group)) p.group = undefined;
}

/**
 * [native pinned (Favs)][pins: single ones and Chrome tab groups, in pin order][divider][everything else].
 * Only touches what is out of place, so a normal layout pass is a few reads and no writes.
 */
async function layoutPins(windowId) {
  let tabs = await windowTabs(windowId);
  const dividers = tabs.filter(isDivider);
  const space = spaceById(spaceOfWindow(windowId, tabs));
  state.windowSpace[windowId] = space.id;

  // The divider is always there: it draws the line under the pins and is Pinline's control panel.
  for (const d of dividers.slice(1)) await chrome.tabs.remove(d.id).catch(() => {});
  const base = tabs.filter((t) => t.pinned).length;
  const pinTabCount = tabs.filter((t) => pinIdOf(t.id) && !t.pinned).length;
  const divider =
    dividers[0] ?? (await createSelf({ windowId, url: dividerFor(space), active: false, index: base + pinTabCount }));
  if (rawUrl(divider).split('#')[0] !== dividerFor(space)) await chrome.tabs.update(divider.id, { url: dividerFor(space) });

  // What it should look like.
  tabs = await windowTabs(windowId);
  // A tab group the user just made around pins, not seen by syncFromPositions yet: adopt it, so it
  // is not taken for a stray group and ungrouped.
  for (const t of tabs) {
    const pin = pinById(pinIdOf(t.id));
    if (pin && !t.pinned && t.groupId > -1 && !state.groupMap[t.groupId]) pin.group = await adoptChromeGroup(t.groupId, space.id);
  }
  const tabOf = new Map();
  for (const t of tabs) {
    const pinId = pinIdOf(t.id);
    if (!pinId || t.pinned) continue;
    const first = tabOf.get(pinId);
    if (!first) {
      tabOf.set(pinId, t);
      continue;
    }
    // Two tabs of one Pin in this window: keep the live one, drop / unbind the other.
    const drop = isAsleep(t) || !isAsleep(first) ? t : first;
    if (drop === first) tabOf.set(pinId, t);
    delete state.tabToPin[drop.id];
    if (isAsleep(drop)) {
      switchClosing.add(drop.id); // closing it must not re-create the pin
      await chrome.tabs.remove(drop.id).catch(() => switchClosing.delete(drop.id));
    }
  }
  const present = state.pins.filter((p) => tabOf.has(p.id));
  const plan = displayOrder(present, state.groups).filter((x) => x.pin || x.pins.length);
  const want = plan.flatMap((x) => (x.pin ? [[tabOf.get(x.pin.id).id, null]] : x.pins.map((p) => [tabOf.get(p.id).id, x.group.id])));
  const pinGroupOf = (t) => (t.groupId > -1 ? state.groupMap[t.groupId] ?? `chrome:${t.groupId}` : null);

  const inPlace = () =>
    want.every(([id, gid], i) => tabs[base + i]?.id === id && pinGroupOf(tabs[base + i]) === gid) &&
    tabs[base + want.length]?.id === divider.id &&
    !(divider.groupId > -1);

  if (!inPlace()) {
    // 1. Group membership: one Chrome group per Pin group (created if missing), nothing else in it.
    const chromeGroupOf = new Map();
    for (const t of tabs) if (t.groupId > -1 && state.groupMap[t.groupId]) chromeGroupOf.set(state.groupMap[t.groupId], t.groupId);
    const wantIds = new Set(want.map(([id]) => id));
    for (const t of tabs) {
      const wanted = want.find(([id]) => id === t.id)?.[1] ?? null;
      const inPinArea = wantIds.has(t.id) || t.id === divider.id;
      const has = pinGroupOf(t);
      if (has !== null && (inPinArea ? has !== wanted : !!state.groupMap[t.groupId])) await chrome.tabs.ungroup(t.id).catch(() => {});
    }
    // New groups are created together (fired at once, Chrome runs them in order).
    const snapshot = await windowTabs(windowId);
    const groupOfTab = new Map(snapshot.map((t) => [t.id, t.groupId]));
    const liveGroups = new Map((await chrome.tabGroups.query({ windowId }).catch(() => [])).map((g) => [g.id, g]));
    await Promise.all(
      plan
        .filter((x) => x.group)
        .map(async (x) => {
          const ids = x.pins.map((p) => tabOf.get(p.id).id);
          const cid = chromeGroupOf.get(x.group.id);
          if (cid !== undefined && liveGroups.has(cid)) {
            const missing = ids.filter((id) => groupOfTab.get(id) !== cid);
            if (missing.length) await chrome.tabs.group({ groupId: cid, tabIds: missing });
            return;
          }
          const newId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
          state.groupMap[newId] = x.group.id;
          chromeGroupOf.set(x.group.id, newId);
          await chrome.tabGroups.update(newId, { title: x.group.title, color: x.group.color, collapsed: x.group.collapsed }).catch(() => {});
        }),
    );

    // 2. Order, left to right: single pins, then whole groups (and the pins inside), then the divider.
    // Usually already right (a Space switch opens pins in order): check with one query first.
    const after = await windowTabs(windowId);
    const finalIds = [...want.map(([id]) => id), divider.id];
    const ordered = finalIds.every((id, k) => after[base + k]?.id === id);
    let at = base;
    if (!ordered) {
    for (const x of plan) {
      if (x.pin) {
        const id = tabOf.get(x.pin.id).id;
        if ((await getTab(id))?.index !== at) await chrome.tabs.move(id, { index: at });
        at++;
        continue;
      }
      const cid = chromeGroupOf.get(x.group.id);
      const first = (await windowTabs(windowId)).find((t) => t.groupId === cid);
      if (first && first.index !== at) await chrome.tabGroups.move(cid, { index: at });
      for (const [k, p] of x.pins.entries()) {
        const id = tabOf.get(p.id).id;
        if ((await getTab(id))?.index !== at + k) await chrome.tabs.move(id, { index: at + k });
      }
      at += x.pins.length;
    }
    if ((await getTab(divider.id))?.index !== at) await chrome.tabs.move(divider.id, { index: at });
    }
  }

  // 3. Names / colours follow the Pin group (changed in the panel or in bookmarks).
  const now = await windowTabs(windowId);
  for (const cid of new Set(now.map((t) => t.groupId).filter((g) => g > -1 && state.groupMap[g]))) {
    const group = groupById(state.groupMap[cid]);
    const live = await getChromeGroup(cid);
    if (group && live && (live.title !== group.title || live.color !== group.color)) {
      await chrome.tabGroups.update(cid, { title: group.title, color: group.color }).catch(() => {});
    }
  }
}

async function layout(windowId) {
  if (!(await isNormalWindow(windowId))) return;
  await layoutFavs(windowId);
  await layoutPins(windowId);
  await persist();
}

async function layoutAll() {
  for (const id of await normalWindowIds()) await layout(id);
}

/** The user moved tabs around: read Fav order from the tiles, Pin membership/order from the divider. */
async function syncFromPositions(windowId) {
  if (!(await isNormalWindow(windowId))) return;
  const tabs = await windowTabs(windowId);

  // Fav order as dragged in this window → applied to every window.
  const favOrder = uniqueOrder(tabs.filter((t) => t.pinned && favIdOf(t.id)).map((t) => favIdOf(t.id)), favById);
  const before = state.favs.map((f) => f.id).join();
  const present = new Set(favOrder);
  let i = 0;
  state.favs = state.favs.map((f) => (present.has(f.id) ? favById(favOrder[i++]) : f));
  const favsReordered = state.favs.map((f) => f.id).join() !== before;

  const d = tabs.findIndex(isDivider);
  const spaceId = spaceOfWindow(windowId, tabs);
  if (d >= 0) {
    const above = tabs.slice(0, d).filter((t) => !t.pinned && !favIdOf(t.id) && !pendingUnpin.has(t.id));
    const groupsBefore = usedGroups();
    const keptAbove = new Set(above.map((t) => pinIdOf(t.id)).filter(Boolean));
    for (const t of tabs.slice(d + 1)) {
      const pinId = pinIdOf(t.id);
      if (!pinId) continue;
      if (keptAbove.has(pinId)) delete state.tabToPin[t.id]; // a stray second copy: just unbind it
      else forgetPin(pinId);
    }
    for (const t of above) if (!pinIdOf(t.id) && canKeep(t)) addPin(t, spaceId);
    // Group membership as arranged by the user (drag into / out of a group, "Add to new group"...).
    for (const t of above) {
      const pin = pinById(pinIdOf(t.id));
      if (!pin) continue;
      if (!(t.groupId > -1)) pin.group = undefined;
      else pin.group = state.groupMap[t.groupId] ?? (await adoptChromeGroup(t.groupId, spaceId));
    }
    dropEmptyGroups(groupsBefore);
    const pinOrder = uniqueOrder(above.map((t) => pinIdOf(t.id)), pinById);
    const set = new Set(pinOrder);
    let j = 0;
    state.pins = state.pins.map((p) => (set.has(p.id) ? pinById(pinOrder[j++]) : p));
  }

  if (favsReordered) await layoutAll();
  else await layout(windowId);
}

// ---------- Fav / Pin operations ----------

async function makeFav(tab) {
  if (favIdOf(tab.id) || !canKeep(tab)) return;
  if (pinIdOf(tab.id)) forgetPin(pinIdOf(tab.id));
  await bindOrAddFav(tab);
  await setPinned(tab, true);
  await layoutAll(); // every other window gets a sleeping copy
}

async function unFav(tab) {
  const favId = favIdOf(tab.id);
  if (!favId) return;
  await removeFav(favId, tab.id);
  await setPinned(tab, false);
  await moveBelowDivider(tab.id, tab.windowId);
  await layoutAll();
}

async function makePinTab(tab) {
  if (pinIdOf(tab.id) || !canKeep(tab)) return;
  if (favIdOf(tab.id)) await removeFav(favIdOf(tab.id), tab.id);
  addPin(tab, spaceOfWindow(tab.windowId, await windowTabs(tab.windowId)));
  await setPinned(tab, false);
  await layoutAll();
}

async function unPin(tab) {
  const pinId = pinIdOf(tab.id);
  if (pinId) forgetPin(pinId);
  await layout(tab.windowId); // the tab ends up right below the divider
}

async function toggleFav(tab) {
  if (favIdOf(tab.id)) await unFav(tab);
  else await makeFav(tab);
}

async function togglePin(tab) {
  if (isDivider(tab)) return;
  if (pinIdOf(tab.id)) await unPin(tab);
  else await makePinTab(tab);
}

/** User unpinned a Fav natively and the tab is still open: drop the Fav everywhere. */
async function confirmUnpin(tabId) {
  if (!pendingUnpin.delete(tabId)) return;
  const tab = await getTab(tabId);
  const favId = favIdOf(tabId);
  if (!tab || tab.pinned || !favId) return;
  await removeFav(favId, tabId);
  // Unpin from the menu drops the tab at the top of the pin area; push it below the line.
  // (A tab dragged somewhere else keeps its spot, so dragging a Fav into the pin area makes it a Pin.)
  const tabs = await windowTabs(tab.windowId);
  const cur = tabs.find((t) => t.id === tabId);
  if (cur && cur.index === tabs.filter((t) => t.pinned).length) await moveBelowDivider(tabId, tab.windowId);
  await syncFromPositions(tab.windowId);
  await layoutAll();
}

/** Index of a pin's slot (between the pins before and after it), for re-creating it. */
async function pinSlot(pin, windowId) {
  const tabs = await windowTabs(windowId);
  const pinTabs = tabs.filter((t) => pinIdOf(t.id) && !t.pinned);
  const divider = tabs.find(isDivider);
  const end = divider ? divider.index : tabs.filter((t) => t.pinned).length + pinTabs.length;
  return insertIndexFor(state.pins, pin.id, pinTabs, state.tabToPin, end);
}

/** Re-open a closed pin, asleep, at its home URL and in its slot. */
async function recreatePin(pin, windowId) {
  const index = await pinSlot(pin, windowId);
  const tab = await createSelf({ windowId, url: sleepingUrl(pin), active: false, index });
  state.tabToPin[tab.id] = pin.id;
  pendingDiscard.add(tab.id);
  await persist();
}

async function sleepTab(tabId) {
  pendingDiscard.delete(tabId);
  const tab = await getTab(tabId);
  if (!tab || tab.active || tab.discarded) return;
  const slept = await chrome.tabs.discard(tabId).catch(() => null);
  if (slept && slept.id !== tabId) remapTab(tabId, slept.id);
}

const itemOf = (tab) => favById(favIdOf(tab.id)) ?? pinById(pinIdOf(tab.id));

async function resetToHome(tab) {
  const item = itemOf(tab);
  if (item && isOpenableUrl(item.url) && normalizeUrl(tabUrl(tab)) !== normalizeUrl(item.url)) await chrome.tabs.update(tab.id, { url: item.url });
}

async function setHome(tab) {
  const item = itemOf(tab);
  if (!item || !canKeep(tab)) return;
  item.url = tabUrl(tab);
  item.title = tab.title || item.url;
  await persist();
}

async function activate(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function gotoFav(n, windowId) {
  const fav = state.favs[n - 1];
  if (!fav) return;
  await layout(windowId); // makes sure this window has it
  const copies = (await Promise.all(tabsIn(state.tabToFav, fav.id).map(getTab))).filter(Boolean);
  const target = copies.find((t) => t.windowId === windowId);
  if (target) await activate(target);
}

async function gotoPin(n, windowId) {
  if (!(await isNormalWindow(windowId))) return;
  const spaceId = spaceOfWindow(windowId, await windowTabs(windowId));
  const ordered = displayOrder(state.pins.filter((p) => p.space === spaceId), state.groups.filter((g) => g.space === spaceId))
    .flatMap((x) => (x.pin ? [x.pin] : x.pins));
  const pin = ordered[n - 1];
  if (!pin) return;
  const copies = (await Promise.all(tabsIn(state.tabToPin, pin.id).map(getTab))).filter(Boolean);
  const target = copies.find((t) => t.windowId === windowId) ?? copies[0];
  if (target) return activate(target);
  if (!isOpenableUrl(pin.url)) return;
  const index = await pinSlot(pin, windowId);
  const tab = await createSelf({ windowId, url: pin.url, active: true, index });
  state.tabToPin[tab.id] = pin.id;
  await layout(windowId);
}

/**
 * The divider got selected. A click shows the control panel (the divider page). But Chrome also
 * selects it by itself right after a Space switch or after closing the tab next to it: then move on.
 */
async function onDividerActivated(divider) {
  const byChrome = Date.now() < switchingUntil || Date.now() - (closedAt[divider.windowId] ?? 0) < 600;
  if (!byChrome) return;
  const cur = await getTab(divider.id);
  if (!cur?.active) return;
  const tabs = await windowTabs(divider.windowId);
  const prev = tabs.find((t) => t.id === lastActive[divider.windowId] && !isDivider(t));
  const target = prev ?? tabs[cur.index + 1] ?? tabs[cur.index - 1];
  if (target && target.id !== divider.id) await chrome.tabs.update(target.id, { active: true });
}
const closedAt = {}; // windowId -> when a tab was last closed

/** Panel with the name field of this tab's Fav / Pin focused. */
async function openRename(tab) {
  const fav = favIdOf(tab.id);
  const pin = pinIdOf(tab.id);
  if (!fav && !pin) return;
  await openPanel(tab.windowId, fav ? `rename=fav:${fav}` : `rename=pin:${pin}`);
}

/** Show the control panel of a window; `focus` = true / 'rename=…' focuses a field (via the URL hash). */
async function openPanel(windowId, focus = false) {
  if (!(await isNormalWindow(windowId))) return;
  await layout(windowId);
  const divider = (await windowTabs(windowId)).find(isDivider);
  if (!divider) return;
  const url = rawUrl(divider).split('#')[0];
  const hash = focus === true ? 'new' : focus || '';
  if (hash) await chrome.tabs.update(divider.id, { url: `${url}#${hash}` }); // hash only: no reload
  await chrome.tabs.update(divider.id, { active: true });
  await chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

// ---------- Spaces ----------
//
// A Space = its pins + divider + tabs. A window shows one Space. Switching saves the shown Space's
// tabs (URL + title) and closes them, then re-opens the target Space's pins and tabs asleep
// (placeholder pages, nothing loads until clicked). Favs stay put. No hidden windows, but pages
// that were open start fresh when you come back (scroll position / form input are not kept).

const switchClosing = new Set(); // tabs closed by a Space switch: not "the user closed a pin"

/** Show `target` (a Space id, or +1 / -1 to cycle) in a window. */
async function switchSpace(windowId, target) {
  if (!(await isNormalWindow(windowId))) return;
  let tabs = await windowTabs(windowId);
  const currentId = spaceOfWindow(windowId, tabs);
  const targetId = typeof target === 'number' ? cycleSpace(state.spaces, currentId, target) : target;
  const space = spaceById(targetId);
  if (!space || targetId === currentId) return;
  switchingUntil = Date.now() + SWITCH_GRACE_MS;

  // 1. Save the current Space: its normal tabs, and what was selected.
  const outgoing = tabs.filter((t) => !t.pinned);
  const saved = [];
  let active = null;
  for (const t of outgoing) {
    if (isDivider(t)) continue;
    if (pinIdOf(t.id)) {
      if (t.active) active = { pin: pinIdOf(t.id) };
      continue;
    }
    if (!isPinnableUrl(tabUrl(t))) continue; // new tab / blank pages are not worth keeping
    if (t.active) active = { tab: saved.length };
    saved.push({ url: tabUrl(t), title: t.title || tabUrl(t), seen: t.active ? Date.now() : lastUsed(t, Date.now()) });
  }
  state.spaceTabs[currentId] = saved;
  state.spaceActive[currentId] = active;

  // 2. Open the target Space: pins, divider, tabs. All asleep except the one to show.
  const want = state.spaceActive[targetId];
  const pins = state.pins.filter((p) => p.space === targetId);
  const items = state.spaceTabs[targetId] ?? [];
  const showPin = pins.find((p) => p.id === want?.pin);
  const showTab = !showPin && items.length ? Math.min(want?.tab ?? 0, items.length - 1) : -1;
  // Arrive with the Space's Pin groups collapsed (Chrome can't collapse the group of the shown tab).
  if (state.settings.collapseGroupsOnSwitch) {
    for (const g of state.groups.filter((g) => g.space === targetId)) g.collapsed = showPin?.group !== g.id;
  }
  const open = async (item, isShown, index) => {
    const props = { windowId, url: isShown ? item.url : sleepingUrl(item), active: isShown };
    if (index !== undefined) props.index = index;
    const tab = await createSelf(props);
    if (!isShown) pendingDiscard.add(tab.id);
    if (!item.space) state.lastSeen[tab.id] = isShown ? Date.now() : item.seen ?? Date.now(); // its age carries over
    if (!isShown && !item.space && isWakeableUrl(item.url)) state.sleepers[tab.id] = { w: windowId, url: item.url, title: item.title };
    return tab;
  };
  const openPin = async (pin, index) => {
    const tab = await open(pin, pin === showPin, index);
    state.tabToPin[tab.id] = pin.id;
  };

  // Calls below are fired together instead of one by one: Chrome runs them in order, so tabs still
  // line up. Pins go in display order (groups already together) right after the Favs, so the
  // final layout pass has little to move.
  const base = tabs.filter((t) => t.pinned).length;
  const ordered = displayOrder(pins, state.groups.filter((g) => g.space === targetId)).flatMap((x) => (x.pin ? [x.pin] : x.pins));
  state.windowSpace[windowId] = targetId;

  // 1. The tab to show comes first, so the window shows the new Space right away.
  const shownItem = showTab >= 0 ? items[showTab] : null;
  let shownTab = null;
  if (showPin) await openPin(showPin, base + ordered.indexOf(showPin));
  else if (shownItem) shownTab = await open(shownItem, true);
  else await createSelf({ windowId, url: 'chrome://newtab/', active: true });

  // 2. Save, then close the old Space's tabs while the new ones are being opened.
  // (The target's saved tabs stay stored until they are open again.)
  await chrome.storage.local.set({ spaceTabs: state.spaceTabs, spaceActive: state.spaceActive });
  for (const t of outgoing) {
    delete state.tabToPin[t.id];
    delete state.sleepers[t.id];
    switchClosing.add(t.id);
  }
  const closing = chrome.tabs.remove(outgoing.map((t) => t.id)).catch(async () => {
    for (const t of outgoing) await chrome.tabs.remove(t.id).catch(() => switchClosing.delete(t.id));
  });
  const opening = Promise.all([
    ...ordered.map((pin, i) => (pin === showPin ? null : openPin(pin, base + i))),
    createSelf({ windowId, url: dividerFor(space), active: false, index: base + ordered.length }),
    ...items.map((item, i) => (i === showTab ? null : open(item, false))),
  ]);
  await Promise.all([closing, opening]);
  delete state.spaceTabs[targetId];
  await chrome.storage.local.set({ spaceTabs: state.spaceTabs });
  // The shown tab was opened first, at the end: put it back in its place among the tabs.
  if (shownTab) await chrome.tabs.move(shownTab.id, { index: base + ordered.length + 1 + showTab }).catch(() => {});
  await layout(windowId);
  switchingUntil = Date.now() + SWITCH_GRACE_MS;
}

/** Next free "Space N" name. */
function defaultSpaceName() {
  const used = new Set(state.spaces.map((s) => s.name));
  let n = state.spaces.length + 1;
  while (used.has(`Space ${n}`)) n++;
  return `Space ${n}`;
}

async function newSpace(windowId, name) {
  const space = { id: crypto.randomUUID(), name: cleanName(name) || defaultSpaceName() };
  state.spaces.push(space);
  await persist();
  if (windowId !== undefined) await switchSpace(windowId, space.id);
  await layoutAll(); // other windows' dividers now show their Space name
  return space;
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

async function renameSpace(spaceId, name) {
  const space = spaceById(spaceId);
  const clean = cleanName(name);
  if (!space || !clean || clean === space.name) return;
  space.name = clean;
  await persist();
  await layoutAll(); // dividers show the new name
}

/**
 * Delete a Space with its pins and saved tabs. Windows showing it switch to a neighbour first
 * (closing its tabs). The last Space cannot be deleted.
 */
async function deleteSpace(spaceId) {
  if (!spaceById(spaceId) || state.spaces.length < 2) return;
  const i = state.spaces.findIndex((s) => s.id === spaceId);
  const fallback = state.spaces[i === 0 ? 1 : i - 1].id;
  for (const w of await normalWindowIds()) {
    if (spaceOfWindow(w, await windowTabs(w)) === spaceId) await switchSpace(w, fallback);
  }
  const gone = spaceById(spaceId);
  if (gone?.bm) state.bmTrash.push(gone.bm); // removes its pins' bookmarks too
  state.spaces = state.spaces.filter((s) => s.id !== spaceId);
  for (const pin of state.pins.filter((p) => p.space === spaceId)) forgetPin(pin.id, false);
  state.groups = state.groups.filter((g) => g.space !== spaceId);
  delete state.spaceTabs[spaceId];
  delete state.spaceActive[spaceId];
  await chrome.storage.local.set({ spaceTabs: state.spaceTabs, spaceActive: state.spaceActive });
  await persist();
  await layoutAll(); // with one Space left, dividers drop the name
}

// ---------- archive (Arc's auto-archive and "Clear unpinned") ----------
//
// Normal tabs below the divider that were not selected for N hours are closed and listed in the
// panel's archive. Never archived automatically: Favs, Pins, the divider, the selected tab of each
// window, tabs playing sound, and tabs in a (user) tab group. Hidden Spaces' saved tabs age out
// the same way, by when they were last used.

const ARCHIVE_ALARM = 'pinline-archive';
const ARCHIVE_EVERY_MIN = 15;

/** When a tab was last used: our own record, else Chrome's lastAccessed, else from now on. */
function lastUsed(tab, now) {
  const seen = state.lastSeen[tab.id] ?? tab.lastAccessed;
  if (Number.isFinite(seen) && seen > 0) return seen;
  state.lastSeen[tab.id] = now;
  return now;
}

/** Archive entry for a tab or a saved tab (null for pages not worth keeping: new tab, blank...). */
function archiveEntry({ url, title, favIconUrl }, spaceId, now) {
  if (!isPinnableUrl(url)) return null;
  const icon = /^(https?:|data:image\/)/.test(favIconUrl ?? '') ? favIconUrl : undefined;
  return { id: crypto.randomUUID(), url, title: title || url, favIconUrl: icon, spaceId, archivedAt: now };
}

let lastArchive = null;
async function saveArchive() {
  const json = JSON.stringify(state.archive);
  if (json === lastArchive) return;
  lastArchive = json;
  await chrome.storage.local.set({ archive: state.archive });
}

/** Close tabs and put them into the archive (newest first). */
async function archiveTabs(tabs, spaceId, now = Date.now()) {
  const entries = tabs
    .map((t) => archiveEntry({ url: tabUrl(t), title: t.title, favIconUrl: isPlaceholder(t) ? undefined : t.favIconUrl }, spaceId, now))
    .filter(Boolean);
  state.archive = pushArchive(state.archive, entries);
  await saveArchive(); // saved before closing: nothing is lost if the browser dies in between
  for (const t of tabs) {
    delete state.sleepers[t.id];
    pendingDiscard.delete(t.id);
  }
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(async () => {
    for (const t of tabs) await chrome.tabs.remove(t.id).catch(() => {});
  });
}

/** One auto-archive pass (the alarm runs it every 15 minutes). `now` can be faked for tests. */
async function archivePass(now = Date.now()) {
  const hours = state.settings.archiveAfterHours;
  if (!state.ready || !hours) return 0;
  let count = 0;
  const shown = new Set();
  for (const windowId of await normalWindowIds()) {
    const tabs = await windowTabs(windowId);
    const spaceId = spaceOfWindow(windowId, tabs);
    shown.add(spaceId);
    const d = tabs.findIndex(isDivider);
    const stale = [];
    for (const t of tabs) {
      if (t.active) {
        if (!isDivider(t)) state.lastSeen[t.id] = now; // in use right now
        continue;
      }
      const protectedTab = t.pinned || favIdOf(t.id) || pinIdOf(t.id) || isDivider(t) || t.audible || t.groupId > -1 || (d >= 0 && t.index < d);
      if (!protectedTab && isStale(lastUsed(t, now), now, hours)) stale.push(t);
    }
    if (stale.length) await archiveTabs(stale, spaceId, now);
    count += stale.length;
  }

  // Hidden Spaces: their saved tabs age out too.
  let changed = false;
  for (const [spaceId, items] of Object.entries(state.spaceTabs)) {
    if (shown.has(spaceId) || !Array.isArray(items)) continue;
    const r = ageOutSaved(items, state.spaceActive[spaceId], now, hours);
    if (!r.gone.length && r.keep.every((x, i) => x === items[i])) continue;
    changed = true;
    state.spaceTabs[spaceId] = r.keep;
    state.spaceActive[spaceId] = r.active;
    state.archive = pushArchive(state.archive, r.gone.map((it) => archiveEntry(it, spaceId, now)).filter(Boolean));
    count += r.gone.length;
  }
  if (changed) {
    await saveArchive();
    await chrome.storage.local.set({ spaceTabs: state.spaceTabs, spaceActive: state.spaceActive });
  }
  await persist();
  return count;
}

/** Arc's ⌘⇧K: archive every normal tab below the divider of a window. */
async function clearUnpinned(windowId) {
  if (!(await isNormalWindow(windowId))) return 0;
  await layout(windowId);
  const tabs = await windowTabs(windowId);
  const d = tabs.findIndex(isDivider);
  if (d < 0) return 0;
  // An empty new tab that is selected stays: it is where you go next anyway.
  const below = tabs.slice(d + 1).filter((t) => !t.pinned && !favIdOf(t.id) && !pinIdOf(t.id) && !(t.active && !isPinnableUrl(tabUrl(t))));
  if (!below.length) return 0;
  // Never leave the window on a closing tab: Chrome would pick a neighbour (often the divider).
  if (below.some((t) => t.active)) await createSelf({ windowId, url: 'chrome://newtab/', active: true });
  await archiveTabs(below, spaceOfWindow(windowId, tabs));
  await layout(windowId);
  return below.length;
}

/** Re-open an archived tab in a window, right below the divider, and drop it from the archive. */
async function openArchived(entryId, windowId) {
  const entry = state.archive.find((e) => e.id === entryId);
  if (!entry || !(await isNormalWindow(windowId))) return;
  state.archive = state.archive.filter((e) => e !== entry);
  await saveArchive();
  if (!isOpenableUrl(entry.url)) return;
  const divider = (await windowTabs(windowId)).find(isDivider);
  const tab = await createSelf({ windowId, url: entry.url, active: true, ...(divider ? { index: divider.index + 1 } : {}) });
  state.lastSeen[tab.id] = Date.now();
  await layout(windowId);
  await chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

async function deleteArchived(entryId) {
  state.archive = state.archive.filter((e) => e.id !== entryId);
  await saveArchive();
}

async function clearArchive() {
  state.archive = [];
  await saveArchive();
}

async function setArchiveAfter(hours) {
  const h = Number(hours);
  if (!ARCHIVE_CHOICES.includes(h)) return;
  state.settings = { ...state.settings, archiveAfterHours: h };
  await chrome.storage.local.set({ settings: state.settings });
}

async function ensureArchiveAlarm() {
  if (!chrome.alarms) return;
  const a = await chrome.alarms.get(ARCHIVE_ALARM).catch(() => null);
  if (!a || a.periodInMinutes !== ARCHIVE_EVERY_MIN) {
    await chrome.alarms.create(ARCHIVE_ALARM, { delayInMinutes: ARCHIVE_EVERY_MIN, periodInMinutes: ARCHIVE_EVERY_MIN });
  }
}

// ---------- recent tabs (Arc's Ctrl+Tab) ----------
//
// Each window keeps its tabs in most-recently-used order. "mru-back" goes to the previous one;
// pressing it again within 1.5 s walks further back (like Alt-Tab), and only when you stop does
// the tab you landed on move to the front.

const MRU_WALK_MS = 1500;
let walk = null; // { windowId, list, pos, expect, timer }

let lastMru = '';
async function saveMru() {
  const json = JSON.stringify(state.mru);
  if (json === lastMru) return;
  lastMru = json;
  await chrome.storage.session.set({ mru: state.mru });
}

function useTab(windowId, tabId) {
  state.mru[windowId] = touchMru(state.mru[windowId], tabId);
}

async function endWalk() {
  if (!walk) return;
  clearTimeout(walk.timer);
  const { windowId, list, pos } = walk;
  walk = null;
  if (pos >= 0 && list[pos] !== undefined) useTab(windowId, list[pos]);
  await saveMru();
}

async function mruBack(windowId) {
  if (walk && walk.windowId !== windowId) await endWalk();
  const tabs = await windowTabs(windowId);
  const live = new Set(tabs.filter((t) => !isDivider(t)).map((t) => t.id));
  if (!walk) {
    const active = tabs.find((t) => t.active);
    let list = (state.mru[windowId] ?? []).filter((id) => live.has(id));
    // Tabs not seen since the list was started (e.g. after a restart) follow, by Chrome's lastAccessed.
    const when = (t) => state.lastSeen[t.id] ?? t.lastAccessed ?? 0;
    const rest = tabs.filter((t) => live.has(t.id) && !list.includes(t.id)).sort((x, y) => when(y) - when(x));
    list = [...list, ...rest.map((t) => t.id)];
    let pos = -1; // the panel (divider) is shown: the first press goes to the most recent tab
    if (active && live.has(active.id)) {
      list = [active.id, ...list.filter((id) => id !== active.id)];
      pos = 0;
    }
    if (list.length < (pos === 0 ? 2 : 1)) return;
    walk = { windowId, list, pos };
  }
  const at = walk.list[walk.pos];
  walk.list = walk.list.filter((id) => live.has(id)); // closed meanwhile
  if (!walk.list.length) return void (walk = null);
  walk.pos = (walk.list.indexOf(at) + 1) % walk.list.length;
  walk.expect = walk.list[walk.pos];
  clearTimeout(walk.timer);
  walk.timer = setTimeout(() => run(endWalk), MRU_WALK_MS);
  await chrome.tabs.update(walk.expect, { active: true }).catch(() => {});
}

// ---------- copy URL (Arc's ⌘⇧C) ----------

async function writeClipboard(text) {
  const url = chrome.runtime.getURL('src/offscreen.html');
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (!has) {
    await chrome.offscreen
      .createDocument({ url, reasons: ['CLIPBOARD'], justification: 'Copy the current page URL' })
      .catch((err) => {
        if (!/single offscreen/i.test(String(err))) throw err; // already being created
      });
  }
  const res = await chrome.runtime.sendMessage({ type: 'offscreen:copy', text });
  return !!res?.ok;
}

/** Copy the tab's URL (the real one for a sleeping placeholder) and flash a ✓ on the toolbar icon. */
async function copyUrl(tab) {
  const url = tabUrl(tab);
  if (!url || isDivider(tab)) return;
  const ok = await writeClipboard(url).catch(() => false);
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#1e8e3e' : '#d93025', tabId: tab.id }).catch(() => {});
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!', tabId: tab.id }).catch(() => {});
  await chrome.action.setTitle({ title: ok ? `已复制：${url}` : '复制失败', tabId: tab.id }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
    chrome.action.setTitle({ title: 'Pinline: pin / unpin current tab', tabId: tab.id }).catch(() => {});
  }, 1500);
  return ok;
}

// ---------- renaming Favs / Pins ----------

const ALL_SITES = { origins: ['<all_urls>'] };
const RETITLE_ID = 'pinline-retitle';
const canRetitle = () => chrome.permissions?.contains(ALL_SITES).catch(() => false) ?? false;

/** Run src/retitle.js only on the sites of renamed Favs / Pins (and only with the permission). */
async function syncRetitleScripts() {
  if (!chrome.scripting) return;
  const sites = new Set();
  if (await canRetitle()) {
    for (const it of [...state.favs, ...state.pins]) {
      if (!it.name || !isWakeableUrl(it.url)) continue;
      const u = new URL(it.url);
      sites.add(`${u.protocol}//${u.hostname}/*`); // match patterns have no port
    }
  }
  const matches = [...sites].sort();
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [RETITLE_ID] }).catch(() => []);
  if (!matches.length) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [RETITLE_ID] }).catch(() => {});
    return;
  }
  if (existing && existing.matches?.slice().sort().join() === matches.join()) return;
  const def = { id: RETITLE_ID, js: ['src/retitle.js'], matches, runAt: 'document_start', persistAcrossSessions: true };
  if (existing) await chrome.scripting.updateContentScripts([def]);
  else await chrome.scripting.registerContentScripts([def]);
}

/** Show an item's (new) name in every tab of it: placeholders are re-rendered, live pages told. */
async function applyName(item) {
  const tabIds = [...tabsIn(state.tabToFav, item.id), ...tabsIn(state.tabToPin, item.id)];
  for (const id of tabIds) {
    const t = await getTab(id);
    if (!t) continue;
    if (isPlaceholder(t)) {
      await chrome.tabs.update(id, { url: sleepingUrl(item) });
      pendingDiscard.add(id);
      continue;
    }
    try {
      await chrome.tabs.sendMessage(id, { type: 'title:set', name: item.name ?? '' });
    } catch {
      // Page loaded before the script was registered: inject it now (needs the permission).
      if (item.name && (await canRetitle())) {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/retitle.js'] }).catch(() => {});
      }
    }
  }
}

const itemByKind = (kind, id) => (kind === 'fav' ? favById(id) : kind === 'pin' ? pinById(id) : null);

/** Rename a Fav / Pin; an empty name goes back to the page's own title. */
async function renameItem(kind, id, name) {
  const item = itemByKind(kind, id);
  if (!item) return;
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const next = clean || undefined;
  if (next === item.name) return;
  item.name = next;
  await persist(); // also syncs the bookmark title
  await syncRetitleScripts();
  await applyName(item);
}

/** Favs and the shown Space's Pins, for the panel's name list. */
async function listItems(windowId) {
  const spaceId = windowId !== undefined && (await isNormalWindow(windowId)) ? spaceOfWindow(windowId, await windowTabs(windowId)) : null;
  const view = (kind) => (it) => ({ kind, id: it.id, url: it.url, title: it.title, name: it.name ?? '', group: it.group ?? null });
  return [...state.favs.map(view('fav')), ...state.pins.filter((p) => p.space === spaceId).map(view('pin'))];
}

/** Pin groups of the window's shown Space, for the panel's name tree. */
async function listGroups(windowId) {
  const spaceId = windowId !== undefined && (await isNormalWindow(windowId)) ? spaceOfWindow(windowId, await windowTabs(windowId)) : null;
  return state.groups.filter((g) => g.space === spaceId).map((g) => ({ id: g.id, title: g.title, color: g.color }));
}

/** Data for the "Manage Spaces" page. */
async function listSpaces(windowId) {
  const current = windowId !== undefined && (await isNormalWindow(windowId)) ? spaceOfWindow(windowId, await windowTabs(windowId)) : null;
  return state.spaces.map((s) => ({
    id: s.id,
    name: s.name,
    current: s.id === current,
    pins: state.pins.filter((p) => p.space === s.id).length,
    tabs: s.id === current ? null : (state.spaceTabs[s.id] ?? []).length,
  }));
}


/**
 * After install/startup: tab ids changed, so re-bind Favs (native pinned tabs, per window) and Pins
 * (tabs above a divider), adopt strays, re-open missing ones, then lay every window out.
 */
async function reconcile() {
  const all = await chrome.tabs.query({});
  const live = new Set(all.map((t) => t.id));
  for (const map of [state.tabToFav, state.tabToPin])
    for (const tabId of Object.keys(map)) if (!live.has(Number(tabId))) delete map[tabId];
  const seenBefore = { ...state.lastSeen };
  for (const tabId of Object.keys(state.lastSeen)) if (!live.has(Number(tabId))) delete state.lastSeen[tabId];

  ensureSpaces();
  const windowIds = await normalWindowIds();

  // Sleeping tabs are our own pages, so Chrome closes them when the extension reloads: re-open them.
  const lost = Object.entries(state.sleepers).filter(([tabId]) => !live.has(Number(tabId)));
  for (const [tabId, s] of lost) {
    delete state.sleepers[tabId];
    if (!windowIds.includes(s.w)) continue;
    const tab = await createSelf({ windowId: s.w, url: sleepUrl(sleepBase(), s), active: false });
    pendingDiscard.add(tab.id);
    state.sleepers[tab.id] = s;
    if (seenBefore[tabId]) state.lastSeen[tab.id] = seenBefore[tabId]; // keeps its age for auto-archive
  }
  if (lost.length) all.push(...(await chrome.tabs.query({})).filter((t) => !live.has(t.id)));
  const pinCandidates = []; // [tab, spaceId]
  for (const windowId of windowIds) {
    const tabs = all.filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);

    // Favs: each window has its own copy of every Fav.
    const pinned = tabs.filter((t) => t.pinned && !favIdOf(t.id)).map((t) => ({ ...t, url: tabUrl(t) }));
    const boundHere = new Set(tabs.map((t) => favIdOf(t.id)).filter(Boolean));
    const { matches, unclaimedTabs } = matchPinsToTabs(state.favs.filter((f) => !boundHere.has(f.id)), pinned);
    for (const [tabId, favId] of matches) state.tabToFav[tabId] = favId;
    for (const t of unclaimedTabs) if (canKeep(t)) await bindOrAddFav(t);

    const spaceId = spaceOfWindow(windowId, tabs);
    state.windowSpace[windowId] = spaceId;
    const divider = tabs.find(isDivider);
    if (divider) {
      for (const t of tabs) {
        if (t.index < divider.index && !t.pinned && !isDivider(t) && !pinIdOf(t.id)) pinCandidates.push([{ ...t, url: tabUrl(t) }, spaceId]);
      }
    } else {
      // No divider (e.g. Chrome closed it when the extension reloaded). Bindings normally survive
      // that, so this only recovers pins whose binding was lost: take the leading tabs that are
      // exactly the URL of an unbound pin of this Space. Never adopt anything else, and never match
      // by site: a normal tab on the same site as a pin must stay a normal tab.
      const bound = new Set(Object.values(state.tabToPin));
      const free = new Map();
      for (const p of state.pins) if (p.space === spaceId && !bound.has(p.id)) free.set(normalizeUrl(p.url), p);
      for (const t of tabs.filter((t) => !t.pinned)) {
        if (pinIdOf(t.id)) continue;
        const pin = free.get(normalizeUrl(tabUrl(t)));
        if (!pin) break;
        free.delete(normalizeUrl(tabUrl(t)));
        state.tabToPin[t.id] = pin.id;
      }
    }
  }

  const boundPins = new Set(Object.values(state.tabToPin));
  const missing = [];
  for (const space of state.spaces) {
    const free = state.pins.filter((p) => p.space === space.id && !boundPins.has(p.id));
    const candidates = pinCandidates.filter(([, s]) => s === space.id).map(([t]) => t);
    const r = matchPinsToTabs(free, candidates);
    for (const [tabId, pinId] of r.matches) state.tabToPin[tabId] = pinId;
    for (const t of r.unclaimedTabs) if (canKeep(t)) addPin(t, space.id);
    missing.push(...r.missing);
  }

  mergeDuplicateFavs();

  // Chrome tab groups holding pins (restored by Chrome with new ids): bind them back to Pin groups.
  for (const t of await chrome.tabs.query({})) {
    if (!(t.groupId > -1) || state.groupMap[t.groupId]) continue;
    const pin = pinById(pinIdOf(t.id));
    if (pin?.group && !Object.values(state.groupMap).includes(pin.group)) state.groupMap[t.groupId] = pin.group;
  }

  state.ready = true;
  await persist();

  // Re-open missing pins in a window showing their Space (hidden Spaces open theirs on switch).
  for (const pin of missing) {
    const where = windowIds.find((w) => state.windowSpace[w] === pin.space);
    if (where) await recreatePin(pin, where);
  }
  await layoutAll();
  await syncBookmarks(); // pick up changes made on other devices while we were not running
  await syncRetitleScripts();
}

// ---------- bookmarks ----------

const BOOKMARK_DEBOUNCE_MS = 300;
let bmTimer = null;
function scheduleBookmarkSync() {
  clearTimeout(bmTimer);
  bmTimer = setTimeout(() => run(syncBookmarks), BOOKMARK_DEBOUNCE_MS);
}

/** Where the Pinline folder goes: "Other bookmarks". */
async function bookmarkParent() {
  const [root] = await chrome.bookmarks.getTree();
  const kids = root.children ?? [];
  return (kids.find((n) => n.folderType === 'other') ?? kids.find((n) => n.id === '2') ?? kids[1] ?? kids[0]).id;
}
const subtree = async (id) => (id ? (await chrome.bookmarks.getSubTree(id).catch(() => []))[0] ?? null : null);

/** Pull bookmark changes in, then push Pinline's state out. Runs debounced, off the hot path. */
async function syncBookmarks() {
  if (!state.ready || !chrome.bookmarks) return;
  bmSyncing = true;
  try {
    const parentId = await bookmarkParent();
    let root = await subtree(state.bm.root);
    let base = bmBase;
    if (!root || root.url) {
      // First run, reinstall, or the folder was deleted. Adopt a "Pinline" folder if there is one
      // (e.g. synced from another device), otherwise it is re-created from Pinline's state below.
      for (const it of [...state.favs, ...state.pins, ...state.spaces, ...state.groups]) it.bm = undefined;
      state.bm = {};
      base = { nodes: {}, order: {} };
      const found = (await chrome.bookmarks.getChildren(parentId)).find((n) => !n.url && n.title === ROOT_TITLE);
      root = found ? await subtree(found.id) : null;
      if (root) state.bm.root = root.id;
    }
    if (root) {
      const fx = mergeFromBookmarks(state, root, base, new Set(state.bmTrash), () => crypto.randomUUID());
      ensureSpaces();
      await applyBookmarkEffects(fx);
    }
    for (const id of state.bmTrash) await chrome.bookmarks.removeTree(id).catch(() => {});
    state.bmTrash = [];
    await mirrorToBookmarks(state, chrome.bookmarks, parentId);
    bmBase = snapshot(await subtree(state.bm.root));
    await chrome.storage.local.set({ bmBase });
    await persist();
  } finally {
    bmSyncing = false;
  }
}

/** Make tabs follow what changed in bookmarks. */
async function applyBookmarkEffects(fx) {
  if (fx.renamed?.length) {
    await syncRetitleScripts();
    for (const id of fx.renamed) {
      const it = favById(id) ?? pinById(id);
      if (it) await applyName(it);
    }
  }
  for (const favId of fx.removedFavs) await removeFav(favId, undefined, false);
  for (const pinId of [...fx.removedPins, ...fx.movedPins]) {
    for (const tabId of tabsIn(state.tabToPin, pinId)) delete state.tabToPin[tabId]; // the tab stays, as a normal tab
  }
  const windows = await normalWindowIds();
  for (const pinId of [...fx.addedPins, ...fx.movedPins]) {
    const pin = pinById(pinId);
    const where = pin && windows.find((w) => state.windowSpace[w] === pin.space);
    if (where && !tabsIn(state.tabToPin, pinId).length) await recreatePin(pin, where);
  }
  await layoutAll();
}

/** "Import from bookmarks": a new Space whose Pins are the bookmarks directly inside `folderId`. */
async function importFolderAsSpace(folderId, windowId) {
  const [folder] = await chrome.bookmarks.get(folderId).catch(() => []);
  if (!folder || folder.url) return;
  const children = await chrome.bookmarks.getChildren(folderId);
  const space = { id: crypto.randomUUID(), name: cleanName(folder.title) || defaultSpaceName() };
  state.spaces.push(space);
  const addLink = (n, group) => state.pins.push({ ...makeItem(crypto.randomUUID(), { url: n.url, title: n.title }), space: space.id, group });
  for (const n of children) {
    if (n.url && !isOpenableUrl(n.url)) continue;
    if (n.url) {
      addLink(n);
      continue;
    }
    // Each sub-folder becomes a Pin group; folders deeper inside it are flattened into that group.
    const [tree] = await chrome.bookmarks.getSubTree(n.id);
    const links = [];
    const collect = (node) => (node.children ?? []).forEach((c) => (c.url ? isOpenableUrl(c.url) && links.push(c) : collect(c)));
    collect(tree);
    if (!links.length) continue;
    const group = { id: crypto.randomUUID(), space: space.id, title: cleanName(n.title), color: 'grey', collapsed: false };
    state.groups.push(group);
    for (const c of links) addLink(c, group.id);
  }
  await persist();
  if (windowId !== undefined) await switchSpace(windowId, space.id);
  await layoutAll();
}

// ---------- context menu ----------

const MENU = {
  fav: 'pinline-fav',
  pin: 'pinline-pin',
  reset: 'pinline-reset',
  home: 'pinline-home',
  rename: 'pinline-rename',
  newSpace: 'pinline-new-space',
  nextSpace: 'pinline-next-space',
  manageSpaces: 'pinline-manage-spaces',
  clearUnpinned: 'pinline-clear-unpinned',
};

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const items = [
      [MENU.fav, '设为 Fav / 取消 Fav'],
      [MENU.pin, '设为 Pin / 取消 Pin'],
      [MENU.reset, '回到固定时的网址'],
      [MENU.home, '把当前网址设为固定网址'],
      [MENU.rename, '重命名 Fav / Pin…'],
      [MENU.newSpace, '新建 Space…'],
      [MENU.nextSpace, '切到下一个 Space'],
      [MENU.clearUnpinned, '归档分割线下方的所有标签'],
      [MENU.manageSpaces, '打开 Pinline 面板（Space / 设置）'],
    ];
    for (const [id, title] of items) {
      // "tab" = native tab strip context menu (newer Chrome); fall back to the toolbar icon menu.
      chrome.contextMenus.create({ id, title, contexts: ['tab', 'action'] }, () => {
        if (chrome.runtime.lastError) chrome.contextMenus.create({ id, title, contexts: ['action'] });
      });
    }
  });
}

// ---------- event wiring (registered synchronously at top level, as MV3 requires) ----------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  createMenus();
  run(ensureArchiveAlarm);
  // A Chrome update also fires onStartup, which reconciles after session restore: don't race it.
  if (reason !== 'chrome_update' && reason !== 'shared_module_update') run(reconcile);
});

/** Session restore adds tabs over a few seconds: wait until the tab count stops changing. */
async function waitForRestore() {
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < 15000) {
    await new Promise((r) => setTimeout(r, 400));
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const loading = tabs.filter((t) => !t.url && !t.pendingUrl).length;
    stable = tabs.length === last && !loading ? stable + 1 : 0;
    last = tabs.length;
    if (stable >= 3 && Date.now() - start > 1500) return;
  }
}

chrome.runtime.onStartup.addListener(() => {
  run(() => {
    // New browser session: tab and window ids from the last one mean nothing (and may be reused).
    state.tabToFav = {};
    state.tabToPin = {};
    state.windowSpace = {};
    state.sleepers = {};
    state.groupMap = {};
    state.lastSeen = {}; // tabs restored by Chrome fall back to Tab.lastAccessed
    state.mru = {};
  });
  run(ensureArchiveAlarm);
  // Wait until Chrome has restored the session before deciding what is missing.
  run(() => waitForRestore().then(reconcile));
});

chrome.windows.onCreated.addListener((win) => {
  if (win.type !== 'normal' || win.incognito) return;
  setTimeout(() => run(() => layout(win.id)), WINDOW_SETTLE_MS);
});

chrome.tabs.onCreated.addListener((tab) => {
  run(async () => {
    state.lastSeen[tab.id] ??= Date.now(); // a new tab counts as just used (unless we set its age)
    if (selfCreated.delete(tab.id) || !state.ready) return;
    const cur = await getTab(tab.id); // the event's snapshot may be stale by now
    if (!cur || favIdOf(cur.id) || pinIdOf(cur.id)) return;
    tab = cur;
    if (!(await isNormalWindow(tab.windowId))) return;
    if (tab.pinned) return makeFav(tab);
    // New tabs never start out as Pins: a link opened from a Fav/Pin lands above the line, move it below.
    await moveBelowDivider(tab.id, tab.windowId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  run(async () => {
    if ('pinned' in info && !selfPinOps.delete(tabId)) {
      if (info.pinned) {
        await makeFav(tab); // user right-click → Pin
      } else if (favIdOf(tabId)) {
        pendingUnpin.add(tabId); // right-click → Unpin, or Chrome closing the tab
        setTimeout(() => run(() => confirmUnpin(tabId)), UNPIN_CONFIRM_MS);
      }
    }
    if (state.sleepers[tabId] && info.url && !isPlaceholder(tab)) delete state.sleepers[tabId]; // woke up
    if ('groupId' in info && state.ready) queueSync(tab.windowId); // dragged into / out of a group
    if (pendingDiscard.has(tabId) && isPlaceholder(tab)) {
      // Wait for the favicon so the sleeping tab keeps its icon; fall back after a second.
      if (info.favIconUrl) await sleepTab(tabId);
      else if (info.status === 'complete') setTimeout(() => run(() => pendingDiscard.has(tabId) && sleepTab(tabId)), 1000);
    } else if (pendingDiscard.has(tabId) && (info.status === 'complete' || info.url)) {
      await sleepTab(tabId);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  closedAt[windowId] = Date.now();
  run(async () => {
    delete state.lastSeen[tabId];
    if (state.mru[windowId]?.includes(tabId)) {
      state.mru[windowId] = state.mru[windowId].filter((id) => id !== tabId);
      await saveMru();
    }
    if (switchClosing.delete(tabId)) return;
    delete state.sleepers[tabId];
    pendingDiscard.delete(tabId);
    pendingUnpin.delete(tabId); // that "unpin" was just Chrome closing the tab
    selfPinOps.delete(tabId);
    selfCreated.delete(tabId);
    delete state.tabToFav[tabId]; // layout() re-opens it asleep
    const pinId = pinIdOf(tabId);
    if (pinId) {
      delete state.tabToPin[tabId];
      const pin = pinById(pinId);
      // Re-create unless this window still has a live tab of it. Other windows (the same Space shown
      // twice) and stale ids left behind must not keep a closed pin from coming back.
      if (!isWindowClosing && pin) {
        let stillHere = false;
        for (const id of tabsIn(state.tabToPin, pinId)) {
          // Missing tabs are only ignored, not unbound: a tab being discarded briefly has no id.
          const t = await getTab(id);
          if (t?.windowId === windowId) stillHere = true;
        }
        if (!stillHere) await recreatePin(pin, windowId);
      }
    }
    // Window closing: keep everything, reconcile() re-binds next start. Otherwise re-open what was closed.
    if (isWindowClosing) await persist();
    else await layout(windowId);
  });
});

// Pin groups follow their Chrome tab group: rename / recolour / collapse in the tab strip.
chrome.tabGroups?.onUpdated.addListener((g) => {
  run(async () => {
    const group = groupById(state.groupMap[g.id]);
    if (!group) return;
    const color = GROUP_COLORS.includes(g.color) ? g.color : group.color;
    if (group.title === g.title && group.color === color && group.collapsed === g.collapsed) return;
    Object.assign(group, { title: g.title, color, collapsed: g.collapsed });
    await persist();
  });
});
chrome.tabGroups?.onRemoved.addListener((g) => {
  run(async () => {
    delete state.groupMap[g.id]; // the Pin group stays; it comes back when its pins do
    await persist();
  });
});

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  run(async () => {
    remapTab(removedId, addedId);
    await saveMru();
    await persist();
  });
});

/**
 * Re-read a window's arrangement once per burst of move / group events. Our own layout moves fire
 * these events too; while a sync for the window is already queued, more events add nothing.
 */
const syncQueued = new Set();
function queueSync(windowId) {
  if (syncQueued.has(windowId)) return;
  syncQueued.add(windowId);
  run(async () => {
    syncQueued.delete(windowId);
    if (state.ready) await syncFromPositions(windowId);
  });
}

chrome.tabs.onMoved.addListener((_tabId, { windowId }) => queueSync(windowId));
chrome.tabs.onAttached.addListener((_tabId, { newWindowId }) => queueSync(newWindowId));
chrome.tabs.onDetached.addListener((_tabId, { oldWindowId }) => run(() => layout(oldWindowId)));

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  run(async () => {
    const tab = await getTab(tabId);
    if (!tab) return;
    // Wait outside the queue so a matching onRemoved can arrive first without blocking other events.
    if (isDivider(tab)) return void setTimeout(() => run(() => onDividerActivated(tab)), 150);
    const now = Date.now();
    const prev = lastActive[windowId] ?? state.mru[windowId]?.[0];
    if (prev !== undefined && prev !== tabId && state.lastSeen[prev] !== undefined) state.lastSeen[prev] = now; // used until now
    state.lastSeen[tabId] = now;
    lastActive[windowId] = tabId;
    // Recent-tabs order: a step of an mru-back walk does not count until the walk ends.
    if (walk?.windowId === windowId && walk.expect === tabId) {
      // part of the walk
    } else {
      if (walk?.windowId === windowId) await endWalk(); // the user picked another tab mid-walk
      useTab(windowId, tabId);
      await saveMru();
    }
    await persist();
    // Wake a sleeping placeholder right away (its page also does this, but only once it is visible).
    if (isPlaceholder(tab) && isWakeableUrl(tabUrl(tab))) {
      pendingDiscard.delete(tabId);
      await chrome.tabs.update(tabId, { url: tabUrl(tab) });
    }
  });
});

// Bookmarks edited by the user (or by Chrome Sync from another device).
for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks?.[name]?.addListener(() => {
    if (!bmSyncing) scheduleBookmarkSync();
  });
}

chrome.permissions?.onAdded.addListener(() => run(async () => {
  await syncRetitleScripts();
  for (const it of [...state.favs, ...state.pins]) if (it.name) await applyName(it);
}));
chrome.permissions?.onRemoved.addListener(() => run(syncRetitleScripts));

// Requests from the "Manage Spaces" page (extension pages only).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  // From src/retitle.js in a page: what should this tab be called?
  if (msg?.type === 'title:get' && sender.tab) {
    const id = sender.tab.id;
    // Through the queue: a cold service worker must finish loading state first.
    run(() => sendResponse({ name: (favById(state.tabToFav[id]) ?? pinById(state.tabToPin[id]))?.name ?? null }));
    return true;
  }
  if (!/^(spaces|items|archive|settings):/.test(msg?.type ?? '')) return;
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return; // extension pages only
  const windowId = Number.isInteger(msg.windowId) ? msg.windowId : undefined;
  let result;
  run(async () => {
    if (msg.type === 'spaces:rename') await renameSpace(msg.id, msg.name);
    if (msg.type === 'items:rename') await renameItem(msg.kind, msg.id, msg.name);
    if (msg.type === 'spaces:delete') await deleteSpace(msg.id);
    if (msg.type === 'spaces:new') await newSpace(windowId, msg.name);
    if (msg.type === 'spaces:suggest') return void (result = { name: defaultSpaceName() });
    if (/^(archive|settings):/.test(msg.type)) {
      if (msg.type === 'settings:set' && 'archiveAfterHours' in msg) await setArchiveAfter(msg.archiveAfterHours);
      if (msg.type === 'settings:set' && typeof msg.collapseGroupsOnSwitch === 'boolean') {
        state.settings = { ...state.settings, collapseGroupsOnSwitch: msg.collapseGroupsOnSwitch };
        await chrome.storage.local.set({ settings: state.settings });
      }
      if (msg.type === 'archive:open' && windowId !== undefined) await openArchived(msg.id, windowId);
      if (msg.type === 'archive:delete') await deleteArchived(msg.id);
      if (msg.type === 'archive:clear') await clearArchive();
      let cleared;
      if (msg.type === 'archive:clear-unpinned' && windowId !== undefined) cleared = await clearUnpinned(windowId);
      return void (result = { archive: state.archive, settings: state.settings, cleared });
    }
    if (msg.type === 'spaces:import' && typeof msg.folderId === 'string') await importFolderAsSpace(msg.folderId, windowId);
    if (msg.type === 'spaces:switch' && windowId !== undefined) {
      await switchSpace(windowId, msg.id);
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    }
    result = {
      spaces: await listSpaces(windowId),
      items: await listItems(windowId),
      groups: await listGroups(windowId),
      canRetitle: await canRetitle(),
      bookmarkRoot: state.bm.root ?? null,
    };
  }).then(() => sendResponse(result ?? { error: 'failed' }));
  return true; // respond asynchronously
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === ARCHIVE_ALARM) run(() => archivePass());
});
run(ensureArchiveAlarm); // alarms may not survive a browser restart

chrome.action.onClicked.addListener((tab) => run(() => togglePin(tab)));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === MENU.fav) run(() => toggleFav(tab));
  if (info.menuItemId === MENU.pin) run(() => togglePin(tab));
  if (info.menuItemId === MENU.reset) run(() => resetToHome(tab));
  if (info.menuItemId === MENU.home) run(() => setHome(tab));
  if (info.menuItemId === MENU.rename) run(() => openRename(tab));
  if (info.menuItemId === MENU.newSpace) run(() => openPanel(tab.windowId, true));
  if (info.menuItemId === MENU.nextSpace) run(() => switchSpace(tab.windowId, 1));
  if (info.menuItemId === MENU.manageSpaces) run(() => openPanel(tab.windowId));
  if (info.menuItemId === MENU.clearUnpinned) run(() => clearUnpinned(tab.windowId));
});

chrome.commands.onCommand.addListener((command, tab) => {
  run(async () => {
    tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab) return;
    if (command === 'copy-url') return copyUrl(tab);
    if (command === 'toggle-fav') return toggleFav(tab);
    if (command === 'toggle-pin') return togglePin(tab);
    if (command === 'reset-pin') return resetToHome(tab);
    if (command === 'set-pin-home') return setHome(tab);
    if (command === 'next-space') return switchSpace(tab.windowId, 1);
    if (command === 'prev-space') return switchSpace(tab.windowId, -1);
    if (command === 'new-space') return openPanel(tab.windowId, true);
    if (command === 'manage-spaces') return openPanel(tab.windowId);
    if (command === 'clear-unpinned') return clearUnpinned(tab.windowId);
    if (command === 'mru-back') return mruBack(tab.windowId);
    let m = /^goto-fav-(\d)$/.exec(command);
    if (m) return gotoFav(Number(m[1]), tab.windowId);
    m = /^goto-pin-(\d)$/.exec(command);
    if (m) return gotoPin(Number(m[1]), tab.windowId);
  });
});

// Exposed for tests only.
export const __test = { state, ready: () => queue };
// Handle for the e2e test / debugging from the service worker console.
globalThis.pinline = {
  state,
  toggleFav: (tab) => run(() => toggleFav(tab)),
  togglePin: (tab) => run(() => togglePin(tab)),
  newSpace: (windowId, name) => run(() => newSpace(windowId, name)),
  switchSpace: (windowId, target) => run(() => switchSpace(windowId, target)),
  renameSpace: (id, name) => run(() => renameSpace(id, name)),
  deleteSpace: (id) => run(() => deleteSpace(id)),
  openPanel: (windowId, focusNew) => run(() => openPanel(windowId, focusNew)),
  renameItem: (kind, id, name) => run(() => renameItem(kind, id, name)),
  copyUrl: async (tabId) => copyUrl(await chrome.tabs.get(tabId)),
  syncBookmarks: () => run(syncBookmarks),
  archivePass: (now) => run(() => archivePass(now)),
  setArchiveAfter: (hours) => run(() => setArchiveAfter(hours)),
  clearUnpinned: (windowId) => run(() => clearUnpinned(windowId)),
  openArchived: (id, windowId) => run(() => openArchived(id, windowId)),
  mruBack: (windowId) => run(() => mruBack(windowId)),
};
