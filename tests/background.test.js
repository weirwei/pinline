import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, loadBackground } from './fake-chrome.js';
import { parseSleepUrl } from '../src/core.js';

const SLEEP = 'chrome-extension://fakeid/src/sleep.html';
const DIVIDER = 'chrome-extension://fakeid/src/divider.html';
const realUrl = (tab) => parseSleepUrl(SLEEP, tab.url) ?? tab.url;

const GMAIL = 'https://mail.google.com/';
const GH = 'https://github.com/';
const DOCS = 'https://docs.example.com/';

async function setup(opts = {}) {
  const fake = createFakeChrome({
    tabs: [
      { id: 1, url: GMAIL, active: true },
      { id: 2, url: GH },
      { id: 3, url: DOCS },
    ],
    ...opts,
  });
  const bg = await loadBackground(fake);
  const { chrome } = fake;
  const settle = () => fake.settle(bg);
  chrome.runtime.onInstalled.emit({ reason: 'install' });
  await settle();
  const command = async (name, tabId) => {
    chrome.commands.onCommand.emit(name, await chrome.tabs.get(tabId));
    await settle();
  };
  /** Window as a compact string: pins as P(url), divider as |, others as url. */
  const strip = async (windowId = 1) =>
    (await chrome.tabs.query({ windowId }))
      .sort((a, b) => a.index - b.index)
      .map((t) => {
        if (t.url.startsWith(DIVIDER)) return '|';
        const { tabToFav, tabToPin } = bg.__test.state;
        const zz = t.discarded ? 'zz' : '';
        if (tabToFav[t.id]) return `F${zz}(${realUrl(t)})`;
        if (tabToPin[t.id]) return `P${zz}(${realUrl(t)})`;
        return realUrl(t);
      });
  return { fake, bg, chrome, settle, command, strip, state: bg.__test.state };
}

test('toggle-pin: full-row tab at the top, divider below; toggling off removes both', async () => {
  const { chrome, command, strip, state } = await setup();
  await command('toggle-pin', 3);

  assert.deepEqual(await strip(), [`P(${DOCS})`, '|', GMAIL, GH]);
  assert.equal((await chrome.tabs.get(3)).pinned, false, 'not a native (icon-only) pinned tab');
  assert.deepEqual(chrome.storage.local.data.pins.map((p) => p.url), [DOCS]);

  await command('toggle-pin', 2);
  assert.deepEqual(await strip(), [`P(${DOCS})`, `P(${GH})`, '|', GMAIL]);

  await command('toggle-pin', 3);
  assert.deepEqual(await strip(), [`P(${GH})`, '|', DOCS, GMAIL], 'unpinned tab lands right below the line');
  await command('toggle-pin', 2);
  assert.deepEqual(await strip(), ['|', GH, DOCS, GMAIL], 'no pins: the divider (control panel) stays');
  assert.equal(state.pins.length, 0);
});

test('closing a pin re-creates it asleep, at its home URL, in its slot', async () => {
  const { chrome, command, settle, strip, state } = await setup();
  await command('toggle-pin', 1); // gmail
  await command('toggle-pin', 2); // github
  await chrome.tabs.update(1, { url: 'https://mail.google.com/somewhere-else' });
  await settle();

  await chrome.tabs.remove(1);
  await settle();

  assert.deepEqual(await strip(), [`Pzz(${GMAIL})`, `P(${GH})`, '|', DOCS]);
  const [first] = (await chrome.tabs.query({})).sort((a, b) => a.index - b.index);
  assert.ok(first.url.startsWith(SLEEP), 'sleeping placeholder, the site does not load');
  assert.equal(first.discarded, true);
  assert.equal(first.active, false);
  assert.equal(state.pins.length, 2, 'no duplicate pin');
});

test('reset-pin navigates back; set-pin-home changes the home', async () => {
  const { chrome, command, settle, state } = await setup();
  await command('toggle-pin', 2);
  await chrome.tabs.update(2, { url: 'https://github.com/pulls' });
  await settle();

  await command('reset-pin', 2);
  assert.equal((await chrome.tabs.get(2)).url, GH);

  await chrome.tabs.update(2, { url: 'https://github.com/notifications' });
  await settle();
  await command('set-pin-home', 2);
  assert.equal(state.pins[0].url, 'https://github.com/notifications');
});

test('dragging across the line pins / unpins; dragging pins reorders them', async () => {
  const { chrome, command, settle, strip, state } = await setup();
  await command('toggle-pin', 1); // [P(gmail) | gh docs]

  await chrome.tabs.move(3, { index: 0 }); // docs above the line
  await settle();
  assert.deepEqual(await strip(), [`P(${DOCS})`, `P(${GMAIL})`, '|', GH]);
  assert.deepEqual(state.pins.map((p) => p.url), [DOCS, GMAIL]);

  await chrome.tabs.move(3, { index: 3 }); // docs back below the line
  await settle();
  assert.deepEqual(await strip(), [`P(${GMAIL})`, '|', GH, DOCS]);
  assert.deepEqual(state.pins.map((p) => p.url), [GMAIL]);
});

test('a link opened from a pin lands below the line', async () => {
  const { chrome, command, settle, strip } = await setup();
  await command('toggle-pin', 1);
  await chrome.tabs.create({ url: 'https://mail.google.com/thread', index: 1, openerTabId: 1, active: false });
  await settle();
  assert.deepEqual(await strip(), [`P(${GMAIL})`, '|', 'https://mail.google.com/thread', GH, DOCS]);
});

