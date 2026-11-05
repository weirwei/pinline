import test from 'node:test';
import assert from 'node:assert/strict';
import { insertIndexFor, isPinnableUrl, isWakeableUrl, matchPinsToTabs, normalizeUrl, parseSleepUrl, sleepUrl } from '../src/core.js';

test('normalizeUrl drops the hash only', () => {
  assert.equal(normalizeUrl('https://a.com/x?q=1#top'), 'https://a.com/x?q=1');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('isPinnableUrl rejects blank / new tab pages', () => {
  assert.equal(isPinnableUrl('chrome://newtab/'), false);
  assert.equal(isPinnableUrl('about:blank'), false);
  assert.equal(isPinnableUrl(''), false);
  assert.equal(isPinnableUrl('https://mail.google.com/'), true);
});

test('matchPinsToTabs: exact match first, then same origin, each tab once', () => {
  const pins = [
    { id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox' },
    { id: 'gh', url: 'https://github.com/' },
    { id: 'gone', url: 'https://notion.so/' },
  ];
  const tabs = [
    { id: 1, url: 'https://github.com/pulls' }, // same origin as gh
    { id: 2, url: 'https://mail.google.com/mail/u/0/#sent' }, // exact (hash ignored)
    { id: 3, url: 'https://example.com/' }, // unrelated
  ];
  const r = matchPinsToTabs(pins, tabs);
  assert.deepEqual(r.matches, [
    [2, 'gmail'],
    [1, 'gh'],
  ]);
  assert.deepEqual(r.missing.map((p) => p.id), ['gone']);
  assert.deepEqual(r.unclaimedTabs.map((t) => t.id), [3]);
});

test('insertIndexFor keeps pin order', () => {
  const pins = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const pinned = [
    { id: 10, index: 0 },
    { id: 30, index: 1 },
  ];
  const map = { 10: 'a', 30: 'c' };
  assert.equal(insertIndexFor(pins, 'b', pinned, map), 1); // between a and c
  assert.equal(insertIndexFor(pins, 'c', [{ id: 10, index: 0 }], { 10: 'a' }), 1); // at the end
  assert.equal(insertIndexFor(pins, 'a', pinned, { 30: 'c' }), 1); // before c (10 untracked)
});

test('sleep placeholder URL round-trips and only wakes to web pages', () => {
  const base = 'chrome-extension://abc/src/sleep.html';
  const u = sleepUrl(base, { url: 'https://a.com/x?y=1&z=2#h', title: 'A & B' });
  assert.equal(parseSleepUrl(base, u), 'https://a.com/x?y=1&z=2#h');
  assert.equal(parseSleepUrl(base, 'https://a.com/'), null);
  assert.equal(isWakeableUrl('https://a.com/'), true);
  assert.equal(isWakeableUrl('javascript:alert(1)'), false);
  assert.equal(isWakeableUrl('chrome://settings'), false);
});

test('space URLs round-trip; cycleSpace wraps', async () => {
  const { spaceUrl, spaceIdFromUrl, cycleSpace } = await import('../src/core.js');
  const base = 'chrome-extension://abc/src/divider.html';
  const u = spaceUrl(base, { id: 's2', name: '工作 & 生活' });
  assert.equal(spaceIdFromUrl(base, u), 's2');
  assert.equal(new URL(u).searchParams.get('name'), '工作 & 生活');
  assert.equal(spaceIdFromUrl(base, base), null);
  assert.equal(spaceIdFromUrl(base, 'https://x.com/?space=s2'), null);
  const spaces = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(cycleSpace(spaces, 'c'), 'a');
  assert.equal(cycleSpace(spaces, 'a', -1), 'c');
  assert.equal(cycleSpace(spaces, 'missing'), 'b');
});

test('displayOrder keeps a group together at its first pin', async () => {
  const { displayOrder } = await import('../src/core.js');
  const pins = [{ id: 'a' }, { id: 'b', group: 'g' }, { id: 'c' }, { id: 'd', group: 'g' }, { id: 'e', group: 'gone' }];
  const groups = [{ id: 'g' }, { id: 'empty' }];
  const view = displayOrder(pins, groups).map((x) => (x.pin ? x.pin.id : `${x.group.id}[${x.pins.map((p) => p.id)}]`));
  assert.deepEqual(view, ['a', 'g[b,d]', 'c', 'e', 'empty[]']);
});

test('archive helpers: isStale, pushArchive cap, filterArchive, ageOutSaved', async () => {
  const { isStale, pushArchive, filterArchive, ageOutSaved, HOUR_MS } = await import('../src/core.js');
  assert.equal(isStale(0, 12 * HOUR_MS, 12), true);
  assert.equal(isStale(1, 12 * HOUR_MS, 12), false);
  assert.equal(isStale(0, 1e12, 0), false, '0 hours = off');
  assert.deepEqual(pushArchive([{ id: 'a' }, { id: 'b' }], [{ id: 'n' }], 2).map((e) => e.id), ['n', 'a']);
  const list = [{ title: 'GitHub Pulls', url: 'https://github.com/pulls' }, { title: '文档', url: 'https://docs.example.com/' }];
  assert.deepEqual(filterArchive(list, 'git PULL').map((e) => e.title), ['GitHub Pulls']);
  assert.deepEqual(filterArchive(list, '文档'), [list[1]]);
  assert.equal(filterArchive(list, '  ').length, 2);

  const now = 100 * HOUR_MS;
  const items = [{ url: 'a', seen: 0 }, { url: 'b', seen: now }, { url: 'c' }];
  const r = ageOutSaved(items, { tab: 1 }, now, 12);
  assert.deepEqual(r.gone.map((x) => x.url), ['a']);
  assert.deepEqual(r.keep.map((x) => [x.url, x.seen]), [['b', now], ['c', now]], 'items without a time start now');
  assert.deepEqual(r.active, { tab: 0 }, 'selection follows its item');
  assert.equal(ageOutSaved(items, { tab: 0 }, now, 12).active, null);
  assert.deepEqual(ageOutSaved(items, { pin: 'p' }, now, 12).active, { pin: 'p' });
});

test('touchMru moves a tab to the front, no duplicates, capped', async () => {
  const { touchMru } = await import('../src/core.js');
  assert.deepEqual(touchMru([1, 2, 3], 3), [3, 1, 2]);
  assert.deepEqual(touchMru(undefined, 5), [5]);
  assert.deepEqual(touchMru([1, 2, 3], 4, 3), [4, 1, 2]);
});
