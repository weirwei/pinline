// Pinline control panel: the page behind the divider tab. Everything goes through the service worker.
const me = await chrome.tabs.getCurrent();
const windowId = me?.windowId;
const send = (msg) => chrome.runtime.sendMessage({ ...msg, windowId }).catch(() => null);
const $ = (id) => document.getElementById(id);

let spaces = [];
let items = [];
let canRetitle = false;
let bookmarkRoot = null;
let selectedId = null; // the Space shown on the right; clicking a Space selects it, it does not switch

const say = (text) => ($('status').textContent = text);
const current = () => spaces.find((s) => s.current);
const selected = () => spaces.find((s) => s.id === selectedId) ?? current();

// ---------- Space list ----------

function select(space) {
  selectedId = space.id;
  renderSpaces();
}

function renderSpaces() {
  const sel = selected();
  $('spaces').replaceChildren(
    ...spaces.map((space, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'space';
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(space.id === sel?.id));
      if (space.current) btn.setAttribute('aria-current', 'true');
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = i < 9 ? String(i + 1) : '';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = space.name;
      if (space.current) name.append(Object.assign(document.createElement('span'), { className: 'dot', title: '当前' }));
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [`${space.pins} 个 Pin`, space.current ? '当前' : `${space.tabs} 个标签`].join(' · ');
      btn.append(key, name, meta);
      btn.addEventListener('click', () => select(space));
      btn.addEventListener('dblclick', () => switchTo(space));

      let action;
      if (space.current) {
        action = Object.assign(document.createElement('span'), { className: 'badge', textContent: '当前' });
      } else {
        action = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: '切换' });
        action.setAttribute('aria-label', `切换到 ${space.name}`);
        action.addEventListener('click', () => switchTo(space));
      }
      li.append(btn, action);
      return li;
    }),
  );

  if (sel && document.activeElement !== $('rename')) $('rename').value = sel.name;
  $('current-meta').textContent = sel
    ? `${sel.pins} 个 Pin${sel.current ? '，当前显示中' : `、${sel.tabs} 个标签`}。删除会关闭它的 Pin 和标签。`
    : '';
  $('switch').disabled = !sel || sel.current;
  $('switch').textContent = sel?.current ? '当前' : '切换';
  $('delete').disabled = spaces.length < 2;
  $('delete').title = spaces.length < 2 ? '至少要保留一个 Space' : '';
}

async function refresh() {
  const res = await send({ type: 'spaces:list' });
  if (!res) return;
  spaces = res.spaces;
  items = res.items ?? [];
  canRetitle = !!res.canRetitle;
  bookmarkRoot = res.bookmarkRoot;
  renderNames();
  if (!spaces.some((s) => s.id === selectedId)) selectedId = current()?.id ?? null;
  renderSpaces();
}

function switchTo(space) {
  if (!space || space.current) return;
  say(`切到「${space.name}」…`);
  send({ type: 'spaces:switch', id: space.id }); // this page closes as part of the switch
}

document.addEventListener('keydown', (e) => {
  if ((e.target instanceof Element && e.target.closest('input, select, textarea, button')) || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && spaces[n - 1]) select(spaces[n - 1]);
  if (e.key === 'Enter') switchTo(selected());
});
$('switch').addEventListener('click', () => switchTo(selected()));

// ---------- new / rename / delete ----------

$('new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('new-name').value.trim() || $('new-name').placeholder;
  say(`新建「${name}」…`);
  send({ type: 'spaces:new', name });
});

async function suggestName() {
  const res = await send({ type: 'spaces:suggest' });
  if (res) $('new-name').placeholder = res.name;
}

function focusNewIfAsked() {
  if (location.hash !== '#new') return;
  history.replaceState(null, '', location.pathname + location.search);
  $('new-name').focus();
}
window.addEventListener('hashchange', focusNewIfAsked);

$('rename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('rename').blur();
  if (e.key === 'Escape') {
    $('rename').value = selected()?.name ?? '';
    $('rename').blur();
  }
});
$('rename').addEventListener('change', async () => {
  const sel = selected();
  const name = $('rename').value.trim();
  if (!sel || !name || name === sel.name) {
    $('rename').value = sel?.name ?? '';
    return;
  }
  // Renaming the current Space reloads this page (the divider shows the name); others just refresh.
  await send({ type: 'spaces:rename', id: sel.id, name });
  say(`已重命名为「${name}」`);
});

$('delete').addEventListener('click', async () => {
  const sel = selected();
  if (!sel || spaces.length < 2) return;
  const tabs = sel.current ? '所有标签' : `${sel.tabs} 个标签`;
  if (!confirm(`删除「${sel.name}」？\n它的 ${sel.pins} 个 Pin 和${tabs}会被关闭，无法恢复。`)) return;
  say(`已删除「${sel.name}」`);
  await send({ type: 'spaces:delete', id: sel.id }); // deleting the current one switches away (page closes)
  selectedId = null;
  refresh();
});

// ---------- Fav / Pin names ----------

const ALL_SITES = { origins: ['<all_urls>'] };