test('clicking the divider shows the panel; Chrome selecting it after a close moves on', async () => {
  const { chrome, command, settle } = await setup();
  await command('toggle-pin', 1); // [P(gmail)=1 | gh=2 docs=3]
  const divider = (await chrome.tabs.query({})).find((t) => t.url.startsWith(DIVIDER));

  await chrome.tabs.update(3, { active: true });
  await settle();
  await sleep(200);
  await chrome.tabs.update(divider.id, { active: true }); // a click
  await sleep(200);
  await settle();
  assert.equal((await chrome.tabs.get(divider.id)).active, true, 'stays: the panel is shown');

  await chrome.tabs.update(2, { active: true });
  await settle();
  await chrome.tabs.remove(2); // Chrome then selects a neighbour, here the divider
  await chrome.tabs.update(divider.id, { active: true });
  await sleep(200);
  await settle();
  assert.equal((await chrome.tabs.get(divider.id)).active, false, 'moved on to a real tab');
});

test('closing the divider brings it back', async () => {
  const { chrome, command, settle, strip } = await setup();
  await command('toggle-pin', 1);
  const divider = (await chrome.tabs.query({})).find((t) => t.url.startsWith(DIVIDER));
  await chrome.tabs.remove(divider.id);
  await settle();
  assert.deepEqual(await strip(), [`P(${GMAIL})`, '|', GH, DOCS]);
});

test('goto-pin-N activates the Nth pin', async () => {
  const { chrome, command } = await setup();
  await command('toggle-pin', 1);
  await command('toggle-pin', 3);
  await command('goto-pin-2', 2);
  assert.equal((await chrome.tabs.get(3)).active, true);
});

test('after restart: rebinds pins above the divider, re-opens missing, migrates native pins', async () => {
  const placeholder = `${SLEEP}?url=${encodeURIComponent(DOCS)}&title=Docs`;
  const fake = createFakeChrome({
    local: {
      pins: [
        { id: 'p-gmail', url: GMAIL, title: 'Gmail' },
        { id: 'p-gh', url: GH, title: 'GitHub' },
        { id: 'p-docs', url: DOCS, title: 'Docs' },
      ],
    },
    tabs: [
      { id: 49, url: 'https://news.example.com/', pinned: true }, // native pin from an older version
      { id: 50, url: 'https://github.com/settings' }, // same origin → github pin
      { id: 51, url: placeholder }, // sleeping docs pin
      { id: 52, url: DIVIDER },
      { id: 53, url: 'https://other.example.com/', active: true },
    ],
  });
  const bg = await loadBackground(fake);
  fake.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await fake.settle(bg);

  const { state } = bg.__test;
  assert.equal(state.tabToPin[50], 'p-gh');
  assert.equal(state.tabToPin[51], 'p-docs');
  assert.equal(state.pins.length, 3);
  assert.deepEqual(state.favs.map((f) => f.url), ['https://news.example.com/'], 'native pinned tab adopted as a Fav');
  const tabs = (await fake.chrome.tabs.query({})).sort((a, b) => a.index - b.index);
  assert.equal(tabs.filter((t) => t.pinned).length, 1, 'the Fav stays a native pinned tile');
  assert.equal(tabs.filter((t) => t.url.startsWith(DIVIDER)).length, 1);
  const gmail = tabs.find((t) => realUrl(t) === GMAIL);
  assert.ok(gmail?.discarded, 'missing gmail pin re-opened asleep');
  assert.deepEqual(tabs.map(realUrl).slice(0, 4), ['https://news.example.com/', GMAIL, 'https://github.com/settings', DOCS], 'Fav, then pins in order');
  assert.ok(tabs[4].url.startsWith(DIVIDER));
});

test('non-web pins are re-created with the real URL and discarded', async () => {
  const { chrome, command, settle } = await setup({ tabs: [{ id: 1, url: 'chrome://settings/', active: true }, { id: 2, url: GH }] });
  await command('toggle-pin', 1);
  await chrome.tabs.remove(1);
  await settle();
  const pin = (await chrome.tabs.query({})).find((t) => t.url === 'chrome://settings/');
  assert.ok(pin);
  assert.equal(pin.discarded, true);
});

// ---------- Favs ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('native right-click → Pin makes a Fav tile; other windows get a sleeping copy', async () => {
  const { chrome, settle, strip } = await setup({
    tabs: [{ id: 1, url: GMAIL, active: true }, { id: 2, url: GH }, { id: 3, url: DOCS, windowId: 2, active: true }],
  });
  await chrome.tabs.update(1, { pinned: true });
  await settle();
  assert.deepEqual(await strip(1), [`F(${GMAIL})`, '|', GH]);
  assert.deepEqual(await strip(2), [`Fzz(${GMAIL})`, '|', DOCS]);
  const copy = (await chrome.tabs.query({ windowId: 2 }))[0];
  assert.equal(copy.pinned, true);
  assert.ok(copy.url.startsWith(SLEEP), 'not loaded in the other window');
});

test('a new window gets all Favs, asleep and in order', async () => {
  const { chrome, settle, strip, command } = await setup();
  await command('toggle-fav', 2);
  await command('toggle-fav', 1);
  const win = await chrome.windows.create();
  await sleep(900); // the extension waits for the window to settle
  await settle();
  assert.deepEqual(await strip(win.id), [`Fzz(${GH})`, `Fzz(${GMAIL})`, '|', 'chrome://newtab/']);
});

test('closing a Fav re-creates it asleep in its slot', async () => {
  const { chrome, settle, strip, command } = await setup();
  await command('toggle-fav', 1);
  await command('toggle-fav', 2);
  await chrome.tabs.remove(1);
  await settle();
  assert.deepEqual(await strip(), [`Fzz(${GMAIL})`, `F(${GH})`, '|', DOCS]);
});

