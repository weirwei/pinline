import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeChrome, loadBackground } from './fake-chrome.js';
import { CMDBAR_ID, cmdbarCommands, parseCmdbarMessage } from '../src/cmdbar.js';

const GMAIL = 'https://mail.google.com/';
const GH = 'https://github.com/';
const DOCS = 'https://docs.example.com/';
const ids = (list) => list.map((c) => c.id);

test('cmdbarCommands: Fav / Pin commands follow the tab', () => {
  const plain = ids(cmdbarCommands({ tab: { role: null, keepable: true, awayFromHome: false } }));
  assert.deepEqual(plain.slice(0, 2), ['toggle-fav', 'toggle-pin']);
  assert.ok(!plain.includes('reset-pin') && !plain.includes('rename'));

  const fav = cmdbarCommands({ tab: { role: 'fav', keepable: true, awayFromHome: true } });
  assert.equal(fav.find((c) => c.id === 'toggle-fav').title, '取消 Fav');
  assert.equal(fav.find((c) => c.id === 'toggle-pin').title, '设为 Pin');
  assert.ok(ids(fav).includes('reset-pin') && ids(fav).includes('set-pin-home'));
  assert.equal(fav.find((c) => c.id === 'rename').title, '重命名 Fav…');

  const newTab = ids(cmdbarCommands({ tab: { role: null, keepable: false } }));
  assert.ok(!newTab.includes('toggle-fav') && !newTab.includes('toggle-pin'), 'chrome://newtab cannot become a Fav / Pin');
  const divider = ids(cmdbarCommands({ tab: { role: 'divider', keepable: false } }));
  assert.ok(!divider.some((id) => /^(toggle|reset|set-pin|rename)/.test(id)));
});

test('cmdbarCommands: one entry per other Space, one per archived tab', () => {
  const one = ids(cmdbarCommands({ tab: null, spaces: [{ id: 's1', name: '工作', current: true }] }));
  assert.ok(!one.includes('next-space') && !one.some((id) => id.startsWith('space:')));
  const list = cmdbarCommands({
    tab: null,
    spaces: [{ id: 's1', name: '工作', current: true }, { id: 's2', name: '个人', current: false }],
    archive: [{ id: 'a1', url: GH, title: 'GitHub', archivedAt: 5 }],
  });
  const space = list.find((c) => c.id === 'space:s2');
  assert.equal(space.title, '切到 Space：个人');
  assert.match(space.keywords, /个人/);
  assert.ok(!ids(list).includes('space:s1'), 'the shown Space is not offered');
  assert.deepEqual(list.find((c) => c.id === 'archive:a1'), { id: 'archive:a1', title: 'GitHub', url: GH, at: 5, keywords: 'archive pinline guidang', kind: 'archive' });
});

test('parseCmdbarMessage validates input', () => {
  assert.equal(parseCmdbarMessage(null), null);
  assert.equal(parseCmdbarMessage({ type: 'spaces:delete', id: 'x' }), null, 'internal messages are not accepted');
  assert.equal(parseCmdbarMessage({ type: 'cmdbar:run' }), null);
  assert.equal(parseCmdbarMessage({ type: 'cmdbar:run', id: 'x'.repeat(201) }), null);
  assert.deepEqual(parseCmdbarMessage({ type: 'cmdbar:run', id: 'toggle-pin', tabId: 3, windowId: '1' }), { type: 'cmdbar:run', id: 'toggle-pin', tabId: 3, windowId: undefined });
});

test('manifest: fixed key, only Arc Cmdbar may connect', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(m.key, 'manifest has a key (fixed extension id)');
  assert.deepEqual(m.externally_connectable, { ids: [CMDBAR_ID] });
});

async function setup() {
  const fake = createFakeChrome({ tabs: [{ id: 1, url: GMAIL, active: true }, { id: 2, url: GH }, { id: 3, url: DOCS }] });
  const bg = await loadBackground(fake);
  const { chrome } = fake;
  const settle = () => fake.settle(bg);
  chrome.runtime.onInstalled.emit({ reason: 'install' });
  await settle();
  const external = async (msg, from = CMDBAR_ID) => {
    let answered = false;
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => !answered && resolve(undefined), from === CMDBAR_ID ? 5000 : 200); // ignored messages never answer
      chrome.runtime.onMessageExternal.emit(msg, { id: from }, (r) => { answered = true; clearTimeout(timer); resolve(r); });
    });
    await settle();
    return res;
  };
  return { chrome, settle, bg, state: bg.__test.state, external };
}

test('external: other extensions get no answer and change nothing', async () => {
  const { external, state } = await setup();
  assert.equal(await external({ type: 'cmdbar:run', id: 'toggle-pin', tabId: 2 }, 'someone-else'), undefined);
  assert.equal(state.pins.length, 0);
  assert.deepEqual(await external({ type: 'spaces:delete', id: 'x' }), { error: 'bad request' });
});

