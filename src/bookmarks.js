// Two-way sync between Pinline and Chrome bookmarks.
//
//   Other bookmarks / Pinline /
//     ⭐ Fav /        one bookmark per Fav, in order
//     <Space name> /  one folder per Space, in order; one bookmark per Pin
//       <group> /     one sub-folder per Pin group (one level; deeper folders are left alone)
//
// Three-way merge: `base` is a snapshot of what Pinline last wrote. Anything the bookmarks changed
// since then wins (rename, reorder, add, delete, move between folders); everything else keeps the
// local value and is written back by mirrorToBookmarks(). Deleting a whole folder does NOT delete
// the Space / Favs: the folder is re-created (delete Spaces from the "Manage Spaces" page).

import { displayOrder, normalizeUrl } from './core.js';

export const ROOT_TITLE = 'Pinline';
export const FAV_TITLE = '⭐ Fav';

/** What a subtree looks like, to tell later which side changed what. */
export function snapshot(root) {
  const nodes = {};
  const order = {};
  const walk = (n) => {
    nodes[n.id] = { t: n.title, u: n.url ?? null, p: n.parentId ?? null };
    if (n.children) {
      order[n.id] = n.children.map((c) => c.id);
      n.children.forEach(walk);
    }
  };
  if (root) walk(root);
  return { nodes, order };
}

/** Keep `list` as is, except that the members of `ordered` take each other's places in that order. */
export function reorder(list, ordered) {
  const set = new Set(ordered);
  let i = 0;
  return list.map((x) => (set.has(x) ? ordered[i++] : x));
}

const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * Apply bookmark-side changes to the model, in place.
 * @param model  { spaces, favs, pins, bm: { root, fav } } (items carry their bookmark id in `bm`)
 * @param root   getSubTree() node of the Pinline folder
 * @param base   snapshot() of our last write; empty = first contact, match by name / URL instead
 * @param trash  Set of bookmark ids we removed locally but have not deleted in bookmarks yet
 * @param newId  () => unique id
 * @returns effects for the caller to apply to tabs
 */