test('native Unpin removes the Fav everywhere; the tab lands below the line', async () => {
  const { chrome, settle, strip, command } = await setup({
    tabs: [{ id: 1, url: GMAIL, active: true }, { id: 2, url: GH }, { id: 3, url: DOCS }, { id: 4, url: DOCS, windowId: 2 }],
  });
  await command('toggle-pin', 3); // a Pin, so there is a divider
  await command('toggle-fav', 1);
  assert.deepEqual(await strip(2), [`Fzz(${GMAIL})`, '|', DOCS]);

  await chrome.tabs.update(1, { pinned: false }); // right-click → Unpin
  await sleep(600);
  await settle();
  assert.deepEqual(await strip(1), [`P(${DOCS})`, '|', GMAIL, GH]);
  assert.deepEqual(await strip(2), ['|', DOCS], 'sleeping copy closed');
});

test('dragging Fav tiles reorders them in every window', async () => {
  const { chrome, settle, strip, command } = await setup({
    tabs: [{ id: 1, url: GMAIL, active: true }, { id: 2, url: GH }, { id: 3, url: DOCS, windowId: 2, active: true }],
  });
  await command('toggle-fav', 1);
  await command('toggle-fav', 2);
  assert.deepEqual(await strip(2), [`Fzz(${GMAIL})`, `Fzz(${GH})`, '|', DOCS]);
  await chrome.tabs.move(2, { index: 0 });
  await settle();
  assert.deepEqual(await strip(1), [`F(${GH})`, `F(${GMAIL})`, '|']);
  assert.deepEqual(await strip(2), [`Fzz(${GH})`, `Fzz(${GMAIL})`, '|', DOCS]);
});

test('toggle-pin on a Fav turns it into a Pin and drops the other copies', async () => {
  const { strip, command } = await setup({
    tabs: [{ id: 1, url: GMAIL, active: true }, { id: 2, url: GH }, { id: 3, url: DOCS, windowId: 2, active: true }],
  });
  await command('toggle-fav', 1);
  await command('toggle-pin', 1);
  assert.deepEqual(await strip(1), [`P(${GMAIL})`, '|', GH]);
  assert.deepEqual(await strip(2), ['|', DOCS]);
});

test('a link opened from a Fav lands below the line, not in the pin area', async () => {
  const { chrome, settle, strip, command } = await setup();
  await command('toggle-fav', 1);
  await command('toggle-pin', 2);
  await chrome.tabs.create({ url: 'https://mail.google.com/thread', index: 1, openerTabId: 1, active: false });
  await settle();
  assert.deepEqual(await strip(), [`F(${GMAIL})`, `P(${GH})`, '|', 'https://mail.google.com/thread', DOCS]);
});

test('after restart: each window re-binds its own Fav copies', async () => {
  const fake = createFakeChrome({
    local: { favs: [{ id: 'f-gmail', url: GMAIL, title: 'Gmail' }], pins: [] },
    tabs: [
      { id: 60, url: GMAIL, pinned: true, active: true },
      { id: 61, url: `${SLEEP}?url=${encodeURIComponent(GMAIL)}&title=Gmail`, pinned: true, windowId: 2 },
      { id: 62, url: DOCS, windowId: 2, active: true },
    ],
  });
  const bg = await loadBackground(fake);
  fake.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await fake.settle(bg);
  const { state } = bg.__test;
  assert.equal(state.tabToFav[60], 'f-gmail');
  assert.equal(state.tabToFav[61], 'f-gmail');
  assert.equal(state.favs.length, 1);
  const all = await fake.chrome.tabs.query({});
  assert.equal(all.filter((t) => !t.url.startsWith(DIVIDER)).length, 3, 'nothing duplicated');
});

// ---------- Spaces ----------

test('new Space: current tabs are saved and closed, nothing hidden anywhere; Favs stay', async () => {
  const { chrome, command, strip, settle, bg } = await setup();
  await command('toggle-fav', 1);
  await command('toggle-pin', 2); // [F(gmail) P(gh) | docs]
  globalThis.pinline.newSpace(1);
  await settle();

  assert.deepEqual(await strip(1), [`F(${GMAIL})`, '|', 'chrome://newtab/'], 'fresh Space: Fav, its divider, a new tab');
  assert.deepEqual((await chrome.windows.getAll()).map((w) => w.id), [1], 'no extra windows');
  await assert.rejects(chrome.tabs.get(2), 'old tabs are closed');
  const { state } = bg.__test;
  assert.equal(state.spaces.length, 2);
  assert.deepEqual(chrome.storage.local.data.spaceTabs[state.spaces[0].id].map((t) => t.url), [DOCS]);
  assert.equal(state.pins.length, 1, 'the pin is kept');
  const divider = (await chrome.tabs.query({ windowId: 1 })).find((t) => t.url.startsWith(DIVIDER));
  assert.equal(new URL(divider.url).searchParams.get('name'), 'Space 2');
});