test('external list: commands for the tab, our tabs annotated (real URLs, names, divider)', async () => {
  const { external, state, chrome } = await setup();
  let res = await external({ type: 'cmdbar:list', tabId: 2, windowId: 1 });
  assert.equal(res.protocol, 1);
  assert.equal(res.commands.find((c) => c.id === 'toggle-pin').title, '设为 Pin');

  await external({ type: 'cmdbar:run', id: 'toggle-pin', tabId: 2, windowId: 1 });
  assert.deepEqual(state.pins.map((p) => p.url), [GH]);
  await external({ type: 'cmdbar:run', id: 'toggle-fav', tabId: 1, windowId: 1 });
  assert.deepEqual(state.favs.map((f) => f.url), [GMAIL]);

  res = await external({ type: 'cmdbar:list', tabId: 2, windowId: 1 });
  assert.equal(res.commands.find((c) => c.id === 'toggle-pin').title, '取消 Pin');
  assert.equal(res.tabs[2].role, 'pin');
  assert.equal(res.tabs[1].role, 'fav');
  assert.equal(res.tabs[1].id, state.favs[0].id);
  assert.equal(res.tabs[1].url, GMAIL);
  const divider = (await chrome.tabs.query({ windowId: 1 })).find((t) => t.url.includes('/src/divider.html'));
  assert.deepEqual(res.tabs[divider.id], { role: 'divider' });
  assert.equal(res.tabs[3], undefined, 'plain tabs are not annotated');

  // A sleeping Pin is reported with its real URL.
  await chrome.tabs.update(3, { active: true });
  await chrome.tabs.remove(2);
  await new Promise((r) => setTimeout(r, 30));
  await external({ type: 'cmdbar:list' }); // let the re-creation settle
  res = await external({ type: 'cmdbar:list', tabId: 3, windowId: 1 });
  const pinTab = Object.entries(res.tabs).find(([, v]) => v.role === 'pin');
  assert.ok(pinTab, 'the re-created pin is annotated');
  assert.equal(pinTab[1].url, GH);
});

test('external run: reset / set home, Spaces, archive', async () => {
  const { external, state, chrome, settle } = await setup();
  await external({ type: 'cmdbar:run', id: 'toggle-pin', tabId: 2, windowId: 1 });
  await chrome.tabs.update(2, { url: 'https://github.com/elsewhere' });
  await settle();
  let res = await external({ type: 'cmdbar:list', tabId: 2, windowId: 1 });
  assert.ok(res.commands.some((c) => c.id === 'reset-pin'));
  await external({ type: 'cmdbar:run', id: 'reset-pin', tabId: 2, windowId: 1 });
  assert.equal((await chrome.tabs.get(2)).url, GH);

  // Spaces: create one through the panel API, then switch by id from the command bar.
  globalThis.pinline.newSpace(1, '个人');
  await settle();
  res = await external({ type: 'cmdbar:list', windowId: 1 });
  const back = res.commands.find((c) => c.kind === 'space');
  assert.equal(back.title, `切到 Space：${state.spaces[0].name}`);
  assert.equal(state.windowSpace[1], state.spaces[1].id);
  await external({ type: 'cmdbar:run', id: back.id, windowId: 1 });
  assert.equal(state.windowSpace[1], state.spaces[0].id, 'switched back');
  await external({ type: 'cmdbar:run', id: 'next-space', windowId: 1 });
  assert.equal(state.windowSpace[1], state.spaces[1].id);
  assert.match((await external({ type: 'cmdbar:run', id: 'space:nope', windowId: 1 })).error, /no such Space/);

  // Archive: archive everything below the divider, then reopen one entry.
  await external({ type: 'cmdbar:run', id: 'prev-space', windowId: 1 });
  const before = (await chrome.tabs.query({ windowId: 1 })).length;
  await external({ type: 'cmdbar:run', id: 'clear-unpinned', windowId: 1 });
  assert.ok(state.archive.length >= 1);
  assert.ok((await chrome.tabs.query({ windowId: 1 })).length <= before);
  res = await external({ type: 'cmdbar:list', windowId: 1 });
  const entry = res.commands.find((c) => c.kind === 'archive');
  assert.ok(entry.url && entry.at);
  const n = state.archive.length;
  assert.deepEqual(await external({ type: 'cmdbar:run', id: entry.id, windowId: 1 }), { ok: true });
  assert.equal(state.archive.length, n - 1);
  assert.ok((await chrome.tabs.query({ windowId: 1 })).some((t) => t.url === entry.url && t.active), 'reopened and selected');
  assert.match((await external({ type: 'cmdbar:run', id: 'bogus' })).error, /unknown command/);
});