export function mergeFromBookmarks(model, root, base, trash, newId) {
  const fx = { removedFavs: [], addedFavs: [], removedPins: [], addedPins: [], movedPins: [] };
  model.groups ??= [];
  const nodes = base?.nodes ?? {};
  const adopt = Object.keys(nodes).length === 0;
  const changed = (n) => {
    const o = nodes[n.id];
    return !o || o.t !== n.title || o.u !== (n.url ?? null);
  };
  const orderChanged = (folder) => {
    const o = base?.order?.[folder.id];
    return adopt || !o || o.join() !== folder.children.map((c) => c.id).join();
  };

  const owner = new Map(); // bookmark id -> ['fav' | 'pin' | 'space', item]
  for (const f of model.favs) if (f.bm) owner.set(f.bm, ['fav', f]);
  for (const p of model.pins) if (p.bm) owner.set(p.bm, ['pin', p]);
  for (const s of model.spaces) if (s.bm) owner.set(s.bm, ['space', s]);
  for (const g of model.groups) if (g.bm) owner.set(g.bm, ['group', g]);
  const reparented = (n) => !nodes[n.id] || nodes[n.id].p !== (n.parentId ?? null);
  const seen = new Set();

  /** The Fav / Pin a bookmark stands for (creating or converting it as needed). */
  const itemFor = (node, kind, spaceId, groupId) => {
    if (trash.has(node.id)) return null;
    const hit = owner.get(node.id);
    if (hit?.[0] === kind) {
      const it = hit[1];
      // Group membership: the bookmark's folder wins only if the bookmark was moved there.
      if (kind === 'pin' && reparented(node)) it.group = groupId;
      if (changed(node)) {
        it.title = node.title || it.title;
        it.url = node.url;
      }
      if (kind === 'pin' && it.space !== spaceId) {
        it.space = spaceId;
        fx.movedPins.push(it.id);
      }
      return it;
    }
    if (hit?.[0] === 'fav') {
      model.favs = model.favs.filter((f) => f !== hit[1]); // dragged from ⭐ Fav into a Space
      fx.removedFavs.push(hit[1].id);
    } else if (hit?.[0] === 'pin') {
      model.pins = model.pins.filter((p) => p !== hit[1]); // dragged from a Space into ⭐ Fav
      fx.removedPins.push(hit[1].id);
    }
    if (adopt) {
      const same = (it) => !it.bm && normalizeUrl(it.url) === normalizeUrl(node.url);
      const it = kind === 'fav' ? model.favs.find(same) : model.pins.find((p) => p.space === spaceId && same(p));
      if (it) {
        it.bm = node.id;
        it.title = node.title || it.title;
        if (kind === 'pin') it.group = groupId;
        return it;
      }
    }
    const it = { id: newId(), url: node.url, title: node.title || node.url, bm: node.id };
    if (kind === 'pin') {
      it.space = spaceId;
      it.group = groupId;
      model.pins.push(it);
      fx.addedPins.push(it.id);
    } else {
      model.favs.push(it);
      fx.addedFavs.push(it.id);
    }
    return it;
  };

  const kids = root.children ?? [];
  const favFolder =
    kids.find((n) => !n.url && n.id === model.bm.fav) ??
    (adopt || !model.bm.fav ? kids.find((n) => !n.url && n.title === FAV_TITLE && !owner.has(n.id)) : undefined);
  model.bm.fav = favFolder?.id;
  if (favFolder) {
    seen.add(favFolder.id);
    const ordered = [];
    for (const n of favFolder.children ?? []) {
      if (!n.url) continue;
      const it = itemFor(n, 'fav');
      if (it) ordered.push(it), seen.add(n.id);
    }
    if (orderChanged(favFolder)) model.favs = reorder(model.favs, ordered);
  } else {
    for (const f of model.favs) f.bm = undefined; // ⭐ Fav folder deleted: re-create it, keep the Favs
  }

  const spaceOrder = [];
  for (const folder of kids) {
    if (folder.url || folder === favFolder || trash.has(folder.id)) continue;
    let space = owner.get(folder.id)?.[0] === 'space' ? owner.get(folder.id)[1] : null;
    if (!space && adopt) space = model.spaces.find((s) => !s.bm && s.name === cleanTitle(folder.title));
    if (!space) {
      space = { id: newId(), name: cleanTitle(folder.title) || 'Space' };
      model.spaces.push(space);
    }
    if (!space.bm || changed(folder)) space.name = cleanTitle(folder.title) || space.name;
    space.bm = folder.id;
    seen.add(folder.id);
    spaceOrder.push(space);

    const ordered = [];
    let groupOrderChanged = false;
    for (const n of folder.children ?? []) {
      if (n.url) {
        const it = itemFor(n, 'pin', space.id, undefined);
        if (it) ordered.push(it), seen.add(n.id);
        continue;
      }
      if (trash.has(n.id)) continue;
      // A sub-folder = a Pin group.
      let group = owner.get(n.id)?.[0] === 'group' ? owner.get(n.id)[1] : null;
      if (!group && adopt) group = model.groups.find((g) => !g.bm && g.space === space.id && (g.title || '分组') === n.title);
      if (!group) {
        group = { id: newId(), space: space.id, title: cleanTitle(n.title), color: 'grey', collapsed: false };
        model.groups.push(group);
      }
      if (!group.bm || changed(n)) group.title = cleanTitle(n.title) === '分组' && !group.title ? '' : cleanTitle(n.title);
      group.space = space.id;
      group.bm = n.id;
      seen.add(n.id);
      for (const c of n.children ?? []) {
        if (!c.url) continue;
        const it = itemFor(c, 'pin', space.id, group.id);
        if (it) ordered.push(it), seen.add(c.id);
      }
      if (orderChanged(n)) groupOrderChanged = true;
    }
    if (orderChanged(folder) || groupOrderChanged) model.pins = reorder(model.pins, ordered);
  }
  if (orderChanged(root)) model.spaces = reorder(model.spaces, spaceOrder);

  // A group folder that is gone: its pins went with it (handled below), the group is dropped later.
  for (const g of model.groups) if (g.bm && !seen.has(g.bm)) g.bm = undefined;
  // A Space folder that is gone: re-create it (with its pins) instead of deleting anything.
  for (const s of model.spaces) {
    if (!s.bm || seen.has(s.bm)) continue;
    s.bm = undefined;
    for (const p of model.pins) if (p.space === s.id) p.bm = undefined;
    for (const g of model.groups) if (g.space === s.id) g.bm = undefined;
  }
  // Single bookmarks that are gone (deleted, or moved out of the Pinline folder): un-Fav / unpin.
  for (const f of [...model.favs]) {
    if (f.bm && !seen.has(f.bm)) {
      model.favs = model.favs.filter((x) => x !== f);
      fx.removedFavs.push(f.id);
    }
  }
  for (const p of [...model.pins]) {
    if (p.bm && !seen.has(p.bm)) {
      model.pins = model.pins.filter((x) => x !== p);
      fx.removedPins.push(p.id);
    }
  }
  return fx;
}