test('switching back re-opens pins and tabs asleep, and selects what was selected', async () => {
  const { chrome, command, strip, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await chrome.tabs.update(3, { active: true }); // docs selected in Space 1
  await settle();
  globalThis.pinline.newSpace(1);
  await settle();
  await chrome.tabs.create({ url: 'https://space2.example.com/', windowId: 1 });
  await settle();

  globalThis.pinline.switchSpace(1, 1); // next = back to Space 1
  await settle();
  assert.deepEqual(await strip(1), [`Pzz(${GH})`, '|', GMAIL, DOCS]);
  const tabs = (await chrome.tabs.query({ windowId: 1 })).sort((a, b) => a.index - b.index);
  assert.ok(tabs[2].url.startsWith(SLEEP) && tabs[2].discarded, 'gmail asleep');
  assert.equal(tabs[3].url, DOCS, 'docs (was selected) opens for real');
  assert.equal(tabs[3].active, true);
  assert.deepEqual(chrome.storage.local.data.spaceTabs[bg.__test.state.spaces[1].id].map((t) => t.url), ['https://space2.example.com/']);
  assert.equal((await chrome.windows.getAll()).length, 1);

  // Closing a re-opened pin still re-creates it.
  await chrome.tabs.remove(tabs[0].id);
  await settle();
  assert.deepEqual((await strip(1)).slice(0, 2), [`Pzz(${GH})`, '|']);
});

test('pins belong to the Space they were made in', async () => {
  const { chrome, command, settle, bg } = await setup();
  globalThis.pinline.newSpace(1);
  await settle();
  const t = await chrome.tabs.create({ url: 'https://s2.example.com/', windowId: 1 });
  await settle();
  await command('toggle-pin', t.id);
  const { state } = bg.__test;
  assert.equal(state.pins.find((p) => p.url === 'https://s2.example.com/').space, state.spaces[1].id);
});

const message = (chrome, settle, msg) =>
  new Promise((resolve) => {
    chrome.runtime.onMessage.emit(msg, { id: 'fakeid' }, resolve);
  });

test('rename a Space: divider shows the new name; empty names are ignored', async () => {
  const { chrome, settle, bg } = await setup();
  globalThis.pinline.newSpace(1);
  await settle();
  const [s1, s2] = bg.__test.state.spaces;
  const res = await message(chrome, settle, { type: 'spaces:rename', id: s2.id, name: '  工作  ', windowId: 1 });
  await settle();
  assert.deepEqual(res.spaces.map((s) => [s.name, s.current]), [['Space 1', false], ['工作', true]]);
  const divider = (await chrome.tabs.query({ windowId: 1 })).find((t) => t.url.startsWith(DIVIDER));
  assert.equal(new URL(divider.url).searchParams.get('name'), '工作');
  await message(chrome, settle, { type: 'spaces:rename', id: s1.id, name: '   ' });
  assert.equal(bg.__test.state.spaces[0].name, 'Space 1');
  await sleep(400); // bookmark sync is debounced
  await settle();
  assert.deepEqual(chrome.bookmarks.titles('Pinline'), ['⭐ Fav', 'Space 1', '工作']);
});

test('delete the shown Space: window switches to a neighbour, its pins and tabs are gone', async () => {
  const { chrome, command, settle, strip, bg } = await setup();
  globalThis.pinline.newSpace(1);
  await settle();
  const t = await chrome.tabs.create({ url: 'https://s2.example.com/', windowId: 1 });
  await settle();
  await command('toggle-pin', t.id);
  const s2 = bg.__test.state.spaces[1];

  const res = await message(chrome, settle, { type: 'spaces:delete', id: s2.id, windowId: 1 });
  await settle();
  assert.deepEqual(res.spaces.map((s) => s.name), ['Space 1']);
  const { state } = bg.__test;
  assert.equal(state.pins.length, 0, "the deleted Space's pin is gone");
  assert.equal(chrome.storage.local.data.spaceTabs[s2.id], undefined);
  assert.deepEqual(await strip(1), ['|', GMAIL, GH, DOCS], 'back in Space 1');
});

test('the last Space cannot be deleted; a hidden Space can', async () => {
  const { chrome, settle, bg } = await setup();
  const only = bg.__test.state.spaces[0];
  await message(chrome, settle, { type: 'spaces:delete', id: only.id });
  assert.equal(bg.__test.state.spaces.length, 1);

  await message(chrome, settle, { type: 'spaces:new', windowId: 1, name: '个人' }); // shows 个人, hides Space 1
  await settle();
  await message(chrome, settle, { type: 'spaces:delete', id: only.id });
  await settle();
  assert.deepEqual(bg.__test.state.spaces.map((s) => s.name), ['个人']);
  assert.equal(chrome.storage.local.data.spaceTabs[only.id], undefined, "hidden Space's saved tabs dropped");
});

test('messages from other extensions are ignored', async () => {
  const { chrome, settle, bg } = await setup();
  let answered = false;
  chrome.runtime.onMessage.emit({ type: 'spaces:new' }, { id: 'evil' }, () => (answered = true));
  await settle();
  assert.equal(answered, false);
  assert.equal(bg.__test.state.spaces.length, 1);
});

test('activating a sleeping placeholder wakes it to the real page', async () => {
  const { chrome, command, settle } = await setup();
  await command('toggle-pin', 2);
  await chrome.tabs.remove(2);
  await settle();
  const [slept] = (await chrome.tabs.query({})).filter((t) => t.url.startsWith(SLEEP));
  await chrome.tabs.update(slept.id, { active: true });
  await settle();
  assert.equal((await chrome.tabs.get(slept.id)).url, GH);
});

test('the new-Space prompt gets a suggested name; creating uses the typed one', async () => {
  const { chrome, settle, bg } = await setup();
  assert.deepEqual(await message(chrome, settle, { type: 'spaces:suggest' }), { name: 'Space 2' });
  const res = await message(chrome, settle, { type: 'spaces:new', name: '读书', windowId: 1 });
  await settle();
  assert.deepEqual(res.spaces.map((s) => [s.name, s.current]), [['Space 1', false], ['读书', true]]);
  assert.deepEqual(await message(chrome, settle, { type: 'spaces:suggest' }), { name: 'Space 3' });
});

// ---------- bookmarks ----------

const BM_WAIT = 400; // > the 300 ms debounce
async function bmSettle(settle) {
  await sleep(BM_WAIT);
  await settle();
}

test('bookmarks: Pinline/⭐ Fav and one folder per Space mirror Favs and Pins, in order', async () => {
  const { chrome, command, settle } = await setup();
  await command('toggle-fav', 1);
  await command('toggle-pin', 3);
  await command('toggle-pin', 2);
  await bmSettle(settle);
  const bm = chrome.bookmarks;
  assert.deepEqual(bm.titles('Pinline'), ['⭐ Fav', 'Space 1']);
  assert.deepEqual(bm.urls('Pinline', '⭐ Fav'), [GMAIL]);
  assert.deepEqual(bm.urls('Pinline', 'Space 1'), [DOCS, GH]);

  await command('toggle-pin', 3); // local unpin → bookmark removed
  await bmSettle(settle);
  assert.deepEqual(bm.urls('Pinline', 'Space 1'), [GH]);
});

test('bookmarks → Pinline: rename folder, reorder, add, delete', async () => {
  const { chrome, command, settle, strip, bg } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  await bmSettle(settle);
  const bm = chrome.bookmarks;
  const folder = bm.find('Pinline', 'Space 1');

  await bm.update(folder.id, { title: '工作' });
  await bmSettle(settle);
  assert.equal(bg.__test.state.spaces[0].name, '工作');

  const [gh, docs] = folder.children;
  await bm.move(docs.id, { parentId: folder.id, index: 0 });
  await bmSettle(settle);
  assert.deepEqual(await strip(1), [`P(${DOCS})`, `P(${GH})`, '|', GMAIL], 'pins reordered like the bookmarks');

  await bm.create({ parentId: folder.id, title: 'Example', url: 'https://example.com/' });
  await bmSettle(settle);
  assert.deepEqual(await strip(1), [`P(${DOCS})`, `P(${GH})`, 'Pzz(https://example.com/)', '|', GMAIL], 'new bookmark → new pin, opened asleep');

  await bm.removeTree(gh.id);
  await bmSettle(settle);
  assert.deepEqual(await strip(1), [`P(${DOCS})`, 'Pzz(https://example.com/)', '|', GH, GMAIL], 'deleted bookmark → unpinned, tab kept');
});

test('bookmarks: moving a bookmark from ⭐ Fav into a Space folder turns the Fav into a Pin', async () => {
  const { chrome, command, settle, strip } = await setup();
  await command('toggle-fav', 1);
  await command('toggle-pin', 2);
  await bmSettle(settle);
  const bm = chrome.bookmarks;
  const fav = bm.find('Pinline', '⭐ Fav').children[0];
  await bm.move(fav.id, { parentId: bm.find('Pinline', 'Space 1').id });
  await bmSettle(settle);
  const s = await strip(1);
  assert.ok(!s.some((x) => x.startsWith('F')), 'no Fav left');
  assert.ok(s.includes(`P(${GH})`) && s.some((x) => x.includes(GMAIL) && x.startsWith('P')), `gmail is a pin now: ${s}`);
});

test('bookmarks: deleting a Space folder re-creates it, the Space is kept', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await bmSettle(settle);
  const bm = chrome.bookmarks;
  await bm.removeTree(bm.find('Pinline', 'Space 1').id);
  await bmSettle(settle);
  assert.deepEqual(bm.urls('Pinline', 'Space 1'), [GH]);
  assert.equal(bg.__test.state.pins.length, 1);
});

