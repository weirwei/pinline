// E2E for renamed Favs / Pins: page titles in a real Chrome for Testing.
// Loads a temporary copy of the extension with <all_urls> granted up front (the permission prompt
// cannot be clicked from a script); the code is the same.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_BIN;
if (!CHROME) {
  console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
const SRC = fileURLToPath(new URL('..', import.meta.url));
const EXT = mkdtempSync(join(tmpdir(), 'pinline-ext-'));
for (const f of ['manifest.json', 'src']) cpSync(join(SRC, f), join(EXT, f), { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest));

const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'pinline-'));
const proc = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, 'about:blank'], { stdio: 'ignore' });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result?.result?.value;
  };
  return { ws, ev };
}
const pageOf = async (pred) => {
  for (let i = 0; i < 20; i++) {
    const t = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.type === 'page' && pred(t.url));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('page not found');
};

try {
  let sw;
  for (let i = 0; i < 60 && !sw; i++) {
    await sleep(250);
    sw = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => [])).find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  }
  const S = await connect(sw.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) {
    if (await S.ev(`return typeof pinline !== 'undefined' && pinline.state.ready;`).catch(() => false)) break;
    await sleep(250);
  }
  const tabId = await S.ev(`return (await chrome.tabs.create({ url: 'https://example.com/', active: true })).id;`);
  await sleep(2500);
  await S.ev(`await pinline.togglePin(await chrome.tabs.get(${tabId}));`);
  await sleep(500);
  const pinId = await S.ev(`return pinline.state.tabToPin[${tabId}];`);
  const title = () => S.ev(`return (await chrome.tabs.get(${tabId})).title;`);
  check((await title()) === 'Example Domain', 'original title');

  await S.ev(`await pinline.renameItem('pin', '${pinId}', '我的示例');`);
  await sleep(800);
  check((await title()) === '我的示例', `rename applies to the loaded page (${await title()})`);
  const reg = await S.ev(`return (await chrome.scripting.getRegisteredContentScripts()).map(r => r.matches);`);
  check(JSON.stringify(reg) === JSON.stringify([['https://example.com/*']]), `content script only on that site (${JSON.stringify(reg)})`);

  const P = await pageOf((u) => u.startsWith('https://example.com/'));
  await P.ev(`document.title = 'Inbox (3)'; return 1;`);
  await sleep(500);
  check((await title()) === '我的示例', `page changing its title is overridden (${await title()})`);

  await S.ev(`await chrome.tabs.reload(${tabId});`);
  await sleep(2500);
  check((await title()) === '我的示例', `still renamed after a reload (${await title()})`);

  await S.ev(`await chrome.tabs.remove(${tabId});`);
  await sleep(2500);
  const slept = await S.ev(`const t = (await chrome.tabs.query({})).find(t => (t.url || '').includes('/src/sleep.html')); return t && { id: t.id, title: t.title };`);
  check(slept?.title === '我的示例', `sleeping placeholder shows the name (${slept?.title})`);
  await S.ev(`await chrome.tabs.update(${slept.id}, { active: true });`);
  await sleep(3000);
  const woke = await S.ev(`const t = await chrome.tabs.get(${slept.id}); return [t.url, t.title];`);
  check(woke[0] === 'https://example.com/' && woke[1] === '我的示例', `woken page keeps the name (${woke})`);

  await S.ev(`await pinline.renameItem('pin', '${pinId}', '');`);
  await sleep(800);
  const back = await S.ev(`return (await chrome.tabs.get(${slept.id})).title;`);
  check(back === 'Example Domain', `clearing the name restores the page title (${back})`);
  const reg2 = await S.ev(`return (await chrome.scripting.getRegisteredContentScripts()).length;`);
  check(reg2 === 0, 'content script unregistered when nothing is renamed');

  // Panel name list.
  await S.ev(`await pinline.openPanel((await chrome.tabs.get(${slept.id})).windowId, 'rename=pin:${pinId}');`);
  await sleep(1500);
  const panel = await pageOf((u) => u.includes('/src/divider.html'));
  const rows = await panel.ev(`await new Promise(r => setTimeout(r, 300)); return [[...document.querySelectorAll('#names input')].map(i => i.placeholder), document.activeElement?.placeholder];`);
  check(rows[0].includes('Example Domain') && rows[1] === 'Example Domain', `panel lists the pin and focuses its name field (${JSON.stringify(rows)})`);
} catch (err) {
  console.log('FAIL', err.message);
  failures++;
} finally {
  proc.kill();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
  console.log(failures ? `${failures} failure(s)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