/** Ask for the permission (must run inside a click / key press). Never two prompts at once. */
let asking = null;
function askPermission() {
  asking ??= chrome.permissions
    .request(ALL_SITES)
    .catch(() => false)
    .finally(() => (asking = null));
  return asking;
}

let saving = null; // one save at a time: Enter, then the blur caused by the prompt, must not both run
function saveName(item, input) {
  if (saving) return saving;
  saving = doSave(item, input).finally(() => (saving = null));
  return saving;
}

async function doSave(item, input) {
  const value = input.value.trim();
  if (value === item.name) return;
  // Request first, while the key press / click still counts as a user gesture.
  if (value && !canRetitle && /^https?:/.test(item.url)) canRetitle = await askPermission();
  await send({ type: 'items:rename', kind: item.kind, id: item.id, name: value });
  item.name = value;
  say(value ? `已改名为「${value}」${canRetitle ? '' : '（没有权限：只在休眠时显示）'}` : '已恢复网页原标题');
  renderPerm();
}

function renderPerm() {
  $('perm').hidden = canRetitle || !items.some((i) => i.name);
}

function renderNames() {
  renderPerm();
  if ($('names').contains(document.activeElement)) return; // don't clobber what is being typed
  $('names').replaceChildren(
    ...items.map((item) => {
      const tr = document.createElement('tr');
      tr.dataset.key = `${item.kind}:${item.id}`;
      const kind = Object.assign(document.createElement('td'), { className: 'kind', textContent: item.kind === 'fav' ? 'Fav' : 'Pin' });
      const cell = document.createElement('td');
      const input = Object.assign(document.createElement('input'), { value: item.name, placeholder: item.title || item.url, maxLength: 80 });
      input.setAttribute('aria-label', `${item.title || item.url} 的名称`);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveName(item, input).then(() => input.blur());
        if (e.key === 'Escape') {
          input.value = item.name;
          input.blur();
        }
      });
      input.addEventListener('change', () => saveName(item, input));
      cell.append(input);
      tr.append(kind, cell);
      return tr;
    }),
  );
  if (!items.length) $('names').replaceChildren(Object.assign(document.createElement('tr'), { innerHTML: '<td class="kind"></td><td>还没有 Fav / Pin</td>' }));
}

$('grant').addEventListener('click', async () => {
  if (asking) return;
  canRetitle = await askPermission();
  say(canRetitle ? '已授权，改过名的网页会马上显示新名字' : '未授权');
  renderPerm();
});

function focusRenameIfAsked() {
  const m = /^#rename=(.+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const row = $('names').querySelector(`tr[data-key="${CSS.escape(decodeURIComponent(m[1]))}"]`);
  if (!row) return;
  row.classList.add('focus');
  const input = row.querySelector('input');
  input.focus();
  input.select();
  input.addEventListener('blur', () => row.classList.remove('focus'), { once: true });
}
window.addEventListener('hashchange', focusRenameIfAsked);

// ---------- import from bookmarks ----------

async function loadFolders() {
  const [tree] = await chrome.bookmarks.getTree();
  const options = [];
  const walk = (node, path) => {
    for (const child of node.children ?? []) {
      if (child.url || child.id === bookmarkRoot) continue;
      const here = [...path, child.title || '(未命名)'];
      const links = (child.children ?? []).filter((c) => c.url).length;
      if (links) options.push({ id: child.id, label: `${here.join(' / ')}（${links}）` });
      walk(child, here);
    }
  };
  walk(tree, []);
  const opts = options.map((o) => Object.assign(document.createElement('option'), { value: o.id, textContent: o.label }));
  if (!opts.length) opts.push(Object.assign(document.createElement('option'), { textContent: '没有包含书签的文件夹', disabled: true }));
  $('folder').replaceChildren(...opts);
}
$('folder').addEventListener('focus', loadFolders);
$('import').addEventListener('submit', (e) => {
  e.preventDefault();
  const opt = $('folder').selectedOptions[0];
  if (!opt || opt.disabled) return;
  say(`从「${opt.textContent}」导入…`);
  send({ type: 'spaces:import', folderId: opt.value });
});

// ---------- shortcuts ----------

async function renderKeys() {
  const commands = await chrome.commands.getAll();
  const wanted = ['copy-url', 'toggle-fav', 'toggle-pin', 'next-space', 'prev-space', 'new-space', 'manage-spaces', 'reset-pin', 'set-pin-home'];
  $('keys').replaceChildren(
    ...wanted
      .map((name) => commands.find((c) => c.name === name))
      .filter(Boolean)
      .map((c) => {
        const tr = document.createElement('tr');
        const what = document.createElement('td');
        what.textContent = c.description;
        const key = document.createElement('td');
        if (c.shortcut) key.append(Object.assign(document.createElement('kbd'), { textContent: c.shortcut }));
        else key.textContent = '未设置';
        tr.append(what, key);
        return tr;
      }),
  );
}
$('edit-keys').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------- start ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.spaces || changes.spaceTabs || changes.pins || changes.favs)) refresh();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    renderKeys();
  }
});

await refresh();
await Promise.all([suggestName(), renderKeys(), loadFolders()]);
focusNewIfAsked();
focusRenameIfAsked();