test('Pinline → bookmarks: new / renamed / deleted Spaces', async () => {
  const { chrome, settle } = await setup();
  const res = await message(chrome, settle, { type: 'spaces:new', name: '个人', windowId: 1 });
  await bmSettle(settle);
  assert.deepEqual(chrome.bookmarks.titles('Pinline'), ['⭐ Fav', 'Space 1', '个人']);
  await message(chrome, settle, { type: 'spaces:rename', id: res.spaces[1].id, name: '生活' });
  await bmSettle(settle);
  assert.deepEqual(chrome.bookmarks.titles('Pinline'), ['⭐ Fav', 'Space 1', '生活']);
  await message(chrome, settle, { type: 'spaces:delete', id: res.spaces[1].id });
  await bmSettle(settle);
  assert.deepEqual(chrome.bookmarks.titles('Pinline'), ['⭐ Fav', 'Space 1']);
});

test('fresh install adopts an existing Pinline folder (another device / reinstall)', async () => {
  const fake = createFakeChrome({ tabs: [{ id: 1, url: DOCS, active: true }] });
  const bm = fake.chrome.bookmarks;
  const root = await bm.create({ title: 'Pinline' });
  const favs = await bm.create({ parentId: root.id, title: '⭐ Fav' });
  await bm.create({ parentId: favs.id, title: 'Gmail', url: GMAIL });
  const work = await bm.create({ parentId: root.id, title: '工作' });
  await bm.create({ parentId: work.id, title: 'GitHub', url: GH });
  await bm.create({ parentId: root.id, title: '个人' });

  const bg = await loadBackground(fake);
  fake.chrome.runtime.onInstalled.emit({ reason: 'install' });
  await fake.settle(bg);
  const { state } = bg.__test;
  assert.deepEqual(state.favs.map((f) => f.url), [GMAIL]);
  assert.deepEqual(state.spaces.map((s) => s.name), ['Space 1', '工作', '个人'].filter((n) => state.spaces.some((s) => s.name === n)));
  assert.ok(state.spaces.some((s) => s.name === '工作') && state.spaces.some((s) => s.name === '个人'));
  assert.deepEqual(state.pins.map((p) => [p.url, state.spaces.find((s) => s.id === p.space).name]), [[GH, '工作']]);
  assert.equal(bm.find('Pinline', '⭐ Fav').children.length, 1, 'nothing duplicated');
  assert.equal(bm.find('Pinline').children.filter((c) => c.title === '工作').length, 1);
});