/** Write the model into the Pinline folder: create what is missing, fix titles / URLs / order. */
export async function mirrorToBookmarks(model, bm, parentId) {
  const get = async (id) => {
    if (!id) return null;
    try {
      return (await bm.get(id))[0];
    } catch {
      return null;
    }
  };
  const folder = async (id, parent, title, stayWhereItIs = false) => {
    const n = await get(id);
    if (!n || n.url) return (await bm.create({ parentId: parent, title })).id;
    if (n.parentId !== parent && !stayWhereItIs) await bm.move(n.id, { parentId: parent });
    if (n.title !== title) await bm.update(n.id, { title });
    return n.id;
  };
  const link = async (item, parent) => {
    const n = await get(item.bm);
    if (!n || !n.url) {
      item.bm = (await bm.create({ parentId: parent, title: item.title || item.url, url: item.url })).id;
      return;
    }
    if (n.parentId !== parent) await bm.move(n.id, { parentId: parent });
    if (n.title !== (item.title || item.url) || n.url !== item.url) await bm.update(n.id, { title: item.title || item.url, url: item.url });
  };
  // Only ever moves items up, which sidesteps index quirks when moving inside one folder.
  const arrange = async (parent, ids) => {
    for (let i = 0; i < ids.length; i++) {
      const kids = await bm.getChildren(parent);
      if (kids[i]?.id !== ids[i]) await bm.move(ids[i], { parentId: parent, index: i });
    }
  };

  model.bm.root = await folder(model.bm.root, parentId, ROOT_TITLE, true); // the user may move it anywhere
  model.bm.fav = await folder(model.bm.fav, model.bm.root, FAV_TITLE);
  for (const f of model.favs) await link(f, model.bm.fav);
  await arrange(model.bm.fav, model.favs.map((f) => f.bm));
  for (const s of model.spaces) {
    s.bm = await folder(s.bm, model.bm.root, s.name);
    const plan = displayOrder(
      model.pins.filter((p) => p.space === s.id),
      (model.groups ?? []).filter((g) => g.space === s.id),
    );
    const top = [];
    for (const x of plan) {
      if (x.pin) {
        await link(x.pin, s.bm);
        top.push(x.pin.bm);
        continue;
      }
      x.group.bm = await folder(x.group.bm, s.bm, x.group.title || '分组');
      for (const p of x.pins) await link(p, x.group.bm);
      await arrange(x.group.bm, x.pins.map((p) => p.bm));
      top.push(x.group.bm);
    }
    await arrange(s.bm, top);
  }
  await arrange(model.bm.root, [model.bm.fav, ...model.spaces.map((s) => s.bm)]);
}
