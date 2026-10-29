// Pure logic shared by the service worker and the tests. No chrome.* access here.

/** Strip the hash so `page#a` and `page#b` count as the same pin. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url ?? '';
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Pages we never treat as a pin (blank / new tab pages have no stable identity). */
export function isPinnableUrl(url) {
  if (!url) return false;
  return !/^(chrome:\/\/newtab|about:blank|chrome-search:)/.test(url);
}

export function makePin(id, tab) {
  return { id, url: tab.url, title: tab.title || tab.url };
}

// ---------- sleeping placeholder ----------
// A re-created pin opens our own lightweight page instead of the real site, so nothing loads
// until the user actually switches to it (see src/sleep.html).

export const SLEEP_PAGE = 'src/sleep.html';
/** The fake tab that draws the line between pins and other tabs (see src/divider.html). */
export const DIVIDER_PAGE = 'src/divider.html';

/** URL of an extension page tagged with a Space: `?space=<id>&name=<name>`. */
export function spaceUrl(base, space) {
  const u = new URL(base);
  if (space) {
    u.searchParams.set('space', space.id);
    u.searchParams.set('name', space.name);
  }
  return u.href;
}

/** Space id carried by such a URL (null if none / not ours). */
export function spaceIdFromUrl(base, url) {
  if (!url || !url.startsWith(base)) return null;
  try {
    return new URL(url).searchParams.get('space');
  } catch {
    return null;
  }
}

/** Next / previous Space id, wrapping around. */
export function cycleSpace(spaces, currentId, step = 1) {
  if (!spaces.length) return null;
  const i = Math.max(0, spaces.findIndex((s) => s.id === currentId));
  return spaces[(i + step + spaces.length) % spaces.length].id;
}

/** @param base  chrome.runtime.getURL(SLEEP_PAGE) */
export function sleepUrl(base, pin) {
  const u = new URL(base);
  u.searchParams.set('url', pin.url);
  u.searchParams.set('title', pin.title || pin.url);
  return u.href;
}

/** Real URL behind a placeholder, or null if `url` is not our placeholder. */
export function parseSleepUrl(base, url) {
  if (!url || !url.startsWith(base)) return null;
  try {
    return new URL(url).searchParams.get('url');
  } catch {
    return null;
  }
}

/** Only ever wake up to web pages (never javascript:, data:, etc.). */
export function isWakeableUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Pair pins with existing pinned tabs (used after a browser restart, when tab ids change).
 * Exact URL match first, then same-origin match, each tab claimed at most once.
 * @returns {{ matches: Array<[number, string]>, missing: object[], unclaimedTabs: object[] }}
 *          matches = [tabId, pinId] pairs
 */
export function matchPinsToTabs(pins, tabs) {
  const freeTabs = new Map(tabs.map((t) => [t.id, t]));
  const matches = [];
  const unmatched = [];

  for (const pin of pins) {
    const want = normalizeUrl(pin.url);
    const hit = [...freeTabs.values()].find((t) => normalizeUrl(t.url || t.pendingUrl) === want);
    if (hit) {
      matches.push([hit.id, pin.id]);
      freeTabs.delete(hit.id);
    } else {
      unmatched.push(pin);
    }
  }

  const missing = [];
  for (const pin of unmatched) {
    const origin = originOf(pin.url);
    const hit = origin && [...freeTabs.values()].find((t) => originOf(t.url || t.pendingUrl) === origin);
    if (hit) {
      matches.push([hit.id, pin.id]);
      freeTabs.delete(hit.id);
    } else {
      missing.push(pin);
    }
  }

  return { matches, missing, unclaimedTabs: [...freeTabs.values()] };
}

/**
 * Where to re-insert a pin so pinned tabs keep the pin order.
 * @param pins          ordered pin list
 * @param pinId         pin being re-created
 * @param pinnedTabs    pinned tabs of the window, sorted by index
 * @param tabToPin      map tabId -> pinId
 * @param end           index to use when the pin goes last
 */
export function insertIndexFor(pins, pinId, pinnedTabs, tabToPin, end = pinnedTabs.length) {
  const order = new Map(pins.map((p, i) => [p.id, i]));
  const mine = order.get(pinId) ?? Infinity;
  for (const t of pinnedTabs) {
    const other = tabToPin[t.id];
    if (other !== undefined && (order.get(other) ?? Infinity) > mine) return t.index;
  }
  return end;
}

/**
 * How one Space's pins are laid out: ungrouped pins in pin order, a group at the position of its
 * first pin with all its pins together. Groups without pins go last.
 * @returns Array<{ pin } | { group, pins }>
 */
export function displayOrder(pins, groups) {
  const known = new Map(groups.map((g) => [g.id, g]));
  const out = [];
  const done = new Set();
  for (const p of pins) {
    const g = p.group && known.get(p.group);
    if (!g) {
      out.push({ pin: p });
      continue;
    }
    if (done.has(g.id)) continue;
    done.add(g.id);
    out.push({ group: g, pins: pins.filter((q) => q.group === g.id) });
  }
  for (const g of groups) if (!done.has(g.id)) out.push({ group: g, pins: [] });
  return out;
}