test('a local unpin is not undone by an unrelated bookmark edit in the same sync', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  await bmSettle(settle);
  await command('toggle-pin', 2); // local: unpin github
  await chrome.bookmarks.create({ parentId: chrome.bookmarks.find('Pinline', 'Space 1').id, title: 'X', url: 'https://x.example.com/' }); // remote: add
  await bmSettle(settle);
  assert.deepEqual(bg.__test.state.pins.map((p) => p.url).sort(), [DOCS, 'https://x.example.com/']);
  assert.deepEqual(chrome.bookmarks.urls('Pinline', 'Space 1').sort(), [DOCS, 'https://x.example.com/']);
});

test('import a bookmark folder as a new Space', async () => {
  const { chrome, settle, strip, bg } = await setup();
  const src = await chrome.bookmarks.create({ parentId: '1', title: '读书' });
  await chrome.bookmarks.create({ parentId: src.id, title: 'A', url: 'https://a.example.com/' });
  await chrome.bookmarks.create({ parentId: src.id, title: 'sub' }); // sub-folder: ignored
  await chrome.bookmarks.create({ parentId: src.id, title: 'B', url: 'https://b.example.com/' });
  await message(chrome, settle, { type: 'spaces:import', folderId: src.id, windowId: 1 });
  await bmSettle(settle);
  assert.equal(bg.__test.state.spaces.at(-1).name, '读书');
  assert.deepEqual(await strip(1), ['Pzz(https://a.example.com/)', 'Pzz(https://b.example.com/)', '|', 'chrome://newtab/']);
  assert.deepEqual(chrome.bookmarks.urls('Pinline', '读书'), ['https://a.example.com/', 'https://b.example.com/']);
  assert.equal(chrome.bookmarks.find('读书'), undefined, 'source folder is in the bookmarks bar, untouched');
  assert.equal((await chrome.bookmarks.getChildren(src.id)).length, 3);
});

// ---------- reloading the extension ----------

async function reload(fake) {
  fake.reloadExtension();
  const bg = await loadBackground(fake);
  fake.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await fake.settle(bg);
  await sleep(BM_WAIT);
  await fake.settle(bg);
  return bg;
}

test('reloading the extension does not duplicate pins; closed sleeping tabs come back', async () => {
  const { fake, chrome, command, settle } = await setup();
  await command('toggle-pin', 2); // github: live pin
  await command('toggle-pin', 3); // docs
  await chrome.tabs.remove(3); // → sleeping placeholder (an extension page)
  await settle();
  globalThis.pinline.newSpace(1);
  await settle();
  globalThis.pinline.switchSpace(1, -1); // back: gmail comes back asleep (also an extension page)
  await settle();
  await bmSettle(settle);
  const before = (await chrome.tabs.query({ windowId: 1 })).sort((a, b) => a.index - b.index).map(realUrl);

  const bg = await reload(fake);
  const s = (await chrome.tabs.query({ windowId: 1 })).sort((a, b) => a.index - b.index);
  const { tabToPin } = bg.__test.state;
  const view = s.map((t) => (t.url.startsWith(DIVIDER) ? '|' : (tabToPin[t.id] ? 'P:' : '') + realUrl(t)));
  assert.deepEqual(view.filter((x) => x.startsWith('P:')).sort(), [`P:${DOCS}`, `P:${GH}`], `no duplicate pins: ${view}`);
  assert.equal(view.filter((x) => x === '|').length, 1);
  assert.deepEqual(s.map(realUrl).filter((u) => !u.startsWith(DIVIDER)).sort(), before.filter((u) => !u.startsWith(DIVIDER)).sort(), 'same tabs as before');
  assert.equal(view.indexOf('|'), 2, 'pins above the divider');
});

test('first reload after upgrading (bindings lost): leading tabs are recognised as pins', async () => {
  const { fake, chrome, command, settle } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  await bmSettle(settle);
  delete chrome.storage.local.data.tabs; // what older versions kept in session storage only
  const bg = await reload(fake);
  const s = (await chrome.tabs.query({ windowId: 1 })).sort((a, b) => a.index - b.index);
  const view = s.map((t) => (t.url.startsWith(DIVIDER) ? '|' : (bg.__test.state.tabToPin[t.id] ? 'P:' : '') + realUrl(t)));
  assert.deepEqual(view, [`P:${GH}`, `P:${DOCS}`, '|', GMAIL]);
});

test('openPanel selects the divider (with #new to focus the new-Space field)', async () => {
  const { chrome, settle } = await setup();
  globalThis.pinline.openPanel(1, true);
  await settle();
  await sleep(200);
  await settle();
  const divider = (await chrome.tabs.query({ windowId: 1 })).find((t) => t.url.startsWith(DIVIDER));
  assert.equal(divider.active, true);
  assert.ok(divider.url.endsWith('#new'));
  globalThis.pinline.openPanel(1);
  await settle();
  assert.equal((await chrome.tabs.query({ windowId: 1 })).filter((t) => t.url.startsWith(DIVIDER)).length, 1, 'hash change does not create another divider');
});

// ---------- Pin groups ----------

const groupView = async (chrome, bg, windowId = 1) => {
  const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const groups = await chrome.tabGroups.query({});
  return tabs.map((t) => {
    if (t.url.startsWith(DIVIDER)) return '|';
    const p = bg.__test.state.tabToPin[t.id] ? 'P' : '';
    const g = t.groupId > -1 ? `[${groups.find((x) => x.id === t.groupId)?.title}]` : '';
    return `${g}${p}${p ? `(${realUrl(t)})` : realUrl(t)}`;
  });
};

