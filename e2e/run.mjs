// End-to-end check in a real Chrome for Testing: load the unpacked extension and drive it over CDP.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

// Branded Chrome ignores --load-extension; use Chrome for Testing or Chromium.
const CHROME = process.env.CHROME_BIN;
if (!CHROME) {
  console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
const EXT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'pinline-'));
const proc = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, 'about:blank',
], { stdio: 'ignore' });

let failures = 0;
let saveTabGroupsProfile = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

try {
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    await sleep(250);
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
    sw = list.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  }
  check(!!sw, 'service worker loaded');
  if (!sw) throw new Error('extension not loaded');

  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(JSON.stringify(msg.params.args.map((a) => a.value ?? a.description)));
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evalSW = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description);
    return res.result.result.value;
  };
  await send('Runtime.enable');
  // A freshly started worker can be attached before the extension APIs are bound: wait for them.
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', { expression: `typeof chrome !== 'undefined' && !!chrome.tabs && typeof pinline !== 'undefined'`, returnByValue: true });
    if (r.result?.result?.value === true) break;
    await sleep(250);
  }

  // Real tab strip context menu support.
  const tabCtx = await evalSW(`return await new Promise(r => chrome.contextMenus.create({ id: 'probe', title: 'p', contexts: ['tab'] }, () => { const e = chrome.runtime.lastError?.message; chrome.contextMenus.remove('probe', () => r(e || 'ok')); }));`);
  check(tabCtx === 'ok', `contextMenus "tab" context supported (${tabCtx})`);

  const SLEEP = await evalSW(`return chrome.runtime.getURL('src/sleep.html');`);
  const DIVIDER = await evalSW(`return chrome.runtime.getURL('src/divider.html');`);

  /** CDP session on the control panel (divider page) of a window. */
  async function panelOf(windowId) {
    for (let tries = 0; tries < 20; tries++) {
      const targets = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page' && t.url.includes('/src/divider.html'));
      for (const t of targets) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener('open', r));
        let seq = 0;
        const pend = new Map();
        const errors = [];
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data);
          if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
          if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 99999, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
          if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
        });
        const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
        const ev = async (x) => (await send('Runtime.evaluate', { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
        if ((await ev(`return (await chrome.tabs.getCurrent()).windowId;`)) === windowId) {
          await send('Page.enable');
          await send('Runtime.enable');
          return { ev, errors, close: () => ws.close() };
        }
        ws.close();
      }
      await sleep(250);
    }
    throw new Error('panel not found');
  }
  const strip = () => evalSW(`
    const w = await chrome.windows.getLastFocused();
    const tabs = (await chrome.tabs.query({ windowId: w.id })).sort((a, b) => a.index - b.index);
    const map = pinline.state.tabToPin;
    return tabs.map(t => { const u = t.url || t.pendingUrl || '';
      if (u.startsWith('${DIVIDER}')) return '|';
      const real = u.startsWith('${SLEEP}') ? new URL(u).searchParams.get('url') : u;
      return (map[t.id] ? 'P(' + real + ')' : real) + (t.pinned ? '[native]' : '') + (t.discarded ? '[zz]' : ''); });`);

  const ids = await evalSW(`
    const urls = ['https://github.com/', 'https://example.org/', 'https://www.iana.org/help/example-domains'];
    const tabs = [];
    for (const url of urls) tabs.push(await chrome.tabs.create({ url, active: false }));
    return tabs.map(t => t.id);`);
  const winA = await evalSW(`return (await chrome.tabs.get(${ids[0]})).windowId;`);
  await sleep(3000);
  const stripOf = (w) => evalSW(`
    const tabs = (await chrome.tabs.query({ windowId: ${w} })).sort((a, b) => a.index - b.index);
    const { tabToFav, tabToPin } = pinline.state;
    return tabs.map(t => { const u = t.url || t.pendingUrl || '';
      if (u.startsWith('${DIVIDER}')) return '|';
      const real = u.startsWith('${SLEEP}') ? new URL(u).searchParams.get('url') : u;
      const zz = t.discarded ? 'zz' : '';
      if (tabToFav[t.id]) return 'F' + zz + (t.pinned ? '' : '[!notpinned]') + '(' + real + ')';
      if (tabToPin[t.id]) return 'P' + zz + (t.pinned ? '[!pinned]' : '') + '(' + real + ')';
      return real; }).filter(x => x !== 'about:blank');`);

  // Fav: native right-click → Pin.
  await evalSW(`await chrome.tabs.update(${ids[0]}, { pinned: true });`);
  await sleep(1500);
  let a = await stripOf(winA);
  console.log('  A after fav:', a.join('  '));
  check(a[0] === 'F(https://github.com/)', 'native pin → Fav tile');

  // A second window gets a sleeping copy.
  const winB = await evalSW(`return (await chrome.windows.create({ url: 'https://example.net/' })).id;`);
  await sleep(3500);
  let b = await stripOf(winB);
  console.log('  B:', b.join('  '));
  check(b[0] === 'Fzz(https://github.com/)' && b.at(-1) === 'https://example.net/', 'new window gets the Fav, asleep');
  const copy = await evalSW(`const [t] = (await chrome.tabs.query({ windowId: ${winB} })).sort((x,y)=>x.index-y.index); return { url: t.url, title: t.title, fav: !!t.favIconUrl, pinned: t.pinned };`);
  check(copy.url.startsWith(SLEEP) && copy.pinned && /GitHub/.test(copy.title) && copy.fav, 'sleeping copy: placeholder with title + favicon');

  // Pin: example.org as a full-row Pin.
  await evalSW(`await pinline.togglePin(await chrome.tabs.get(${ids[1]}));`);
  await sleep(1000);
  a = await stripOf(winA);
  console.log('  A after pin:', a.join('  '));
  check(a[0] === 'F(https://github.com/)' && a[1] === 'P(https://example.org/)' && a[2] === '|', 'layout: Fav tile, Pin row, divider');
  const divTitle = await evalSW(`return (await chrome.tabs.query({})).find(t => (t.url||'').startsWith('${DIVIDER}'))?.title;`);
  check(/^─+$/.test(divTitle ?? ''), 'divider tab title is a line');

  // Closing the Fav and the Pin: both come back asleep in their slots.
  await evalSW(`await chrome.tabs.update(${ids[0]}, { url: 'https://github.com/features' });`);
  await sleep(1500);
  await evalSW(`await chrome.tabs.remove(${ids[0]}); await chrome.tabs.remove(${ids[1]});`);
  await sleep(4000);
  a = await stripOf(winA);
  console.log('  A after close:', a.join('  '));
  check(a[0] === 'Fzz(https://github.com/)' && a[1] === 'Pzz(https://example.org/)' && a[2] === '|', 'closed Fav + Pin re-created asleep at home URL, in slot');

  // Waking the Fav.
  const favId = await evalSW(`const [t] = (await chrome.tabs.query({ windowId: ${winA}, pinned: true })); await chrome.tabs.update(t.id, { active: true }); return t.id;`);
  await sleep(3000);
  const woke = await evalSW(`return (await chrome.tabs.get(${favId})).url;`);
  check(woke === 'https://github.com/', `activating wakes it to the real page (${woke})`);

  // Clicking the divider shows the control panel.
  await sleep(1000);
  await evalSW(`const d = (await chrome.tabs.query({ windowId: ${winA} })).find(t => (t.url||'').startsWith('${DIVIDER}')); await chrome.tabs.update(d.id, { active: true });`);
  await sleep(800);
  const active = await evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winA} }); return t.url || t.pendingUrl;`);
  check(active.startsWith(DIVIDER), 'clicking the divider keeps it selected (panel shown)');
  {
    const panel = await panelOf(winA);
    const names = await panel.ev(`await new Promise(r => setTimeout(r, 300)); return [...document.querySelectorAll('.space .name')].map(n => n.textContent);`);
    check(names.length === 1, `panel lists the Spaces (${names.join(', ')})`);
    panel.close();
  }
  await evalSW(`await chrome.tabs.update(${favId}, { active: true });`);
  await sleep(500);

  // Drag iana above the line → Pin.
  await evalSW(`await chrome.tabs.move(${ids[2]}, { index: 1 });`);
  await sleep(1500);
  a = await stripOf(winA);
  console.log('  A after drag up:', a.join('  '));
  check(a[1] === 'P(https://www.iana.org/help/example-domains)' && a.indexOf('|') === 3, 'dragging a tab above the line pins it');

  // Native Unpin of the Fav: removed everywhere, tab lands below the line.
  await evalSW(`await chrome.tabs.update(${favId}, { pinned: false });`);
  await sleep(2000);
  a = await stripOf(winA);
  b = await stripOf(winB);
  console.log('  A after unfav:', a.join('  '));
  console.log('  B after unfav:', b.join('  '));
  check(!a.some((x) => x.startsWith('F')) && a[a.indexOf('|') + 1] === 'https://github.com/', 'un-Fav: tab becomes a normal tab right below the line');
  check(!b.some((x) => x.startsWith('F')) && b.at(-1) === 'https://example.net/', 'un-Fav: sleeping copy in the other window closed');

  // ---------- Spaces ----------
  const winCount = () => evalSW(`return (await chrome.windows.getAll()).length;`);
  const windowsBefore = await winCount();
  // Select iana so we can check it is the one shown when coming back.
  await evalSW(`await chrome.tabs.update(${ids[2]}, { active: true });`);
  await sleep(500);

  const timeSwitch = async (expr) => evalSW(`const t = performance.now(); await ${expr}; return Math.round(performance.now() - t);`);
  const msNew = await timeSwitch(`pinline.newSpace(${winA})`);
  await sleep(1500);
  a = await stripOf(winA);
  console.log(`  A in Space 2 (${msNew} ms):`, a.join('  '));
  check(a.length === 2 && a[0] === '|' && a[1] === 'chrome://newtab/', 'new Space: empty Space with its divider + a new tab');
  const div2 = await evalSW(`return (await chrome.tabs.query({ windowId: ${winA} })).find(t => (t.url||'').startsWith('${DIVIDER}')).title;`);
  check(/Space 2/.test(div2), `divider shows the Space name (${div2.slice(0, 20)}…)`);
  check((await winCount()) === windowsBefore, 'no extra (hidden) windows');
  const oldGone = await evalSW(`return !(await chrome.tabs.get(${ids[2]}).catch(() => null));`);
  check(oldGone, 'old Space tabs are closed');

  await evalSW(`await chrome.tabs.create({ windowId: ${winA}, url: 'https://example.com/?space2' });`);
  await sleep(2000);
  const msBack = await timeSwitch(`pinline.switchSpace(${winA}, 1)`);
  await sleep(2500);
  a = await stripOf(winA);
  console.log(`  A back in Space 1 (${msBack} ms):`, a.join('  '));
  check(a[0] === 'Pzz(https://www.iana.org/help/example-domains)' || a[0] === 'P(https://www.iana.org/help/example-domains)', 'pins back in order');
  check(a.includes('https://github.com/') && a.indexOf('|') === 2, 'tabs back below the divider');
  const shown = await evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winA} }); return { url: t.url, discarded: t.discarded };`);
  check(shown.url === 'https://www.iana.org/help/example-domains', `the tab selected before is selected again and loaded (${shown.url})`);
  const asleep = await evalSW(`return (await chrome.tabs.query({ windowId: ${winA} })).filter(t => !t.active && !t.pinned && !(t.url||'').startsWith('${DIVIDER}')).every(t => t.discarded);`);
  check(asleep, 'all other re-opened tabs are asleep');
  check((await winCount()) === windowsBefore, 'still no extra windows');

  // Switch from the panel: click the other Space.
  await sleep(1000);
  await evalSW(`await pinline.openPanel(${winA});`);
  await sleep(800);
  {
    const panel = await panelOf(winA);
    const other = `[...document.querySelectorAll('#spaces li')].find(li => !li.querySelector('.space').hasAttribute('aria-current'))`;
    await panel.ev(`await new Promise(r => setTimeout(r, 300)); ${other}.querySelector('.space').click();`);
    await sleep(800);
    const still = await stripOf(winA);
    check(still.includes('https://github.com/'), 'clicking a Space only selects it (no switch)');
    const sel = await panel.ev(`return [document.getElementById('rename').value, document.getElementById('switch').disabled];`);
    check(sel[0] === 'Space 2' && sel[1] === false, `right side shows the selected Space (${sel})`);
    await panel.ev(`${other}.querySelector('button.btn').click();`); // its 切换 button
  }
  await sleep(2500);
  a = await stripOf(winA);
  console.log('  A after switching from the panel:', a.join('  '));
  check(a.includes('https://example.com/?space2') && !a.includes('https://github.com/'), '切换 button switches to it');
  const activeNow = await evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winA} }); return t.url || t.pendingUrl;`);
  check(activeNow === 'https://example.com/?space2', `Space 2's selected tab is shown (${activeNow})`);

  // ---------- Panel: rename / delete / new ----------
  await evalSW(`await pinline.openPanel(${winA});`);
  await sleep(800);
  let panel = await panelOf(winA);
  await panel.ev(`await new Promise(r => setTimeout(r, 300)); const i = document.getElementById('rename'); i.value = '工作'; i.dispatchEvent(new Event('change'));`);
  await sleep(1500);
  const renamed = await evalSW(`return (await chrome.tabs.query({ windowId: ${winA} })).find(t => (t.url||'').startsWith('${DIVIDER}')).title;`);
  check(/工作/.test(renamed), `rename in the panel → divider shows it (${renamed.slice(0, 12)}…)`);
  check(panel.errors.length === 0, `no errors in the panel${panel.errors.length ? ': ' + panel.errors.join(' | ') : ''}`);
  panel.close();

  // Select Space 1 with the "1" key (no switch), delete it from the panel while it is hidden.
  await evalSW(`await pinline.openPanel(${winA});`);
  await sleep(800);
  panel = await panelOf(winA);
  await panel.ev(`await new Promise(r => setTimeout(r, 300)); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));`);
  await sleep(500);
  let curName = await evalSW(`return (await chrome.tabs.query({ windowId: ${winA} })).find(t => (t.url||'').startsWith('${DIVIDER}')).title;`);
  const selName = await panel.ev(`return document.getElementById('rename').value;`);
  check(/工作/.test(curName) && selName === 'Space 1', `key 1 selects Space 1 without switching (${selName})`);
  await panel.ev(`document.getElementById('delete').click(); await new Promise(r => setTimeout(r, 1500));`);
  await sleep(1000);
  const left = await evalSW(`return pinline.state.spaces.map(s => s.name);`);
  check(left.length === 1 && left[0] === '工作', `delete (after confirm) removes the selected hidden Space (${left})`);
  const panelRows = await panel.ev(`await new Promise(r => setTimeout(r, 500)); return [...document.querySelectorAll('.space .name')].map(n => n.textContent);`);
  check(panelRows.length === 1, `panel refreshes in place (${panelRows})`);
  panel.close();
  const pinsLeft = await evalSW(`return pinline.state.pins.length;`);
  check(pinsLeft === 0, `its pins are gone (${pinsLeft})`);
  await evalSW(`await pinline.openPanel(${winA});`);
  await sleep(800);
  panel = await panelOf(winA);
  const delDisabled = await panel.ev(`await new Promise(r => setTimeout(r, 300)); return document.getElementById('delete').disabled;`);
  check(delDisabled, 'cannot delete the last Space');
  panel.close();

  // New Space from the panel, with the field focused (#new).
  await evalSW(`await pinline.openPanel(${winA}, true);`);
  await sleep(1000);
  panel = await panelOf(winA);
  const focus = await panel.ev(`await new Promise(r => setTimeout(r, 300)); return [document.activeElement.id, document.getElementById('new-name').placeholder];`);
  check(focus[0] === 'new-name' && focus[1] === 'Space 2', `new-Space field focused with a suggested name (${focus})`);
  await panel.ev(`document.getElementById('new-name').value = '学习'; document.getElementById('new').requestSubmit();`);
  await sleep(2500);
  const newDiv = await evalSW(`return (await chrome.tabs.query({ windowId: ${winA} })).find(t => (t.url||'').startsWith('${DIVIDER}'))?.title ?? '';`);
  check(/学习/.test(newDiv), `switched to the new Space with the typed name (${newDiv.slice(0, 12)}…)`);

  // ---------- Bookmarks ----------
  await sleep(1000);
  const bmTree = () => evalSW(`
    const [other] = (await chrome.bookmarks.getTree())[0].children.filter(n => n.folderType === 'other' || n.id === '2');
    const root = (await chrome.bookmarks.getSubTree(other.id))[0].children.find(n => n.title === 'Pinline' && !n.url);
    if (!root) return null;
    return Object.fromEntries(root.children.map(f => [f.title, (f.children || []).map(c => c.url)]));`);
  let tree = await bmTree();
  console.log('  bookmarks:', JSON.stringify(tree));
  check(!!tree && '⭐ Fav' in tree && '学习' in tree, 'Pinline folder with ⭐ Fav + one folder per Space');

  // A pin in Space "学习", then rename + add from the bookmarks side.
  const pinTab = await evalSW(`return (await chrome.tabs.create({ windowId: ${winA}, url: 'https://example.org/?bm' })).id;`);
  await sleep(1500);
  await evalSW(`await pinline.togglePin(await chrome.tabs.get(${pinTab}));`);
  await sleep(1200);
  tree = await bmTree();
  check(JSON.stringify(tree?.['学习']) === JSON.stringify(['https://example.org/?bm']), `new pin appears in bookmarks (${JSON.stringify(tree?.['学习'])})`);

  await evalSW(`
    const [other] = (await chrome.bookmarks.getTree())[0].children.filter(n => n.folderType === 'other' || n.id === '2');
    const root = (await chrome.bookmarks.getSubTree(other.id))[0].children.find(n => n.title === 'Pinline');
    const f = root.children.find(n => n.title === '学习');
    await chrome.bookmarks.update(f.id, { title: '学习笔记' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'IANA', url: 'https://www.iana.org/' });`);
  await sleep(2000);
  a = await stripOf(winA);
  console.log('  A after bookmark edits:', a.join('  '));
  const divBm = await evalSW(`return (await chrome.tabs.query({ windowId: ${winA} })).find(t => (t.url||'').startsWith('${DIVIDER}'))?.title ?? '';`);
  check(/学习笔记/.test(divBm), `renaming the bookmark folder renames the Space (${divBm.slice(0, 14)}…)`);
  check(a.some((x) => x.includes('https://www.iana.org/') && x.startsWith('P')), 'adding a bookmark adds a pin');

  // Switching speed with bookmark sync on.
  const t1 = await timeSwitch(`pinline.newSpace(${winA}, 'B')`);
  await sleep(1500);
  const t2 = await timeSwitch(`pinline.switchSpace(${winA}, -1)`);
  await sleep(1500);
  console.log(`  INFO switch with bookmark sync: new ${t1} ms, back ${t2} ms`);
  check(t2 < 400, `switching stays fast (${t2} ms)`);

  // Import a bookmark folder from the manage page.
  await evalSW(`const f = await chrome.bookmarks.create({ parentId: '1', title: '读书' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'A', url: 'https://example.com/?a' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'B', url: 'https://example.com/?b' });`);
  await evalSW(`await pinline.openPanel(${winA});`);
  await sleep(1000);
  panel = await panelOf(winA);
  const opts = await panel.ev(`document.getElementById('folder').dispatchEvent(new Event('focus')); await new Promise(r => setTimeout(r, 500)); return [...document.querySelectorAll('#folder option')].map(o => o.textContent);`);
  console.log('  import options:', opts.join(' | '));
  check(opts.some((o) => o.includes('读书（2）')) && !opts.some((o) => o.includes('Pinline')), 'folder list shows 读书, hides Pinline');
  await panel.ev(`const sel = document.getElementById('folder'); sel.value = [...sel.options].find(o => o.textContent.includes('读书')).value; document.getElementById('import').requestSubmit();`);
  await sleep(2500);
  a = await stripOf(winA);
  console.log('  A after import:', a.join('  '));
  check(a[0] === 'Pzz(https://example.com/?a)' && a[1] === 'Pzz(https://example.com/?b)' && a[2] === '|', 'imported folder → new Space with those pins');

  // ---------- Pin groups ----------
  const gview = () => evalSW(`
    const w = ${winA};
    const tabs = (await chrome.tabs.query({ windowId: w })).sort((a, b) => a.index - b.index);
    const groups = await chrome.tabGroups.query({ windowId: w });
    return tabs.map(t => { const u = t.url || t.pendingUrl || '';
      if (u.startsWith('${DIVIDER}')) return '|';
      const real = u.startsWith('${SLEEP}') ? new URL(u).searchParams.get('url') : u;
      const g = t.groupId > -1 ? '[' + groups.find(x => x.id === t.groupId)?.title + ':' + groups.find(x => x.id === t.groupId)?.color + ']' : '';
      return g + (pinline.state.tabToPin[t.id] ? 'P(' + real + ')' : real); });`);
  const gIds = await evalSW(`
    const out = [];
    for (const u of ['https://example.com/?g1', 'https://example.com/?g2', 'https://example.com/?solo']) {
      const t = await chrome.tabs.create({ windowId: ${winA}, url: u, active: false });
      out.push(t.id);
    }
    return out;`);
  await sleep(2000);
  for (const id of gIds) await evalSW(`await pinline.togglePin(await chrome.tabs.get(${id}));`);
  await sleep(800);
  await evalSW(`const g = await chrome.tabs.group({ tabIds: [${gIds[0]}, ${gIds[1]}] }); await chrome.tabGroups.update(g, { title: '组A', color: 'purple' });`);
  await sleep(1500);
  let gv = await gview();
  console.log('  A with a group:', gv.join('  '));
  const gi = gv.indexOf('|');
  check(gv.slice(0, gi).filter((x) => x.startsWith('[组A:purple]P(')).length === 2, 'native grouping of two pins → Pin group, above the divider');
  check(await evalSW(`return pinline.state.groups.length;`) === 1, 'one Pin group stored');

  // Close a pin inside the group → it comes back inside the group.
  await evalSW(`await chrome.tabs.remove(${gIds[1]});`);
  await sleep(2500);
  gv = await gview();
  check(gv.filter((x) => x.startsWith('[组A:purple]P(')).length === 2, `closed grouped pin re-created in the group (${gv.join(' ')})`);

  // Bookmarks: sub-folder.
  await sleep(800);
  tree = await evalSW(`
    const [other] = (await chrome.bookmarks.getTree())[0].children.filter(n => n.folderType === 'other' || n.id === '2');
    const root = (await chrome.bookmarks.getSubTree(other.id))[0].children.find(n => n.title === 'Pinline');
    const sp = root.children.find(n => n.children?.some(c => c.title === '组A'));
    return sp ? sp.children.find(c => c.title === '组A').children.map(c => c.url) : null;`);
  check(JSON.stringify(tree) === JSON.stringify(['https://example.com/?g1', 'https://example.com/?g2']), `group mirrored as a bookmark sub-folder (${JSON.stringify(tree)})`);

  // Switch away and back 3 times: group restored each time; saved-tab-group records do not pile up.
  for (let k = 0; k < Number(process.env.ROUND_TRIPS || 3); k++) {
    await evalSW(`await pinline.switchSpace(${winA}, 1);`);
    await sleep(1200);
    await evalSW(`await pinline.switchSpace(${winA}, -1);`);
    await sleep(1800);
  }
  gv = await gview();
  console.log('  A after 3 round trips:', gv.join('  '));
  check(gv.filter((x) => x.startsWith('[组A:purple]P(')).length === 2, 'group restored after switching Space');
  check((await evalSW(`return (await chrome.tabGroups.query({})).length;`)) === 1, 'exactly one live tab group');
  saveTabGroupsProfile = true;

  // ---------- Archive / Clear unpinned / recent tabs ----------
  const alarm = await evalSW(`return await chrome.alarms.get('pinline-archive');`);
  check(alarm?.periodInMinutes === 15, `archive alarm every 15 minutes (${alarm?.periodInMinutes})`);
  const cmds = await evalSW(`return (await chrome.commands.getAll()).filter(c => ['clear-unpinned', 'mru-back'].includes(c.name)).map(c => c.name + ':' + (c.shortcut || ''));`);
  check(cmds.length === 2 && cmds.every((c) => c.endsWith(':')), `new commands registered without a default key (${cmds})`);
  const pinCount = async () => (await stripOf(winA)).filter((x) => x.startsWith('P')).length;
  const pinsBefore = await pinCount();
  const arc = await evalSW(`
    const out = [];
    for (const u of ['https://example.com/?arc1', 'https://example.com/?arc2', 'https://example.com/?keep']) out.push((await chrome.tabs.create({ windowId: ${winA}, url: u, active: false })).id);
    return out;`);
  await sleep(2500);
  const la = await evalSW(`return (await chrome.tabs.get(${arc[0]})).lastAccessed;`);
  console.log(`  INFO Tab.lastAccessed of a never-selected tab: ${la ? Math.round((Date.now() - la) / 1000) + ' s ago' : la}`);
  await evalSW(`await chrome.tabs.update(${arc[2]}, { active: true });`);
  await sleep(600);
  await evalSW(`await pinline.setArchiveAfter(12);`);
  const bActive = await evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winB} }); return t.id;`);
  const n0 = await evalSW(`return await pinline.archivePass(Date.now() + 11 * 3600e3);`);
  check(n0 === 0, `nothing archived before 12 h (${n0})`);
  const n1 = await evalSW(`return await pinline.archivePass(Date.now() + 13 * 3600e3);`);
  await sleep(1500);
  a = await stripOf(winA);
  console.log(`  A after archive pass (${n1} archived):`, a.join('  '));
  const archived = await evalSW(`return (await chrome.storage.local.get('archive')).archive.map(e => e.url);`);
  check(!a.includes('https://example.com/?arc1') && !a.includes('https://example.com/?arc2') && archived.includes('https://example.com/?arc1') && archived.includes('https://example.com/?arc2'), 'stale tabs closed into the archive');
  check(a.includes('https://example.com/?keep') && (await pinCount()) === pinsBefore, 'selected tab and Pins kept');
  const bKept = await evalSW(`return !!(await chrome.tabs.get(${bActive}).catch(() => null));`);
  check(bKept, 'the selected tab of the other window is kept');

  // Panel: list, search, reopen.
  await evalSW(`await pinline.openPanel(${winA});`);
  await sleep(1000);
  panel = await panelOf(winA);
  const arcView = await panel.ev(`await new Promise(r => setTimeout(r, 400));
    const rows = () => [...document.querySelectorAll('#archive .entry')].map(e => e.title);
    const all = rows();
    const s = document.getElementById('archive-search'); s.value = 'arc1'; s.dispatchEvent(new Event('input'));
    return { all, filtered: rows(), after: document.getElementById('archive-after').value };`);
  console.log('  archive in panel:', JSON.stringify(arcView));
  check(arcView.all.includes('https://example.com/?arc1') && arcView.filtered.length === 1 && arcView.after === '12', 'panel lists the archive, search filters it, setting shown');
  await panel.ev(`document.querySelector('#archive .entry').click();`);
  await sleep(2000);
  check(panel.errors.length === 0, `no errors in the panel${panel.errors.length ? ': ' + panel.errors.join(' | ') : ''}`);
  panel.close();
  a = await stripOf(winA);
  const reActive = await evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winA} }); return t.url || t.pendingUrl;`);
  check(a[a.indexOf('|') + 1] === 'https://example.com/?arc1' && reActive === 'https://example.com/?arc1', `clicking an entry reopens it below the divider, selected (${a.join(' ')})`);
  const still = await evalSW(`return (await chrome.storage.local.get('archive')).archive.map(e => e.url);`);
  check(!still.includes('https://example.com/?arc1'), 'reopened entry left the archive');

  // Clear unpinned.
  const cleared = await evalSW(`return await pinline.clearUnpinned(${winA});`);
  await sleep(1500);
  a = await stripOf(winA);
  console.log(`  A after clear-unpinned (${cleared}):`, a.join('  '));
  const activeAfterClear = await evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winA} }); return t.url || t.pendingUrl;`);
  check(JSON.stringify(a.slice(a.indexOf('|') + 1)) === JSON.stringify(['chrome://newtab/']) && activeAfterClear === 'chrome://newtab/', 'clear-unpinned: only a selected new tab is left below the divider');
  check((await pinCount()) === pinsBefore, 'clear-unpinned keeps the Pins');
  const archived2 = await evalSW(`return (await chrome.storage.local.get('archive')).archive.slice(0, 5).map(e => e.url);`);
  check(archived2.includes('https://example.com/?arc1') && archived2.includes('https://example.com/?keep'), `cleared tabs are in the archive (${archived2.join(' ')})`);

  // Recent tabs.
  const mruIds = await evalSW(`
    const out = [];
    for (const u of ['https://example.com/?m1', 'https://example.com/?m2', 'https://example.com/?m3']) out.push((await chrome.tabs.create({ windowId: ${winA}, url: u, active: true })).id);
    return out;`);
  await sleep(1500);
  for (const id of mruIds) {
    await evalSW(`await chrome.tabs.update(${id}, { active: true });`);
    await sleep(400);
  }
  const activeNowId = () => evalSW(`const [t] = await chrome.tabs.query({ active: true, windowId: ${winA} }); return t.id;`);
  await evalSW(`await pinline.mruBack(${winA});`);
  await sleep(300);
  const step1 = await activeNowId();
  await evalSW(`await pinline.mruBack(${winA});`);
  await sleep(300);
  const step2 = await activeNowId();
  check(step1 === mruIds[1] && step2 === mruIds[0], `mru-back walks back: m2 then m1 (${step1}, ${step2})`);
  await sleep(2000);
  const mru = await evalSW(`return [pinline.state.mru[${winA}].slice(0, 3), (await chrome.storage.session.get('mru')).mru[${winA}].slice(0, 3)];`);
  check(JSON.stringify(mru[0]) === JSON.stringify([mruIds[0], mruIds[2], mruIds[1]]) && JSON.stringify(mru[1]) === JSON.stringify(mru[0]), `after the pause the landing tab is first, saved in storage.session (${JSON.stringify(mru)})`);
  await evalSW(`await pinline.setArchiveAfter(0);`);

  check(errors.length === 0, `no service worker errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  ws.close();
} catch (err) {
  console.log('FAIL', err.message, err.stack?.split('\n').slice(1, 3).join(' '));
  failures++;
} finally {
  proc.kill();
  await sleep(1500);
  if (saveTabGroupsProfile && process.env.SAVED_GROUPS_REPORT) {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('python3', [process.env.SAVED_GROUPS_REPORT, join(profile, 'Default', 'Sync Data', 'LevelDB', '000003.log')]).toString();
    console.log('  saved tab groups in profile:\n' + out);
  }
  if (process.env.KEEP_PROFILE) console.log('  KEPT PROFILE ' + profile);
  else rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} failure(s)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