async function pinsInGroup(chrome, command, settle, title, ...tabIds) {
  const gid = await chrome.tabs.group({ tabIds }); // right-click → "Add tab to new group"
  await chrome.tabGroups.update(gid, { title, color: 'blue' });
  await settle();
  return gid;
}

test('grouping pins natively makes a Pin group; it stays above the divider', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 1);
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  await pinsInGroup(chrome, command, settle, '工作', 2, 3);
  const { state } = bg.__test;
  assert.equal(state.groups.length, 1);
  assert.deepEqual([state.groups[0].title, state.groups[0].color], ['工作', 'blue']);
  assert.deepEqual(state.pins.map((p) => !!p.group), [false, true, true]);
  assert.deepEqual(await groupView(chrome, bg), [`P(${GMAIL})`, `[工作]P(${GH})`, `[工作]P(${DOCS})`, '|']);
});

test('closing a pin in a group re-creates it inside the group', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  await pinsInGroup(chrome, command, settle, '文档', 2, 3);
  await chrome.tabs.remove(3);
  await settle();
  const v = await groupView(chrome, bg);
  assert.deepEqual(v, [`[文档]P(${GH})`, `[文档]P(${DOCS})`, '|', GMAIL]);
  assert.equal(bg.__test.state.groups.length, 1);
});

test('switching Space and back restores the group (title, colour, members)', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  const gid = await pinsInGroup(chrome, command, settle, '文档', 2, 3);
  await chrome.tabGroups.update(gid, { color: 'green' });
  await settle();
  globalThis.pinline.newSpace(1);
  await settle();
  assert.equal((await chrome.tabGroups.query({})).length, 0, 'group closed with its Space');
  assert.equal(bg.__test.state.groups.length, 1, 'Pin group kept');
  globalThis.pinline.switchSpace(1, -1);
  await settle();
  const groups = await chrome.tabGroups.query({});
  assert.deepEqual(groups.map((g) => [g.title, g.color]), [['文档', 'green']]);
  assert.deepEqual(await groupView(chrome, bg), [`[文档]P(${GH})`, `[文档]P(${DOCS})`, '|', GMAIL]);
});

test('ungrouping the last pin drops the Pin group; renaming the tab group renames it', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  const gid = await pinsInGroup(chrome, command, settle, 'A', 2, 3);
  await chrome.tabGroups.update(gid, { title: 'B' });
  await settle();
  assert.equal(bg.__test.state.groups[0].title, 'B');
  await chrome.tabs.ungroup([2, 3]);
  await settle();
  assert.equal(bg.__test.state.groups.length, 0);
  assert.ok(bg.__test.state.pins.every((p) => !p.group));
});

test('bookmarks: a Pin group is a sub-folder of its Space folder, both ways', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 1);
  await command('toggle-pin', 2);
  await command('toggle-pin', 3);
  await pinsInGroup(chrome, command, settle, '文档', 2, 3);
  await bmSettle(settle);
  const bm = chrome.bookmarks;
  assert.deepEqual(bm.titles('Pinline', 'Space 1'), ['https://mail.google.com/', '文档']);
  assert.deepEqual(bm.urls('Pinline', 'Space 1', '文档'), [GH, DOCS]);

  // Rename the sub-folder → group renamed; move a bookmark out of it → pin leaves the group.
  const sub = bm.find('Pinline', 'Space 1', '文档');
  await bm.update(sub.id, { title: '资料' });
  await bm.move(sub.children[0].id, { parentId: bm.find('Pinline', 'Space 1').id, index: 0 });
  await bmSettle(settle);
  assert.equal(bg.__test.state.groups[0].title, '资料');
  assert.deepEqual(await groupView(chrome, bg), [`P(${GH})`, `P(${GMAIL})`, `[资料]P(${DOCS})`, '|']);
});

test('import: sub-folders become Pin groups, deeper folders are flattened into them', async () => {
  const { chrome, settle, bg } = await setup();
  const src = await chrome.bookmarks.create({ parentId: '1', title: '项目' });
  await chrome.bookmarks.create({ parentId: src.id, title: 'A', url: 'https://a.example.com/' });
  const sub = await chrome.bookmarks.create({ parentId: src.id, title: '设计' });
  await chrome.bookmarks.create({ parentId: sub.id, title: 'B', url: 'https://b.example.com/' });
  const deep = await chrome.bookmarks.create({ parentId: sub.id, title: '更深' });
  await chrome.bookmarks.create({ parentId: deep.id, title: 'D', url: 'https://d.example.com/' });
  await chrome.bookmarks.create({ parentId: sub.id, title: 'C', url: 'https://c.example.com/' });
  await message(chrome, settle, { type: 'spaces:import', folderId: src.id, windowId: 1 });
  await bmSettle(settle);
  assert.deepEqual(bg.__test.state.groups.map((g) => g.title), ['设计']);
  assert.deepEqual(await groupView(chrome, bg), ['P(https://a.example.com/)', '[设计]P(https://b.example.com/)', '[设计]P(https://d.example.com/)', '[设计]P(https://c.example.com/)', '|', 'chrome://newtab/']);
  assert.deepEqual(chrome.bookmarks.urls('Pinline', '项目', '设计'), ['https://b.example.com/', 'https://d.example.com/', 'https://c.example.com/']);
});

// ---------- renaming Favs / Pins ----------

test('rename a pin: bookmark title, sleeping placeholder, content script only on that site', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  await command('toggle-fav', 1);
  await bmSettle(settle);
  const pin = bg.__test.state.pins[0];
  chrome.permissions.granted = true;

  await message(chrome, settle, { type: 'items:rename', kind: 'pin', id: pin.id, name: '代码' });
  await bmSettle(settle);
  assert.equal(bg.__test.state.pins[0].name, '代码');
  assert.deepEqual(chrome.bookmarks.titles('Pinline', 'Space 1'), ['代码']);
  assert.deepEqual(chrome.scripting.registered.map((r) => r.matches), [['https://github.com/*']]);
  assert.deepEqual(chrome.scripting.injected, [2], 'already-loaded page gets the script injected');

  // Closed → re-created asleep with the custom name.
  await chrome.tabs.remove(2);
  await settle();
  const slept = (await chrome.tabs.query({})).find((t) => t.url.startsWith(SLEEP));
  assert.equal(new URL(slept.url).searchParams.get('title'), '代码');

  // The page asks what it is called.
  const name = await new Promise((r) => chrome.runtime.onMessage.emit({ type: 'title:get' }, { id: 'fakeid', tab: { id: slept.id } }, r));
  assert.deepEqual(name, { name: '代码' });

  // Clearing the name: bookmark back to the page title, script unregistered.
  await message(chrome, settle, { type: 'items:rename', kind: 'pin', id: pin.id, name: '  ' });
  await bmSettle(settle);
  assert.equal(bg.__test.state.pins[0].name, undefined);
  assert.deepEqual(chrome.bookmarks.titles('Pinline', 'Space 1'), [GH]);
  assert.deepEqual(chrome.scripting.registered, []);
});

test('without the permission no script is registered, the name still shows while asleep', async () => {
  const { chrome, command, settle, bg } = await setup();
  await command('toggle-pin', 2);
  const pin = bg.__test.state.pins[0];
  await message(chrome, settle, { type: 'items:rename', kind: 'pin', id: pin.id, name: 'GH' });
  assert.deepEqual(chrome.scripting.registered, []);
  assert.deepEqual(chrome.scripting.injected, []);
  await chrome.tabs.remove(2);
  await settle();
  const slept = (await chrome.tabs.query({})).find((t) => t.url.startsWith(SLEEP));
  assert.equal(new URL(slept.url).searchParams.get('title'), 'GH');
});

test('renaming the bookmark renames the Fav; a live page is told', async () => {
  const { chrome, command, settle, bg } = await setup({ allSites: true });
  await command('toggle-fav', 1);
  await bmSettle(settle);
  chrome.scripting.injected.push(1); // the page already runs the script
  const bmNode = chrome.bookmarks.find('Pinline', '⭐ Fav').children[0];
  await chrome.bookmarks.update(bmNode.id, { title: '邮件' });
  await bmSettle(settle);
  assert.equal(bg.__test.state.favs[0].name, '邮件');
  assert.deepEqual(chrome.tabs.messages, [[1, { type: 'title:set', name: '邮件' }]]);
  assert.deepEqual(chrome.scripting.registered[0].matches, ['https://mail.google.com/*']);
});

test('list for the panel: Favs and the shown Space pins, with names', async () => {
  const { chrome, command, settle } = await setup();
  await command('toggle-fav', 1);
  await command('toggle-pin', 2);
  const res = await message(chrome, settle, { type: 'spaces:list', windowId: 1 });
  assert.deepEqual(res.items.map((i) => [i.kind, i.url, i.name]), [['fav', GMAIL, ''], ['pin', GH, '']]);
  assert.equal(res.canRetitle, false);
});

// ---------- restart races ----------

test('a pinned tab restored after reconcile binds to its Fav instead of creating a duplicate', async () => {
  const CT = 'https://ctool.example.com/#/json';
  const fake = createFakeChrome({
    local: { favs: [{ id: 'f-gh', url: GH, title: 'GitHub' }, { id: 'f-ct', url: CT, title: 'Ctool' }], pins: [] },
    tabs: [{ id: 80, url: GH, pinned: true, active: true }], // Ctool not restored yet
  });
  const bg = await loadBackground(fake);
  fake.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await fake.settle(bg);
  // Session restore brings Ctool back (live page, title not loaded yet).
  await fake.chrome.tabs.create({ url: 'https://ctool.example.com/#/xml', pinned: true, active: false });
  await fake.settle(bg);
  const { state } = bg.__test;
  assert.deepEqual(state.favs.map((f) => f.id), ['f-gh', 'f-ct'], 'no new Fav');
  const pinned = (await fake.chrome.tabs.query({ pinned: true })).map((t) => realUrl(t));
  assert.equal(pinned.length, 2, `sleeping duplicate closed: ${pinned}`);
  assert.ok(pinned.includes('https://ctool.example.com/#/xml'), 'the restored live tab is kept');
});

test('duplicate Favs from an older version are merged on reload', async () => {
  const fake = createFakeChrome({
    local: {
      favs: [
        { id: 'f-a', url: GH, title: 'GitHub' },
        { id: 'f-b', url: DOCS, title: 'Docs' },
        { id: 'f-b2', url: DOCS, title: DOCS, name: '文档' },
      ],
      pins: [],
    },
    tabs: [
      { id: 90, url: GH, pinned: true, active: true },
      { id: 91, url: DOCS, pinned: true },
      { id: 92, url: `${SLEEP}?url=${encodeURIComponent(DOCS)}&title=x`, pinned: true },
    ],
  });
  const bg = await loadBackground(fake);
  fake.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await fake.settle(bg);
  const { state } = bg.__test;
  assert.deepEqual(state.favs.map((f) => [f.id, f.name]), [['f-a', undefined], ['f-b', '文档']]);
  assert.deepEqual((await fake.chrome.tabs.query({ pinned: true })).map((t) => t.id).sort(), [90, 91]);
});
